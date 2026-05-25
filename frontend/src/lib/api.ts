import WebApp from '@twa-dev/sdk';

// Re-read initData every call — Telegram refreshes it periodically and
// expired data will fail HMAC verification on the server.
function authHeader(): HeadersInit {
	return { Authorization: `tma ${WebApp.initData}` };
}

export class ApiError extends Error {
	status: number;
	body: unknown;
	constructor(status: number, body: unknown) {
		super(`HTTP ${status}`);
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
	user_role: 'user' | 'superior' | 'admin';
	superior_telegram_id: string | null;
	pending: boolean;
}
