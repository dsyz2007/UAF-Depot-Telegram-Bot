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

// Precedence:
// 1. working_day_overrides → use its value
// 2. confirmed public_holidays → non-working
// 3. Sat/Sun → non-working
// 4. otherwise working
export async function isWorkingDay(env: Env, sgtDate: string): Promise<boolean> {
	const override = await env.depot_db
		.prepare('SELECT is_working_day FROM working_day_overrides WHERE override_date = ?')
		.bind(sgtDate)
		.first<{ is_working_day: number }>();
	if (override) return override.is_working_day === 1;

	const ph = await env.depot_db
		.prepare('SELECT 1 AS one FROM public_holidays WHERE holiday_date = ? AND confirmed = 1')
		.bind(sgtDate)
		.first<{ one: number }>();
	if (ph) return false;

	const dow = dayOfWeekSgt(sgtDate);
	if (dow === 0 || dow === 6) return false;
	return true;
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
	const { results: existingRows } = await env.depot_db
		.prepare(
			`SELECT holiday_date, name, confirmed FROM public_holidays
			 WHERE substr(holiday_date, 1, 4) IN (?, ?)`,
		)
		.bind(String(todayYear), String(todayYear + 1))
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
				if (d.kind === 'new') return `🆕 ${d.holiday_date} — ${d.name}`;
				if (d.kind === 'changed') return `✏ ${d.holiday_date} — ${d.previous_name} → ${d.name}`;
				return `❌ ${d.holiday_date} — ${d.name} (removed)`;
			})
			.join('\n');
		for (const sa of superadmins) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: sa.telegram_id,
				text: `🇸🇬 <b>Public-holiday updates (nager.date)</b>\n\n${summary}\n\nReview each change individually below:`,
				parse_mode: 'HTML',
			});
			for (const d of deltas) {
				const label = d.kind === 'removed' ? `${d.holiday_date} (${d.name})` : `${d.holiday_date} — ${d.name}`;
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
