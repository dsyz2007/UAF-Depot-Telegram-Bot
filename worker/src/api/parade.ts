import { json, type AuthedContext } from './router';
import { PARADE_STATUSES, REASON_REQUIRED_STATUSES, DEPARTMENTS, autoApprovesOwn, type ParadeStatus } from '../types';
import { tgSendDocument, tgSendMessage, tgEditMessageText } from '../tg';
import { getRangeWorkInfo, slotWorking, sgtToday, sgtDateAddDays } from '../holidays';
import { approverTidsFor } from '../superiors';
import { buildXlsx } from '../xlsx';

const REASON_REQUIRED = new Set<string>(REASON_REQUIRED_STATUSES as readonly string[]);

// Max days per Excel export. One worksheet (tab) per date, so this also caps the
// number of tabs. 7 = up to a week — small enough that building the workbook
// (pure synchronous CPU: string-building + one CRC32 pass) stays trivially within
// the Workers free-tier ~10ms budget even for an all-departments pull
// (7 × ~100 people × 2 ≈ 1.4k rows, a few ms).
const EXPORT_MAX_DAYS = 7;
// Belt-and-suspenders cap on total cells. With the 7-day limit a realistic export
// is far below this, so it should never trigger in practice — it just stops a
// pathological pull (a very large unit) from approaching the CPU cap. Above it we
// refuse and ask them to narrow the range or pick one department.
const EXPORT_MAX_ROWS = 7000;

// Sentinel "status" meaning: clear (delete) this period's entry so the day
// reverts to the original empty/blank state. Not a real parade status.
const CLEAR_STATUS = 'Blank';

const AM_CUTOFF_MIN = 7 * 60 + 30; // 07:30 SGT — staff may self-edit (no approval) until now
const PM_CUTOFF_MIN = 13 * 60; // 13:00 SGT

// SGT minutes-into-day (0..1439). Uses UTC + 8h offset (no DST in SG).
function sgtMinutesIntoDay(): number {
	const now = new Date();
	const sgt = new Date(now.getTime() + 8 * 3_600_000);
	return sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
}

interface MonthRow {
	user_id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	parade_state_date: string;
	period: 'AM' | 'PM';
	parade_status: string;
	reason: string | null;
}

const ALLOWED_STATUS = new Set<string>(PARADE_STATUSES as readonly string[]);

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function expandRange(start: string, end: string): string[] {
	const out: string[] = [];
	const cur = new Date(`${start}T00:00:00Z`);
	const stop = new Date(`${end}T00:00:00Z`);
	while (cur <= stop && out.length < 95) {
		out.push(cur.toISOString().slice(0, 10));
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
}

export async function handleParade(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/parade'.length);

	// Calendar chip data — only the caller's own entries for the visible month.
	// Returns ~60 rows max (1 user × 30 days × 2 periods) instead of the
	// everyone-in-the-month payload, which is ~5,400 rows. Big read-cost win.
	if (request.method === 'GET' && sub === '/my-month') {
		const ym = url.searchParams.get('ym') ?? '';
		if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'bad_ym' }, { status: 400 });
		const start = `${ym}-01`;
		const { results } = await env.depot_db
			.prepare(
				`SELECT parade_state_date, period, parade_status, reason
				 FROM parade_state_entries
				 WHERE user_id = ?
				   AND parade_state_date >= ?
				   AND parade_state_date < date(?, '+1 month')
				 ORDER BY parade_state_date, period`,
			)
			.bind(user.id, start, start)
			.all<{
				parade_state_date: string;
				period: 'AM' | 'PM';
				parade_status: string;
				reason: string | null;
			}>();
		return json(results ?? []);
	}

	// Day-details data — EVERY active user with their entries for the date.
	// LEFT JOIN from users so unfilled users still appear (with NULL fields).
	// Each user contributes 1–3 rows: 1 placeholder row if they submitted
	// nothing, or one row per period they did submit.
	if (request.method === 'GET' && sub === '/day') {
		const date = url.searchParams.get('date') ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id AS user_id, u.full_name, u.department, u.sub_department,
				        u.user_role, u.personnel_type,
				        p.parade_state_date, p.period, p.parade_status, p.reason
				 FROM users u
				 LEFT JOIN parade_state_entries p
				   ON p.user_id = u.id AND p.parade_state_date = ?
				 WHERE u.full_name NOT LIKE 'PENDING:%'
				 ORDER BY u.department, u.sub_department, u.full_name, p.period`,
			)
			.bind(date)
			.all<{
				user_id: number;
				full_name: string;
				department: string | null;
				sub_department: string | null;
				user_role: string | null;
				personnel_type: string | null;
				parade_state_date: string | null;
				period: 'AM' | 'PM' | null;
				parade_status: string | null;
				reason: string | null;
			}>();
		return json(results ?? []);
	}

	// Which users the caller may edit parade state for (drives the inline Edit
	// buttons in the "Everyone" panel). Superadmin → everyone; otherwise the
	// caller's direct reports via either superior slot.
	if (request.method === 'GET' && sub === '/staff-ids') {
		if (user.user_role === 'admin' || user.user_role === 'superadmin') return json({ all: true, ids: [] as number[] });
		// Appointment-holders may edit their own unit's members.
		if (user.appointment) {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id FROM users
					 WHERE department = ? AND IFNULL(sub_department,'') = IFNULL(?, '')
					   AND id != ? AND full_name NOT LIKE 'PENDING:%'`,
				)
				.bind(user.department, user.sub_department ?? null, user.id)
				.all<{ id: number }>();
			return json({ all: false, ids: (results ?? []).map((r) => r.id) });
		}
		return json({ all: false, ids: [] as number[] });
	}

	// View ONE person's month forecast (admin/superadmin only), rate-limited per
	// viewer per day: users cannot, admins 40/day, superadmins 300/day.
	if (request.method === 'GET' && sub === '/user-month') {
		if (user.user_role !== 'admin' && user.user_role !== 'superadmin') {
			return json({ error: 'forbidden' }, { status: 403 });
		}
		const targetId = Number(url.searchParams.get('user_id'));
		const ym = url.searchParams.get('ym') ?? '';
		if (!Number.isInteger(targetId)) return json({ error: 'bad_user' }, { status: 400 });
		if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'bad_ym' }, { status: 400 });

		const cap = user.user_role === 'superadmin' ? 300 : 40;
		const today = sgtToday();
		const usedRow = await env.depot_db
			.prepare(`SELECT count FROM forecast_views WHERE viewer_id = ? AND view_date = ?`)
			.bind(user.id, today)
			.first<{ count: number }>();
		const used = usedRow?.count ?? 0;
		if (used >= cap) return json({ error: 'view_limit', cap, used }, { status: 429 });

		// Validate the target BEFORE charging a view, so a bad/stale id doesn't burn quota.
		const target = await env.depot_db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(targetId).first<{ full_name: string }>();
		if (!target) return json({ error: 'user_not_found' }, { status: 404 });

		await env.depot_db
			.prepare(
				`INSERT INTO forecast_views (viewer_id, view_date, count) VALUES (?, ?, 1)
				 ON CONFLICT(viewer_id, view_date) DO UPDATE SET count = count + 1`,
			)
			.bind(user.id, today)
			.run();

		const start = `${ym}-01`;
		const { results } = await env.depot_db
			.prepare(
				`SELECT parade_state_date, period, parade_status, reason
				 FROM parade_state_entries
				 WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date < date(?, '+1 month')
				 ORDER BY parade_state_date, period`,
			)
			.bind(targetId, start, start)
			.all<{ parade_state_date: string; period: 'AM' | 'PM'; parade_status: string; reason: string | null }>();
		return json({ full_name: target.full_name, entries: results ?? [], cap, remaining: cap - used - 1 });
	}

	// Deprecated — keep until any cached old WebApp bundles roll over. New
	// frontend uses /my-month + /day above instead.
	if (request.method === 'GET' && sub === '/month') {
		const ym = url.searchParams.get('ym') ?? '';
		if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'bad_ym' }, { status: 400 });
		const start = `${ym}-01`;
		const { results } = await env.depot_db
			.prepare(
				`SELECT p.user_id, u.full_name, u.department, u.sub_department,
				        p.parade_state_date, p.period, p.parade_status, p.reason
				 FROM parade_state_entries p JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date >= ?
				   AND p.parade_state_date < date(?, '+1 month')
				 ORDER BY p.parade_state_date, u.department, u.sub_department, u.full_name, p.period`,
			)
			.bind(start, start)
			.all<MonthRow>();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/submit') {
		const body = (await request.json()) as {
			startdate?: string;
			enddate?: string;
			entries?: { period?: string; status?: string; reason?: string | null }[];
			// Optional: a superior/superadmin editing one of their staff's state.
			user_id?: number;
		};
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) {
			return json({ error: 'bad_dates' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });

		// entries = per-period {period, status, reason}. At least one required.
		const entries = Array.isArray(body.entries) ? body.entries : [];
		let clean: { period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];
		const seenPeriods = new Set<string>();
		for (const e of entries) {
			if (e.period !== 'AM' && e.period !== 'PM') return json({ error: 'bad_period' }, { status: 400 });
			if (seenPeriods.has(e.period)) return json({ error: 'duplicate_period' }, { status: 400 });
			seenPeriods.add(e.period);
			// CLEAR_STATUS ('Blank') is a valid action — it deletes the entry.
			if (typeof e.status !== 'string' || (e.status !== CLEAR_STATUS && !ALLOWED_STATUS.has(e.status))) {
				return json({ error: 'bad_status' }, { status: 400 });
			}
			const reason = e.status === CLEAR_STATUS ? null : e.reason?.trim() || null;
			if (REASON_REQUIRED.has(e.status) && !reason) {
				return json({ error: 'reason_required', status: e.status, period: e.period }, { status: 400 });
			}
			clean.push({ period: e.period, status: e.status, reason });
		}
		if (clean.length === 0) {
			return json({ error: 'no_period_filled' }, { status: 400 });
		}

		// Target resolution. By default a user edits their own state. A superior
		// (either slot) may edit their staff; a superadmin may edit anyone.
		const editingSelf = !Number.isInteger(body.user_id) || body.user_id === user.id;
		let target: { id: number; full_name: string; department: string | null } = {
			id: user.id,
			full_name: user.full_name,
			department: user.department,
		};
		if (!editingSelf) {
			const t = await env.depot_db
				.prepare('SELECT id, full_name, department, sub_department FROM users WHERE id = ?')
				.bind(body.user_id)
				.first<{ id: number; full_name: string; department: string | null; sub_department: string | null }>();
			if (!t) return json({ error: 'user_not_found' }, { status: 404 });
			// Admins & superadmins may edit anyone; an appointment-holder only their
			// own unit's members.
			const canEditAnyone = user.user_role === 'admin' || user.user_role === 'superadmin';
			const sameUnit =
				!!user.appointment && t.department === user.department && (user.sub_department ?? '') === (t.sub_department ?? '');
			if (!canEditAnyone && !sameUnit) return json({ error: 'forbidden' }, { status: 403 });
			target = { id: t.id, full_name: t.full_name, department: t.department };
		}

		// RSI/RSO is managed entirely on the Sick page, where it's always recorded as
		// a SINGLE half-day (today → the current half by SGT clock; a later working
		// day → its AM). For a self-edit we therefore never paint RSI/RSO from the
		// calendar: strip those halves (so any OTHER status submitted alongside — e.g.
		// PM=Present in the same diff submit — is still saved) and route the user to
		// the Sick page to report the RSI/RSO. Approvers editing a staff member set it
		// directly, so we leave their entries untouched.
		const sickType = (clean.find((e) => e.status === 'RSI' || e.status === 'RSO')?.status ?? null) as 'RSI' | 'RSO' | null;
		const routeSick = editingSelf ? sickType : null;
		if (routeSick) clean = clean.filter((e) => e.status !== 'RSI' && e.status !== 'RSO');

		const allDates = expandRange(body.startdate, body.enddate);
		const today = sgtToday();

		// Past-day lock: once a day has ended, only a superadmin may amend its
		// parade state. Everyone else (incl. admins / appointment-holders) is
		// blocked from editing any date before today (SGT).
		const canEditPast = user.user_role === 'superadmin';
		const notPast = allDates.filter((d) => canEditPast || d >= today);
		const skippedPast = allDates.length - notPast.length;

		// Working-day info covering the range (two queries total). A slot is
		// skipped when its (department, period) is non-working — weekend / confirmed
		// holiday, or a superadmin override forcing it non-working. An override can
		// also force an otherwise-weekend slot working. A date is kept only if at
		// least one of the submitted periods is working for the target's department.
		const workInfo = await getRangeWorkInfo(env, notPast);
		const targetDept = target.department;
		const dates = notPast.filter((d) => clean.some((e) => slotWorking(workInfo.get(d)!, targetDept, e.period)));
		const skippedWeekends = notPast.length - dates.length;

		// Compulsory backing for OFF (self-edits only): OFF needs an off request
		// covering every OFF date. If it's missing we save NOTHING and tell the
		// frontend to route the user to the Off page to apply first. (RSI/RSO was
		// already stripped + routed to the Sick page above.)
		if (editingSelf && dates.length > 0) {
			if (clean.some((e) => e.status === 'OFF')) {
				const { results: offReqs } = await env.depot_db
					.prepare(
						`SELECT startdate, enddate FROM off_requests
						 WHERE user_id = ? AND off_status IN ('pending','approved')
						   AND startdate <= ? AND enddate >= ?`,
					)
					.bind(user.id, body.enddate, body.startdate)
					.all<{ startdate: string; enddate: string }>();
				const covered = (d: string) => (offReqs ?? []).some((r) => r.startdate <= d && d <= r.enddate);
				// Only require backing for dates where an OFF entry actually lands on a
				// working slot (a per-department override can make one half non-working,
				// in which case that OFF is skipped and needs no off request).
				const needsBacking = (d: string) =>
					clean.some((e) => e.status === 'OFF' && slotWorking(workInfo.get(d)!, targetDept, e.period));
				const uncovered = dates.filter((d) => needsBacking(d) && !covered(d));
				if (uncovered.length > 0) {
					return json({ ok: true, applied: 0, pending: 0, skipped_weekends: skippedWeekends, skipped_past: skippedPast, blocked_off: true, uncovered_dates: uncovered });
				}
			}
		}

		const minutesNow = sgtMinutesIntoDay();
		// The late-change approval gate applies only to a user editing their OWN
		// state, only when they're not self-managed, and NOT for Regulars (who can
		// always update after the cutoffs without approval). A superior/superadmin
		// editing staff applies changes directly (they're the approver).
		const gateApplies = editingSelf && !autoApprovesOwn(user) && user.personnel_type !== 'Regular';

		// Classify each (date, period) entry into one of these buckets:
		//   • status 'Blank'                          → delete the entry (a fix),
		//       applies directly, no approval/backing
		//   • on-time / future / past(superadmin)     → apply immediately
		//   • LATE + status 'Present'/duty             → apply immediately
		//   • LATE + other status                     → stage as pending change
		//       request; superior must approve before it applies
		// (RSI/RSO never reach here for a self-edit — they were stripped above and
		// routed to the Sick page; an approver's staff edit applies them directly.)
		// "Late" = target date is today (SGT) on a working slot AND
		//   AM submitted at/after 07:30  OR  PM submitted at/after 13:00.
		const directOps: ReturnType<typeof env.depot_db.prepare>[] = [];
		const deleteOps: ReturnType<typeof env.depot_db.prepare>[] = [];
		const upsertStmt = env.depot_db.prepare(
			`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, parade_state_date, period)
			 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
		);
		const deleteStmt = env.depot_db.prepare(
			`DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date = ? AND period = ?`,
		);
		const pendingPayloads: { date: string; period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];

		for (const d of dates) {
			for (const e of clean) {
				// Skip a period whose (department, slot) is non-working.
				if (!slotWorking(workInfo.get(d)!, targetDept, e.period)) continue;
				// 'Blank' resets the slot to the original empty state.
				if (e.status === CLEAR_STATUS) {
					deleteOps.push(deleteStmt.bind(target.id, d, e.period));
					continue;
				}
				const isLate =
					gateApplies &&
					d === today &&
					((e.period === 'AM' && minutesNow >= AM_CUTOFF_MIN) ||
						(e.period === 'PM' && minutesNow >= PM_CUTOFF_MIN));
				// Present / duty-style statuses apply directly even when late.
				const noApprovalNeeded = e.status === 'Present' || e.status === 'Operator Off';
				if (isLate && !noApprovalNeeded) {
					// Late non-Present → needs superior approval.
					pendingPayloads.push({ date: d, period: e.period, status: e.status, reason: e.reason });
				} else {
					// Apply now. Late Present applies silently (no superior FYI).
					directOps.push(upsertStmt.bind(target.id, d, e.period, e.status, e.reason));
				}
			}
		}

		if (directOps.length > 0) await env.depot_db.batch(directOps);
		if (deleteOps.length > 0) await env.depot_db.batch(deleteOps);

		const approverTids = pendingPayloads.length ? await approverTidsFor(env, user) : [];

		// Stage pending requests — supersede any previous pending for the same
		// (user, date, period) so the superior only ever sees the latest one.
		const pendingIds: number[] = [];
		for (const p of pendingPayloads) {
			await env.depot_db
				.prepare(
					`UPDATE parade_change_requests SET status = 'cancelled'
					 WHERE user_id = ? AND parade_state_date = ? AND period = ? AND status = 'pending'`,
				)
				.bind(user.id, p.date, p.period)
				.run();
			const ins = await env.depot_db
				.prepare(
					`INSERT INTO parade_change_requests
					   (user_id, parade_state_date, period, new_status, new_reason, status)
					 VALUES (?, ?, ?, ?, ?, 'pending')
					 RETURNING id`,
				)
				.bind(user.id, p.date, p.period, p.status, p.reason)
				.first<{ id: number }>();
			if (!ins) continue;
			pendingIds.push(ins.id);

			// Per-request DM with inline buttons to EACH superior (either may approve).
			const cutoff = p.period === 'AM' ? '07:00' : '13:00';
			let firstMsgId: string | undefined;
			for (const tid of approverTids) {
				const msg = await tgSendMessage(env.BOT_TOKEN, {
					chat_id: tid,
					text: `🟡 <b>Late ${p.period} parade-state change</b> (after ${cutoff})\n${user.full_name}: ${p.date} → ${p.status}${p.reason ? `\nReason: ${p.reason}` : ''}`,
					parse_mode: 'HTML',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Approve', callback_data: `paradechg:approve:${ins.id}` },
								{ text: '❌ Reject', callback_data: `paradechg:reject:${ins.id}` },
							],
						],
					},
				});
				if (msg?.message_id && firstMsgId === undefined) firstMsgId = String(msg.message_id);
			}
			if (firstMsgId) {
				await env.depot_db
					.prepare(`UPDATE parade_change_requests SET approval_message_id = ? WHERE id = ?`)
					.bind(firstMsgId, ins.id)
					.run();
			}
		}

		// Edit the most-recent parade nudge (if any) in place, so the user's own
		// update is reflected without sending another notification. Only today /
		// tomorrow are ever nudged. Best-effort — never let a nudge-edit failure
		// break the save. (OFF/RSI/RSO backing was already enforced upfront.)
		if (editingSelf) {
			try {
				const tomorrow = sgtDateAddDays(today, 1);
				const editableDates = [...new Set(dates)].filter((d) => d === today || d === tomorrow);
				for (const d of editableDates) {
					const tracked = await env.depot_db
						.prepare(`SELECT chat_id, message_id FROM parade_nudge_messages WHERE user_id = ? AND target_date = ?`)
						.bind(user.id, d)
						.first<{ chat_id: string; message_id: string }>();
					if (!tracked) continue;
					const cur = await env.depot_db
						.prepare(
							`SELECT MAX(CASE WHEN period = 'AM' THEN parade_status END) AS am,
							        MAX(CASE WHEN period = 'PM' THEN parade_status END) AS pm
							 FROM parade_state_entries WHERE user_id = ? AND parade_state_date = ?`,
						)
						.bind(user.id, d)
						.first<{ am: string | null; pm: string | null }>();
					const text = `✅ Parade state for ${d} updated:\n  AM: ${cur?.am ?? '— not set —'}\n  PM: ${cur?.pm ?? '— not set —'}`;
					// Keep the "Open Parade page" button so they can re-edit from the DM.
					await tgEditMessageText(env.BOT_TOKEN, tracked.chat_id, tracked.message_id, text, {
						inline_keyboard: [[{ text: '🪖 Open Parade page', web_app: { url: `${env.WEBAPP_URL}?tab=parade&date=${d}` } }]],
					});
				}
			} catch (e) {
				console.error('parade nudge-edit failed (non-fatal)', e);
			}
		}

		return json({
			ok: true,
			applied: directOps.length + deleteOps.length,
			pending: pendingPayloads.length,
			pending_ids: pendingIds,
			skipped_weekends: skippedWeekends,
			skipped_past: skippedPast,
			// Set when an RSI/RSO half was stripped from a self-edit: the rest was
			// saved (see `applied`), and the frontend routes the user to the Sick page
			// to report the RSI/RSO.
			blocked_sick: routeSick ?? undefined,
			target_user_id: target.id,
		});
	}

	// Strength report data — every active user with their parade entry (or
	// null) for the given date+period. Open to all authenticated users; the
	// View State button in the UI uses it.
	if (request.method === 'GET' && sub === '/strength') {
		const date = url.searchParams.get('date') ?? '';
		const period = url.searchParams.get('period') ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });
		if (period !== 'AM' && period !== 'PM') return json({ error: 'bad_period' }, { status: 400 });

		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.full_name, u.department, u.sub_department, u.personnel_type,
				        p.parade_status AS status, p.reason
				 FROM users u
				 LEFT JOIN parade_state_entries p
				   ON p.user_id = u.id AND p.parade_state_date = ? AND p.period = ?
				 WHERE u.full_name NOT LIKE 'PENDING:%'
				 ORDER BY u.department, u.sub_department, u.personnel_type, u.full_name`,
			)
			.bind(date, period)
			.all<{
				id: number;
				full_name: string;
				department: string | null;
				sub_department: string | null;
				personnel_type: string | null;
				status: string | null;
				reason: string | null;
			}>();
		return json({ date, period, users: results ?? [] });
	}

	if (request.method === 'POST' && sub === '/export') {
		// Multi-sheet Excel export — one worksheet (tab) per date in the range,
		// optionally filtered to a single department. Admin/superadmin only.
		// Telegram's in-app WebView blocks browser downloads, so we push the file
		// into the user's chat with the bot via sendDocument.
		//
		// Format = a real .xlsx (OOXML) with one worksheet per date — see xlsx.ts.
		// (We previously emitted SpreadsheetML 2003, which modern Excel began
		// flagging as "corrupted" with multiple sheets.) Building it is pure
		// synchronous CPU; the ≤7-day range cap (+ EXPORT_MAX_ROWS) keeps the cost
		// comfortably within the free-tier budget.
		if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json().catch(() => ({}))) as { start?: string; end?: string; department?: string };
		const start = body.start ?? '';
		const end = body.end ?? '';
		if (!isValidDate(start) || !isValidDate(end)) return json({ error: 'bad_dates' }, { status: 400 });
		if (start > end) return json({ error: 'bad_range' }, { status: 400 });
		const dates = expandRange(start, end);
		if (dates.length > EXPORT_MAX_DAYS) return json({ error: 'range_too_long', max_days: EXPORT_MAX_DAYS }, { status: 400 });

		// Department filter: 'all' (null) or one known department. DSP absorbed the
		// legacy STG rows, so a DSP filter matches both.
		const dept = body.department && body.department !== 'all' ? body.department : null;
		if (dept && !(DEPARTMENTS as readonly string[]).includes(dept)) return json({ error: 'bad_department' }, { status: 400 });
		let deptClause = '';
		const qbinds: (string | number)[] = [start, end];
		if (dept === 'DSP') {
			deptClause = ` AND u.department IN ('DSP','STG')`;
		} else if (dept) {
			deptClause = ` AND u.department = ?`;
			qbinds.push(dept);
		}

		type ExportRow = { full_name: string; department: string | null; parade_state_date: string; period: string; parade_status: string; reason: string | null };
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.full_name, u.department, p.parade_state_date, p.period, p.parade_status, p.reason
				 FROM parade_state_entries p
				 JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date >= ? AND p.parade_state_date <= ?${deptClause}
				 ORDER BY p.parade_state_date, u.department, u.full_name, p.period`,
			)
			.bind(...qbinds)
			.all<ExportRow>();
		const rows = results ?? [];
		// Nothing to export — tell the caller so the UI can show a friendly note
		// (don't send an empty file).
		if (rows.length === 0) return json({ ok: true, rows: 0, sheets: 0 });
		// Safety net: refuse an over-large pull rather than risk the CPU cap.
		if (rows.length > EXPORT_MAX_ROWS) {
			return json({ error: 'too_many_rows', rows: rows.length, max_rows: EXPORT_MAX_ROWS }, { status: 400 });
		}

		// One worksheet per date that actually has entries (skips blank weekends),
		// in chronological order.
		const byDate = new Map<string, ExportRow[]>();
		for (const r of rows) {
			const arr = byDate.get(r.parade_state_date) ?? [];
			arr.push(r);
			byDate.set(r.parade_state_date, arr);
		}

		// One worksheet per date; header row + one row per (dept, name, period).
		const header = ['Department', 'Name', 'Period', 'Status', 'Reason'];
		const sheets = [...byDate.entries()].map(([date, sheetRows]) => ({
			name: date, // YYYY-MM-DD — safe as a sheet name (<=31 chars, no special chars)
			rows: [header, ...sheetRows.map((r) => [r.department ?? '', r.full_name, r.period, r.parade_status, r.reason ?? ''])],
		}));
		const workbook = buildXlsx(sheets);

		const rangeTag = start === end ? start : `${start}_to_${end}`;
		const deptTag = dept ? `_${dept}` : '';
		const sent = await tgSendDocument(
			env.BOT_TOKEN,
			user.telegram_id,
			`parade-state_${rangeTag}${deptTag}.xlsx`,
			workbook,
			`📊 Parade state ${start === end ? start : `${start} → ${end}`}${dept ? ` · ${dept}` : ''} — ${byDate.size} date tab(s), ${rows.length} entries`,
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		);
		if (!sent) return json({ error: 'send_failed' }, { status: 502 });
		return json({ ok: true, rows: rows.length, sheets: byDate.size });
	}

	return json({ error: 'not_found' }, { status: 404 });
}
