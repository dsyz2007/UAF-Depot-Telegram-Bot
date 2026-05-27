import { json, type AuthedContext } from './router';
import { PARADE_STATUSES, type ParadeStatus } from '../types';

interface MonthRow {
	user_id: number;
	full_name: string;
	parade_state_date: string;
	period: 'AM' | 'PM';
	parade_status: string;
	reason: string | null;
}

const ALLOWED_STATUS = new Set<string>(PARADE_STATUSES as readonly string[]);

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

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
}

export async function handleParade(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/parade'.length);

	if (request.method === 'GET' && sub === '/month') {
		const ym = url.searchParams.get('ym') ?? '';
		if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'bad_ym' }, { status: 400 });
		const start = `${ym}-01`;
		const { results } = await env.depot_db
			.prepare(
				`SELECT p.user_id, u.full_name, p.parade_state_date, p.period, p.parade_status, p.reason
				 FROM parade_state_entries p JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date >= ?
				   AND p.parade_state_date < date(?, '+1 month')
				 ORDER BY p.parade_state_date, u.full_name, p.period`,
			)
			.bind(start, start)
			.all<MonthRow>();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/submit') {
		const body = (await request.json()) as {
			startdate?: string;
			enddate?: string;
			status?: string;
			reason?: string | null;
			periods?: ('AM' | 'PM')[];
		};
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) {
			return json({ error: 'bad_dates' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });
		if (typeof body.status !== 'string' || !ALLOWED_STATUS.has(body.status)) {
			return json({ error: 'bad_status' }, { status: 400 });
		}
		const reason = body.reason?.trim() || null;
		if ((body.status as ParadeStatus) === 'Others' && !reason) {
			return json({ error: 'reason_required_for_others' }, { status: 400 });
		}
		const periods = (body.periods && body.periods.length > 0 ? body.periods : ['AM', 'PM']) as ('AM' | 'PM')[];
		for (const p of periods) {
			if (p !== 'AM' && p !== 'PM') return json({ error: 'bad_period' }, { status: 400 });
		}

		const dates = expandRange(body.startdate, body.enddate);
		const stmt = env.depot_db.prepare(
			`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, parade_state_date, period)
			 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
		);
		const ops = [];
		for (const d of dates) {
			for (const p of periods) {
				ops.push(stmt.bind(user.id, d, p, body.status, reason));
			}
		}
		await env.depot_db.batch(ops);
		return json({ ok: true, count: ops.length });
	}

	if (request.method === 'GET' && sub === '/export') {
		// CSV export — single date, admin or superadmin.
		if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
		const date = url.searchParams.get('date') ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });

		// Department grouping so the CSV is also useful as a paste-able roll-call.
		const { results } = await env.depot_db
			.prepare(
				`SELECT u.full_name, u.department, p.period, p.parade_status, p.reason
				 FROM parade_state_entries p
				 JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date = ?
				 ORDER BY u.department, u.full_name, p.period`,
			)
			.bind(date)
			.all<{ full_name: string; department: string | null; period: string; parade_status: string; reason: string | null }>();
		const rows = results ?? [];

		const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
		const header = 'department,name,period,status,reason\n';
		const body = rows
			.map((r) => [r.department ?? '', r.full_name, r.period, r.parade_status, r.reason ?? ''].map(csvEscape).join(','))
			.join('\n');
		return new Response(header + body + '\n', {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="parade-state_${date}.csv"`,
			},
		});
	}

	return json({ error: 'not_found' }, { status: 404 });
}
