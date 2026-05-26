// Singapore public holidays via data.gov.sg + working-day classification.
//
// We use data.gov.sg's CKAN datastore_search endpoint. Dataset name per year:
// "Public Holidays for YYYY". The dataset publishes resource IDs we have to
// look up via package_search.
//
// Cache table: public_holidays(holiday_date PK, name, confirmed, refreshed_at)
// Override table: working_day_overrides(override_date PK, is_working_day, reason, ...)

import { tgSendMessage } from './tg';

interface HolidayRecord {
	holiday_date: string; // YYYY-MM-DD
	name: string;
}

// Convert a UTC `now` into SGT date string (YYYY-MM-DD).
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
	// 0 = Sunday, 6 = Saturday
	return new Date(`${sgtDate}T00:00:00Z`).getUTCDay();
}

// Precedence:
// 1. working_day_overrides row → use is_working_day
// 2. public_holidays row with confirmed=1 → non-working
// 3. Saturday/Sunday → non-working
// 4. Otherwise → working
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
// data.gov.sg fetch
// --------------------------------------------------------------------------
// CKAN package_search to find resource IDs, then datastore_search to read.
// data.gov.sg dataset slug pattern: "public-holidays-for-YYYY".
async function fetchHolidaysForYear(year: number): Promise<HolidayRecord[]> {
	const pkgUrl = `https://data.gov.sg/api/action/package_show?id=public-holidays-for-${year}`;
	const pkgRes = await fetch(pkgUrl, { headers: { accept: 'application/json' } });
	if (!pkgRes.ok) {
		console.warn(`holidays: package_show ${year} → ${pkgRes.status}`);
		return [];
	}
	const pkgJson = (await pkgRes.json()) as {
		result?: { resources?: { id: string; format?: string }[] };
	};
	const resource = pkgJson.result?.resources?.find((r) => /csv/i.test(r.format ?? ''));
	if (!resource) {
		console.warn(`holidays: no CSV resource for ${year}`);
		return [];
	}
	const dsUrl = `https://data.gov.sg/api/action/datastore_search?resource_id=${resource.id}&limit=100`;
	const dsRes = await fetch(dsUrl);
	if (!dsRes.ok) {
		console.warn(`holidays: datastore_search ${year} → ${dsRes.status}`);
		return [];
	}
	const dsJson = (await dsRes.json()) as {
		result?: { records?: Record<string, string>[] };
	};
	const records = dsJson.result?.records ?? [];

	const out: HolidayRecord[] = [];
	for (const r of records) {
		// Field names vary per year ("Date" / "date") and ("Holiday" / "Name" / "holiday")
		const rawDate = r.Date ?? r.date ?? r['Holiday Date'] ?? '';
		const name = r.Holiday ?? r.holiday ?? r.Name ?? r.name ?? '';
		const iso = normaliseDate(rawDate);
		if (iso && name) out.push({ holiday_date: iso, name });
	}
	return out;
}

// data.gov.sg ships dates as "YYYY-MM-DD" usually but sometimes "D Mmm YYYY".
function normaliseDate(raw: string): string | null {
	if (!raw) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString().slice(0, 10);
}

interface HolidayDelta {
	kind: 'new' | 'changed' | 'removed';
	holiday_date: string;
	name: string;
	previous_name?: string;
}

// Fetch current + next year, diff against cache, DM superadmins with each delta.
// Returns the number of deltas detected (0 when no DMs sent).
export async function refreshHolidays(env: Env): Promise<number> {
	const todayYear = Number(sgtToday().slice(0, 4));
	const fetched = [...(await fetchHolidaysForYear(todayYear)), ...(await fetchHolidaysForYear(todayYear + 1))];
	if (fetched.length === 0) {
		console.warn('holidays: no records fetched, retaining cache');
		return 0;
	}

	const { results: existingRows } = await env.depot_db
		.prepare(
			`SELECT holiday_date, name, confirmed FROM public_holidays
			 WHERE substr(holiday_date, 1, 4) IN (?, ?)`,
		)
		.bind(String(todayYear), String(todayYear + 1))
		.all<{ holiday_date: string; name: string; confirmed: number }>();
	const existing = new Map((existingRows ?? []).map((r) => [r.holiday_date, r]));

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

	if (deltas.length === 0) {
		// Touch refreshed_at so we can see in DB when last successfully refreshed.
		await env.depot_db
			.prepare(`UPDATE public_holidays SET refreshed_at = datetime('now') WHERE confirmed = 1`)
			.run();
		return 0;
	}

	// Stage all deltas as confirmed=0 rows / pending deletions.
	// NEW + CHANGED: upsert with confirmed=0.
	// REMOVED: we mark by setting confirmed=0 to flag pending review (delete on confirm).
	const upsert = env.depot_db.prepare(
		`INSERT INTO public_holidays (holiday_date, name, confirmed) VALUES (?, ?, 0)
		 ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name, confirmed = 0,
		   refreshed_at = datetime('now')`,
	);
	const stageRemoval = env.depot_db.prepare(
		`UPDATE public_holidays SET confirmed = 0, name = name || ' [REMOVED]'
		 WHERE holiday_date = ?`,
	);
	const batchOps = deltas.map((d) =>
		d.kind === 'removed' ? stageRemoval.bind(d.holiday_date) : upsert.bind(d.holiday_date, d.name),
	);
	if (batchOps.length) await env.depot_db.batch(batchOps);

	// DM all superadmins.
	const { results: admins } = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin'`)
		.all<{ telegram_id: string }>();
	if (!admins?.length) return deltas.length;

	const summary = deltas
		.map((d) => {
			if (d.kind === 'new') return `🆕 ${d.holiday_date} — ${d.name}`;
			if (d.kind === 'changed') return `✏ ${d.holiday_date} — ${d.previous_name} → ${d.name}`;
			return `❌ ${d.holiday_date} — ${d.name} (no longer listed)`;
		})
		.join('\n');

	for (const a of admins) {
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: a.telegram_id,
			text: `🇸🇬 <b>Public holiday changes from data.gov.sg</b>\n\n${summary}\n\nReview each change individually below:`,
			parse_mode: 'HTML',
		});
		// Then one message per delta with inline buttons.
		for (const d of deltas) {
			const label = d.kind === 'removed' ? `${d.holiday_date} (${d.name})` : `${d.holiday_date} — ${d.name}`;
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: a.telegram_id,
				text: `<b>${holidayKindLabel(d.kind)}</b>\n${label}`,
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
	return deltas.length;
}

function holidayKindLabel(k: HolidayDelta['kind']): string {
	switch (k) {
		case 'new':
			return '🆕 NEW holiday';
		case 'changed':
			return '✏ CHANGED holiday';
		case 'removed':
			return '❌ REMOVED holiday';
	}
}
