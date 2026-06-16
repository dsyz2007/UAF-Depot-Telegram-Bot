// Dedicated Leave requests (LL / OL / Leave (Others)).
//
// Leave is reached ONLY by choosing a leave status in the Parade tab — the
// frontend routes that into POST /api/leave/request instead of writing the
// parade entry directly. Leave is NOT credit-tracked: the real application
// still has to be filed in OneNS (we hammer that point on approval).
//
// Flow mirrors the sick flow: the parade calendar shows the leave optimistically
// (pending) right away; on reject/cancel we roll that back.

import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { autoApprovesOwn, isLeaveStatus, periodsOverlap } from '../types';
import { approverTidsFor, sameUnit } from '../superiors';
import { getRangeWorkInfo, slotWorking } from '../holidays';

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

function rangeLabel(start: string, end: string): string {
	return start === end ? start : `${start} → ${end}`;
}

const ONENS_NOTE = '‼️ IMPORTANT: You still need to submit the actual leave application on OneNS yourself — the bot has only forwarded the request to your superior, it cannot file it on OneNS for you.';

// MA (medical appointment) rides the same approval pipeline as leave but is not
// "leave": no OneNS reminder, and worded as an appointment rather than leave.
function isMa(leaveType: string): boolean {
	return leaveType === 'MA';
}
// True for the statuses that route through this approval flow (leave + MA).
function isApprovalRouted(s: unknown): s is string {
	return typeof s === 'string' && (isLeaveStatus(s) || s === 'MA');
}
// " leave" suffix for LL/OL/Others; nothing for MA (so "full-day MA" reads right).
function leaveNoun(leaveType: string): string {
	return isMa(leaveType) ? '' : ' leave';
}
function leaveIcon(leaveType: string): string {
	return isMa(leaveType) ? '🩺' : '🏝️';
}

type LeavePeriod = 'AM' | 'PM' | 'FD';
function periodsFor(p: LeavePeriod): readonly ('AM' | 'PM')[] {
	return p === 'FD' ? (['AM', 'PM'] as const) : ([p] as const);
}
function periodTag(p: LeavePeriod): string {
	return p === 'FD' ? 'full-day' : `${p} half-day`;
}

// Optimistically paint the leave onto the parade calendar for every working
// slot of the chosen period(s) in the range, for the leave-taker's department.
export async function setParadeForLeave(
	env: Env,
	userId: number,
	dept: string | null,
	start: string,
	end: string,
	leaveType: string,
	reason: string | null,
	period: LeavePeriod,
): Promise<void> {
	const dates = expandRange(start, end);
	const info = await getRangeWorkInfo(env, dates);
	const stmt = env.depot_db.prepare(
		`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, parade_state_date, period)
		 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
	);
	const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
	for (const d of dates) {
		const di = info.get(d);
		if (!di) continue;
		for (const slot of periodsFor(period)) {
			if (!slotWorking(di, dept, slot)) continue;
			ops.push(stmt.bind(userId, d, slot, leaveType, reason));
		}
	}
	if (ops.length) await env.depot_db.batch(ops);
}

// Roll back the optimistic parade entries on reject/cancel — only clears slots
// of the chosen period(s) still set to this leave type, so it won't clobber a
// status the user changed.
async function clearParadeForLeave(
	env: Env,
	userId: number,
	start: string,
	end: string,
	leaveType: string,
	period: LeavePeriod,
): Promise<void> {
	const periodClause = period === 'FD' ? '' : ' AND period = ?';
	const binds: (string | number)[] = [userId, start, end, leaveType];
	if (period !== 'FD') binds.push(period);
	await env.depot_db
		.prepare(
			`DELETE FROM parade_state_entries
			 WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = ?${periodClause}`,
		)
		.bind(...binds)
		.run();
}

interface LeaveRow {
	id: number;
	leave_type: string;
	startdate: string;
	enddate: string;
	reason: string | null;
	status: string;
	approved_by_name: string | null;
	approved_at: string | null;
	created_at: string;
}

export async function handleLeave(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/leave'.length);

	// The caller's recent leave requests (latest first).
	if (request.method === 'GET' && sub === '/mine') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT l.id, l.leave_type, l.startdate, l.enddate, l.reason, l.status, l.approved_at, l.created_at,
				        a.full_name AS approved_by_name
				 FROM leave_requests l
				 LEFT JOIN users a ON a.id = l.approved_by
				 WHERE l.user_id = ?
				 ORDER BY l.id DESC LIMIT 20`,
			)
			.bind(user.id)
			.all<LeaveRow>();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/request') {
		const body = (await request.json()) as { leave_type?: string; startdate?: string; enddate?: string; reason?: string; period?: string };
		if (!isApprovalRouted(body.leave_type)) return json({ error: 'bad_leave_type' }, { status: 400 });
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) return json({ error: 'bad_dates' }, { status: 400 });
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });
		// Guard against an absurd multi-decade range (parade only paints ~95 days anyway).
		if (expandRange(body.startdate, body.enddate).length >= 95) return json({ error: 'range_too_long' }, { status: 400 });
		const reason = body.reason?.trim() || null;
		// OL (overseas), "Leave (Others)" and MA (appointment) must carry a reason;
		// LL is self-explanatory.
		if ((body.leave_type === 'OL' || body.leave_type === 'Leave (Others)' || body.leave_type === 'MA') && !reason) {
			return json({ error: 'reason_required' }, { status: 400 });
		}

		// Validated by the isLeaveStatus / isValidDate guards above.
		const leaveType = body.leave_type as string;
		const startdate = body.startdate as string;
		const enddate = body.enddate as string;
		// Leave can be a half day (AM / PM) or full day (FD, default).
		const period: LeavePeriod = body.period === 'AM' || body.period === 'PM' ? body.period : 'FD';
		const range = rangeLabel(startdate, enddate);
		const what = `${periodTag(period)} ${leaveType}`;

		// Dedup: refuse if this user already has an overlapping pending/approved
		// leave/MA for the same half/period. Stops an auto-approver from nullifying a
		// superior's revert by resubmitting (the reverted leave is back to 'pending',
		// so it blocks here) and prevents duplicate inbox entries. Rejected/cancelled
		// leave is not in this set, so a denied request can still be retried.
		const { results: dupRows } = await env.depot_db
			.prepare(
				`SELECT id, period FROM leave_requests
				 WHERE user_id = ? AND status IN ('pending','approved')
				   AND startdate <= ? AND enddate >= ?`,
			)
			.bind(user.id, enddate, startdate)
			.all<{ id: number; period: string }>();
		const clash = (dupRows ?? []).find((d) => periodsOverlap(d.period, period));
		if (clash) return json({ error: 'overlapping_request', id: clash.id }, { status: 409 });

		// Appointment-holders / self-managed auto-approve their own leave.
		if (autoApprovesOwn(user)) {
			const ins = await env.depot_db
				.prepare(
					`INSERT INTO leave_requests (user_id, leave_type, period, startdate, enddate, reason, status, approved_by, approved_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now')) RETURNING id`,
				)
				.bind(user.id, leaveType, period, startdate, enddate, reason, user.id)
				.first<{ id: number }>();
			if (!ins) return json({ error: 'insert_failed' }, { status: 500 });
			await setParadeForLeave(env, user.id, user.department, startdate, enddate, leaveType, reason, period);
			return json({ ok: true, id: ins.id, auto_approved: true });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO leave_requests (user_id, leave_type, period, startdate, enddate, reason, status)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending') RETURNING id`,
			)
			.bind(user.id, leaveType, period, startdate, enddate, reason)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Show it on the calendar straight away (pending).
		await setParadeForLeave(env, user.id, user.department, startdate, enddate, leaveType, reason, period);

		// DM the person that it's been forwarded to their superior (the webapp
		// also tells them) — and hammer the OneNS point (leave only, not MA).
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: user.telegram_id,
			text: `${leaveIcon(leaveType)} Your ${what}${leaveNoun(leaveType)} (${range}) has been forwarded to your superior for approval.${isMa(leaveType) ? '' : `\n\n${ONENS_NOTE}`}`,
		});

		// DM each approver with inline approve/reject.
		const approverTids = await approverTidsFor(env, user);
		let firstMsgId: string | undefined;
		for (const tid of approverTids) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `${leaveIcon(leaveType)} <b>${isMa(leaveType) ? 'Medical appointment (MA) request' : 'Leave request'}</b>\n${user.full_name}: ${what}\n${range}${reason ? `\nReason: ${reason}` : ''}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [[{ text: '🗂 Open Pending page', web_app: { url: `${env.WEBAPP_URL}?tab=today` } }]],
				},
			});
			if (msg?.message_id && firstMsgId === undefined) firstMsgId = String(msg.message_id);
		}
		if (firstMsgId) {
			await env.depot_db.prepare('UPDATE leave_requests SET superior_message_id = ? WHERE id = ?').bind(firstMsgId, ins.id).run();
		}
		return json({ ok: true, id: ins.id });
	}

	// Requester cancels their own pending leave — or one-step-undoes their own
	// already-approved leave when they auto-approve (appointment-holder / self).
	if (request.method === 'POST' && sub === '/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(`SELECT id, user_id, leave_type, period, startdate, enddate, status FROM leave_requests WHERE id = ?`)
			.bind(body.id)
			.first<{ id: number; user_id: number; leave_type: string; period: LeavePeriod; startdate: string; enddate: string; status: string }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_request' }, { status: 403 });
		const isPending = row.status === 'pending';
		const selfUndo = autoApprovesOwn(user) && row.status === 'approved';
		if (!isPending && !selfUndo) return json({ error: 'not_cancellable', state: row.status }, { status: 409 });

		await env.depot_db
			.prepare(`UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?`)
			.bind(user.id, body.id)
			.run();
		await clearParadeForLeave(env, row.user_id, row.startdate, row.enddate, row.leave_type, row.period);

		const approverTids = await approverTidsFor(env, user);
		await Promise.allSettled(
			approverTids.map((tid) =>
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: tid,
					text: `🚫 ${user.full_name} cancelled their ${row.leave_type}${leaveNoun(row.leave_type)} request (${rangeLabel(row.startdate, row.enddate)}).`,
				}),
			),
		);
		return json({ ok: true });
	}

	// Revert an approved leave: superadmin (any), the original approver, or a
	// same-department appointment-holder. Reopens it as pending.
	if (request.method === 'POST' && sub === '/revert') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT l.id, l.user_id, l.leave_type, l.startdate, l.enddate, l.status, l.approved_by,
				        u.telegram_id AS requester_tid, u.full_name AS requester_name,
				        u.department AS requester_dept, u.sub_department AS requester_sub,
				        a.telegram_id AS approver_tid
				 FROM leave_requests l
				 JOIN users u ON u.id = l.user_id
				 LEFT JOIN users a ON a.id = l.approved_by
				 WHERE l.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				leave_type: string;
				startdate: string;
				enddate: string;
				status: string;
				approved_by: number | null;
				requester_tid: string;
				requester_name: string;
				requester_dept: string | null;
				requester_sub: string | null;
				approver_tid: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.status !== 'approved') return json({ error: 'not_approved' }, { status: 409 });
		const canRevert =
			user.user_role === 'superadmin' ||
			row.approved_by === user.id ||
			(!!user.appointment && sameUnit(user, row.requester_dept, row.requester_sub));
		if (!canRevert) return json({ error: 'not_your_approval' }, { status: 403 });

		const flip = await env.depot_db
			.prepare(`UPDATE leave_requests SET status = 'pending', approved_by = NULL, approved_at = NULL WHERE id = ? AND status = 'approved'`)
			.bind(body.id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return json({ error: 'not_approved' }, { status: 409 });
		const msg = `↩ ${user.full_name} reverted your approved ${row.leave_type}${leaveNoun(row.leave_type)} (${rangeLabel(row.startdate, row.enddate)}) — it's pending approval again.`;
		const sends: Promise<unknown>[] = [tgSendMessage(env.BOT_TOKEN, { chat_id: row.requester_tid, text: msg })];
		if (row.approver_tid && row.approver_tid !== user.telegram_id) {
			sends.push(
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: row.approver_tid,
					text: `↩ ${row.leave_type}${leaveNoun(row.leave_type)} for ${row.requester_name} reverted to pending by ${user.full_name}.`,
				}),
			);
		}
		await Promise.allSettled(sends);
		return json({ ok: true, reopened: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}

// Shared approval/reject logic used by both the inbox (applyAction) and the
// inline Telegram buttons. Returns false if not pending / not found.
export async function approveLeave(
	env: Env,
	approver: { id: number; full_name: string; telegram_id: string },
	id: number,
	action: 'approve' | 'reject',
): Promise<{ ok: boolean; requester_tid?: string; leave_type?: string; range?: string }> {
	const row = await env.depot_db
		.prepare(
			`SELECT l.id, l.user_id, l.leave_type, l.period, l.startdate, l.enddate, l.reason, l.status,
			        u.telegram_id AS requester_tid, u.department AS requester_dept
			 FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.id = ?`,
		)
		.bind(id)
		.first<{ id: number; user_id: number; leave_type: string; period: LeavePeriod; startdate: string; enddate: string; reason: string | null; status: string; requester_tid: string; requester_dept: string | null }>();
	if (!row || row.status !== 'pending') return { ok: false };
	const range = rangeLabel(row.startdate, row.enddate);
	const what = `${periodTag(row.period)} ${row.leave_type}`;
	const noun = leaveNoun(row.leave_type);

	if (action === 'reject') {
		// Atomic flip so concurrent inbox + chat actions can't both fire.
		const flip = await env.depot_db
			.prepare(`UPDATE leave_requests SET status = 'rejected', rejected_by = ?, rejected_at = datetime('now') WHERE id = ? AND status = 'pending'`)
			.bind(approver.id, id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return { ok: false };
		// Sync the calendar: blank the leave slots for the range (only those still
		// set to this leave type, so it won't clobber a status the user changed).
		await clearParadeForLeave(env, row.user_id, row.startdate, row.enddate, row.leave_type, row.period);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `❌ Your ${what}${noun} (${range}) was rejected by ${approver.full_name}.\nYour parade status for ${range} is now blank (unfilled).`,
		});
		return { ok: true, requester_tid: row.requester_tid, leave_type: row.leave_type, range };
	}

	const flipA = await env.depot_db
		.prepare(`UPDATE leave_requests SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ? AND status = 'pending'`)
		.bind(approver.id, id)
		.run();
	if ((flipA.meta.changes ?? 0) === 0) return { ok: false };
	// Sync the calendar to the approved status — re-assert the leave on every
	// working slot of the range (idempotent upsert; repairs the cell if the user
	// changed it between request and approval).
	await setParadeForLeave(env, row.user_id, row.requester_dept, row.startdate, row.enddate, row.leave_type, row.reason, row.period);
	await tgSendMessage(env.BOT_TOKEN, {
		chat_id: row.requester_tid,
		text: `✅ Your ${what}${noun} (${range}) was approved by ${approver.full_name}.${isMa(row.leave_type) ? '' : `\n\n${ONENS_NOTE}`}`,
	});
	return { ok: true, requester_tid: row.requester_tid, leave_type: row.leave_type, range };
}
