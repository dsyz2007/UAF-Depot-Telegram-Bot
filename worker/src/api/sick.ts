import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { autoApprovesOwn } from '../types';
import { approverTidsFor, sameUnit } from '../superiors';
import { sgtToday, sgtDateAddDays, sgtPeriodNow, getDayWorkInfo, getRangeWorkInfo, slotWorking } from '../holidays';
import { packApprovalMsgs, type MsgPair } from '../approval-dms';

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

// After a user records MC days, paint MC onto the parade calendar across the MC
// date range — every WORKING slot, for the user's department. Keeps any existing
// RSI/RSO cell (the reported half-day) intact, and caps the range to ~2 months
// ahead (the calendar window) so a long MC can't paint beyond what's viewable.
// Returns the distinct dates actually touched (for the user-facing confirmation).
async function setParadeForMc(env: Env, userId: number, dept: string | null, mcStart: string, mcEnd: string): Promise<string[]> {
	// Cap to the calendar window (~2 months ahead). Never paint into the past.
	const today = sgtToday();
	const cap = sgtDateAddDays(today, 62);
	const start = mcStart < today ? today : mcStart;
	const end = mcEnd > cap ? cap : mcEnd;
	if (start > end) return [];
	const dates = expandRange(start, end);
	const info = await getRangeWorkInfo(env, dates);
	const reason = `${mcStart} → ${mcEnd} MC`;
	const stmt = env.depot_db.prepare(
		`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
		 VALUES (?, ?, ?, 'MC', ?)
		 ON CONFLICT(user_id, parade_state_date, period)
		 DO UPDATE SET parade_status = 'MC', reason = excluded.reason
		   WHERE parade_state_entries.parade_status NOT IN ('RSI','RSO')`,
	);
	const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
	const touched = new Set<string>();
	for (const d of dates) {
		const di = info.get(d);
		if (!di) continue;
		for (const p of ['AM', 'PM'] as const) {
			if (slotWorking(di, dept, p)) {
				ops.push(stmt.bind(userId, d, p, reason));
				touched.add(d);
			}
		}
	}
	if (ops.length) await env.depot_db.batch(ops);
	return [...touched].sort();
}

// Optimistically set a user's parade state for `date` to the sick status
// (RSI/RSO) when they report — shown even before approval. Bypasses the normal
// late-change gate because the sick approval IS the gate. Skips any half-day
// that is non-working for the user's department (weekend / holiday / override)
// so RSI/RSO never shows on a non-working day.
//
// Which half-day(s) get marked:
//   • for TODAY → only the half-day currently in progress (AM before noon SGT,
//     otherwise PM) — you don't retroactively mark a half-day that's over.
//   • for a LATER day (report() only ever passes tomorrow) → only that day's AM.
// report() clamps sick_date to today/tomorrow, so these two cases are exhaustive.
export async function setParadeForSick(env: Env, userId: number, dept: string | null, date: string, status: string): Promise<void> {
	const info = await getDayWorkInfo(env, date);
	const periods: ('AM' | 'PM')[] = date === sgtToday() ? [sgtPeriodNow()] : ['AM'];
	const stmt = env.depot_db.prepare(
		`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
		 VALUES (?, ?, ?, ?, NULL)
		 ON CONFLICT(user_id, parade_state_date, period)
		 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
	);
	const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
	for (const period of periods) {
		if (!slotWorking(info, dept, period)) continue;
		ops.push(stmt.bind(userId, date, period, status));
	}
	if (ops.length) await env.depot_db.batch(ops);
}

// Revert the optimistic parade state on reject/cancel — only clears entries
// still set to this sick status, so it won't clobber a status the user changed.
async function clearParadeForSick(env: Env, userId: number, date: string, status: string): Promise<void> {
	await env.depot_db
		.prepare(`DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date = ? AND parade_status = ?`)
		.bind(userId, date, status)
		.run();
}

interface OpenCase {
	id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	sick_date: string | null;
	reason: string | null;
	approved_at: string | null;
	updated_status: string | null;
	updated_at: string | null;
	num_of_mc_days: number | null;
	mc_start_date: string | null;
	mc_end_date: string | null;
	location: string | null;
	approx_time: string | null;
	mc_file_id: string | null;
	created_at: string;
}

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function handleSick(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/sick'.length);

	if (request.method === 'GET' && sub === '/my-open') {
		const row = await env.depot_db
			.prepare(
				`SELECT id, case_type, reportsick_status, sick_date, reason, approved_at, updated_status, updated_at,
				        num_of_mc_days, mc_start_date, mc_end_date, location, approx_time, mc_file_id, created_at
				 FROM sick_cases
				 WHERE user_id = ? AND reportsick_status IN ('pending_superior','approved','updated','flagged')
				 ORDER BY id DESC LIMIT 1`,
			)
			.bind(user.id)
			.first<OpenCase>();
		return json(row ?? null);
	}

	if (request.method === 'POST' && sub === '/report') {
		const body = (await request.json()) as { case_type?: string; sick_date?: string; reason?: string };
		if (body.case_type !== 'RSI' && body.case_type !== 'RSO') {
			return json({ error: 'bad_case_type' }, { status: 400 });
		}
		// Which day this RSI/RSO is for — today or tomorrow only (default today).
		const today = sgtToday();
		const tomorrow = sgtDateAddDays(today, 1);
		const sickDate = isValidDate(body.sick_date) && (body.sick_date === today || body.sick_date === tomorrow) ? body.sick_date : today;
		// Reason / symptoms — compulsory; shown to the approver in the inbox + recent.
		const reason = body.reason?.trim() || null;
		if (!reason) return json({ error: 'reason_required' }, { status: 400 });

		const open = await env.depot_db
			.prepare(
				`SELECT id FROM sick_cases
				 WHERE user_id = ? AND reportsick_status IN ('pending_superior','approved','updated','flagged')`,
			)
			.bind(user.id)
			.first<{ id: number }>();
		if (open) return json({ error: 'already_open', id: open.id }, { status: 409 });

		// Self-managed users and appointment-holders skip the approval step: the
		// case is logged as approved immediately, no DM, no reminders.
		if (autoApprovesOwn(user)) {
			const ins = await env.depot_db
				.prepare(
					`INSERT INTO sick_cases (user_id, case_type, reportsick_status, superior_user_id, approved_at, sick_date, reason)
					 VALUES (?, ?, 'approved', ?, datetime('now'), ?, ?)
					 RETURNING id`,
				)
				.bind(user.id, body.case_type, user.id, sickDate, reason)
				.first<{ id: number }>();
			if (!ins) return json({ error: 'insert_failed' }, { status: 500 });
			await setParadeForSick(env, user.id, user.department, sickDate, body.case_type);
			return json({ ok: true, id: ins.id, auto_approved: true, sick_date: sickDate });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO sick_cases (user_id, case_type, reportsick_status, sick_date, reason)
				 VALUES (?, ?, 'pending_superior', ?, ?)
				 RETURNING id`,
			)
			.bind(user.id, body.case_type, sickDate, reason)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Optimistically reflect it on the parade calendar right away (pending).
		await setParadeForSick(env, user.id, user.department, sickDate, body.case_type);

		// Per-request DM with inline Approve/Reject to EACH superior; store all
		// (chat,msg) pairs so a decision edits every copy.
		const approverTids = await approverTidsFor(env, user);
		const msgPairs: MsgPair[] = [];
		for (const tid of approverTids) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🟡 <b>${body.case_type}</b> request from ${user.full_name}${reason ? `\nReason: ${reason}` : ''}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `sick:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `sick:reject:${ins.id}` },
						],
					],
				},
			});
			if (msg?.message_id) msgPairs.push([tid, String(msg.message_id)]);
		}
		if (msgPairs.length) {
			await env.depot_db.prepare('UPDATE sick_cases SET approval_message_id = ? WHERE id = ?').bind(packApprovalMsgs(msgPairs), ins.id).run();
		}
		return json({ ok: true, id: ins.id, sick_date: sickDate });
	}

	if (request.method === 'POST' && sub === '/update') {
		const body = (await request.json()) as {
			id?: number;
			num_of_mc_days?: number;
			mc_start_date?: string | null;
			mc_end_date?: string | null;
			location?: string | null;
			approx_time?: string | null;
		};
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		if (typeof body.num_of_mc_days !== 'number' || body.num_of_mc_days < 0) {
			return json({ error: 'invalid_mc_days' }, { status: 400 });
		}
		if (body.num_of_mc_days >= 1) {
			if (!isValidDate(body.mc_start_date) || !isValidDate(body.mc_end_date)) {
				return json({ error: 'mc_dates_required' }, { status: 400 });
			}
			if (body.mc_start_date > body.mc_end_date) {
				return json({ error: 'bad_mc_range' }, { status: 400 });
			}
		}

		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.superior_user_id,
				        sup.telegram_id AS superior_tid, u.department AS requester_dept
				 FROM sick_cases s
				 JOIN users u ON u.id = s.user_id
				 LEFT JOIN users sup ON sup.id = s.superior_user_id
				 WHERE s.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				case_type: string;
				reportsick_status: string;
				superior_user_id: number | null;
				superior_tid: string | null;
				requester_dept: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_case' }, { status: 403 });
		if (row.reportsick_status !== 'approved' && row.reportsick_status !== 'flagged') {
			return json({ error: 'bad_state', state: row.reportsick_status }, { status: 409 });
		}

		const startDate = body.num_of_mc_days >= 1 ? body.mc_start_date : null;
		const endDate = body.num_of_mc_days >= 1 ? body.mc_end_date : null;
		const location = body.location?.trim() || null;
		const approxTime = body.approx_time?.trim() || null;
		const extra = [location ? `loc: ${location}` : null, approxTime ? `time: ${approxTime}` : null]
			.filter(Boolean)
			.join(' · ');
		const updatedStatusSummary =
			body.num_of_mc_days >= 1
				? `${body.num_of_mc_days} day(s) MC (${startDate} → ${endDate})${extra ? ` · ${extra}` : ''}`
				: `No MC${extra ? ` · ${extra}` : ''}`;

		await env.depot_db
			.prepare(
				`UPDATE sick_cases SET
				   reportsick_status = 'updated',
				   updated_status = ?,
				   updated_at = datetime('now'),
				   num_of_mc_days = ?,
				   mc_start_date = ?,
				   mc_end_date = ?,
				   location = ?,
				   approx_time = ?
				 WHERE id = ?`,
			)
			.bind(updatedStatusSummary, body.num_of_mc_days, startDate, endDate, location, approxTime, row.id)
			.run();

		await env.depot_db
			.prepare(
				`DELETE FROM reminders
				 WHERE related_type = 'sick_case' AND related_id = ? AND sent_at IS NULL`,
			)
			.bind(row.id)
			.run();

		// Auto-fill the parade calendar with MC across the MC date range (working
		// days only, capped to the calendar window, keeping the reported RSI/RSO
		// half-day cell). Tell the user which dates the bot updated.
		let mcDates: string[] = [];
		if (body.num_of_mc_days >= 1 && startDate && endDate) {
			mcDates = await setParadeForMc(env, row.user_id, row.requester_dept, startDate, endDate);
		}

		if (row.superior_tid) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.superior_tid,
				text: `✅ ${user.full_name} updated their ${row.case_type}: ${updatedStatusSummary}`,
			});
		}
		return json({ ok: true, mc_dates: mcDates });
	}

	// Requester cancels/undoes their OWN sick case in one step. Normally only a
	// still-pending case is cancellable; but an appointment-holder / self-managed
	// user (who auto-approves their own requests) may also one-step-undo their own
	// already-approved RSI/RSO — there's no separate superior to ask.
	if (request.method === 'POST' && sub === '/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(`SELECT id, user_id, case_type, reportsick_status, sick_date FROM sick_cases WHERE id = ?`)
			.bind(body.id)
			.first<{ id: number; user_id: number; case_type: string; reportsick_status: string; sick_date: string | null }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_case' }, { status: 403 });
		const isPending = row.reportsick_status === 'pending_superior';
		const selfUndo = autoApprovesOwn(user) && ['approved', 'updated', 'flagged'].includes(row.reportsick_status);
		if (!isPending && !selfUndo) {
			return json({ error: 'not_cancellable', state: row.reportsick_status }, { status: 409 });
		}

		await env.depot_db
			.prepare(
				`UPDATE sick_cases SET reportsick_status = 'cancelled',
				   cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?`,
			)
			.bind(user.id, body.id)
			.run();
		// Roll back the optimistic parade entry for that day + clear any reminders.
		if (row.sick_date) await clearParadeForSick(env, user.id, row.sick_date, row.case_type);
		await env.depot_db
			.prepare(`DELETE FROM reminders WHERE related_type = 'sick_case' AND related_id = ? AND sent_at IS NULL`)
			.bind(body.id)
			.run();

		const approverTids = await approverTidsFor(env, user);
		await Promise.allSettled(
			approverTids.map((tid) =>
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: tid,
					text: `🚫 ${user.full_name} cancelled their ${row.case_type} request.`,
				}),
			),
		);
		return json({ ok: true });
	}

	// Revert a sick approval/update. Allowed for a superadmin (any case) or the
	// superior who approved it (any role) — so user-role superiors can undo too.
	if (request.method === 'POST' && sub === '/revert') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });

		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.superior_user_id,
				        u.telegram_id AS requester_tid, u.full_name AS requester_name,
				        u.department AS requester_dept, u.sub_department AS requester_sub,
				        sup.telegram_id AS approver_tid, sup.full_name AS approver_name
				 FROM sick_cases s
				 JOIN users u ON u.id = s.user_id
				 LEFT JOIN users sup ON sup.id = s.superior_user_id
				 WHERE s.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				case_type: string;
				reportsick_status: string;
				superior_user_id: number | null;
				requester_tid: string;
				requester_name: string;
				requester_dept: string | null;
				requester_sub: string | null;
				approver_tid: string | null;
				approver_name: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (!['approved', 'updated', 'flagged'].includes(row.reportsick_status)) {
			return json({ error: 'bad_state', state: row.reportsick_status }, { status: 409 });
		}
		const canRevert =
			user.user_role === 'superadmin' ||
			row.superior_user_id === user.id ||
			(!!user.appointment && sameUnit(user, row.requester_dept, row.requester_sub));
		if (!canRevert) return json({ error: 'not_your_approval' }, { status: 403 });

		// Reopen as pending (back to the inbox) and clear the approval fields.
		const flip = await env.depot_db
			.prepare(
				`UPDATE sick_cases SET reportsick_status = 'pending_superior',
				   superior_user_id = NULL, approved_at = NULL
				 WHERE id = ? AND reportsick_status IN ('approved','updated','flagged')`,
			)
			.bind(body.id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return json({ error: 'bad_state' }, { status: 409 });

		await env.depot_db
			.prepare(
				`DELETE FROM reminders
				 WHERE related_type = 'sick_case' AND related_id = ? AND sent_at IS NULL`,
			)
			.bind(body.id)
			.run();

		const msg = `↩ ${user.full_name} reverted your approved ${row.case_type} — it's pending approval again.`;
		const sends: Promise<unknown>[] = [
			tgSendMessage(env.BOT_TOKEN, { chat_id: row.requester_tid, text: msg }),
		];
		if (row.approver_tid && row.approver_tid !== user.telegram_id) {
			sends.push(tgSendMessage(env.BOT_TOKEN, { chat_id: row.approver_tid, text: `↩ ${row.case_type} for ${row.requester_name} reverted to pending by ${user.full_name}.` }));
		}
		await Promise.allSettled(sends);
		return json({ ok: true, reopened: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}
