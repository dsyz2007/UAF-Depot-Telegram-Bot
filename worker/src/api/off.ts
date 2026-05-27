import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { dayCountInclusive } from '../types';

interface SummaryRow {
	id: number;
	full_name: string;
	off_count: number;
	off_credits: number;
	department: string | null;
}

interface DetailRow {
	id: number;
	startdate: string;
	enddate: string;
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

export async function handleOff(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/off'.length);

	// -------- read ---------------------------------------------------------
	if (request.method === 'GET' && sub === '/summary') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.full_name, u.off_credits, u.department,
				   (SELECT COUNT(*) FROM off_requests o
				      WHERE o.user_id = u.id AND o.off_status = 'approved') AS off_count
				 FROM users u
				 WHERE u.full_name NOT LIKE 'PENDING:%'
				 ORDER BY u.full_name`,
			)
			.all<SummaryRow>();
		return json(results ?? []);
	}

	if (request.method === 'GET' && sub === '/user') {
		const id = Number(url.searchParams.get('id'));
		if (!Number.isInteger(id)) return json({ error: 'bad_id' }, { status: 400 });
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.id, o.startdate, o.enddate, o.reason, o.approved_date, o.off_status,
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
				`SELECT o.id, o.startdate, o.enddate, o.reason, o.off_status,
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
		const body = (await request.json()) as { startdate?: string; enddate?: string; reason?: string };
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate) || !body.reason?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });

		const days = dayCountInclusive(body.startdate, body.enddate);
		if (user.off_credits < days) {
			return json(
				{
					error: 'insufficient_credits',
					required: days,
					balance: user.off_credits,
					message: `You need ${days} off credit(s) but only have ${user.off_credits}. Ask an admin to grant you more credits first.`,
				},
				{ status: 409 },
			);
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO off_requests
				   (user_id, requested_by_user_id, startdate, enddate, reason, off_status)
				 VALUES (?, ?, ?, ?, ?, 'pending')
				 RETURNING id`,
			)
			.bind(user.id, user.id, body.startdate, body.enddate, body.reason.trim())
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		const superiorTid = await resolveSuperiorTid(env, user.superior_telegram_id);
		if (superiorTid) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: superiorTid,
				text: `🟡 <b>Off request</b>\n${user.full_name}: ${body.startdate} → ${body.enddate} (${days} day${days === 1 ? '' : 's'})\nBalance after approval: ${user.off_credits - days}\nReason: ${body.reason}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `off:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `off:reject:${ins.id}` },
						],
					],
				},
			});
			if (msg?.message_id) {
				await env.depot_db
					.prepare('UPDATE off_requests SET superior_message_id = ? WHERE id = ?')
					.bind(String(msg.message_id), ins.id)
					.run();
			}
		}
		return json({ ok: true, id: ins.id, days_requested: days, balance_after_approval: user.off_credits - days });
	}

	// -------- grant credits (admin → user, needs superior approval) -------
	if (request.method === 'POST' && sub === '/grant') {
		if (!isAdminish(user.user_role)) {
			return json({ error: 'forbidden' }, { status: 403 });
		}
		const body = (await request.json()) as {
			staff_id?: number;
			num_days?: number;
			reason?: string;
		};
		if (!Number.isInteger(body.staff_id) || !Number.isInteger(body.num_days) || body.num_days! <= 0 || !body.reason?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		const staff = await env.depot_db
			.prepare('SELECT id, telegram_id, full_name, superior_telegram_id FROM users WHERE id = ?')
			.bind(body.staff_id)
			.first<{ id: number; telegram_id: string; full_name: string; superior_telegram_id: string | null }>();
		if (!staff) return json({ error: 'staff_not_found' }, { status: 404 });
		// Admins can grant only to their direct reports; superadmins to anyone.
		if (user.user_role === 'admin' && staff.superior_telegram_id !== user.telegram_id) {
			return json({ error: 'not_your_staff' }, { status: 403 });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status)
				 VALUES (?, ?, ?, ?, 'pending_superior')
				 RETURNING id`,
			)
			.bind(staff.id, user.id, body.num_days, body.reason.trim())
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// DM the staff's superior to approve. If admin == superior, the DM
		// goes to admin themselves which is fine (they can self-approve).
		const approverTid = staff.superior_telegram_id ?? (await firstAdminTid(env));
		if (approverTid) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: approverTid,
				text: `🪙 <b>Off-credit grant</b>\n${user.full_name} → ${staff.full_name}: ${body.num_days} day(s)\nReason: ${body.reason}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve grant', callback_data: `grant:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `grant:reject:${ins.id}` },
						],
					],
				},
			});
			if (msg?.message_id) {
				await env.depot_db
					.prepare('UPDATE off_credit_grants SET approval_message_id = ? WHERE id = ?')
					.bind(String(msg.message_id), ins.id)
					.run();
			}
		}
		// Also notify the staff that a grant is pending
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: staff.telegram_id,
			text: `🪙 ${user.full_name} proposed granting you ${body.num_days} off day(s) — pending superior approval. Reason: ${body.reason}`,
		});

		return json({ ok: true, id: ins.id });
	}

	// -------- cancel own pending request ---------------------------------
	if (request.method === 'POST' && sub === '/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT id, user_id, off_status, startdate, enddate FROM off_requests WHERE id = ?`,
			)
			.bind(body.id)
			.first<{ id: number; user_id: number; off_status: string; startdate: string; enddate: string }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_request' }, { status: 403 });
		if (row.off_status !== 'pending') return json({ error: 'not_pending' }, { status: 409 });

		await env.depot_db
			.prepare(
				`UPDATE off_requests SET off_status = 'cancelled',
				   cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?`,
			)
			.bind(user.id, body.id)
			.run();

		const superiorTid = await resolveSuperiorTid(env, user.superior_telegram_id);
		if (superiorTid) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: superiorTid,
				text: `🚫 ${user.full_name} cancelled their off request (${row.startdate} → ${row.enddate}).`,
			});
		}
		return json({ ok: true });
	}

	// -------- revert approval (admin/superadmin) -------------------------
	if (request.method === 'POST' && sub === '/revert') {
		if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.approved_by,
				        u.telegram_id AS requester_tid, u.full_name AS requester_name,
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
				approver_tid: string | null;
				approver_name: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.off_status !== 'approved') return json({ error: 'not_approved' }, { status: 409 });
		if (user.user_role === 'admin' && row.approved_by !== user.id) {
			return json({ error: 'not_your_approval' }, { status: 403 });
		}

		const days = dayCountInclusive(row.startdate, row.enddate);
		await env.depot_db.batch([
			env.depot_db
				.prepare(
					`UPDATE off_requests SET off_status = 'reverted',
					   cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?`,
				)
				.bind(user.id, body.id),
			// Refund credits to the user
			env.depot_db
				.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`)
				.bind(days, row.user_id),
		]);

		const msg = `↩ Approval reverted by ${user.full_name}: off ${row.startdate} → ${row.enddate} for ${row.requester_name}. ${days} credit(s) refunded.`;
		const sends: Promise<unknown>[] = [
			tgSendMessage(env.BOT_TOKEN, { chat_id: row.requester_tid, text: msg }),
		];
		if (row.approver_tid && row.approver_tid !== user.telegram_id) {
			sends.push(tgSendMessage(env.BOT_TOKEN, { chat_id: row.approver_tid, text: msg }));
		}
		await Promise.allSettled(sends);
		return json({ ok: true, days_refunded: days });
	}

	if (request.method === 'GET' && sub === '/staff') {
		if (user.user_role === 'superadmin') {
			const { results } = await env.depot_db
				.prepare(`SELECT id, full_name, off_credits, department FROM users WHERE full_name NOT LIKE 'PENDING:%' ORDER BY full_name`)
				.all<{ id: number; full_name: string; off_credits: number; department: string | null }>();
			return json(results ?? []);
		}
		if (user.user_role === 'admin') {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id, full_name, off_credits, department FROM users
					 WHERE superior_telegram_id = ? AND full_name NOT LIKE 'PENDING:%'
					 ORDER BY full_name`,
				)
				.bind(user.telegram_id)
				.all<{ id: number; full_name: string; off_credits: number; department: string | null }>();
			return json(results ?? []);
		}
		return json([]);
	}

	return json({ error: 'not_found' }, { status: 404 });
}

async function resolveSuperiorTid(env: Env, superiorTid: string | null): Promise<string | null> {
	if (superiorTid) return superiorTid;
	return firstAdminTid(env);
}

async function firstAdminTid(env: Env): Promise<string | null> {
	const a = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role IN ('admin','superadmin') LIMIT 1`)
		.first<{ telegram_id: string }>();
	return a?.telegram_id ?? null;
}
