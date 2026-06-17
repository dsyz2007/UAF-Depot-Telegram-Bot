// Cron dispatcher. Wired via wrangler.jsonc triggers.crons.
//
// Cloudflare free tier caps us at 5 cron triggers. Schedule:
//   */5 * * * *      → every 5 min        drain reminders queue
//   0 10 * * *       → 18:00 prev day      parade-state nudge for tomorrow (if working day)
//   30 21 * * *      → 05:30 same day      AM update nudge (everyone, with reassurance)
//   0 5,15,23 * * *  → 13:00 SGT (05:00 UTC, PM flag), 23:00 SGT (15:00 UTC, gentle
//                      "tomorrow AM still blank" nudge), 07:00 SGT (23:00 UTC, AM flag)
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
		case '0 5,15,23 * * *': {
			// One expression, three meaningful fires (no extra cron trigger used):
			//   23:00 UTC = 07:00 SGT → AM flag (superiors DM'd if a half is missing)
			//   05:00 UTC = 13:00 SGT → PM flag
			//   15:00 UTC = 23:00 SGT → gentle "tomorrow AM still blank" nudge to the
			//                           person (short; no current status).
			// scheduledTime tells them apart (survives delays).
			const utcHour = new Date(event.scheduledTime).getUTCHours();
			if (utcHour === 15) await paradeNudge(env, 'evening_late_am');
			else await flagPeriodMissing(env, utcHour === 23 ? 'AM' : 'PM');
			return;
		}
		default:
			console.warn('unknown cron', event.cron);
	}
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Reminders queue drain (every 5 min)
// ──────────────────────────────────────────────────────────────────────────
// Cap drained reminders per invocation so the fan-out (1 SELECT + ≤2 status
// fetches + ≤40 sends + a few batched writes) stays well under the Free-tier
// 50-subrequest/invocation limit. Leftovers ride the next 5-min drain.
const DRAIN_LIMIT = 40;
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
			 ORDER BY r.due_at
			 LIMIT ${DRAIN_LIMIT}`,
		)
		.all<DueRow>();
	if (!results?.length) return;

	// Parade-state nudges are fanned out THROUGH this queue (rather than sent inline
	// in the cron) so a ~90-user broadcast is spread across several 5-min drains and
	// no single invocation exceeds the 50-subrequest/invocation Free-tier cap. Their
	// reminder_type packs the kind + target date: "paradenudge:<kind>:<date>".
	const nudges = results.filter((r) => r.related_type === 'parade_nudge');
	const others = results.filter((r) => r.related_type !== 'parade_nudge');

	// Re-fetch current AM/PM status for the nudge users (grouped by target date, so
	// at most ~2 queries) — gives a fresh status line AND lets us skip anyone who
	// filled the slot in the gap between enqueue and send.
	type ParsedNudge = { row: DueRow; kind: NudgeKind; date: string };
	const KINDS = ['evening_prev_am', 'evening_late_am', 'morning_am', 'noon_pm'];
	const parsed: ParsedNudge[] = [];
	for (const r of nudges) {
		const [, kind, date] = r.reminder_type.split(':');
		if (KINDS.includes(kind) && date) parsed.push({ row: r, kind: kind as NudgeKind, date });
	}
	const statusByDate = new Map<string, Map<number, { am: string | null; pm: string | null }>>();
	for (const d of [...new Set(parsed.map((x) => x.date))]) {
		const ids = parsed.filter((x) => x.date === d).map((x) => x.row.user_id);
		const { results: srows } = await env.depot_db
			.prepare(
				`SELECT user_id,
				        MAX(CASE WHEN period = 'AM' THEN parade_status END) AS am_status,
				        MAX(CASE WHEN period = 'PM' THEN parade_status END) AS pm_status
				 FROM parade_state_entries
				 WHERE parade_state_date = ? AND user_id IN (${ids.map(() => '?').join(',')})
				 GROUP BY user_id`,
			)
			.bind(d, ...ids)
			.all<{ user_id: number; am_status: string | null; pm_status: string | null }>();
		const m = new Map<number, { am: string | null; pm: string | null }>();
		for (const x of srows ?? []) m.set(x.user_id, { am: x.am_status, pm: x.pm_status });
		statusByDate.set(d, m);
	}
	const stillUnfilled = (kind: NudgeKind, am: string | null, pm: string | null) =>
		kind === 'evening_late_am' ? am === null : am === null || pm === null;

	// Combined, ordered send list so settled[i] lines up with toSend[i].
	type SendItem = { t: 'other'; row: DueRow } | { t: 'nudge'; p: ParsedNudge; am: string | null; pm: string | null };
	const toSend: SendItem[] = others.map((row) => ({ t: 'other' as const, row }));
	for (const x of parsed) {
		const st = statusByDate.get(x.date)?.get(x.row.user_id) ?? { am: null, pm: null };
		if (stillUnfilled(x.kind, st.am, st.pm)) toSend.push({ t: 'nudge', p: x, am: st.am, pm: st.pm });
		// else: filled in the meantime — it'll just be marked sent below, no DM.
	}

	// Chunked send (10 at a time, ~2s pause) to stay under Telegram's rate limit.
	const settled = await sendThrottled(toSend, (item) => {
		if (item.t === 'other') {
			const r = item.row;
			const text = renderReminder(r);
			const isSuperiorFlag = r.reminder_type === 'sick_update_superior_flag';
			const targetTid = isSuperiorFlag && r.approver_tid ? r.approver_tid : r.telegram_id;
			// Personnel-facing sick reminders deep-link to the Sick page; the
			// 8h-flag DM to the superior is informational only — no button.
			const reply_markup = isSuperiorFlag ? undefined : webAppButton(env, 'sick');
			return tgSendMessage(env.BOT_TOKEN, { chat_id: targetTid, text, reply_markup });
		}
		const { p, am, pm } = item;
		return tgSendMessage(env.BOT_TOKEN, {
			chat_id: p.row.telegram_id,
			text: nudgeText(p.kind, p.date, am, pm),
			// Deep-link the calendar to the exact date this nudge is about.
			reply_markup: webAppButton(env, 'parade', p.date),
		});
	});

	// Mark EVERY drained reminder sent — including nudges skipped as already-filled,
	// so they leave the queue. One batched round-trip.
	const markStmt = env.depot_db.prepare(`UPDATE reminders SET sent_at = datetime('now') WHERE id = ?`);
	await env.depot_db.batch(results.map((r) => markStmt.bind(r.id)));

	settled.forEach((sres, i) => {
		if (sres.status === 'rejected') {
			const item = toSend[i];
			console.error('reminder send failed', item.t === 'other' ? item.row.id : item.p.row.id, sres.reason);
		}
	});

	// Record each freshly-sent nudge's message so a later in-app parade update can
	// edit it in place (see parade.ts /submit) instead of sending another DM.
	const upsertStmt = env.depot_db.prepare(
		`INSERT INTO parade_nudge_messages (user_id, target_date, chat_id, message_id, updated_at)
		 VALUES (?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(user_id, target_date)
		 DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, updated_at = datetime('now')`,
	);
	// Dedupe by (user_id, target_date) — two different nudge KINDS can share a date
	// (evening_prev_am + evening_late_am → tomorrow; morning_am + noon_pm → today),
	// and parade_nudge_messages is keyed on (user_id, target_date). Keep the most
	// recently sent message (the one worth editing), so the batch never carries two
	// rows for the same key.
	const upsertByKey = new Map<string, ReturnType<typeof env.depot_db.prepare>>();
	settled.forEach((sres, i) => {
		const item = toSend[i];
		if (item.t === 'nudge' && sres.status === 'fulfilled' && sres.value?.message_id) {
			upsertByKey.set(
				`${item.p.row.user_id}|${item.p.date}`,
				upsertStmt.bind(item.p.row.user_id, item.p.date, item.p.row.telegram_id, String(sres.value.message_id)),
			);
		}
	});
	if (upsertByKey.size) await env.depot_db.batch([...upsertByKey.values()]);

	const flagIds = others
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
type NudgeKind = 'evening_prev_am' | 'evening_late_am' | 'morning_am' | 'noon_pm';

async function paradeNudge(env: Env, kind: NudgeKind): Promise<void> {
	// targetDate: which SGT date the nudge refers to. The two evening nudges
	// (18:00 + 23:00) are about TOMORROW's AM; the others are about today.
	const today = sgtToday();
	const targetDate = kind === 'evening_prev_am' || kind === 'evening_late_am' ? sgtDateAddDays(today, 1) : today;

	// Which half-day this nudge is about (drives the per-department working check).
	const period: 'AM' | 'PM' = kind === 'noon_pm' ? 'PM' : 'AM';
	const info = await getDayWorkInfo(env, targetDate);
	// Skip entirely if the whole day is non-working with no department exceptions.
	if (info.baseNonWorking && info.overrides.length === 0) return;

	// AM/PM-aware fetch so we can skip anyone already done and apply the per-dept
	// working check. (The drain re-checks + renders the live status at send time.)
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

	// The 23:00 nudge is strictly about a blank AM; the others nudge if either half
	// is unset. Skip anyone whose relevant half-day is non-working for their dept.
	const unfilled = (u: { am_status: string | null; pm_status: string | null }) =>
		kind === 'evening_late_am' ? u.am_status === null : u.am_status === null || u.pm_status === null;
	const targets = (statusRows ?? []).filter((u) => unfilled(u) && slotWorking(info, u.department, period));
	if (!targets.length) return;

	// Do NOT broadcast inline — ENQUEUE one reminder per user and let the every-5-min
	// drain send them in capped batches, so this fan-out (up to ~90 users) never
	// exceeds the 50-subrequest/invocation Free-tier cap. reminder_type packs the
	// kind + target date; the drain re-checks fill status at send time. The whole
	// enqueue is a single D1 round-trip (one subrequest).
	const rt = `paradenudge:${kind}:${targetDate}`;
	const insStmt = env.depot_db.prepare(
		`INSERT INTO reminders (user_id, related_type, related_id, due_at, reminder_type)
		 VALUES (?, 'parade_nudge', 0, datetime('now'), ?)`,
	);
	await env.depot_db.batch([
		// Clear any still-unsent nudge of the same kind/date first, so a double cron
		// fire can't double-nudge anyone (idempotent enqueue).
		env.depot_db.prepare(`DELETE FROM reminders WHERE related_type = 'parade_nudge' AND reminder_type = ? AND sent_at IS NULL`).bind(rt),
		...targets.map((u) => insStmt.bind(u.id, rt)),
	]);
}

function fmtStatus(s: string | null): string {
	return s ?? '— not set —';
}

function nudgeText(kind: NudgeKind, targetDate: string, am: string | null, pm: string | null): string {
	switch (kind) {
		case 'evening_prev_am':
			return `📋 Submit tomorrow's parade state (${targetDate}) in Depot App → 🪖 Parade.`;
		case 'evening_late_am':
			// Short, gentle, no current status (it's blank anyway).
			return `⏰ Gentle reminder: tomorrow's (${targetDate}) AM parade state is still blank. Please fill it in. 🪖`;
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

