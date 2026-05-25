import { json, type AuthedContext } from './router';

export async function handleAdmin(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	if (user.user_role !== 'admin') return json({ error: 'forbidden' }, { status: 403 });
	const sub = url.pathname.slice('/api/admin'.length);

	if (request.method === 'GET' && sub === '/users') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT id, telegram_id, full_name, user_role, superior_telegram_id, created_at
				 FROM users ORDER BY full_name LIKE 'PENDING:%' DESC, full_name`,
			)
			.all();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/users') {
		const body = (await request.json()) as {
			id?: number;
			full_name?: string;
			user_role?: 'user' | 'superior' | 'admin';
			superior_telegram_id?: string | null;
		};
		if (!Number.isInteger(body.id) || !body.full_name?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		if (body.user_role && !['user', 'superior', 'admin'].includes(body.user_role)) {
			return json({ error: 'bad_role' }, { status: 400 });
		}
		await env.depot_db
			.prepare(
				`UPDATE users SET full_name = ?, user_role = ?, superior_telegram_id = ? WHERE id = ?`,
			)
			.bind(
				body.full_name.trim(),
				body.user_role ?? 'user',
				body.superior_telegram_id?.trim() || null,
				body.id,
			)
			.run();
		return json({ ok: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}
