// Cron dispatcher. Wired via wrangler.jsonc triggers.crons.
//
// Cloudflare free tier caps us at 5 cron triggers. Schedule:
//   */5 * * * *      → every 5 min        drain reminders queue
//   0 13 * * *       → 21:00 prev day      AM-empty nudge for tomorrow (if working day)
//   30 21 * * *      → 05:30 same day      AM update nudge (everyone, with reassurance)
//   0 5,23 * * *     → 07:00 SGT (23:00 UTC, AM flag) and 13:00 SGT (05:00 UTC, PM flag)
//   0 4 * * *        → 12:00 same day      PM update nudge + holiday refresh + ORD scan + parade prune

import { tgSendMessage } from './tg';
import { isWorkingDay, refreshHolidays, sgtToday, sgtDateAddDays } from './holidays';

// Inline keyboard with a single WebApp button that deep-links to a tab.
// Optional `date` (YYYY-MM-DD) pre-selects that date on the Parade calendar —
// used by the 9pm reminder so the button lands on tomorrow, not today.
function webAppButton(
	env: Env,
	tab: 'parade' | 'sick' | 'off',
	date?: string,
): { inline_keyboard: { text: string; web_app: { url: string } }[][] } {
	const labels: Record<'parade' | 'sick' | 'off', string> = {
		parade: '🪖 Open Parade page',
		sick: '🤒 Open Sick page',
		off: '📅 Open Off page',
	};
	const url = date ? `${env.WEBAPP_URL}?tab=${tab}&date=${date}` : `${env.WEBAPP_URL}?tab=${tab}`;
	return { inline_keyboard: [[{ text: labels[tab], web_app: { url } }]] };
}

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
			// 12:00 SGT — bundle PM nudge + holiday refresh + ORD scan + prune
			// into a single cron to stay under Cloudflare's 5-trigger cap.
			await paradeNudge(env, 'noon_pm');
			await Promise.allSettled([
				runHolidayRefresh(env),
				runOrdReminders(env),
				runParadePrune(env),
			]);
			return;
		case '0 5,23 * * *': {
			// Fires twice a day — both at minute :00:
			//   23:00 UTC = 07:00 SGT → AM flag
			//   05:00 UTC = 13:00 SGT → PM flag
			// One expression, two meaningful fires, no no-ops. Stays within the
			// 5-cron cap. scheduledTime tells the two apart (survives delays).
			const period: 'AM' | 'PM' = new Date(event.scheduledTime).getUTCHours() === 23 ? 'AM' : 'PM';
			await flagPeriodMissing(env, period);
			return;
		}
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
		const isSuperiorFlag = r.reminder_type === 'sick_update_superior_flag';
		const targetTid = isSuperiorFlag && r.superior_telegram_id ? r.superior_telegram_id : r.telegram_id;
		// Personnel-facing sick reminders deep-link to the Sick page; the
		// 8h-flag DM to the superior is informational only — no button.
		const reply_markup = isSuperiorFlag ? undefined : webAppButton(env, 'sick');
		return tgSendMessage(env.BOT_TOKEN, { chat_id: targetTid, text, reply_markup });
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
			return `⏰ Update your ${r.case_type ?? 'sick'} status (MC days, dates, medicine) in Depot App → 🤒 Sick.`;
		case 'sick_update_personnel_2':
			return `⏰ Second reminder: your ${r.case_type ?? 'sick'} status is still unset — update in Depot App → 🤒 Sick.`;
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
	// All three nudges now share a single AM/PM-aware fetch so the 5:30am
	// reminder can tell the user their actual current status.
	const { results: statusRows } = await env.depot_db
		.prepare(
			`SELECT u.id, u.telegram_id, u.full_name, u.superior_telegram_id,
			        MAX(CASE WHEN p.period = 'AM' THEN p.parade_status END) AS am_status,
			        MAX(CASE WHEN p.period = 'PM' THEN p.parade_status END) AS pm_status
			 FROM users u
			 LEFT JOIN parade_state_entries p
			   ON p.user_id = u.id AND p.parade_state_date = ?
			 WHERE u.full_name NOT LIKE 'PENDING:%'
			 GROUP BY u.id`,
		)
		.bind(targetDate)
		.all<UserRow & { am_status: string | null; pm_status: string | null }>();

	type EnrichedRow = { user: UserRow; amStatus: string | null; pmStatus: string | null };
	let enriched: EnrichedRow[] = [];

	if (kind === 'evening_prev_am') {
		// Only users with no AM entry for tomorrow.
		enriched = (statusRows ?? [])
			.filter((u) => u.am_status === null)
			.map((u) => ({
				user: { id: u.id, telegram_id: u.telegram_id, full_name: u.full_name, superior_telegram_id: u.superior_telegram_id },
				amStatus: u.am_status,
				pmStatus: u.pm_status,
			}));
	} else if (kind === 'morning_am') {
		// 5:30am: nudge everyone, message includes their AM/PM current values.
		enriched = (statusRows ?? []).map((u) => ({
			user: { id: u.id, telegram_id: u.telegram_id, full_name: u.full_name, superior_telegram_id: u.superior_telegram_id },
			amStatus: u.am_status,
			pmStatus: u.pm_status,
		}));
	} else {
		// noon_pm: nudge everyone, message focuses on PM.
		enriched = (statusRows ?? []).map((u) => ({
			user: { id: u.id, telegram_id: u.telegram_id, full_name: u.full_name, superior_telegram_id: u.superior_telegram_id },
			amStatus: u.am_status,
			pmStatus: u.pm_status,
		}));
	}

	if (!enriched.length) return;

	const sends = enriched.map((e) =>
		tgSendMessage(env.BOT_TOKEN, {
			chat_id: e.user.telegram_id,
			text: nudgeText(kind, targetDate, e.amStatus, e.pmStatus),
			// Deep-link the calendar to the exact date this reminder is about
			// (tomorrow for the 9pm nudge, today for the others).
			reply_markup: webAppButton(env, 'parade', targetDate),
		}),
	);
	await Promise.allSettled(sends);
}

function fmtStatus(s: string | null): string {
	return s ?? '— not set —';
}

function nudgeText(kind: NudgeKind, targetDate: string, am: string | null, pm: string | null): string {
	switch (kind) {
		case 'evening_prev_am':
			return `📋 Submit tomorrow's AM parade state (${targetDate}) in Depot App → 🪖 Parade. Editable anytime before 7am.`;
		case 'morning_am': {
			// Show user's actual current AM/PM so they know if any update is
			// needed at a glance.
			const lines = [
				`☀ Today (${targetDate}) parade state:`,
				`  AM: ${fmtStatus(am)}`,
				`  PM: ${fmtStatus(pm)}`,
				'',
				`Update in Depot App → 🪖 Parade if anything's changed. Otherwise ignore this.`,
			];
			return lines.join('\n');
		}
		case 'noon_pm':
			return pm !== null
				? `🕛 Today's PM is "${pm}". Update in Depot App → 🪖 Parade if anything's changed; otherwise ignore.`
				: `🕛 Today's PM parade state is not set. Update in Depot App → 🪖 Parade.`;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Daily maintenance pieces (08:00 SGT for ORD + prune; 12:00 SGT for holidays)
// ──────────────────────────────────────────────────────────────────────────
// 07:00 SGT (AM) and 13:00 SGT (PM): users whose status for that period is
// still empty get their superior DM'd. Skip non-working days entirely.
async function flagPeriodMissing(env: Env, period: 'AM' | 'PM'): Promise<void> {
	const today = sgtToday();
	if (!(await isWorkingDay(env, today))) return;

	const { results } = await env.depot_db
		.prepare(
			`SELECT u.telegram_id, u.full_name, u.superior_telegram_id
			 FROM users u
			 WHERE u.full_name NOT LIKE 'PENDING:%'
			   AND NOT EXISTS (
			     SELECT 1 FROM parade_state_entries p
			     WHERE p.user_id = u.id AND p.parade_state_date = ? AND p.period = ?
			   )`,
		)
		.bind(today, period)
		.all<{ telegram_id: string; full_name: string; superior_telegram_id: string | null }>();
	const missing = results ?? [];
	if (!missing.length) return;

	// Group by superior_telegram_id so each superior gets one consolidated DM.
	const groups = new Map<string, string[]>();
	for (const r of missing) {
		if (!r.superior_telegram_id) continue;
		const arr = groups.get(r.superior_telegram_id) ?? [];
		arr.push(r.full_name);
		groups.set(r.superior_telegram_id, arr);
	}

	const cutoff = period === 'AM' ? '07:00' : '13:00';
	await Promise.allSettled(
		[...groups.entries()].map(([tid, names]) =>
			tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🚩 ${period} parade state still unknown at ${cutoff} (${today}):\n• ${names.join('\n• ')}`,
			}),
		),
	);
}

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
