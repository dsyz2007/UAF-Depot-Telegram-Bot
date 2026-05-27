// Cron dispatcher. Wired via wrangler.jsonc triggers.crons.
//
// Crons (UTC → SGT):
//   */5 * * * *  → every 5 min    drain reminders queue
//   0 13 * * *   → 21:00 prev day AM-empty nudge for tomorrow (if working day)
//   30 21 * * *  → 05:30 same day AM update nudge (everyone, with reassurance)
//   0 4 * * *    → 12:00 same day PM update nudge + holiday refresh
//   0 0 * * *    → 08:00 SGT      ORD scan + parade pruning

import { tgSendMessage } from './tg';
import { isWorkingDay, refreshHolidays, sgtToday, sgtDateAddDays } from './holidays';

interface DueRow {
	id: number;
	user_id: number;
	related_type: string;
	related_id: number;
	reminder_type: string;
	telegram_id: string;
	full_name: string;
	superior_telegram_id: string | null;
	case_type: string | null;
}

interface UserRow {
	id: number;
	telegram_id: string;
	full_name: string;
	superior_telegram_id: string | null;
}

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
	switch (event.cron) {
		case '*/5 * * * *':
			await drainReminders(env);
			return;
		case '0 13 * * *':
			await paradeNudge(env, 'evening_prev_am');
			return;
		case '30 21 * * *':
			await paradeNudge(env, 'morning_am');
			return;
		case '0 4 * * *':
			await paradeNudge(env, 'noon_pm');
			await runHolidayRefresh(env);
			return;
		case '0 0 * * *':
			await Promise.allSettled([runOrdReminders(env), runParadePrune(env)]);
			return;
		default:
			console.warn('unknown cron', event.cron);
	}
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Reminders queue drain (every 5 min)
// ──────────────────────────────────────────────────────────────────────────
async function drainReminders(env: Env): Promise<void> {
	const { results } = await env.depot_db
		.prepare(
			`SELECT r.id, r.user_id, r.related_type, r.related_id, r.reminder_type,
			        u.telegram_id, u.full_name, u.superior_telegram_id,
			        sc.case_type
			 FROM reminders r
			 JOIN users u ON u.id = r.user_id
			 LEFT JOIN sick_cases sc ON r.related_type = 'sick_case' AND sc.id = r.related_id
			 WHERE r.sent_at IS NULL AND r.due_at <= datetime('now')
			 LIMIT 100`,
		)
		.all<DueRow>();
	if (!results?.length) return;

	const sends: Promise<unknown>[] = results.map((r) => {
		const text = renderReminder(r);
		const targetTid =
			r.reminder_type === 'sick_update_superior_flag' && r.superior_telegram_id
				? r.superior_telegram_id
				: r.telegram_id;
		return tgSendMessage(env.BOT_TOKEN, { chat_id: targetTid, text });
	});
	const settled = await Promise.allSettled(sends);

	const stmt = env.depot_db.prepare(`UPDATE reminders SET sent_at = datetime('now') WHERE id = ?`);
	await env.depot_db.batch(results.map((r) => stmt.bind(r.id)));

	settled.forEach((s, i) => {
		if (s.status === 'rejected') console.error('reminder send failed', results[i].id, s.reason);
	});

	const flagIds = results
		.filter((r) => r.related_type === 'sick_case' && r.reminder_type === 'sick_update_superior_flag')
		.map((r) => r.related_id);
	if (flagIds.length) {
		const flagStmt = env.depot_db.prepare(
			`UPDATE sick_cases SET reportsick_status = 'flagged', escalated_at = datetime('now')
			 WHERE id = ? AND reportsick_status = 'approved'`,
		);
		await env.depot_db.batch(flagIds.map((id) => flagStmt.bind(id)));
	}
}

function renderReminder(r: DueRow): string {
	switch (r.reminder_type) {
		case 'sick_update_personnel':
			return `⏰ Reminder: please update your ${r.case_type ?? 'sick'} status in the depot app (MC days, medicine, etc.).`;
		case 'sick_update_personnel_2':
			return `⏰ Second reminder: your ${r.case_type ?? 'sick'} status is still unset. Please update soon.`;
		case 'sick_update_superior_flag':
			return `🚩 ${r.full_name} has not updated their ${r.case_type ?? 'sick'} status after 8h.`;
		default:
			return `Reminder: ${r.reminder_type}`;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Parade nudges
// ──────────────────────────────────────────────────────────────────────────
type NudgeKind = 'evening_prev_am' | 'morning_am' | 'noon_pm';

async function paradeNudge(env: Env, kind: NudgeKind): Promise<void> {
	// targetDate: which SGT date the nudge refers to
	const today = sgtToday();
	const targetDate = kind === 'evening_prev_am' ? sgtDateAddDays(today, 1) : today;

	// Skip entirely if target date is non-working (weekend, confirmed PH, override)
	if (!(await isWorkingDay(env, targetDate))) return;

	const period: 'AM' | 'PM' = kind === 'noon_pm' ? 'PM' : 'AM';

	// Who should we nudge?
	//   evening_prev_am  → only users with NO entry for tomorrow AM
	//   morning_am       → all users (reassure if already filled)
	//   noon_pm          → all users (reassure if already filled)
	let rows: { user: UserRow; hasEntry: boolean }[] = [];
	if (kind === 'evening_prev_am') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.telegram_id, u.full_name, u.superior_telegram_id
				 FROM users u
				 WHERE u.full_name NOT LIKE 'PENDING:%'
				   AND NOT EXISTS (
				     SELECT 1 FROM parade_state_entries p
				     WHERE p.user_id = u.id AND p.parade_state_date = ? AND p.period = 'AM'
				   )`,
			)
			.bind(targetDate)
			.all<UserRow>();
		rows = (results ?? []).map((u) => ({ user: u, hasEntry: false }));
	} else if (kind === 'morning_am') {
		// 5:30am: general reminder. Reassure if EITHER AM or PM (or both) is filled.
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.telegram_id, u.full_name, u.superior_telegram_id,
				        (SELECT COUNT(*) FROM parade_state_entries p
				          WHERE p.user_id = u.id AND p.parade_state_date = ?) AS filled_periods
				 FROM users u
				 WHERE u.full_name NOT LIKE 'PENDING:%'`,
			)
			.bind(targetDate)
			.all<UserRow & { filled_periods: number }>();
		rows = (results ?? []).map((u) => ({
			user: { id: u.id, telegram_id: u.telegram_id, full_name: u.full_name, superior_telegram_id: u.superior_telegram_id },
			hasEntry: u.filled_periods > 0,
		}));
	} else {
		// noon_pm: reassure if PM specifically is filled.
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.telegram_id, u.full_name, u.superior_telegram_id,
				        (SELECT 1 FROM parade_state_entries p
				          WHERE p.user_id = u.id AND p.parade_state_date = ? AND p.period = 'PM') AS has_entry
				 FROM users u
				 WHERE u.full_name NOT LIKE 'PENDING:%'`,
			)
			.bind(targetDate)
			.all<UserRow & { has_entry: number | null }>();
		rows = (results ?? []).map((u) => ({
			user: { id: u.id, telegram_id: u.telegram_id, full_name: u.full_name, superior_telegram_id: u.superior_telegram_id },
			hasEntry: u.has_entry === 1,
		}));
	}

	if (!rows.length) return;

	const sends = rows.map(({ user, hasEntry }) =>
		tgSendMessage(env.BOT_TOKEN, {
			chat_id: user.telegram_id,
			text: nudgeText(kind, targetDate, hasEntry),
		}),
	);
	await Promise.allSettled(sends);
}

function nudgeText(kind: NudgeKind, targetDate: string, hasEntry: boolean): string {
	switch (kind) {
		case 'evening_prev_am':
			return `📋 Please submit tomorrow's AM parade state (${targetDate}). You can edit anytime before 7am.`;
		case 'morning_am':
			return hasEntry
				? `☀ Reminder: please check today's (${targetDate}) parade state in case anything's changed. If already submitted and nothing's new, you can ignore this.`
				: `☀ Reminder: please update today's (${targetDate}) parade state. Update both AM and PM as needed.`;
		case 'noon_pm':
			return hasEntry
				? `🕛 Reminder: please check today's (${targetDate}) PM parade state in case anything's changed. If PM is already submitted and nothing's new, you can ignore this.`
				: `🕛 Reminder: please update today's (${targetDate}) PM parade state.`;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Daily maintenance pieces (08:00 SGT for ORD + prune; 12:00 SGT for holidays)
// ──────────────────────────────────────────────────────────────────────────
async function runOrdReminders(env: Env): Promise<void> {
	const today = sgtToday();
	const in30 = sgtDateAddDays(today, 30);

	const { results: superadmins } = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin'`)
		.all<{ telegram_id: string }>();
	if (!superadmins?.length) return;

	const { results: thirty } = await env.depot_db
		.prepare(`SELECT id, full_name, ord_date FROM users WHERE ord_date = ?`)
		.bind(in30)
		.all<{ id: number; full_name: string; ord_date: string }>();
	const { results: today_ord } = await env.depot_db
		.prepare(`SELECT id, full_name, ord_date FROM users WHERE ord_date = ?`)
		.bind(today)
		.all<{ id: number; full_name: string; ord_date: string }>();

	const sends: Promise<unknown>[] = [];
	for (const sa of superadmins) {
		for (const u of thirty ?? []) {
			sends.push(
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: sa.telegram_id,
					text: `⏳ ORD heads-up (30 days): ${u.full_name} ORDs on ${u.ord_date}.`,
				}),
			);
		}
		for (const u of today_ord ?? []) {
			sends.push(
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: sa.telegram_id,
					text: `🎉 ORD today: ${u.full_name}. Use the button below to remove from the depot bot.`,
					reply_markup: {
						inline_keyboard: [[{ text: '🗑 Delete user', callback_data: `user:delete:${u.id}` }]],
					},
				}),
			);
		}
	}
	await Promise.allSettled(sends);
}

async function runParadePrune(env: Env): Promise<void> {
	const cutoff = sgtDateAddDays(sgtToday(), -5);
	await env.depot_db
		.prepare(`DELETE FROM parade_state_entries WHERE parade_state_date < ?`)
		.bind(cutoff)
		.run();
}

async function runHolidayRefresh(env: Env): Promise<void> {
	try {
		await refreshHolidays(env);
	} catch (e) {
		console.error('holiday refresh failed', e);
	}
}
