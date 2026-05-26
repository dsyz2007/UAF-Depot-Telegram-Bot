// Read initData directly from window.Telegram.WebApp so we don't depend on
// the @twa-dev/sdk wrapper for this critical path (the wrapper has init-order
// quirks across versions). Re-read every call — Telegram refreshes it.
function readInitData(): string {
	const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
	return tg?.initData ?? '';
}

function authHeader(): HeadersInit {
	return { Authorization: `tma ${readInitData()}` };
}

export class ApiError extends Error {
	status: number;
	body: unknown;
	constructor(status: number, body: unknown) {
		const detail =
			body && typeof body === 'object' && 'error' in body
				? (body as { error: unknown }).error
				: null;
		super(detail ? `HTTP ${status} — ${String(detail)}` : `HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: {
			...authHeader(),
			...(body ? { 'content-type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	let parsed: unknown = null;
	try {
		parsed = await res.json();
	} catch {
		// non-JSON response (e.g. CSV download); fall through
	}
	if (!res.ok) throw new ApiError(res.status, parsed);
	return parsed as T;
}

export const api = {
	get: <T,>(path: string) => request<T>('GET', path),
	post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body),
	getBlob: async (path: string): Promise<Blob> => {
		const res = await fetch(path, { headers: authHeader() });
		if (!res.ok) throw new ApiError(res.status, await res.text());
		return res.blob();
	},
};

export interface Me {
	id: number;
	telegram_id: string;
	full_name: string;
	user_role: 'user' | 'admin' | 'superadmin';
	superior_telegram_id: string | null;
	pending: boolean;
}

// Generic DELETE helper for the admin overrides endpoint.
export async function apiDelete<T = unknown>(path: string): Promise<T> {
	const res = await fetch(path, { method: 'DELETE', headers: authHeader() });
	let parsed: unknown = null;
	try {
		parsed = await res.json();
	} catch {
		// ignore
	}
	if (!res.ok) throw new ApiError(res.status, parsed);
	return parsed as T;
}
