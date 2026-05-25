import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

export function registerStartHandler(bot: Bot, env: Env): void {
	bot.command('start', async (ctx) => {
		const from = ctx.from;
		if (!from) return;
		const telegramId = String(from.id);
		const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'unnamed';

		const existing = await env.depot_db
			.prepare('SELECT id, full_name FROM users WHERE telegram_id = ?')
			.bind(telegramId)
			.first<{ id: number; full_name: string }>();

		if (!existing) {
			await env.depot_db
				.prepare(
					'INSERT INTO users (telegram_id, full_name, user_role) VALUES (?, ?, ?)',
				)
				.bind(telegramId, `PENDING:${displayName}`, 'user')
				.run();
			await ctx.reply(
				'Welcome to the depot bot. Your account is pending — an admin will assign your name and role shortly.',
			);
			return;
		}

		if (existing.full_name.startsWith('PENDING:')) {
			await ctx.reply('Your account is still pending admin approval. Please wait.');
			return;
		}

		const kb = new InlineKeyboard().webApp('Open Depot App', env.WEBAPP_URL);
		await ctx.reply(`Welcome back, ${existing.full_name}.`, { reply_markup: kb });
	});
}
