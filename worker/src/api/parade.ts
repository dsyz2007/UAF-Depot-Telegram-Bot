import { json, type AuthedContext } from './router';

interface MonthRow {
	user_id: number;
	full_name: string;
	parade_state_date: string;
	parade_status: string;
	reason: string | null;
}

const ALLOWED_STATUS = new Set([
	'Present',
	'Off',
	'Leave',
	'MC',
	'Course',
	'Duty',
	'Detached',
	'AWOL',
	'Others',
]);

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Expand inclusive date range into ISO date strings. Caps at 95 to avoid abuse.
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

export async function handleParade(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/parade'.length);

	if (request.method === 'GET' && sub === '/month') {
		const ym = url.searchParams.get('ym') ?? '';
		if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'bad_ym' }, { status: 400 });
		const start = `${ym}-01`;
		// Use SQLite date arithmetic to compute month end (1st of next month, then minus 1 day, then format)
		const { results } = await env.depot_db
			.prepare(
				`SELECT p.user_id, u.full_name, p.parade_state_date, p.parade_status, p.reason
				 FROM parade_state_entries p JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date >= ?
				   AND p.parade_state_date < date(?, '+1 month')
				 ORDER BY p.parade_state_date, u.full_name`,
			)
			.bind(start, start)
			.all<MonthRow>();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/submit') {
		const body = (await request.json()) as { startdate?: string; enddate?: string; status?: string; reason?: string };
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) {
			return json({ error: 'bad_dates' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });
		if (typeof body.status !== 'string' || !ALLOWED_STATUS.has(body.status)) {
			return json({ error: 'bad_status' }, { status: 400 });
		}
		const dates = expandRange(body.startdate, body.enddate);
		const stmt = env.depot_db.prepare(
			`INSERT INTO parade_state_entries (user_id, parade_state_date, parade_status, reason)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, parade_state_date)
			 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
		);
		await env.depot_db.batch(dates.map((d) => stmt.bind(user.id, d, body.status, body.reason ?? null)));
		return json({ ok: true, count: dates.length });
	}

	if (request.method === 'GET' && sub === '/export') {
		if (user.user_role !== 'admin') return json({ error: 'forbidden' }, { status: 403 });
		const from = url.searchParams.get('from') ?? '';
		const to = url.searchParams.get('to') ?? '';
		if (!isValidDate(from) || !isValidDate(to)) return json({ error: 'bad_dates' }, { status: 400 });

		const { results } = await env.depot_db
			.prepare(
				`SELECT u.full_name, p.parade_state_date, p.parade_status, p.reason
				 FROM parade_state_entries p JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date BETWEEN ? AND ?
				 ORDER BY u.full_name, p.parade_state_date`,
			)
			.bind(from, to)
			.all<{ full_name: string; parade_state_date: string; parade_status: string; reason: string | null }>();
		const rows = results ?? [];

		// Group consecutive same-status dates per user back into ranges.
		interface Out { name: string; start: string; end: string; status: string; reason: string }
		const out: Out[] = [];
		let cur: Out | null = null;
		const nextDay = (d: string) => {
			const dt = new Date(`${d}T00:00:00Z`);
			dt.setUTCDate(dt.getUTCDate() + 1);
			return dt.toISOString().slice(0, 10);
		};
		for (const r of rows) {
			const reason = r.reason ?? '';
			if (
				cur &&
				cur.name === r.full_name &&
				cur.status === r.parade_status &&
				cur.reason === reason &&
				nextDay(cur.end) === r.parade_state_date
			) {
				cur.end = r.parade_state_date;
			} else {
				if (cur) out.push(cur);
				cur = { name: r.full_name, start: r.parade_state_date, end: r.parade_state_date, status: r.parade_status, reason };
			}
		}
		if (cur) out.push(cur);

		const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
		const header = 'name,start_date,end_date,status,reason\n';
		const body = out.map((r) => [r.name, r.start, r.end, r.status, r.reason].map(csvEscape).join(',')).join('\n');
		return new Response(header + body + '\n', {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="parade-state_${from}_to_${to}.csv"`,
			},
		});
	}

	return json({ error: 'not_found' }, { status: 404 });
}
