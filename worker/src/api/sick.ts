import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { isSelfManaged } from '../types';

interface OpenCase {
	id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
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

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
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
				`SELECT id, case_type, reportsick_status, approved_at, updated_status, updated_at,
				        num_of_mc_days, mc_start_date, mc_end_date, location, approx_time, mc_file_id, created_at
				 FROM sick_cases
				 WHERE user_id = ? AND reportsick_status IN ('pending_superior','approved','flagged')
				 ORDER BY id DESC LIMIT 1`,
			)
			.bind(user.id)
			.first<OpenCase>();
		return json(row ?? null);
	}

	if (request.method === 'POST' && sub === '/report') {
		const body = (await request.json()) as { case_type?: string };
		if (body.case_type !== 'RSI' && body.case_type !== 'RSO') {
			return json({ error: 'bad_case_type' }, { status: 400 });
		}
		const open = await env.depot_db
			.prepare(
				`SELECT id FROM sick_cases
				 WHERE user_id = ? AND reportsick_status IN ('pending_superior','approved')`,
			)
			.bind(user.id)
			.first<{ id: number }>();
		if (open) return json({ error: 'already_open', id: open.id }, { status: 409 });

		// Self-managed users skip the superior-approval step: the case is logged
		// as approved immediately, no DM, no reminders, no MC requirement.
		if (isSelfManaged(user)) {
			const ins = await env.depot_db
				.prepare(
					`INSERT INTO sick_cases (user_id, case_type, reportsick_status, superior_user_id, approved_at)
					 VALUES (?, ?, 'approved', ?, datetime('now'))
					 RETURNING id`,
				)
				.bind(user.id, body.case_type, user.id)
				.first<{ id: number }>();
			if (!ins) return json({ error: 'insert_failed' }, { status: 500 });
			return json({ ok: true, id: ins.id, auto_approved: true });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO sick_cases (user_id, case_type, reportsick_status)
				 VALUES (?, ?, 'pending_superior')
				 RETURNING id`,
			)
			.bind(user.id, body.case_type)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Per-request DM with inline buttons (also actionable from the inbox).
		const superiorTid = user.superior_telegram_id ?? (await firstAdminTid(env));
		if (superiorTid) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: superiorTid,
				text: `🟡 <b>${body.case_type}</b> request from ${user.full_name}.`,
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
			if (msg?.message_id) {
				await env.depot_db
					.prepare('UPDATE sick_cases SET approval_message_id = ? WHERE id = ?')
					.bind(String(msg.message_id), ins.id)
					.run();
			}
		}
		return json({ ok: true, id: ins.id });
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
				        sup.telegram_id AS superior_tid
				 FROM sick_cases s LEFT JOIN users sup ON sup.id = s.superior_user_id
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

		if (row.superior_tid) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.superior_tid,
				text: `✅ ${user.full_name} updated their ${row.case_type}: ${updatedStatusSummary}`,
			});
		}
		return json({ ok: true });
	}

	// Requester cancels their own pending sick case.
	if (request.method === 'POST' && sub === '/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(`SELECT id, user_id, case_type, reportsick_status FROM sick_cases WHERE id = ?`)
			.bind(body.id)
			.first<{ id: number; user_id: number; case_type: string; reportsick_status: string }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_case' }, { status: 403 });
		if (row.reportsick_status !== 'pending_superior') {
			return json({ error: 'not_pending' }, { status: 409 });
		}

		await env.depot_db
			.prepare(
				`UPDATE sick_cases SET reportsick_status = 'cancelled',
				   cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?`,
			)
			.bind(user.id, body.id)
			.run();

		const superiorTid = user.superior_telegram_id ?? (await firstAdminTid(env));
		if (superiorTid) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: superiorTid,
				text: `🚫 ${user.full_name} cancelled their ${row.case_type} request.`,
			});
		}
		return json({ ok: true });
	}

	// Admin/superadmin reverts a sick approval/update.
	if (request.method === 'POST' && sub === '/revert') {
		if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });

		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.superior_user_id,
				        u.telegram_id AS requester_tid, u.full_name AS requester_name,
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
				approver_tid: string | null;
				approver_name: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (!['approved', 'updated', 'flagged'].includes(row.reportsick_status)) {
			return json({ error: 'bad_state', state: row.reportsick_status }, { status: 409 });
		}
		if (user.user_role === 'admin' && row.superior_user_id !== user.id) {
			return json({ error: 'not_your_approval' }, { status: 403 });
		}

		await env.depot_db
			.prepare(
				`UPDATE sick_cases SET reportsick_status = 'reverted',
				   cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?`,
			)
			.bind(user.id, body.id)
			.run();

		await env.depot_db
			.prepare(
				`DELETE FROM reminders
				 WHERE related_type = 'sick_case' AND related_id = ? AND sent_at IS NULL`,
			)
			.bind(body.id)
			.run();

		const msg = `↩ ${row.case_type} approval reverted by ${user.full_name} for ${row.requester_name}.`;
		const sends: Promise<unknown>[] = [
			tgSendMessage(env.BOT_TOKEN, { chat_id: row.requester_tid, text: msg }),
		];
		if (row.approver_tid && row.approver_tid !== user.telegram_id) {
			sends.push(tgSendMessage(env.BOT_TOKEN, { chat_id: row.approver_tid, text: msg }));
		}
		await Promise.allSettled(sends);
		return json({ ok: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}

// Fallback approver when a user has no superior set — the first superadmin.
async function firstAdminTid(env: Env): Promise<string | null> {
	const a = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin' ORDER BY id LIMIT 1`)
		.first<{ telegram_id: string }>();
	return a?.telegram_id ?? null;
}
