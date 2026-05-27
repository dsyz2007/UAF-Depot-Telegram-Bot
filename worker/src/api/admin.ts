import { json, type AuthedContext } from './router';
import { refreshHolidays, sgtToday, sgtDateAddDays } from '../holidays';
import { DEPARTMENTS, type Department } from '../types';

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
}

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidDepartment(s: unknown): s is Department {
	return typeof s === 'string' && (DEPARTMENTS as readonly string[]).includes(s);
}

export async function handleAdmin(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
	const sub = url.pathname.slice('/api/admin'.length);

	// ------ User management ------------------------------------------------
	if (request.method === 'GET' && sub === '/users') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT id, telegram_id, full_name, user_role, superior_telegram_id, ord_date,
				        department, off_credits, created_at
				 FROM users ORDER BY full_name LIKE 'PENDING:%' DESC, full_name`,
			)
			.all();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/users') {
		const body = (await request.json()) as {
			id?: number;
			full_name?: string;
			user_role?: 'user' | 'admin' | 'superadmin';
			superior_telegram_id?: string | null;
			ord_date?: string | null;
			department?: string | null;
		};
		if (!Number.isInteger(body.id) || !body.full_name?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		const targetRole = body.user_role ?? 'user';
		if (!['user', 'admin', 'superadmin'].includes(targetRole)) {
			return json({ error: 'bad_role' }, { status: 400 });
		}
		if (targetRole === 'superadmin' && user.user_role !== 'superadmin') {
			return json({ error: 'cannot_grant_superadmin' }, { status: 403 });
		}
		const ordDate = body.ord_date?.trim() || null;
		if (ordDate && !isValidDate(ordDate)) {
			return json({ error: 'bad_ord_date' }, { status: 400 });
		}
		const dept = body.department?.trim();
		const departmentValue = dept && isValidDepartment(dept) ? dept : null;

		await env.depot_db
			.prepare(
				`UPDATE users SET full_name = ?, user_role = ?, superior_telegram_id = ?,
				   ord_date = ?, department = ? WHERE id = ?`,
			)
			.bind(
				body.full_name.trim(),
				targetRole,
				body.superior_telegram_id?.trim() || null,
				ordDate,
				departmentValue,
				body.id,
			)
			.run();
		const updated = await env.depot_db
			.prepare(
				`SELECT id, telegram_id, full_name, user_role, superior_telegram_id, ord_date,
				        department, off_credits, created_at
				 FROM users WHERE id = ?`,
			)
			.bind(body.id)
			.first();
		return json({ ok: true, user: updated });
	}

	if (request.method === 'POST' && sub === '/users/delete') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		if (body.id === user.id) return json({ error: 'cannot_delete_self' }, { status: 400 });
		await env.depot_db.prepare(`DELETE FROM users WHERE id = ?`).bind(body.id).run();
		return json({ ok: true });
	}

	// ------ Public holidays -----------------------------------------------
	if (request.method === 'POST' && sub === '/refresh-holidays') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		try {
			const report = await refreshHolidays(env);
			return json({ ok: true, ...report });
		} catch (e) {
			return json({ error: 'refresh_failed', detail: String(e) }, { status: 500 });
		}
	}

	if (request.method === 'GET' && sub === '/holidays') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT holiday_date, name, confirmed, refreshed_at FROM public_holidays
				 WHERE holiday_date >= ? ORDER BY holiday_date`,
			)
			.bind(sgtDateAddDays(sgtToday(), -30))
			.all();
		return json(results ?? []);
	}

	// Confirm/reject a single pending holiday from the Holidays UI.
	if (request.method === 'POST' && sub === '/holidays/confirm') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as { date?: string; action?: 'confirm' | 'reject' };
		if (!isValidDate(body.date) || (body.action !== 'confirm' && body.action !== 'reject')) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		if (body.action === 'reject') {
			await env.depot_db.prepare(`DELETE FROM public_holidays WHERE holiday_date = ?`).bind(body.date).run();
		} else {
			await env.depot_db
				.prepare(`UPDATE public_holidays SET confirmed = 1 WHERE holiday_date = ?`)
				.bind(body.date)
				.run();
		}
		return json({ ok: true });
	}

	// ------ Working-day overrides -----------------------------------------
	if (request.method === 'GET' && sub === '/overrides') {
		const today = sgtToday();
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.override_date, o.is_working_day, o.reason, o.set_at, u.full_name AS set_by_name
				 FROM working_day_overrides o
				 LEFT JOIN users u ON u.id = o.set_by_user_id
				 WHERE o.override_date >= ?
				 ORDER BY o.override_date`,
			)
			.bind(sgtDateAddDays(today, -7))
			.all();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/overrides') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as {
			override_date?: string;
			is_working_day?: boolean | number;
			reason?: string;
		};
		if (!isValidDate(body.override_date)) return json({ error: 'bad_date' }, { status: 400 });
		const isWorking = body.is_working_day === true || body.is_working_day === 1 ? 1 : 0;
		await env.depot_db
			.prepare(
				`INSERT INTO working_day_overrides (override_date, is_working_day, reason, set_by_user_id)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(override_date) DO UPDATE SET
				   is_working_day = excluded.is_working_day,
				   reason = excluded.reason,
				   set_by_user_id = excluded.set_by_user_id,
				   set_at = datetime('now')`,
			)
			.bind(body.override_date, isWorking, body.reason?.trim() || null, user.id)
			.run();
		return json({ ok: true });
	}

	if (request.method === 'DELETE' && sub === '/overrides') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const date = url.searchParams.get('date') ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });
		await env.depot_db.prepare(`DELETE FROM working_day_overrides WHERE override_date = ?`).bind(date).run();
		return json({ ok: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}
