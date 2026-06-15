// Cron dispatcher. Wired via wrangler.jsonc triggers.crons.
//
// Cloudflare free tier caps us at 5 cron triggers. Schedule:
//   */5 * * * *      → every 5 min        drain reminders queue
//   0 10 * * *       → 18:00 prev day      parade-state nudge for tomorrow (if working day)
//   30 21 * * *      → 05:30 same day      AM update nudge (everyone, with reassurance)
//   0 5,23 * * *     → 07:00 SGT (23:00 UTC, AM flag) and 13:00 SGT (05:00 UTC, PM flag)
//   0 4 * * *        → 12:00 same day      PM update nudge + ORD scan + parade prune

import { tgSendMessage, sendThrottled } from './tg';
import { getDayWorkInfo, slotWorking, sgtToday, sgtDateAddDays } from './holidays';
import { dayCountInclusive } from './types';

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
	approver_tid: string | null;
	case_type: string | null;
}

interface UserRow {
	id: number;
	telegram_id: string;
	full_name: string;
}

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
	switch (event.cron) {
		case '*/5 * * * *':
			await drainReminders(env);
			return;
		case '0 10 * * *':
			await paradeNudge(env, 'evening_prev_am');
			return;
		case '30 21 * * *':
			await paradeNudge(env, 'morning_am');
			return;
		case '0 4 * * *':
			// 12:00 SGT — bundle PM nudge + ORD scan + prune into a single cron to
			// stay under Cloudflare's 5-trigger cap. (Public-holiday refresh is NOT
			// run here — it only happens when a superadmin presses force-fetch in
			// Admin, to avoid hitting nager.date every day for no change.)
			await paradeNudge(env, 'noon_pm');
			// Refund expired-pending offs BEFORE the retention prune runs, so an old
			// pending off can't be deleted before its credits are returned.
			await runOffExpiry(env);
			await Promise.allSettled([
				runOrdReminders(env),
				runParadePrune(env),
				runRetentionPrune(env),
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
			        u.telegram_id, u.full_name,
			        sa.telegram_id AS approver_tid,
			        sc.case_type
			 FROM reminders r
			 JOIN users u ON u.id = r.user_id
			 LEFT JOIN sick_cases sc ON r.related_type = 'sick_case' AND sc.id = r.related_id
			 LEFT JOIN users sa ON sa.id = sc.superior_user_id
			 WHERE r.sent_at IS NULL AND r.due_at <= datetime('now')
			 LIMIT 100`,
		)
		.all<DueRow>();
	if (!results?.length) return;

	// Chunked send (10 at a time, ~2s pause) to stay under Telegram's rate limit.
	const settled = await sendThrottled(results, (r) => {
		const text = renderReminder(r);
		const isSuperiorFlag = r.reminder_type === 'sick_update_superior_flag';
		const targetTid = isSuperiorFlag && r.approver_tid ? r.approver_tid : r.telegram_id;
		// Personnel-facing sick reminders deep-link to the Sick page; the
		// 8h-flag DM to the superior is informational only — no button.
		const reply_markup = isSuperiorFlag ? undefined : webAppButton(env, 'sick');
		return tgSendMessage(env.BOT_TOKEN, { chat_id: targetTid, text, reply_markup });
	});

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

	// Which half-day this nudge is about (drives the per-department working check).
	const period: 'AM' | 'PM' = kind === 'noon_pm' ? 'PM' : 'AM';
	const info = await getDayWorkInfo(env, targetDate);
	// Skip entirely if the whole day is non-working with no department exceptions.
	if (info.baseNonWorking && info.overrides.length === 0) return;

	// All three nudges share a single AM/PM-aware fetch so the message can show
	// the user's actual current status, and so we can skip anyone already done.
	const { results: statusRows } = await env.depot_db
		.prepare(
			`SELECT u.id, u.telegram_id, u.full_name, u.department,
			        MAX(CASE WHEN p.period = 'AM' THEN p.parade_status END) AS am_status,
			        MAX(CASE WHEN p.period = 'PM' THEN p.parade_status END) AS pm_status
			 FROM users u
			 LEFT JOIN parade_state_entries p
			   ON p.user_id = u.id AND p.parade_state_date = ?
			 WHERE u.full_name NOT LIKE 'PENDING:%'
			 GROUP BY u.id`,
		)
		.bind(targetDate)
		.all<UserRow & { department: string | null; am_status: string | null; pm_status: string | null }>();

	type EnrichedRow = { user: UserRow; amStatus: string | null; pmStatus: string | null };

	// Skip anyone who already has BOTH AM and PM filled for the target date, and
	// anyone whose relevant half-day is non-working for their department.
	const enriched: EnrichedRow[] = (statusRows ?? [])
		.filter((u) => (u.am_status === null || u.pm_status === null) && slotWorking(info, u.department, period))
		.map((u) => ({
			user: { id: u.id, telegram_id: u.telegram_id, full_name: u.full_name },
			amStatus: u.am_status,
			pmStatus: u.pm_status,
		}));

	if (!enriched.length) return;

	// Send, capturing each message_id so a later in-app parade-state update can
	// edit the most-recent nudge in place (see parade.ts /submit) rather than
	// sending another notification.
	// Chunked send (10 at a time, ~2s pause) so a ~90-user nudge stays under
	// Telegram's ~30 msg/sec limit.
	const settled = await sendThrottled(enriched, (e) =>
		tgSendMessage(env.BOT_TOKEN, {
			chat_id: e.user.telegram_id,
			text: nudgeText(kind, targetDate, e.amStatus, e.pmStatus),
			// Deep-link the calendar to the exact date this reminder is about
			// (tomorrow for the 9pm nudge, today for the others).
			reply_markup: webAppButton(env, 'parade', targetDate),
		}),
	);
	settled.forEach((s, i) => {
		if (s.status === 'rejected') console.error('parade nudge send failed', enriched[i].user.telegram_id, s.reason);
	});

	const upsertStmt = env.depot_db.prepare(
		`INSERT INTO parade_nudge_messages (user_id, target_date, chat_id, message_id, updated_at)
		 VALUES (?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(user_id, target_date)
		 DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, updated_at = datetime('now')`,
	);
	const upserts: ReturnType<typeof env.depot_db.prepare>[] = [];
	settled.forEach((s, i) => {
		if (s.status === 'fulfilled' && s.value?.message_id) {
			upserts.push(upsertStmt.bind(enriched[i].user.id, targetDate, enriched[i].user.telegram_id, String(s.value.message_id)));
		}
	});
	if (upserts.length) await env.depot_db.batch(upserts);
}

function fmtStatus(s: string | null): string {
	return s ?? '— not set —';
}

function nudgeText(kind: NudgeKind, targetDate: string, am: string | null, pm: string | null): string {
	switch (kind) {
		case 'evening_prev_am':
			return `📋 Submit tomorrow's parade state (${targetDate}) in Depot App → 🪖 Parade.`;
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
				? `🕛 Today's PM Status is labelled "${pm}". Update in Depot App → 🪖 Parade if anything's changed; otherwise ignore.`
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
	const info = await getDayWorkInfo(env, today);
	// Whole day non-working with no department exceptions → nothing to flag.
	if (info.baseNonWorking && info.overrides.length === 0) return;

	const { results } = await env.depot_db
		.prepare(
			`SELECT u.full_name, u.department, u.sub_department, u.self_managed
			 FROM users u
			 WHERE u.full_name NOT LIKE 'PENDING:%'
			   AND NOT EXISTS (
			     SELECT 1 FROM parade_state_entries p
			     WHERE p.user_id = u.id AND p.parade_state_date = ? AND p.period = ?
			   )`,
		)
		.bind(today, period)
		.all<{ full_name: string; department: string | null; sub_department: string | null; self_managed: number }>();
	// Only flag users whose relevant half-day is actually working for their dept.
	const missing = (results ?? []).filter((r) => slotWorking(info, r.department, period));
	if (!missing.length) return;

	// Build a unit → appointment-holder-tids index once, plus the superadmin
	// list, so we group missing users by their approvers without a per-user query.
	const { results: holders } = await env.depot_db
		.prepare(
			`SELECT telegram_id, department, sub_department FROM users
			 WHERE appointment IN ('WOIC','2IC','PC') AND full_name NOT LIKE 'PENDING:%'`,
		)
		.all<{ telegram_id: string; department: string | null; sub_department: string | null }>();
	const unitKey = (d: string | null, s: string | null) => `${d ?? ''}|${s ?? ''}`;
	const byUnit = new Map<string, string[]>();
	for (const h of holders ?? []) {
		const k = unitKey(h.department, h.sub_department);
		(byUnit.get(k) ?? byUnit.set(k, []).get(k)!).push(h.telegram_id);
	}
	const { results: sas } = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin'`)
		.all<{ telegram_id: string }>();
	const superadminTids = (sas ?? []).map((r) => r.telegram_id);

	// Group missing users under each approver. self-managed users have no approver.
	const groups = new Map<string, string[]>();
	for (const r of missing) {
		if (r.self_managed) continue;
		const unitHolders = r.department ? byUnit.get(unitKey(r.department, r.sub_department)) : undefined;
		const approvers = unitHolders && unitHolders.length ? unitHolders : superadminTids;
		for (const tid of [...new Set(approvers)]) {
			const arr = groups.get(tid) ?? [];
			arr.push(r.full_name);
			groups.set(tid, arr);
		}
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

	const { results: superadmins } = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin'`)
		.all<{ telegram_id: string }>();
	if (!superadmins?.length) return;

	// Same-day ORD only (the 30-day heads-up was dropped per request).
	const { results: today_ord } = await env.depot_db
		.prepare(`SELECT id, full_name, ord_date FROM users WHERE ord_date = ?`)
		.bind(today)
		.all<{ id: number; full_name: string; ord_date: string }>();

	const sends: Promise<unknown>[] = [];
	for (const sa of superadmins) {
		for (const u of today_ord ?? []) {
			sends.push(
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: sa.telegram_id,
					text: `📅 Expiry date today: ${u.full_name}. Use the button below to remove from the depot bot.`,
					reply_markup: {
						inline_keyboard: [[{ text: '🗑 Delete user', callback_data: `user:delete:${u.id}` }]],
					},
				}),
			);
		}
	}
	await Promise.allSettled(sends);
}

// Auto-expire pending off requests whose dates have fully passed without ever
// being approved: refund the reserved credits and close them out (off_status
// 'cancelled'). Mirrors a user cancel (no parade rewrite) — without this, the
// credits would stay reserved forever on an off that can never happen. Runs daily.
function offCreditDays(start: string, end: string, period: string): number {
	const d = dayCountInclusive(start, end);
	return period === 'AM' || period === 'PM' ? d * 0.5 : d;
}
async function runOffExpiry(env: Env): Promise<void> {
	const today = sgtToday();
	const { results } = await env.depot_db
		.prepare(
			`SELECT o.id, o.user_id, o.startdate, o.enddate, o.period, u.telegram_id
			 FROM off_requests o JOIN users u ON u.id = o.user_id
			 WHERE o.off_status = 'pending' AND o.enddate < ?`,
		)
		.bind(today)
		.all<{ id: number; user_id: number; startdate: string; enddate: string; period: string; telegram_id: string }>();
	for (const o of results ?? []) {
		// Atomic flip so we never double-refund if it's actioned concurrently.
		const flip = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND off_status = 'pending'`)
			.bind(o.id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) continue;
		const days = offCreditDays(o.startdate, o.enddate, o.period);
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, o.user_id).run();
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: o.telegram_id,
			text: `⌛ Your pending off (${o.startdate} → ${o.enddate}) expired — it was never approved and the dates have passed. 🪙 ${days} credit(s) refunded.`,
		});
	}
}

async function runParadePrune(env: Env): Promise<void> {
	const today = sgtToday();
	await env.depot_db.batch([
		// Keep parade state for as long as the date is still reachable in the
		// calendar (±2 months). The calendar's earliest visible date is the 1st of
		// (current month − 2), so prune only entries older than that. Anything the
		// user can still view or export is retained. (Storage is trivially cheap.)
		env.depot_db
			.prepare(`DELETE FROM parade_state_entries WHERE parade_state_date < date('now','+8 hours','start of month','-2 months')`),
		// Nudge-message rows only matter for today/tomorrow; drop anything past.
		env.depot_db.prepare(`DELETE FROM parade_nudge_messages WHERE target_date < ?`).bind(today),
		// Forecast-view counters only matter for the current day.
		env.depot_db.prepare(`DELETE FROM forecast_views WHERE view_date < ?`).bind(today),
	]);
}

// Retention: delete request/audit records more than ~2 months old (SGT) to keep
// the DB small. "Old" = the record's relevant end/created date is before the
// 2-month-ago cutoff. (Parade STATE entries are pruned separately, to the
// calendar window, in runParadePrune.)
async function runRetentionPrune(env: Env): Promise<void> {
	const cutoff = `date('now','+8 hours','-2 months')`;
	await env.depot_db.batch([
		// Off requests — by the off's end date.
		env.depot_db.prepare(`DELETE FROM off_requests WHERE enddate < ${cutoff}`),
		// Sick cases — by MC end date, falling back to created date when no MC.
		env.depot_db.prepare(`DELETE FROM sick_cases WHERE COALESCE(mc_end_date, date(created_at)) < ${cutoff}`),
		// Leave requests — by the leave's end date.
		env.depot_db.prepare(`DELETE FROM leave_requests WHERE enddate < ${cutoff}`),
		// Off-credit grants — by created date (they have no "end").
		env.depot_db.prepare(`DELETE FROM off_credit_grants WHERE date(created_at) < ${cutoff}`),
		// Late parade-change requests — by the parade date they targeted.
		env.depot_db.prepare(`DELETE FROM parade_change_requests WHERE parade_state_date < ${cutoff}`),
		// Reminders — drained or stale ones past their due time.
		env.depot_db.prepare(`DELETE FROM reminders WHERE due_at < ${cutoff}`),
		// Past public holidays — they're only consulted for the working-day check
		// of recent/upcoming dates; older ones just accumulate.
		env.depot_db.prepare(`DELETE FROM public_holidays WHERE holiday_date < ${cutoff}`),
		// Stale PENDING stubs — someone /started but was never set up by an admin.
		// Clear their (empty) reminders first to satisfy the legacy FK, then delete.
		env.depot_db.prepare(
			`DELETE FROM reminders WHERE user_id IN (SELECT id FROM users WHERE full_name LIKE 'PENDING:%' AND date(created_at) < date('now','+8 hours','-3 months'))`,
		),
		env.depot_db.prepare(`DELETE FROM users WHERE full_name LIKE 'PENDING:%' AND date(created_at) < date('now','+8 hours','-3 months')`),
	]);
}

