// Telegram bot wiring with grammy. The Bot instance is built per-request
// (Workers are stateless, but constructing the Bot is cheap).
//
// Handlers live in worker/src/handlers/ — this file is the glue.

import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import './types';
import { registerStartHandler } from './handlers/start';
import { registerOffCallbacks } from './handlers/off-callbacks';
import { registerSickCallbacks } from './handlers/sick-callbacks';

export function createBot(env: Env): Bot {
	const bot = new Bot(env.BOT_TOKEN);

	registerStartHandler(bot, env);
	registerOffCallbacks(bot, env);
	registerSickCallbacks(bot, env);

	// Fallback: any other message → show the WebApp button.
	bot.on('message', async (ctx) => {
		const kb = new InlineKeyboard().webApp('Open Depot App', env.WEBAPP_URL);
		await ctx.reply('Tap below to open the depot app.', { reply_markup: kb });
	});

	return bot;
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	// Telegram sends X-Telegram-Bot-Api-Secret-Token if we set secret_token
	// when registering the webhook. Reject anything else loudly.
	const supplied = request.headers.get('x-telegram-bot-api-secret-token');
	if (!env.WEBHOOK_SECRET || supplied !== env.WEBHOOK_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}
	const bot = createBot(env);
	const handle = webhookCallback(bot, 'cloudflare-mod');
	return handle(request);
}
