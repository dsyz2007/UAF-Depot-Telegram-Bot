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
import { registerParadeChangeCallbacks } from './handlers/parade-change-callbacks';
import { webAppKeyboard } from './keyboards';

// Module-scope cache for the bot's identity. grammy normally calls Telegram's
// getMe() on the first message handled per Bot instance — we cache the result
// across requests on a warm Worker instance so we skip that round-trip.
// Keyed by token so a token rotation invalidates automatically.
// Inferred from the Bot class itself so we don't depend on grammy's
// non-public type exports.
type BotInfo = Bot['botInfo'];
let cachedBotInfo: BotInfo | undefined;
let cachedBotInfoToken: string | undefined;

// Constant-time string comparison so the webhook-secret check doesn't leak
// information through timing. Workers' === would early-exit on the first
// mismatched byte; this XORs every byte before returning.
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function createBot(env: Env): Bot {
	const useCached = cachedBotInfo && cachedBotInfoToken === env.BOT_TOKEN;
	const bot = new Bot(env.BOT_TOKEN, useCached ? { botInfo: cachedBotInfo } : undefined);

	registerStartHandler(bot, env);
	registerOffCallbacks(bot, env);
	registerSickCallbacks(bot, env);
	registerUserCallbacks(bot, env);
	registerHolidayCallbacks(bot, env);
	registerParadeChangeCallbacks(bot, env);

	// Fallback: any other message → re-show the WebApp button.
	bot.on('message', async (ctx) => {
		await ctx.reply('Tap the button below to open the depot app.', {
			reply_markup: webAppKeyboard(env.WEBAPP_URL),
		});
	});

	return bot;
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const supplied = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
	if (!env.WEBHOOK_SECRET || !safeEqual(supplied, env.WEBHOOK_SECRET)) {
		return new Response('unauthorized', { status: 401 });
	}
	const bot = createBot(env);
	const handle = webhookCallback(bot, 'cloudflare-mod');
	const response = await handle(request);
	// After the handler runs, the Bot is initialised — cache its identity for
	// the next request on this warm instance. botInfo throws if not initialised.
	if (!cachedBotInfo) {
		try {
			cachedBotInfo = bot.botInfo;
			cachedBotInfoToken = env.BOT_TOKEN;
		} catch {
			// not initialised yet (e.g. early error) — try again next request
		}
	}
	return response;
}
