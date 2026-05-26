// Telegram bot wiring with grammy. The Bot instance is built per-request
// (Workers are stateless, but constructing the Bot is cheap).
//
// Handlers live in worker/src/handlers/ — this file is the glue.

import { Bot, webhookCallback } from 'grammy';
import './types';
import { registerStartHandler } from './handlers/start';
import { registerOffCallbacks } from './handlers/off-callbacks';
import { registerSickCallbacks } from './handlers/sick-callbacks';
import { registerUserCallbacks } from './handlers/user-callbacks';
import { registerHolidayCallbacks } from './handlers/holiday-callbacks';
import { webAppKeyboard } from './keyboards';

export function createBot(env: Env): Bot {
	const bot = new Bot(env.BOT_TOKEN);

	registerStartHandler(bot, env);
	registerOffCallbacks(bot, env);
	registerSickCallbacks(bot, env);
	registerUserCallbacks(bot, env);
	registerHolidayCallbacks(bot, env);

	// Fallback: any other message → re-show the WebApp button.
	bot.on('message', async (ctx) => {
		await ctx.reply('Tap the button below to open the depot app.', {
			reply_markup: webAppKeyboard(env.WEBAPP_URL),
		});
	});

	return bot;
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const supplied = request.headers.get('x-telegram-bot-api-secret-token');
	if (!env.WEBHOOK_SECRET || supplied !== env.WEBHOOK_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}
	const bot = createBot(env);
	const handle = webhookCallback(bot, 'cloudflare-mod');
	return handle(request);
}
