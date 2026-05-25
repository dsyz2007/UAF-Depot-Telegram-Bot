import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';

interface SummaryRow {
	id: number;
	full_name: string;
	off_count: number;
}

interface DetailRow {
	id: number;
	startdate: string;
	enddate: string;
	reason: string;
	approved_date: string | null;
	approved_by_name: string | null;
	off_status: string;
}

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function handleOff(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/off'.length);

	if (request.method === 'GET' && sub === '/summary') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.full_name,
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
				        a.full_name AS approved_by_name
				 FROM off_requests o
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.user_id = ? AND o.off_status = 'approved'
				 ORDER BY o.startdate DESC`,
			)
			.bind(id)
			.all<DetailRow>();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/request') {
		const body = (await request.json()) as { startdate?: string; enddate?: string; reason?: string };
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate) || !body.reason?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });

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

		// DM superior. If no superior set, fall back to admins (rare).
		const superiorTid = await resolveSuperiorTid(env, user.superior_telegram_id);
		if (superiorTid) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: superiorTid,
				text: `🟡 <b>Off request</b>\n${user.full_name}: ${body.startdate} → ${body.enddate}\nReason: ${body.reason}`,
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
		return json({ ok: true, id: ins.id });
	}

	if (request.method === 'POST' && sub === '/add-approved') {
		if (user.user_role !== 'superior' && user.user_role !== 'admin') {
			return json({ error: 'forbidden' }, { status: 403 });
		}
		const body = (await request.json()) as { staff_id?: number; startdate?: string; enddate?: string; reason?: string };
		if (!Number.isInteger(body.staff_id) || !isValidDate(body.startdate) || !isValidDate(body.enddate) || !body.reason?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		const staff = await env.depot_db
			.prepare('SELECT id, telegram_id, full_name, superior_telegram_id FROM users WHERE id = ?')
			.bind(body.staff_id)
			.first<{ id: number; telegram_id: string; full_name: string; superior_telegram_id: string | null }>();
		if (!staff) return json({ error: 'staff_not_found' }, { status: 404 });
		if (user.user_role === 'superior' && staff.superior_telegram_id !== user.telegram_id) {
			return json({ error: 'not_your_staff' }, { status: 403 });
		}

		await env.depot_db
			.prepare(
				`INSERT INTO off_requests
				   (user_id, requested_by_user_id, startdate, enddate, reason, off_status, approved_by, approved_date)
				 VALUES (?, ?, ?, ?, ?, 'approved', ?, datetime('now'))`,
			)
			.bind(staff.id, user.id, body.startdate, body.enddate, body.reason.trim(), user.id)
			.run();

		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: staff.telegram_id,
			text: `✅ ${user.full_name} added an approved off for you: ${body.startdate} → ${body.enddate} (${body.reason}).`,
		});
		return json({ ok: true });
	}

	if (request.method === 'GET' && sub === '/staff') {
		// List of staff this user can add offs for. Superiors see direct reports;
		// admins see everyone.
		if (user.user_role === 'admin') {
			const { results } = await env.depot_db
				.prepare(`SELECT id, full_name FROM users WHERE full_name NOT LIKE 'PENDING:%' ORDER BY full_name`)
				.all<{ id: number; full_name: string }>();
			return json(results ?? []);
		}
		if (user.user_role === 'superior') {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id, full_name FROM users
					 WHERE superior_telegram_id = ? AND full_name NOT LIKE 'PENDING:%'
					 ORDER BY full_name`,
				)
				.bind(user.telegram_id)
				.all<{ id: number; full_name: string }>();
			return json(results ?? []);
		}
		return json([]);
	}

	return json({ error: 'not_found' }, { status: 404 });
}

async function resolveSuperiorTid(env: Env, superiorTid: string | null): Promise<string | null> {
	if (superiorTid) return superiorTid;
	const admin = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'admin' LIMIT 1`)
		.first<{ telegram_id: string }>();
	return admin?.telegram_id ?? null;
}
