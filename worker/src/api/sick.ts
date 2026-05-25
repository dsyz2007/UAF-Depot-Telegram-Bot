import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';

interface OpenCase {
	id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	approved_at: string | null;
	updated_status: string | null;
	updated_at: string | null;
	created_at: string;
}

export async function handleSick(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/sick'.length);

	if (request.method === 'GET' && sub === '/my-open') {
		const row = await env.depot_db
			.prepare(
				`SELECT id, case_type, reportsick_status, approved_at, updated_status, updated_at, created_at
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

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO sick_cases (user_id, case_type, reportsick_status)
				 VALUES (?, ?, 'pending_superior')
				 RETURNING id`,
			)
			.bind(user.id, body.case_type)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

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
		const body = (await request.json()) as { id?: number; updated_status?: string };
		if (!Number.isInteger(body.id) || !body.updated_status?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.superior_user_id,
				        sup.telegram_id AS superior_tid
				 FROM sick_cases s LEFT JOIN users sup ON sup.id = s.superior_user_id
				 WHERE s.id = ?`,
			)
			.bind(body.id)
			.first<{ id: number; user_id: number; case_type: string; reportsick_status: string; superior_user_id: number | null; superior_tid: string | null }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_case' }, { status: 403 });
		if (row.reportsick_status !== 'approved' && row.reportsick_status !== 'flagged') {
			return json({ error: 'bad_state', state: row.reportsick_status }, { status: 409 });
		}

		await env.depot_db
			.prepare(
				`UPDATE sick_cases
				 SET reportsick_status = 'updated', updated_status = ?, updated_at = datetime('now')
				 WHERE id = ?`,
			)
			.bind(body.updated_status.trim(), row.id)
			.run();

		// Cancel any still-pending reminders for this case (3h/6h/8h drops).
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
				text: `✅ ${user.full_name} updated their ${row.case_type}: ${body.updated_status.trim()}`,
			});
		}
		return json({ ok: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}

async function firstAdminTid(env: Env): Promise<string | null> {
	const a = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'admin' LIMIT 1`)
		.first<{ telegram_id: string }>();
	return a?.telegram_id ?? null;
}
