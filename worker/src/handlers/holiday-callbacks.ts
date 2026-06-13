// Inline-button handler for "Confirm / Reject / Treat as working day" sent
// from the daily holiday-diff DM to all superadmins.

import type { Bot } from 'grammy';

type Action = 'confirm' | 'reject' | 'overrideworking';

export function registerHolidayCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^hol:(confirm|reject|overrideworking):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
		const action = ctx.match![1] as Action;
		const date = ctx.match![2];
		const actorTid = String(ctx.from.id);

		const actor = await env.depot_db
			.prepare(`SELECT id, full_name, user_role FROM users WHERE telegram_id = ?`)
			.bind(actorTid)
			.first<{ id: number; full_name: string; user_role: string }>();
		if (!actor || actor.user_role !== 'superadmin') {
			await ctx.answerCallbackQuery({ text: 'Only superadmins.' });
			return;
		}

		const row = await env.depot_db
			.prepare(`SELECT name FROM public_holidays WHERE holiday_date = ?`)
			.bind(date)
			.first<{ name: string }>();
		if (!row) {
			await ctx.answerCallbackQuery({ text: 'No pending change for this date.' });
			await ctx.editMessageText(`(stale) ${date}`);
			return;
		}

		if (action === 'confirm') {
			if (row.name.endsWith(' [REMOVED]')) {
				await env.depot_db
					.prepare(`DELETE FROM public_holidays WHERE holiday_date = ?`)
					.bind(date)
					.run();
				await ctx.editMessageText(`❌ Holiday removed: ${date}\nConfirmed by ${actor.full_name}.`);
			} else {
				await env.depot_db
					.prepare(`UPDATE public_holidays SET confirmed = 1 WHERE holiday_date = ?`)
					.bind(date)
					.run();
				await ctx.editMessageText(`✅ Holiday confirmed: ${date} — ${row.name}\nBy ${actor.full_name}.`);
			}
			await ctx.answerCallbackQuery({ text: 'Confirmed.' });
			return;
		}

		if (action === 'reject') {
			await env.depot_db.prepare(`DELETE FROM public_holidays WHERE holiday_date = ?`).bind(date).run();
			await ctx.editMessageText(`❌ Rejected: ${date}\nBy ${actor.full_name}.`);
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			return;
		}

		// overrideworking: keep holiday confirmed AND force working day.
		await env.depot_db
			.prepare(`UPDATE public_holidays SET confirmed = 1 WHERE holiday_date = ?`)
			.bind(date)
			.run();
		// Migration 018 made the PK composite (override_date, period); write a
		// whole-day ('FD'), all-departments (NULL) override with the matching
		// conflict target.
		await env.depot_db
			.prepare(
				`INSERT INTO working_day_overrides (override_date, period, departments, is_working_day, reason, set_by_user_id)
				 VALUES (?, 'FD', NULL, 1, ?, ?)
				 ON CONFLICT(override_date, period) DO UPDATE SET
				   departments = NULL,
				   is_working_day = 1,
				   reason = excluded.reason,
				   set_by_user_id = excluded.set_by_user_id,
				   set_at = datetime('now')`,
			)
			.bind(date, `Unit operating despite ${row.name.replace(' [REMOVED]', '')}`, actor.id)
			.run();
		await ctx.editMessageText(
			`🛠 ${date} marked WORKING (overrides holiday: ${row.name.replace(' [REMOVED]', '')})\nBy ${actor.full_name}.`,
		);
		await ctx.answerCallbackQuery({ text: 'Override set.' });
	});
}
