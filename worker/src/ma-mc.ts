// Detection for the "MA in the morning, MC in the afternoon" case.
//
// When a user's parade state for a date ends up AM = MA (a morning medical
// appointment) and PM = MC (a medical certificate covering the afternoon), we:
//   1. remind the USER to (a) submit the MC on OneNS themselves, and (b) SEND the
//      MC photo/PDF in the Telegram CHAT (not the depot app — the bot forwards it);
//   2. inform the unit's appointment-holders for awareness.
// Deduped to once per (user, date) via a marker row in `reminders` (sent_at set so
// the queue drain ignores it). Best-effort: never throws into the caller.
//
// This can only arise from the parade calendar (a user setting PM=MC while AM is
// MA) — a sick MC update repaints both halves to MC, so it can't leave AM=MA.

import { tgSendMessage } from './tg';
import { approverTidsFor } from './superiors';

export async function informMaMcCombo(env: Env, userId: number, dates: string[]): Promise<void> {
	try {
		const uniq = [...new Set(dates)];
		if (!uniq.length) return;
		const placeholders = uniq.map(() => '?').join(',');
		const { results } = await env.depot_db
			.prepare(
				`SELECT parade_state_date AS d,
				        MAX(CASE WHEN period = 'AM' THEN parade_status END) AS am,
				        MAX(CASE WHEN period = 'PM' THEN parade_status END) AS pm
				 FROM parade_state_entries
				 WHERE user_id = ? AND parade_state_date IN (${placeholders})
				 GROUP BY parade_state_date`,
			)
			.bind(userId, ...uniq)
			.all<{ d: string; am: string | null; pm: string | null }>();
		const hits = (results ?? []).filter((r) => r.am === 'MA' && r.pm === 'MC').map((r) => r.d);
		if (!hits.length) return;

		const u = await env.depot_db
			.prepare(`SELECT id, full_name, telegram_id, department, sub_department, self_managed FROM users WHERE id = ?`)
			.bind(userId)
			.first<{ id: number; full_name: string; telegram_id: string; department: string | null; sub_department: string | null; self_managed: number }>();
		if (!u) return;

		for (const d of hits) {
			// One notification per (user, date). Marker row in reminders, sent_at set so
			// the 5-min drain never picks it up — it's purely a dedup record.
			const rt = `mamc:${d}`;
			const existing = await env.depot_db
				.prepare(`SELECT 1 FROM reminders WHERE related_type = 'ma_mc_combo' AND related_id = ? AND reminder_type = ? LIMIT 1`)
				.bind(userId, rt)
				.first();
			if (existing) continue;
			await env.depot_db
				.prepare(
					`INSERT INTO reminders (user_id, related_type, related_id, due_at, reminder_type, sent_at)
					 VALUES (?, 'ma_mc_combo', ?, datetime('now'), ?, datetime('now'))`,
				)
				.bind(userId, userId, rt)
				.run();

			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: u.telegram_id,
				text:
					`📋 You have MA (morning) + MC (afternoon) on ${d}.\n\n` +
					`1️⃣ Submit the MC on OneNS yourself — the bot can't do that for you.\n` +
					`2️⃣ Send the MC photo/PDF here in this Telegram CHAT (NOT in the depot app) — I'll forward it to your superior.`,
			});

			const tids = await approverTidsFor(env, u);
			await Promise.allSettled(
				tids.map((tid) =>
					tgSendMessage(env.BOT_TOKEN, {
						chat_id: tid,
						text: `🔔 ${u.full_name} has MA (AM) + MC (PM) on ${d}. They've been reminded to submit the MC on OneNS and to send it here in chat (the bot forwards it).`,
					}),
				),
			);
		}
	} catch (e) {
		console.error('informMaMcCombo failed (non-fatal)', e);
	}
}
