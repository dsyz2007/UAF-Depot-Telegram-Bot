// Router for all /api/* endpoints.
//
// Auth model (uniform):
//   1. Client sends `Authorization: tma <initDataRaw>` header.
//      `tma` is the Telegram-recommended scheme for this kind of token.
//   2. We verify the HMAC and extract the user.id.
//   3. We look up the DB row. No row → 403 (unregistered). LIKE 'PENDING:%'
//      full_name is allowed (lets new users see a "waiting for admin" screen).

import { verifyInitData } from '../auth';
import type { DbUser } from '../types';
import { handleOff } from './off';
import { handleSick } from './sick';
import { handleParade } from './parade';
import { handleAdmin } from './admin';
import { handleMe } from './me';

export interface AuthedContext {
	url: URL;
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	user: DbUser;
}

function json(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
	});
}

export { json };

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// Public health endpoint (handy when debugging deploys).
	if (path === '/api/health') return json({ ok: true, ts: Date.now() });

	// Extract & verify initData
	const authHeader = request.headers.get('authorization') ?? '';
	const initData = authHeader.startsWith('tma ') ? authHeader.slice(4) : null;
	if (!initData) return json({ error: 'missing_init_data' }, { status: 401 });

	const verified = await verifyInitData(initData, env.BOT_TOKEN);
	if (!verified) return json({ error: 'invalid_init_data' }, { status: 401 });

	const dbUser = await env.depot_db
		.prepare('SELECT * FROM users WHERE telegram_id = ?')
		.bind(String(verified.user.id))
		.first<DbUser>();
	if (!dbUser) return json({ error: 'not_registered' }, { status: 403 });

	const actx: AuthedContext = { url, request, env, ctx, user: dbUser };

	if (path === '/api/me') return handleMe(actx);
	if (path.startsWith('/api/off')) return handleOff(actx);
	if (path.startsWith('/api/sick')) return handleSick(actx);
	if (path.startsWith('/api/parade')) return handleParade(actx);
	if (path.startsWith('/api/admin')) return handleAdmin(actx);

	return json({ error: 'not_found' }, { status: 404 });
}
