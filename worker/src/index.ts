// Worker entrypoint. Three responsibilities, routed by URL:
//   POST /webhook   → Telegram updates (verified via secret header)
//        /api/*     → JSON endpoints for the WebApp (verified via initData)
//        anything   → static React build via the ASSETS binding
//
// The `scheduled` handler is fired by Cron Triggers (see wrangler.jsonc).

import './types';
import { handleWebhook } from './bot';
import { handleApi } from './api/router';
import { handleScheduled } from './scheduled';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/webhook') {
			return handleWebhook(request, env);
		}
		if (url.pathname.startsWith('/api/')) {
			return handleApi(request, env, ctx);
		}
		// Fall through to static assets (Vite-built React SPA).
		return env.ASSETS.fetch(request);
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduled(controller, env));
	},
} satisfies ExportedHandler<Env>;
