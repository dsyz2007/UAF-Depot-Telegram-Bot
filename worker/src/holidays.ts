// Singapore public holidays via nager.date + working-day classification.
//
// We switched away from data.gov.sg's CKAN API because it has shifted
// endpoints multiple times and was returning empty results. nager.date
// publishes Singapore's MOM-confirmed holidays once they're released and
// is a stable JSON endpoint.
//
//   GET https://date.nager.at/api/v3/PublicHolidays/{year}/SG
//
// Tables (created by migration 002):
//   public_holidays(holiday_date PK, name, confirmed, refreshed_at)
//   working_day_overrides(override_date PK, is_working_day, reason, ...)

import { tgSendMessage } from './tg';

interface HolidayRecord {
	holiday_date: string; // YYYY-MM-DD
	name: string;
}

export function sgtToday(): string {
	const now = new Date();
	const sgt = new Date(now.getTime() + 8 * 3600 * 1000);
	return sgt.toISOString().slice(0, 10);
}

export function sgtDateAddDays(sgtDate: string, deltaDays: number): string {
	const d = new Date(`${sgtDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + deltaDays);
	return d.toISOString().slice(0, 10);
}

export function dayOfWeekSgt(sgtDate: string): number {
	return new Date(`${sgtDate}T00:00:00Z`).getUTCDay();
}

// The current half-day by the Singapore clock: AM before 12:00 noon, else PM.
// Used when a same-day RSI/RSO should mark only the half-day in progress.
export function sgtPeriodNow(): Period {
	const sgt = new Date(Date.now() + 8 * 3_600_000);
	const min = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
	return min < 12 * 60 ? 'AM' : 'PM';
}

// ── Working-day classification (per department + half-day) ─────────────────
//
// A date's working/non-working status can now vary by department and by half
// (AM / PM). Overrides (set by superadmins) win over the weekend/holiday rule.
//
// Precedence for a (date, department, period) slot:
//   1. The most specific matching override wins (period match beats FD;
//      department-scoped beats all-departments).
//   2. Else a confirmed public holiday or Sat/Sun → non-working.
//   3. Else working.

export type Period = 'AM' | 'PM';
export type OverridePeriod = 'AM' | 'PM' | 'FD';

export interface OverrideRow {
	period: OverridePeriod;
	departments: string[] | null; // null = all departments
	is_working_day: number;
	reason: string | null;
}
export interface DayWorkInfo {
	baseNonWorking: boolean; // weekend or confirmed public holiday
	holidayName: string | null; // name of the confirmed public holiday on this date, if any
	overrides: OverrideRow[];
}

function parseDepartments(csv: string | null): string[] | null {
	if (!csv) return null;
	const list = csv.split(',').map((s) => s.trim()).filter(Boolean);
	return list.length ? list : null;
}

// Specificity score so the most targeted override wins.
function overrideScore(o: OverrideRow, period: Period, department: string | null): number {
	let s = 0;
	if (o.period === period) s += 2; // exact half beats full-day
	if (o.departments !== null) s += 1; // department-scoped beats all
	void department;
	return s;
}

// Is a single slot (department, period) working, given the day's info?
export function slotWorking(info: DayWorkInfo, department: string | null, period: Period): boolean {
	const matches = info.overrides.filter(
		(o) =>
			(o.period === period || o.period === 'FD') &&
			(o.departments === null || (department !== null && o.departments.includes(department))),
	);
	if (matches.length) {
		matches.sort((a, b) => overrideScore(b, period, department) - overrideScore(a, period, department));
		return matches[0].is_working_day === 1;
	}
	return !info.baseNonWorking;
}

// Why is a (department, period) slot non-working? Returns null if it IS working;
// otherwise a human-readable reason: the forced-non-working override's reason, or
// the public-holiday name, or a weekend label. Used to alert a user who tries to
// set parade state on a non-working slot instead of silently dropping it.
export function slotNonWorkingReason(
	info: DayWorkInfo,
	department: string | null,
	period: Period,
	date: string,
): string | null {
	if (slotWorking(info, department, period)) return null;
	const matches = info.overrides.filter(
		(o) =>
			(o.period === period || o.period === 'FD') &&
			(o.departments === null || (department !== null && o.departments.includes(department))),
	);
	if (matches.length) {
		matches.sort((a, b) => overrideScore(b, period, department) - overrideScore(a, period, department));
		if (matches[0].is_working_day === 0) return matches[0].reason?.trim() || 'Forced non-working day';
	}
	if (info.holidayName) return `Public holiday: ${info.holidayName}`;
	const dow = dayOfWeekSgt(date);
	if (dow === 6) return 'Weekend (Saturday)';
	if (dow === 0) return 'Weekend (Sunday)';
	return 'Non-working day';
}

export async function getDayWorkInfo(env: Env, sgtDate: string): Promise<DayWorkInfo> {
	const { results: ovs } = await env.depot_db
		.prepare('SELECT period, departments, is_working_day, reason FROM working_day_overrides WHERE override_date = ?')
		.bind(sgtDate)
		.all<{ period: OverridePeriod; departments: string | null; is_working_day: number; reason: string | null }>();
	const overrides: OverrideRow[] = (ovs ?? []).map((r) => ({
		period: r.period,
		departments: parseDepartments(r.departments),
		is_working_day: r.is_working_day,
		reason: r.reason,
	}));

	const ph = await env.depot_db
		.prepare('SELECT name FROM public_holidays WHERE holiday_date = ? AND confirmed = 1')
		.bind(sgtDate)
		.first<{ name: string }>();
	const dow = dayOfWeekSgt(sgtDate);
	const baseNonWorking = !!ph || dow === 0 || dow === 6;
	return { baseNonWorking, holidayName: ph?.name ?? null, overrides };
}

// Batch variant — two queries total regardless of range size (used by the
// parade-submit range expansion so a 90-day range stays cheap).
export async function getRangeWorkInfo(env: Env, dates: string[]): Promise<Map<string, DayWorkInfo>> {
	const out = new Map<string, DayWorkInfo>();
	if (dates.length === 0) return out;
	const ph = dates.map(() => '?').join(',');

	const { results: ovs } = await env.depot_db
		.prepare(`SELECT override_date, period, departments, is_working_day, reason FROM working_day_overrides WHERE override_date IN (${ph})`)
		.bind(...dates)
		.all<{ override_date: string; period: OverridePeriod; departments: string | null; is_working_day: number; reason: string | null }>();
	const ovByDate = new Map<string, OverrideRow[]>();
	for (const r of ovs ?? []) {
		const arr = ovByDate.get(r.override_date) ?? [];
		arr.push({ period: r.period, departments: parseDepartments(r.departments), is_working_day: r.is_working_day, reason: r.reason });
		ovByDate.set(r.override_date, arr);
	}

	const { results: hols } = await env.depot_db
		.prepare(`SELECT holiday_date, name FROM public_holidays WHERE confirmed = 1 AND holiday_date IN (${ph})`)
		.bind(...dates)
		.all<{ holiday_date: string; name: string }>();
	const holidayNames = new Map((hols ?? []).map((h) => [h.holiday_date, h.name]));

	for (const d of dates) {
		const dow = dayOfWeekSgt(d);
		out.set(d, {
			baseNonWorking: holidayNames.has(d) || dow === 0 || dow === 6,
			holidayName: holidayNames.get(d) ?? null,
			overrides: ovByDate.get(d) ?? [],
		});
	}
	return out;
}

// Coarse "is this date a working day for anyone?" — true if either half-day is
// working under the default (all-department) view. Used for day-level gating.
export async function isWorkingDay(env: Env, sgtDate: string): Promise<boolean> {
	const info = await getDayWorkInfo(env, sgtDate);
	return slotWorking(info, null, 'AM') || slotWorking(info, null, 'PM');
}

// --------------------------------------------------------------------------
// Fetch from nager.date
// --------------------------------------------------------------------------
async function fetchHolidaysForYear(year: number): Promise<HolidayRecord[]> {
	const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/SG`;
	let res: Response;
	try {
		res = await fetch(url, { headers: { accept: 'application/json' } });
	} catch (e) {
		console.warn(`nager.date ${year} fetch threw`, e);
		return [];
	}
	if (!res.ok) {
		console.warn(`nager.date ${year} → ${res.status}`);
		return [];
	}
	const json = (await res.json()) as
		| { date: string; localName?: string; name?: string }[]
		| null;
	if (!Array.isArray(json)) {
		console.warn(`nager.date ${year} returned non-array`);
		return [];
	}
	const out: HolidayRecord[] = [];
	for (const r of json) {
		if (!r?.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
		out.push({ holiday_date: r.date, name: r.localName ?? r.name ?? 'Holiday' });
	}
	return out;
}

interface HolidayDelta {
	kind: 'new' | 'changed' | 'removed';
	holiday_date: string;
	name: string;
	previous_name?: string;
}

export interface RefreshReport {
	fetched: number;
	deltas: number;
	bootstrap: boolean;
	cached_total: number;
}

// Returns a summary report (always — even when nothing changed).
export async function refreshHolidays(env: Env): Promise<RefreshReport> {
	const todayYear = Number(sgtToday().slice(0, 4));
	const fetched = [
		...(await fetchHolidaysForYear(todayYear)),
		...(await fetchHolidaysForYear(todayYear + 1)),
	];

	if (fetched.length === 0) {
		console.warn('holidays: no records fetched from nager.date');
		const cnt = await countCached(env);
		return { fetched: 0, deltas: 0, bootstrap: false, cached_total: cnt };
	}

	// Detect bootstrap: do we already have ANY rows in this year/next-year window?
	// Range filter on the PK column instead of substr() — uses the index.
	const yearStart = `${todayYear}-01-01`;
	const yearAfterNext = `${todayYear + 2}-01-01`;
	const { results: existingRows } = await env.depot_db
		.prepare(
			`SELECT holiday_date, name, confirmed FROM public_holidays
			 WHERE holiday_date >= ? AND holiday_date < ?`,
		)
		.bind(yearStart, yearAfterNext)
		.all<{ holiday_date: string; name: string; confirmed: number }>();
	const existing = new Map((existingRows ?? []).map((r) => [r.holiday_date, r]));
	const isBootstrap = existing.size === 0;

	if (isBootstrap) {
		// Bootstrap: trust nager.date for the initial load (auto-confirm).
		const stmt = env.depot_db.prepare(
			`INSERT INTO public_holidays (holiday_date, name, confirmed) VALUES (?, ?, 1)
			 ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name, confirmed = 1,
			   refreshed_at = datetime('now')`,
		);
		await env.depot_db.batch(fetched.map((h) => stmt.bind(h.holiday_date, h.name)));
		const cnt = await countCached(env);
		return { fetched: fetched.length, deltas: fetched.length, bootstrap: true, cached_total: cnt };
	}

	// Diff against cache, stage deltas as confirmed=0 + DM superadmins to confirm.
	const deltas: HolidayDelta[] = [];
	const seen = new Set<string>();
	for (const h of fetched) {
		seen.add(h.holiday_date);
		const prev = existing.get(h.holiday_date);
		if (!prev) {
			deltas.push({ kind: 'new', ...h });
		} else if (prev.name !== h.name) {
			deltas.push({ kind: 'changed', holiday_date: h.holiday_date, name: h.name, previous_name: prev.name });
		}
	}
	for (const [date, row] of existing) {
		if (!seen.has(date)) {
			deltas.push({ kind: 'removed', holiday_date: date, name: row.name });
		}
	}

	// Always touch refreshed_at so we know the fetch succeeded.
	await env.depot_db
		.prepare(`UPDATE public_holidays SET refreshed_at = datetime('now') WHERE confirmed = 1`)
		.run();

	if (deltas.length === 0) {
		const cnt = await countCached(env);
		return { fetched: fetched.length, deltas: 0, bootstrap: false, cached_total: cnt };
	}

	const upsert = env.depot_db.prepare(
		`INSERT INTO public_holidays (holiday_date, name, confirmed) VALUES (?, ?, 0)
		 ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name, confirmed = 0,
		   refreshed_at = datetime('now')`,
	);
	const stageRemoval = env.depot_db.prepare(
		`UPDATE public_holidays SET confirmed = 0,
		   name = CASE WHEN name LIKE '%[REMOVED]' THEN name ELSE name || ' [REMOVED]' END
		 WHERE holiday_date = ?`,
	);
	const ops = deltas.map((d) =>
		d.kind === 'removed' ? stageRemoval.bind(d.holiday_date) : upsert.bind(d.holiday_date, d.name),
	);
	if (ops.length) await env.depot_db.batch(ops);

	const { results: superadmins } = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin'`)
		.all<{ telegram_id: string }>();
	if (superadmins?.length) {
		const summary = deltas
			.map((d) => {
				if (d.kind === 'new') return `🆕 ${d.holiday_date}: ${d.name}`;
				if (d.kind === 'changed') return `✏ ${d.holiday_date}: ${d.previous_name} → ${d.name}`;
				return `❌ ${d.holiday_date}: ${d.name} (removed)`;
			})
			.join('\n');
		for (const sa of superadmins) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: sa.telegram_id,
				text: `🇸🇬 <b>Public-holiday updates (nager.date)</b>\n\n${summary}\n\nReview each change individually below:`,
				parse_mode: 'HTML',
			});
			for (const d of deltas) {
				const label = d.kind === 'removed' ? `${d.holiday_date} (${d.name})` : `${d.holiday_date}: ${d.name}`;
				await tgSendMessage(env.BOT_TOKEN, {
					chat_id: sa.telegram_id,
					text: `<b>${kindLabel(d.kind)}</b>\n${label}`,
					parse_mode: 'HTML',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Confirm', callback_data: `hol:confirm:${d.holiday_date}` },
								{ text: '❌ Reject', callback_data: `hol:reject:${d.holiday_date}` },
							],
							[{ text: '🛠 Treat as working day', callback_data: `hol:overrideworking:${d.holiday_date}` }],
						],
					},
				});
			}
		}
	}

	const cnt = await countCached(env);
	return { fetched: fetched.length, deltas: deltas.length, bootstrap: false, cached_total: cnt };
}

async function countCached(env: Env): Promise<number> {
	const r = await env.depot_db
		.prepare(`SELECT COUNT(*) AS n FROM public_holidays`)
		.first<{ n: number }>();
	return r?.n ?? 0;
}

function kindLabel(k: HolidayDelta['kind']): string {
	if (k === 'new') return '🆕 NEW holiday';
	if (k === 'changed') return '✏ CHANGED';
	return '❌ REMOVED';
}
