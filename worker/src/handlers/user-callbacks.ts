// Inline-button handler for "Delete user" — sent from the daily ORD reminder
// to all superadmins on the user's ORD date.

import type { Bot } from 'grammy';
import { tgSendMessage } from '../tg';

export function registerUserCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^user:delete:(\d+)$/, async (ctx) => {
		const userId = Number(ctx.match![1]);
		const actorTid = String(ctx.from.id);

		const actor = await env.depot_db
			.prepare(`SELECT id, full_name, user_role FROM users WHERE telegram_id = ?`)
			.bind(actorTid)
			.first<{ id: number; full_name: string; user_role: string }>();
		if (!actor || actor.user_role !== 'superadmin') {
			await ctx.answerCallbackQuery({ text: 'Only superadmins can delete users.' });
			return;
		}
		if (actor.id === userId) {
			await ctx.answerCallbackQuery({ text: 'You cannot delete yourself.' });
			return;
		}

		const target = await env.depot_db
			.prepare(`SELECT full_name FROM users WHERE id = ?`)
			.bind(userId)
			.first<{ full_name: string }>();
		if (!target) {
			await ctx.answerCallbackQuery({ text: 'User not found (already deleted?).' });
			await ctx.editMessageText('User no longer exists.');
			return;
		}

		await env.depot_db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
		await ctx.editMessageText(`🗑 ${target.full_name} removed from depot bot (by ${actor.full_name}).`);
		await ctx.answerCallbackQuery({ text: 'Deleted.' });

		// Notify all OTHER superadmins.
		const { results: peers } = await env.depot_db
			.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin' AND telegram_id <> ?`)
			.bind(actorTid)
			.all<{ telegram_id: string }>();
		await Promise.allSettled(
			(peers ?? []).map((p) =>
				tgSendMessage(env.BOT_TOKEN, {
					chat_id: p.telegram_id,
					text: `🗑 ${actor.full_name} removed ${target.full_name} from the depot bot.`,
				}),
			),
		);
	});
}
