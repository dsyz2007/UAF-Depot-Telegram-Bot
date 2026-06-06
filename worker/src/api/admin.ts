import { json, type AuthedContext } from './router';
import { refreshHolidays, sgtToday, sgtDateAddDays } from '../holidays';
import {
	DEPARTMENTS,
	STG_SUB_DEPARTMENTS,
	PERSONNEL_TYPES,
	type Department,
	type StgSubDepartment,
	type PersonnelType,
} from '../types';

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
}

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidDepartment(s: unknown): s is Department {
	return typeof s === 'string' && (DEPARTMENTS as readonly string[]).includes(s);
}
function isValidSubDepartment(s: unknown): s is StgSubDepartment {
	return typeof s === 'string' && (STG_SUB_DEPARTMENTS as readonly string[]).includes(s);
}
function isValidPersonnelType(s: unknown): s is PersonnelType {
	return typeof s === 'string' && (PERSONNEL_TYPES as readonly string[]).includes(s);
}

export async function handleAdmin(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
	const sub = url.pathname.slice('/api/admin'.length);

	// ------ User management ------------------------------------------------
	if (request.method === 'GET' && sub === '/users') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT id, telegram_id, full_name, user_role, superior_telegram_id, superior_telegram_id_2, ord_date,
				        department, sub_department, personnel_type, off_credits, created_at
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
			superior_telegram_id_2?: string | null;
			ord_date?: string | null;
			department?: string | null;
			sub_department?: string | null;
			personnel_type?: string | null;
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

		// Sub-department only applies when department is STG; ignored otherwise.
		const subRaw = body.sub_department?.trim();
		const subDepartmentValue =
			departmentValue === 'STG' && subRaw && isValidSubDepartment(subRaw) ? subRaw : null;

		const ptRaw = body.personnel_type?.trim();
		const personnelTypeValue = ptRaw && isValidPersonnelType(ptRaw) ? ptRaw : null;

		await env.depot_db
			.prepare(
				`UPDATE users SET full_name = ?, user_role = ?, superior_telegram_id = ?, superior_telegram_id_2 = ?,
				   ord_date = ?, department = ?, sub_department = ?, personnel_type = ? WHERE id = ?`,
			)
			.bind(
				body.full_name.trim(),
				targetRole,
				body.superior_telegram_id?.trim() || null,
				body.superior_telegram_id_2?.trim() || null,
				ordDate,
				departmentValue,
				subDepartmentValue,
				personnelTypeValue,
				body.id,
			)
			.run();
		const updated = await env.depot_db
			.prepare(
				`SELECT id, telegram_id, full_name, user_role, superior_telegram_id, superior_telegram_id_2, ord_date,
				        department, sub_department, personnel_type, off_credits, created_at
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
		// `reminders.user_id REFERENCES users(id)` from migration 001 was never
		// rebuilt, so the FK still blocks DELETE on users. Wipe the user's
		// reminders first (they're transient anyway), then delete the user.
		// Other tables (off_requests, sick_cases, parade_state_entries) were
		// rebuilt in 002 without FK refs — their rows orphan harmlessly.
		await env.depot_db.batch([
			env.depot_db.prepare(`DELETE FROM reminders WHERE user_id = ?`).bind(body.id),
			env.depot_db.prepare(`DELETE FROM users WHERE id = ?`).bind(body.id),
		]);
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

	// Manually add a holiday (in case the nager.date fetch is unavailable or
	// MOM declares an ad-hoc holiday). Stored as confirmed=1 immediately.
	if (request.method === 'POST' && sub === '/holidays/add') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as { date?: string; name?: string };
		if (!isValidDate(body.date) || !body.name?.trim()) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		await env.depot_db
			.prepare(
				`INSERT INTO public_holidays (holiday_date, name, confirmed) VALUES (?, ?, 1)
				 ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name, confirmed = 1,
				   refreshed_at = datetime('now')`,
			)
			.bind(body.date, body.name.trim())
			.run();
		return json({ ok: true });
	}

	// Delete a confirmed holiday from the Holidays UI.
	if (request.method === 'POST' && sub === '/holidays/delete') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as { date?: string };
		if (!isValidDate(body.date)) return json({ error: 'invalid_body' }, { status: 400 });
		await env.depot_db.prepare(`DELETE FROM public_holidays WHERE holiday_date = ?`).bind(body.date).run();
		return json({ ok: true });
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
		// Forcing a day non-working makes it behave like a weekend: wipe every
		// user's parade state for that date and drop any pending late-changes.
		let clearedEntries = 0;
		if (isWorking === 0) {
			const del = await env.depot_db
				.prepare(`DELETE FROM parade_state_entries WHERE parade_state_date = ?`)
				.bind(body.override_date)
				.run();
			clearedEntries = del.meta.changes ?? 0;
			await env.depot_db
				.prepare(
					`UPDATE parade_change_requests SET status = 'cancelled'
					 WHERE parade_state_date = ? AND status = 'pending'`,
				)
				.bind(body.override_date)
				.run();
		}
		return json({ ok: true, cleared_entries: clearedEntries });
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
