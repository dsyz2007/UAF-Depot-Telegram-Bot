// Cron dispatcher. Wired via wrangler.jsonc triggers.crons.
//
// All four crons land here; we switch on event.cron.
//
// Why use a reminders TABLE instead of waiting in-memory?
// Workers are stateless — there is no "wait 3 hours". We persist the future
// fire time and let the */5min cron sweep it up.

import { tgSendMessage } from './tg';

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
	switch (event.cron) {
		case '*/5 * * * *':
			await drainReminders(env);
			return;
		case '0 13 * * *': // 21:00 SGT — tomorrow nudge
			await nudgeParadeMissing(env, '+1 day', 'evening_prev');
			return;
		case '30 21 * * *': // 05:30 SGT — same-day nudge
			await nudgeParadeMissing(env, '+0 day', 'morning_same');
			return;
		case '30 23 * * *': // 07:30 SGT — escalate to superior
			await escalateParadeMissing(env);
			return;
		default:
			console.warn('unknown cron', event.cron);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Drain due reminders (every 5 minutes).
// ───────────────────────────────────────────────────────────────────────────

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

	const sends: Promise<unknown>[] = [];
	for (const r of results) {
		const text = renderReminder(r);
		const targetTid =
			r.reminder_type === 'sick_update_superior_flag' && r.superior_telegram_id
				? r.superior_telegram_id
				: r.telegram_id;
		sends.push(tgSendMessage(env.BOT_TOKEN, { chat_id: targetTid, text }));
	}
	const settled = await Promise.allSettled(sends);

	// Mark sent (only those we attempted; even failures get marked to avoid
	// runaway resends — log failures for inspection).
	const stmt = env.depot_db.prepare(`UPDATE reminders SET sent_at = datetime('now') WHERE id = ?`);
	const updates = results.map((r) => stmt.bind(r.id));
	await env.depot_db.batch(updates);

	settled.forEach((s, i) => {
		if (s.status === 'rejected') console.error('reminder send failed', results[i].id, s.reason);
	});

	// If we sent the 8h flag, also mark the sick case as flagged.
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

// ───────────────────────────────────────────────────────────────────────────
// 2. Parade-state nudges.
// ───────────────────────────────────────────────────────────────────────────

interface MissingRow {
	telegram_id: string;
	full_name: string;
	superior_telegram_id: string | null;
}

async function fetchMissingParade(env: Env, dayOffset: string): Promise<MissingRow[]> {
	// dayOffset like '+1 day' or '+0 day'. We compute "today in SGT" by adding
	// 8 hours to UTC `now`, then optionally adding +1 day for "tomorrow".
	const { results } = await env.depot_db
		.prepare(
			`SELECT u.telegram_id, u.full_name, u.superior_telegram_id
			 FROM users u
			 WHERE u.full_name NOT LIKE 'PENDING:%'
			   AND NOT EXISTS (
			     SELECT 1 FROM parade_state_entries p
			      WHERE p.user_id = u.id
			        AND p.parade_state_date = date('now', '+8 hours', ?)
			   )`,
		)
		.bind(dayOffset)
		.all<MissingRow>();
	return results ?? [];
}

async function nudgeParadeMissing(env: Env, dayOffset: string, when: 'evening_prev' | 'morning_same'): Promise<void> {
	const rows = await fetchMissingParade(env, dayOffset);
	if (!rows.length) return;
	const text =
		when === 'evening_prev'
			? '🌙 Please submit tomorrow\'s parade state in the depot app. You can edit anytime before 7am.'
			: '☀ Reminder: please submit today\'s parade state in the depot app before 7am.';
	await Promise.allSettled(
		rows.map((r) => tgSendMessage(env.BOT_TOKEN, { chat_id: r.telegram_id, text })),
	);
}

async function escalateParadeMissing(env: Env): Promise<void> {
	const rows = await fetchMissingParade(env, '+0 day');
	if (!rows.length) return;
	const groups = new Map<string, string[]>();
	for (const r of rows) {
		if (!r.superior_telegram_id) continue;
		const arr = groups.get(r.superior_telegram_id) ?? [];
		arr.push(r.full_name);
		groups.set(r.superior_telegram_id, arr);
	}
	await Promise.allSettled(
		[...groups.entries()].map(([tid, names]) =>
			tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🚩 Parade state not submitted by 07:30:\n• ${names.join('\n• ')}`,
			}),
		),
	);
}
