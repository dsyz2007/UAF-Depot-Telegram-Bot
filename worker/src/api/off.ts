import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { dayCountInclusive, autoApprovesOwn } from '../types';
import { approverTidsFor, sameUnit } from '../superiors';

interface SummaryRow {
	id: number;
	full_name: string;
	off_credits: number;
	department: string | null;
	sub_department: string | null;
	personnel_type: string | null;
	user_role: string;
}

interface DetailRow {
	id: number;
	startdate: string;
	enddate: string;
	period: string;
	reason: string;
	approved_date: string | null;
	approved_by_id: number | null;
	approved_by_name: string | null;
	off_status: string;
}

interface MyOffRow extends DetailRow {
	requester_id: number;
}

interface GrantRow {
	id: number;
	user_id: number;
	num_days: number;
	reason: string;
	status: string;
	granted_by_name: string | null;
	created_at: string;
	approved_at: string | null;
}

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
}

// Credit-days for an off request: a half-day (AM/PM) costs 0.5 per day in the
// range, a full day (FD) costs 1.
function offDays(start: string, end: string, period: string): number {
	const d = dayCountInclusive(start, end);
	return period === 'AM' || period === 'PM' ? d * 0.5 : d;
}
function periodSuffix(period: string): string {
	return period === 'AM' || period === 'PM' ? ` (${period} only)` : '';
}

export async function handleOff(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/off'.length);

	// -------- read ---------------------------------------------------------
	if (request.method === 'GET' && sub === '/summary') {
		// Just users + credit balance + department. We no longer surface
		// "taken X" so the JOIN with off_requests is removed — saves reads.
		const { results } = await env.depot_db
			.prepare(
				`SELECT id, full_name, off_credits, department, sub_department, personnel_type, user_role
				 FROM users
				 WHERE full_name NOT LIKE 'PENDING:%'
				 ORDER BY full_name`,
			)
			.all<SummaryRow>();
		return json(results ?? []);
	}

	if (request.method === 'GET' && sub === '/user') {
		const id = Number(url.searchParams.get('id'));
		if (!Number.isInteger(id)) return json({ error: 'bad_id' }, { status: 400 });
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.id, o.startdate, o.enddate, o.period, o.reason, o.approved_date, o.off_status,
				        a.id AS approved_by_id, a.full_name AS approved_by_name
				 FROM off_requests o
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.user_id = ? AND o.off_status = 'approved'
				 ORDER BY o.startdate DESC`,
			)
			.bind(id)
			.all<DetailRow>();
		return json(results ?? []);
	}

	if (request.method === 'GET' && sub === '/mine') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.id, o.startdate, o.enddate, o.period, o.reason, o.off_status,
				        o.approved_date, o.requested_by_user_id AS requester_id,
				        a.id AS approved_by_id, a.full_name AS approved_by_name
				 FROM off_requests o
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.user_id = ?
				 ORDER BY o.startdate DESC LIMIT 50`,
			)
			.bind(user.id)
			.all<MyOffRow>();
		return json(results ?? []);
	}

	// My credit grants (pending + recent history)
	if (request.method === 'GET' && sub === '/grants/mine') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status,
				        g.created_at, g.approved_at,
				        gr.full_name AS granted_by_name
				 FROM off_credit_grants g
				 LEFT JOIN users gr ON gr.id = g.granted_by
				 WHERE g.user_id = ?
				 ORDER BY g.id DESC LIMIT 30`,
			)
			.bind(user.id)
			.all<GrantRow>();
		return json(results ?? []);
	}

	// -------- request off (uses credits) -----------------------------------
	if (request.method === 'POST' && sub === '/request') {
		const body = (await request.json()) as { startdate?: string; enddate?: string; reason?: string; period?: string };
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate) || !body.reason?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });
		// Guard against a fat-fingered year deducting thousands of credits.
		if (dayCountInclusive(body.startdate, body.enddate) > 95) return json({ error: 'range_too_long' }, { status: 400 });

		// Half-day (AM/PM) costs 0.5 credits per day; full day (FD) costs 1.
		const period = body.period === 'AM' || body.period === 'PM' ? body.period : 'FD';
		const days = offDays(body.startdate, body.enddate, period);
		const range = `${body.startdate} → ${body.enddate}`;
		// Off-credit balance is allowed to go negative — no sufficiency block.

		// Self-managed users and appointment-holders skip approval — the off is
		// recorded as approved immediately and credits deducted.
		if (autoApprovesOwn(user)) {
			await env.depot_db.batch([
				env.depot_db
					.prepare(
						`INSERT INTO off_requests
						   (user_id, requested_by_user_id, startdate, enddate, period, reason, off_status, approved_by, approved_date)
						 VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'))`,
					)
					.bind(user.id, user.id, body.startdate, body.enddate, period, body.reason.trim(), user.id),
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(days, user.id),
			]);
			return json({ ok: true, auto_approved: true, days_requested: days, balance_after: user.off_credits - days });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO off_requests
				   (user_id, requested_by_user_id, startdate, enddate, period, reason, off_status)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending')
				 RETURNING id`,
			)
			.bind(user.id, user.id, body.startdate, body.enddate, period, body.reason.trim())
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Reserve the credits NOW (at request time), not on approval — so a user
		// can't queue several pending requests that together exceed their balance.
		// Refunded if the request is rejected or cancelled.
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(days, user.id).run();

		// Per-request DM with inline buttons — sent to EACH of the user's
		// superiors (either may approve). The inbox sync edits the primary
		// superior's stored message; the others are idempotent if tapped later.
		const approverTids = await approverTidsFor(env, user);
		let firstMsgId: string | undefined;
		for (const tid of approverTids) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🟡 <b>Off request</b>\n${user.full_name}: ${range} (${days} day${days === 1 ? '' : 's'})${periodSuffix(period)}\nBalance (credits already reserved): ${user.off_credits - days}\nReason: ${body.reason}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `off:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `off:reject:${ins.id}` },
						],
						[{ text: '📅 Open Off page', web_app: { url: `${env.WEBAPP_URL}?tab=off` } }],
					],
				},
			});
			if (msg?.message_id && firstMsgId === undefined) firstMsgId = String(msg.message_id);
		}
		if (firstMsgId) {
			await env.depot_db
				.prepare('UPDATE off_requests SET superior_message_id = ? WHERE id = ?')
				.bind(firstMsgId, ins.id)
				.run();
		}
		return json({ ok: true, id: ins.id, days_requested: days, balance_after: user.off_credits - days });
	}

	// -------- credit offs (self or admin→staff, needs superior approval) --
	if (request.method === 'POST' && sub === '/grant') {
		const body = (await request.json()) as {
			staff_id?: number | string;
			num_days?: number | string;
			reason?: string;
		};
		// Coerce robustly: num_days / staff_id may arrive as a number OR a numeric
		// string (older cached bundles, locale quirks). Fractional credits are
		// allowed (e.g. 3.5 for half-days) — rounded to 1 decimal place. Precise
		// errors so failures are diagnosable instead of a generic invalid_body.
		const sid = Number(body.staff_id);
		const targetId = Number.isInteger(sid) && sid > 0 ? sid : user.id;
		const rawDays = Number(body.num_days);
		const days = Number.isFinite(rawDays) ? Math.round(rawDays * 10) / 10 : NaN;
		const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
		if (!Number.isFinite(days) || days <= 0) {
			return json({ error: 'invalid_num_days', got: body.num_days ?? null }, { status: 400 });
		}
		if (!reason) return json({ error: 'reason_required' }, { status: 400 });

		const isSelf = targetId === user.id;

		const staff = await env.depot_db
			.prepare('SELECT id, telegram_id, full_name, department, sub_department, self_managed, appointment FROM users WHERE id = ?')
			.bind(targetId)
			.first<{
				id: number;
				telegram_id: string;
				full_name: string;
				department: string | null;
				sub_department: string | null;
				self_managed: number;
				appointment: string | null;
			}>();
		if (!staff) return json({ error: 'staff_not_found' }, { status: 404 });

		// Immediate (no approval) ONLY when the GRANTER holds an appointment AND is
		// self-managed AND the recipient is in the granter's own department (incl
		// themselves). Everyone else's credit — including a superadmin/admin
		// crediting another person — is a proposal routed for approval.
		const granterAutoCredit = !!user.appointment && !!user.self_managed && sameUnit(user, staff.department, staff.sub_department);

		// Who may credit ANOTHER person: admins/superadmins (any department,
		// subject to approval), or an appointment+self granter within their own
		// department. Anyone may propose a self-credit.
		if (!isSelf && !isAdminish(user.user_role) && !granterAutoCredit) {
			return json({ error: 'forbidden' }, { status: 403 });
		}

		if (granterAutoCredit) {
			// The appointment+self granter self-approves their own-department credit.
			await env.depot_db.batch([
				env.depot_db
					.prepare(
						`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status, superior_user_id, approved_at)
						 VALUES (?, ?, ?, ?, 'approved', ?, datetime('now'))`,
					)
					.bind(staff.id, user.id, days, reason, user.id),
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, staff.id),
			]);
			const bal = await env.depot_db
				.prepare(`SELECT off_credits FROM users WHERE id = ?`)
				.bind(staff.id)
				.first<{ off_credits: number }>();
			if (staff.telegram_id !== user.telegram_id) {
				await tgSendMessage(env.BOT_TOKEN, {
					chat_id: staff.telegram_id,
					text: `🪙 ${user.full_name} credited you +${days} off day(s). Balance: ${bal?.off_credits ?? '?'}.`,
				});
			}
			return json({ ok: true, auto_approved: true, balance: bal?.off_credits, recipient_name: staff.full_name });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status)
				 VALUES (?, ?, ?, ?, 'pending_superior')
				 RETURNING id`,
			)
			.bind(staff.id, user.id, days, reason)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Per-request DM with inline buttons to EACH of the recipient's superiors.
		const approverTids = await approverTidsFor(env, staff);
		const whoLine = isSelf ? `${staff.full_name} (self-credit)` : `${user.full_name} → ${staff.full_name}`;
		let firstMsgId: string | undefined;
		for (const tid of approverTids) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🪙 <b>Off-credit request</b>\n${whoLine}: ${days} day(s)\nReason: ${reason}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `grant:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `grant:reject:${ins.id}` },
						],
					],
				},
			});
			if (msg?.message_id && firstMsgId === undefined) firstMsgId = String(msg.message_id);
		}
		if (firstMsgId) {
			await env.depot_db
				.prepare('UPDATE off_credit_grants SET approval_message_id = ? WHERE id = ?')
				.bind(firstMsgId, ins.id)
				.run();
		}
		// Notify the recipient ONLY when they didn't initiate it themselves and
		// they aren't one of the approvers (avoids duplicate messages to a person).
		if (staff.telegram_id !== user.telegram_id && !approverTids.includes(staff.telegram_id)) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: staff.telegram_id,
				text: `🪙 ${user.full_name} proposed crediting you ${days} off day(s) — pending superior approval. Reason: ${reason}`,
			});
		}

		return json({ ok: true, id: ins.id, recipient_name: staff.full_name });
	}

	// -------- cancel own pending request ---------------------------------
	if (request.method === 'POST' && sub === '/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT id, user_id, off_status, startdate, enddate, period FROM off_requests WHERE id = ?`,
			)
			.bind(body.id)
			.first<{ id: number; user_id: number; off_status: string; startdate: string; enddate: string; period: string }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_request' }, { status: 403 });
		if (row.off_status !== 'pending') return json({ error: 'not_pending' }, { status: 409 });

		// Refund the credits reserved at request time (matching the half/full-day rate).
		const refundDays = offDays(row.startdate, row.enddate, row.period);
		// Atomic flip so a cancel racing with a reject can't double-refund.
		const flip = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ? AND off_status = 'pending'`)
			.bind(user.id, body.id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return json({ error: 'not_pending' }, { status: 409 });
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(refundDays, row.user_id).run();

		const approverTids = await approverTidsFor(env, user);
		await Promise.allSettled(
			approverTids.map((tid) =>
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: tid,
					text: `🚫 ${user.full_name} cancelled their off request (${row.startdate} → ${row.enddate}).`,
				}),
			),
		);
		return json({ ok: true });
	}

	// -------- revert an approved off (refund credits) --------------------
	// Allowed for a superadmin (any) or the superior who approved it (any role).
	if (request.method === 'POST' && sub === '/revert') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.approved_by,
				        u.telegram_id AS requester_tid, u.full_name AS requester_name,
				        u.department AS requester_dept, u.sub_department AS requester_sub,
				        a.telegram_id AS approver_tid, a.full_name AS approver_name
				 FROM off_requests o
				 JOIN users u ON u.id = o.user_id
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				off_status: string;
				startdate: string;
				enddate: string;
				approved_by: number | null;
				requester_tid: string;
				requester_name: string;
				requester_dept: string | null;
				requester_sub: string | null;
				approver_tid: string | null;
				approver_name: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.off_status !== 'approved') return json({ error: 'not_approved' }, { status: 409 });
		// Superadmin (any), the original approver, or a same-department
		// appointment-holder may revert.
		const canRevert =
			user.user_role === 'superadmin' ||
			row.approved_by === user.id ||
			(!!user.appointment && sameUnit(user, row.requester_dept, row.requester_sub));
		if (!canRevert) return json({ error: 'not_your_approval' }, { status: 403 });

		// Reopen as pending (back to the inbox). Credits were reserved at request
		// time and stay reserved while pending — no refund here (they're only
		// returned on reject/cancel).
		const flipRevert = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'pending', approved_by = NULL, approved_date = NULL WHERE id = ? AND off_status = 'approved'`)
			.bind(body.id)
			.run();
		if ((flipRevert.meta.changes ?? 0) === 0) return json({ error: 'not_approved' }, { status: 409 });

		const msg = `↩ ${user.full_name} reverted your approved off (${row.startdate} → ${row.enddate}) — it's pending approval again.`;
		const sends: Promise<unknown>[] = [tgSendMessage(env.BOT_TOKEN, { chat_id: row.requester_tid, text: msg })];
		if (row.approver_tid && row.approver_tid !== user.telegram_id) {
			sends.push(tgSendMessage(env.BOT_TOKEN, { chat_id: row.approver_tid, text: `↩ Off for ${row.requester_name} (${row.startdate} → ${row.enddate}) reverted to pending by ${user.full_name}.` }));
		}
		await Promise.allSettled(sends);
		return json({ ok: true, reopened: true });
	}

	// -------- revert an APPROVED off-credit grant (claw back credits) ------
	// Allowed for a superadmin (any) or the superior who approved it.
	if (request.method === 'POST' && sub === '/grant/revert') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.status, g.superior_user_id,
				        u.telegram_id AS staff_tid, u.full_name AS staff_name,
				        u.department AS staff_dept, u.sub_department AS staff_sub,
				        gr.telegram_id AS granter_tid
				 FROM off_credit_grants g
				 JOIN users u ON u.id = g.user_id
				 LEFT JOIN users gr ON gr.id = g.granted_by
				 WHERE g.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				num_days: number;
				status: string;
				superior_user_id: number | null;
				staff_tid: string;
				staff_name: string;
				staff_dept: string | null;
				staff_sub: string | null;
				granter_tid: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.status !== 'approved') return json({ error: 'not_approved' }, { status: 409 });
		const canRevertGrant =
			user.user_role === 'superadmin' ||
			row.superior_user_id === user.id ||
			(!!user.appointment && sameUnit(user, row.staff_dept, row.staff_sub));
		if (!canRevertGrant) return json({ error: 'not_your_approval' }, { status: 403 });
		// Reopen as pending (back to the inbox) and claw the credits back — atomic
		// flip so a double-revert can't claw twice.
		const flipClaw = await env.depot_db
			.prepare(`UPDATE off_credit_grants SET status='pending_superior', superior_user_id=NULL, approved_at=NULL WHERE id=? AND status='approved'`)
			.bind(body.id)
			.run();
		if ((flipClaw.meta.changes ?? 0) === 0) return json({ error: 'not_approved' }, { status: 409 });
		// Plain subtraction (negative balances are allowed) so the clawback
		// exactly mirrors the unclamped grant-add — keeps approve/revert reversible.
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(row.num_days, row.user_id).run();
		const msg = `↩ Off-credit reverted by ${user.full_name}: −${row.num_days} day(s) from ${row.staff_name} (pending approval again).`;
		const sent = new Set<string>([user.telegram_id]);
		const notify = (tid: string | null) =>
			!tid || sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text: msg }));
		await Promise.allSettled([notify(row.staff_tid), notify(row.granter_tid)]);
		return json({ ok: true, days_clawed: row.num_days });
	}

	if (request.method === 'GET' && sub === '/staff') {
		// Admins & superadmins may credit anyone. Include role + personnel type so
		// the client can sort by the same tiebreaks as the Parade panel.
		if (user.user_role === 'admin' || user.user_role === 'superadmin') {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id, full_name, off_credits, department, user_role, personnel_type
					 FROM users WHERE full_name NOT LIKE 'PENDING:%' ORDER BY full_name`,
				)
				.all<{ id: number; full_name: string; off_credits: number; department: string | null; user_role: string; personnel_type: string | null }>();
			return json(results ?? []);
		}
		// An appointment+self granter may credit their OWN department's members.
		if (user.appointment && user.self_managed) {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id, full_name, off_credits, department, user_role, personnel_type
					 FROM users
					 WHERE full_name NOT LIKE 'PENDING:%'
					   AND department = ? AND IFNULL(sub_department,'') = IFNULL(?, '')
					 ORDER BY full_name`,
				)
				.bind(user.department, user.sub_department ?? null)
				.all<{ id: number; full_name: string; off_credits: number; department: string | null; user_role: string; personnel_type: string | null }>();
			return json(results ?? []);
		}
		return json([]);
	}

	return json({ error: 'not_found' }, { status: 404 });
}
