import { json, type AuthedContext } from './router';
import { refreshHolidays, sgtToday, sgtDateAddDays } from '../holidays';
import { tgGetChat, sendThrottled } from '../tg';
import {
	DEPARTMENTS,
	PERSONNEL_TYPES,
	APPOINTMENTS,
	type Department,
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
				`SELECT id, telegram_id, full_name, username, user_role, ord_date,
				        department, sub_department, personnel_type, appointment, self_managed, off_credits, created_at
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
			ord_date?: string | null;
			department?: string | null;
			sub_department?: string | null;
			personnel_type?: string | null;
			appointment?: string | null;
			self_managed?: boolean | number;
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
		// Only a superadmin may modify (and therefore demote) another superadmin.
		if (user.user_role !== 'superadmin') {
			const existing = await env.depot_db
				.prepare(`SELECT user_role FROM users WHERE id = ?`)
				.bind(body.id)
				.first<{ user_role: string }>();
			if (existing?.user_role === 'superadmin') {
				return json({ error: 'cannot_modify_superadmin' }, { status: 403 });
			}
		}
		const ordDate = body.ord_date?.trim() || null;
		if (ordDate && !isValidDate(ordDate)) {
			return json({ error: 'bad_ord_date' }, { status: 400 });
		}
		const dept = body.department?.trim();
		const departmentValue = dept && isValidDepartment(dept) ? dept : null;

		// STG was merged into a single DSP department — no sub-section anymore.
		const subDepartmentValue = null;

		const ptRaw = body.personnel_type?.trim();
		const personnelTypeValue = ptRaw && isValidPersonnelType(ptRaw) ? ptRaw : null;

		const apptRaw = body.appointment?.trim();
		const appointmentValue = apptRaw && (APPOINTMENTS as readonly string[]).includes(apptRaw) ? apptRaw : null;
		const selfManagedValue = body.self_managed === true || body.self_managed === 1 ? 1 : 0;

		await env.depot_db
			.prepare(
				`UPDATE users SET full_name = ?, user_role = ?, ord_date = ?, department = ?,
				   sub_department = ?, personnel_type = ?, appointment = ?, self_managed = ? WHERE id = ?`,
			)
			.bind(
				body.full_name.trim(),
				targetRole,
				ordDate,
				departmentValue,
				subDepartmentValue,
				personnelTypeValue,
				appointmentValue,
				selfManagedValue,
				body.id,
			)
			.run();
		const updated = await env.depot_db
			.prepare(
				`SELECT id, telegram_id, full_name, username, user_role, ord_date,
				        department, sub_department, personnel_type, appointment, self_managed, off_credits, created_at
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
		// Off records (take-off + credit grants) are kept for 2 years, but a
		// deleted user's off history is no longer needed — delete it too so the
		// long-retained off tables can't accumulate orphans. (sick_cases /
		// parade_state_entries still orphan harmlessly; they prune on their own.)
		await env.depot_db.batch([
			env.depot_db.prepare(`DELETE FROM reminders WHERE user_id = ?`).bind(body.id),
			env.depot_db.prepare(`DELETE FROM off_requests WHERE user_id = ?`).bind(body.id),
			env.depot_db.prepare(`DELETE FROM off_credit_grants WHERE user_id = ?`).bind(body.id),
			env.depot_db.prepare(`DELETE FROM users WHERE id = ?`).bind(body.id),
		]);
		return json({ ok: true });
	}

	// One-time (re-runnable) backfill: fetch each registered user's current
	// Telegram @handle via getChat(id) and store it. Works because the bot has a
	// chat with everyone who /start-ed. Throttled to respect rate limits.
	if (request.method === 'POST' && sub === '/backfill-usernames') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const { results } = await env.depot_db.prepare(`SELECT id, telegram_id FROM users`).all<{ id: number; telegram_id: string }>();
		const rows = results ?? [];
		let updated = 0;
		let noUsername = 0;
		let failed = 0;
		await sendThrottled(
			rows,
			async (r) => {
				try {
					const chat = await tgGetChat(env.BOT_TOKEN, r.telegram_id);
					if (!chat) {
						failed++;
						return;
					}
					const uname = chat.username ?? null;
					await env.depot_db.prepare(`UPDATE users SET username = ? WHERE id = ?`).bind(uname, r.id).run();
					if (uname) updated++;
					else noUsername++;
				} catch (e) {
					failed++;
					console.error('backfill-usernames failed', r.telegram_id, e);
				}
			},
			{ chunkSize: 10, pauseMs: 1500 },
		);
		return json({ ok: true, total: rows.length, updated, no_username: noUsername, failed });
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
		// Show every override still reachable in the parade calendar (±2 months).
		// The calendar's earliest day is the 1st of (current SGT month − 2), so the
		// lower bound must match that exactly (a fixed −60 days falls ~a month short
		// and would drop in-window past overrides from the list). Mirrors the
		// parade-retention prune in scheduled.ts.
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.override_date, o.period, o.departments, o.is_working_day, o.reason, o.set_at,
				        u.full_name AS set_by_name
				 FROM working_day_overrides o
				 LEFT JOIN users u ON u.id = o.set_by_user_id
				 WHERE o.override_date >= date('now','+8 hours','start of month','-2 months')
				 ORDER BY o.override_date, o.period`,
			)
			.all();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/overrides') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as {
			override_date?: string;
			period?: string;
			departments?: string[] | null;
			is_working_day?: boolean | number;
			reason?: string;
		};
		if (!isValidDate(body.override_date)) return json({ error: 'bad_date' }, { status: 400 });
		const period = body.period === 'AM' || body.period === 'PM' ? body.period : 'FD';
		const isWorking = body.is_working_day === true || body.is_working_day === 1 ? 1 : 0;
		// departments: null/empty = all; else keep only valid department codes.
		const validDepts = Array.isArray(body.departments)
			? body.departments.filter((d) => isValidDepartment(d))
			: [];
		const departmentsCsv = validDepts.length ? [...new Set(validDepts)].join(',') : null;

		await env.depot_db
			.prepare(
				`INSERT INTO working_day_overrides (override_date, period, departments, is_working_day, reason, set_by_user_id)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(override_date, period) DO UPDATE SET
				   departments = excluded.departments,
				   is_working_day = excluded.is_working_day,
				   reason = excluded.reason,
				   set_by_user_id = excluded.set_by_user_id,
				   set_at = datetime('now')`,
			)
			.bind(body.override_date, period, departmentsCsv, isWorking, body.reason?.trim() || null, user.id)
			.run();

		// Forcing a slot non-working wipes the affected users' parade state for
		// that date+period and drops their pending late-changes — scoped to the
		// chosen period (FD = both) and to the chosen departments (else all).
		let clearedEntries = 0;
		if (isWorking === 0) {
			const periodClause = period === 'FD' ? '' : ' AND period = ?';
			const deptClause = departmentsCsv
				? ` AND user_id IN (SELECT id FROM users WHERE department IN (${validDepts.map(() => '?').join(',')}))`
				: '';
			const binds: (string | number)[] = [body.override_date];
			if (period !== 'FD') binds.push(period);
			if (departmentsCsv) binds.push(...validDepts);

			const del = await env.depot_db
				.prepare(`DELETE FROM parade_state_entries WHERE parade_state_date = ?${periodClause}${deptClause}`)
				.bind(...binds)
				.run();
			clearedEntries = del.meta.changes ?? 0;
			await env.depot_db
				.prepare(
					`UPDATE parade_change_requests SET status = 'cancelled'
					 WHERE parade_state_date = ?${periodClause}${deptClause} AND status = 'pending'`,
				)
				.bind(...binds)
				.run();
		}
		// Return the saved row so the client can confirm/display it immediately
		// (defends against any read-window mismatch on the subsequent list fetch).
		const saved = await env.depot_db
			.prepare(
				`SELECT o.override_date, o.period, o.departments, o.is_working_day, o.reason, o.set_at,
				        u.full_name AS set_by_name
				 FROM working_day_overrides o LEFT JOIN users u ON u.id = o.set_by_user_id
				 WHERE o.override_date = ? AND o.period = ?`,
			)
			.bind(body.override_date, period)
			.first();
		return json({ ok: true, cleared_entries: clearedEntries, override: saved });
	}

	if (request.method === 'DELETE' && sub === '/overrides') {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const date = url.searchParams.get('date') ?? '';
		const periodParam = url.searchParams.get('period') ?? 'FD';
		const period = periodParam === 'AM' || periodParam === 'PM' ? periodParam : 'FD';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });
		await env.depot_db
			.prepare(`DELETE FROM working_day_overrides WHERE override_date = ? AND period = ?`)
			.bind(date, period)
			.run();
		return json({ ok: true });
	}

	return json({ error: 'not_found' }, { status: 404 });
}
