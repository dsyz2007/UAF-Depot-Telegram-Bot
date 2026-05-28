import { json, type AuthedContext } from './router';
import { PARADE_STATUSES, type ParadeStatus } from '../types';
import { tgSendDocument } from '../tg';

interface MonthRow {
	user_id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
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
				`SELECT p.user_id, u.full_name, u.department, u.sub_department,
				        p.parade_state_date, p.period, p.parade_status, p.reason
				 FROM parade_state_entries p JOIN users u ON u.id = p.user_id
				 WHERE p.parade_state_date >= ?
				   AND p.parade_state_date < date(?, '+1 month')
				 ORDER BY p.parade_state_date, u.department, u.sub_department, u.full_name, p.period`,
			)
			.bind(start, start)
			.all<MonthRow>();
		return json(results ?? []);
	}

	if (request.method === 'POST' && sub === '/submit') {
		const body = (await request.json()) as {
			startdate?: string;
			enddate?: string;
			entries?: { period?: string; status?: string; reason?: string | null }[];
		};
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) {
			return json({ error: 'bad_dates' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });

		// entries = per-period {period, status, reason}. At least one required.
		const entries = Array.isArray(body.entries) ? body.entries : [];
		const clean: { period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];
		const seenPeriods = new Set<string>();
		for (const e of entries) {
			if (e.period !== 'AM' && e.period !== 'PM') return json({ error: 'bad_period' }, { status: 400 });
			if (seenPeriods.has(e.period)) return json({ error: 'duplicate_period' }, { status: 400 });
			seenPeriods.add(e.period);
			if (typeof e.status !== 'string' || !ALLOWED_STATUS.has(e.status)) {
				return json({ error: 'bad_status' }, { status: 400 });
			}
			const reason = e.reason?.trim() || null;
			if ((e.status as ParadeStatus) === 'Others' && !reason) {
				return json({ error: 'reason_required_for_others', period: e.period }, { status: 400 });
			}
			clean.push({ period: e.period, status: e.status, reason });
		}
		if (clean.length === 0) {
			return json({ error: 'no_period_filled' }, { status: 400 });
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
			for (const e of clean) {
				ops.push(stmt.bind(user.id, d, e.period, e.status, e.reason));
			}
		}
		await env.depot_db.batch(ops);
		return json({ ok: true, count: ops.length, periods: clean.map((c) => c.period) });
	}

	// Strength report data — every active user with their parade entry (or
	// null) for the given date+period. Open to all authenticated users; the
	// View State button in the UI uses it.
	if (request.method === 'GET' && sub === '/strength') {
		const date = url.searchParams.get('date') ?? '';
		const period = url.searchParams.get('period') ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });
		if (period !== 'AM' && period !== 'PM') return json({ error: 'bad_period' }, { status: 400 });

		const { results } = await env.depot_db
			.prepare(
				`SELECT u.id, u.full_name, u.department, u.sub_department, u.personnel_type,
				        p.parade_status AS status, p.reason
				 FROM users u
				 LEFT JOIN parade_state_entries p
				   ON p.user_id = u.id AND p.parade_state_date = ? AND p.period = ?
				 WHERE u.full_name NOT LIKE 'PENDING:%'
				 ORDER BY u.department, u.sub_department, u.personnel_type, u.full_name`,
			)
			.bind(date, period)
			.all<{
				id: number;
				full_name: string;
				department: string | null;
				sub_department: string | null;
				personnel_type: string | null;
				status: string | null;
				reason: string | null;
			}>();
		return json({ date, period, users: results ?? [] });
	}

	if (request.method === 'POST' && sub === '/export') {
		// CSV export — single date, admin or superadmin. Telegram's WebView
		// blocks browser downloads, so we push the file into the user's chat
		// with the bot via sendDocument instead of returning a blob.
		if (!isAdminish(user.user_role)) return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json().catch(() => ({}))) as { date?: string };
		const date = body.date ?? '';
		if (!isValidDate(date)) return json({ error: 'bad_date' }, { status: 400 });

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
		const csvBody = rows
			.map((r) => [r.department ?? '', r.full_name, r.period, r.parade_status, r.reason ?? ''].map(csvEscape).join(','))
			.join('\n');
		const csv = header + csvBody + '\n';

		const sent = await tgSendDocument(
			env.BOT_TOKEN,
			user.telegram_id,
			`parade-state_${date}.csv`,
			csv,
			`📄 Parade state for ${date} (${rows.length} entries)`,
		);
		if (!sent) return json({ error: 'send_failed' }, { status: 502 });
		return json({ ok: true, rows: rows.length });
	}

	return json({ error: 'not_found' }, { status: 404 });
}
