import type { Bot } from 'grammy';
import { webAppKeyboard } from '../keyboards';

export function registerStartHandler(bot: Bot, env: Env): void {
	bot.command('start', async (ctx) => {
		const from = ctx.from;
		if (!from) return;
		const telegramId = String(from.id);
		const username = from.username ?? null;
		const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'unnamed';

		const existing = await env.depot_db
			.prepare('SELECT id, full_name FROM users WHERE telegram_id = ?')
			.bind(telegramId)
			.first<{ id: number; full_name: string }>();

		// Invite gate. An unknown Telegram ID may only create an account if it
		// arrived through the private share link `t.me/<bot>?start=<INVITE_CODE>`,
		// whose deep-link payload surfaces as `ctx.match`. Anyone who merely
		// discovers the bot's @username and presses Start without the code is
		// turned away WITHOUT a row being written — no PENDING junk, and no hint of
		// what the bot is for. Existing users (any state) bypass the gate: the code
		// is only needed to CREATE an account. Fail-closed — if INVITE_CODE is unset
		// no new user can join, which is loud and self-correcting (existing users
		// are unaffected) rather than a silent security hole.
		if (!existing && ctx.match !== env.INVITE_CODE) {
			await ctx.reply('This bot is private — you need an invite link.');
			return;
		}

		// Nuke any leftover reply keyboard from earlier code paths. Reply keyboards
		// persist in the chat across messages until explicitly removed; without
		// this, an old stale `Keyboard.webApp().persistent()` button keeps
		// showing forever even though new messages use inline keyboards instead.
		await ctx.reply('…', { reply_markup: { remove_keyboard: true } }).then((m) => ctx.api.deleteMessage(m.chat.id, m.message_id).catch(() => {}));

		if (!existing) {
			await env.depot_db
				.prepare(
					'INSERT INTO users (telegram_id, full_name, user_role, username) VALUES (?, ?, ?, ?)',
				)
				.bind(telegramId, `PENDING:${displayName}`, 'user', username)
				.run();
			await ctx.reply(
				'Welcome to the depot bot. Your account is pending — an admin will assign your name and role shortly.',
			);
			return;
		}

		// Refresh the stored handle on every /start (usernames can change).
		await env.depot_db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').bind(username, telegramId).run();

		if (existing.full_name.startsWith('PENDING:')) {
			await ctx.reply('Your account is still pending admin approval. Please wait.');
			return;
		}

		await ctx.reply(
			`Welcome back, ${existing.full_name}.\n\nTap the button below to open the depot app, or use the menu icon at the bottom-left of the chat input.`,
			{ reply_markup: webAppKeyboard(env.WEBAPP_URL) },
		);
	});
}
