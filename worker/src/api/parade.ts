import { json, type AuthedContext } from './router';
import { PARADE_STATUSES, REASON_REQUIRED_STATUSES, isSelfManaged, type ParadeStatus } from '../types';
import { tgSendDocument, tgSendMessage, tgEditMessageText } from '../tg';
import { isWorkingDay, sgtToday, sgtDateAddDays, dayOfWeekSgt } from '../holidays';

const REASON_REQUIRED = new Set<string>(REASON_REQUIRED_STATUSES as readonly string[]);

const AM_CUTOFF_MIN = 7 * 60; // 07:00 SGT
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
				parade_state_date: string | null;
				period: 'AM' | 'PM' | null;
				parade_status: string | null;
				reason: string | null;
			}>();
		return json(results ?? []);
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
		};
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) {
			return json({ error: 'bad_dates' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });

		// entries = per-period {period, status, reason}. At least one required.
		const entries = Array.isArray(body.entries) ? body.entries : [];
		const clean: { period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];
		const seenPeriods = new Set<string>();
		for (const e of entries) {
			if (e.period !== 'AM' && e.period !== 'PM') return json({ error: 'bad_period' }, { status: 400 });
			if (seenPeriods.has(e.period)) return json({ error: 'duplicate_period' }, { status: 400 });
			seenPeriods.add(e.period);
			if (typeof e.status !== 'string' || !ALLOWED_STATUS.has(e.status)) {
				return json({ error: 'bad_status' }, { status: 400 });
			}
			const reason = e.reason?.trim() || null;
			if (REASON_REQUIRED.has(e.status) && !reason) {
				return json({ error: 'reason_required', status: e.status, period: e.period }, { status: 400 });
			}
			clean.push({ period: e.period, status: e.status, reason });
		}
		if (clean.length === 0) {
			return json({ error: 'no_period_filled' }, { status: 400 });
		}

		const allDates = expandRange(body.startdate, body.enddate);

		// Skip weekend days (Sat/Sun) in the range — no parade state on weekends
		// unless a working_day_override forces that specific day to working.
		const weekendDates = allDates.filter((d) => {
			const dow = dayOfWeekSgt(d);
			return dow === 0 || dow === 6;
		});
		let forcedWorkingWeekends = new Set<string>();
		if (weekendDates.length > 0) {
			const placeholders = weekendDates.map(() => '?').join(',');
			const { results } = await env.depot_db
				.prepare(
					`SELECT override_date FROM working_day_overrides
					 WHERE is_working_day = 1 AND override_date IN (${placeholders})`,
				)
				.bind(...weekendDates)
				.all<{ override_date: string }>();
			forcedWorkingWeekends = new Set((results ?? []).map((r) => r.override_date));
		}
		const dates = allDates.filter((d) => {
			const dow = dayOfWeekSgt(d);
			const isWeekend = dow === 0 || dow === 6;
			return !isWeekend || forcedWorkingWeekends.has(d);
		});
		const skippedWeekends = allDates.length - dates.length;

		const today = sgtToday();
		const minutesNow = sgtMinutesIntoDay();
		// Self-managed users bypass the late-change approval gate entirely.
		const todayIsWorking = isSelfManaged(user) ? false : await isWorkingDay(env, today);

		// Classify each (date, period) entry into one of three buckets:
		//   • on-time / future / non-working / past  → apply immediately
		//   • LATE + status 'Present'                 → apply immediately, but
		//       send an FYI to the superior (no approval needed)
		//   • LATE + status ≠ 'Present'               → stage as pending change
		//       request; superior must approve before it applies
		// "Late" = target date is today (SGT) on a working day AND
		//   AM submitted at/after 07:00  OR  PM submitted at/after 13:00.
		const directOps: ReturnType<typeof env.depot_db.prepare>[] = [];
		const upsertStmt = env.depot_db.prepare(
			`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, parade_state_date, period)
			 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
		);
		const pendingPayloads: { date: string; period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];

		for (const d of dates) {
			for (const e of clean) {
				const isLate =
					todayIsWorking &&
					d === today &&
					((e.period === 'AM' && minutesNow >= AM_CUTOFF_MIN) ||
						(e.period === 'PM' && minutesNow >= PM_CUTOFF_MIN));
				if (isLate && e.status !== 'Present') {
					// Late non-Present → needs superior approval.
					pendingPayloads.push({ date: d, period: e.period, status: e.status, reason: e.reason });
				} else {
					// Apply now. Late Present applies silently (no superior FYI).
					directOps.push(upsertStmt.bind(user.id, d, e.period, e.status, e.reason));
				}
			}
		}

		if (directOps.length > 0) {
			await env.depot_db.batch(directOps);
		}

		const superiorTid = user.superior_telegram_id ?? (await firstAdminTidForParade(env));

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

			// Per-request DM with inline buttons (also actionable from the inbox).
			if (superiorTid) {
				const cutoff = p.period === 'AM' ? '07:00' : '13:00';
				const msg = await tgSendMessage(env.BOT_TOKEN, {
					chat_id: superiorTid,
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
				if (msg?.message_id) {
					await env.depot_db
						.prepare(`UPDATE parade_change_requests SET approval_message_id = ? WHERE id = ?`)
						.bind(String(msg.message_id), ins.id)
						.run();
				}
			}
		}

		// ── Edit the most-recent parade nudge (if any) in place, so the user's
		// update is reflected without sending another notification. Only today /
		// tomorrow are ever nudged, so only those can have a tracked message.
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

		// ── Auto-route: if the user marked OFF / RSI / RSO but never applied for
		// it, flag the frontend to bounce them to the Off / Sick apply form. The
		// parade entry itself still saved normally above. Only when something was
		// actually saved (a weekend-only range that got fully skipped shouldn't
		// route anywhere).
		const savedSomething = directOps.length > 0 || pendingPayloads.length > 0;
		let suggestOff = false;
		if (savedSomething && clean.some((e) => e.status === 'OFF')) {
			const existing = await env.depot_db
				.prepare(
					`SELECT 1 FROM off_requests
					 WHERE user_id = ? AND off_status IN ('pending','approved')
					   AND startdate <= ? AND enddate >= ? LIMIT 1`,
				)
				.bind(user.id, body.enddate, body.startdate)
				.first();
			suggestOff = !existing;
		}
		let suggestSick: 'RSI' | 'RSO' | null = null;
		for (const t of ['RSI', 'RSO'] as const) {
			if (!savedSomething || !clean.some((e) => e.status === t)) continue;
			const existing = await env.depot_db
				.prepare(
					`SELECT 1 FROM sick_cases
					 WHERE user_id = ? AND case_type = ?
					   AND reportsick_status IN ('pending_superior','approved','updated','flagged') LIMIT 1`,
				)
				.bind(user.id, t)
				.first();
			if (!existing) {
				suggestSick = t;
				break;
			}
		}

		return json({
			ok: true,
			applied: directOps.length,
			pending: pendingPayloads.length,
			pending_ids: pendingIds,
			skipped_weekends: skippedWeekends,
			suggest_off: suggestOff,
			suggest_sick: suggestSick,
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
		// CSV export — single date, admin or superadmin. Telegram's WebView
		// blocks browser downloads, so we push the file into the user's chat
		// with the bot via sendDocument instead of returning a blob.
		if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json().catch(() => ({}))) as { date?: string };
		const date = body.date ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });

		const { results } = await env.depot_db
			.prepare(
				`SELECT u.full_name, u.department, p.period, p.parade_status, p.reason
				 FROM parade_state_entries p
				 JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date = ?
				 ORDER BY u.department, u.full_name, p.period`,
			)
			.bind(date)
			.all<{ full_name: string; department: string | null; period: string; parade_status: string; reason: string | null }>();
		const rows = results ?? [];

		const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
		const header = 'department,name,period,status,reason\n';
		const csvBody = rows
			.map((r) => [r.department ?? '', r.full_name, r.period, r.parade_status, r.reason ?? ''].map(csvEscape).join(','))
			.join('\n');
		// UTF-8 BOM so Excel auto-detects encoding and renders any non-ASCII
		// characters correctly. (Note: Google Sheets shows the BOM as "ï»¿"
		// gibberish in the first header cell — open the file in Excel.)
		const csv = '﻿' + header + csvBody + '\n';

		const sent = await tgSendDocument(
			env.BOT_TOKEN,
			user.telegram_id,
			`parade-state_${date}.csv`,
			csv,
			`📄 Parade state for ${date} (${rows.length} entries)`,
		);
		if (!sent) return json({ error: 'send_failed' }, { status: 502 });
		return json({ ok: true, rows: rows.length });
	}

	return json({ error: 'not_found' }, { status: 404 });
}

// Fallback approver when the user has no superior_telegram_id set — pick any admin.
// Fallback approver when a user has no superior set — the first superadmin.
async function firstAdminTidForParade(env: Env): Promise<string | null> {
	const a = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin' ORDER BY id LIMIT 1`)
		.first<{ telegram_id: string }>();
	return a?.telegram_id ?? null;
}
