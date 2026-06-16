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

export type Department = 'DHQ' | 'DMSP' | 'DCS' | 'DSP' | 'Others';
export const DEPARTMENTS: readonly Department[] = ['DHQ', 'DMSP', 'DCS', 'DSP', 'Others'];

// Cross-tab navigation request: the Parade tab raises one of these when a user
// marks OFF / RSI / RSO without having applied, so App can switch to the Off /
// Sick tab and open the matching apply form.
export type RouteAction =
	| { kind: 'off'; start: string; end: string; period?: 'FD' | 'AM' | 'PM'; reason?: string }
	| { kind: 'sick'; sickType: 'RSI' | 'RSO'; reason?: string };

export type PersonnelType = 'NSF' | 'Regular';
export const PERSONNEL_TYPES: readonly PersonnelType[] = ['NSF', 'Regular'];

export type Appointment = 'WOIC' | '2IC' | 'PC';
export const APPOINTMENTS: readonly Appointment[] = ['WOIC', '2IC', 'PC'];

// Display labels. NSF → "N", Regular → "R". (Legacy 'NSF Officer' rows, if any
// remain from before that type was removed, still render as "N".)
export function personnelLabel(t: string | null | undefined): string {
	if (t === 'Regular') return 'R';
	if (t === 'NSF' || t === 'NSF Officer') return 'N';
	return '';
}

// Department display label. STG was merged into a single "DSP" department, so
// any legacy 'STG' rows (and their sub-sections) collapse to "DSP".
export function deptLabel(department: string | null | undefined, _sub?: string | null | undefined): string {
	if (department === 'DSP' || department === 'STG') return 'DSP';
	return department ?? 'Unassigned';
}

export interface Me {
	id: number;
	telegram_id: string;
	full_name: string;
	user_role: 'user' | 'admin' | 'superadmin';
	ord_date: string | null;
	department: Department | null;
	sub_department: string | null;
	personnel_type: PersonnelType | null;
	appointment: Appointment | null;
	self_managed: number;
	off_credits: number;
	is_approver: boolean;
	pending: boolean;
}

// Telegram's WebApp.showConfirm is flaky — on some clients the callback never
// fires, which makes `await new Promise(r => WebApp.showConfirm(msg, r))` hang
// forever. This wrapper races showConfirm against a short timeout; if showConfirm
// hasn't responded by then we fall back to window.confirm (always synchronous).
export function confirmDialog(message: string): Promise<boolean> {
	const tg = (window as unknown as {
		Telegram?: { WebApp?: { showConfirm?: (m: string, cb: (ok: boolean) => void) => void } };
	}).Telegram?.WebApp;
	if (!tg || typeof tg.showConfirm !== 'function') {
		return Promise.resolve(window.confirm(message));
	}
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		try {
			tg.showConfirm!(message, (ok) => finish(!!ok));
		} catch {
			finish(window.confirm(message));
			return;
		}
		// If showConfirm never invokes the callback (broken on this client),
		// fall back after a short grace period so the calling action isn't stuck.
		setTimeout(() => {
			if (!settled) finish(window.confirm(message));
		}, 2000);
	});
}

// Robust alert — Telegram's WebApp.showAlert throws on older clients (< Bot API
// 6.2) and silently no-ops on a few others, which makes a *successful* action
// look like "nothing happened". This wraps it and falls back to window.alert so
// the user always sees the result.
export function alertDialog(message: string): void {
	const tg = (window as unknown as {
		Telegram?: { WebApp?: { showAlert?: (m: string) => void } };
	}).Telegram?.WebApp;
	if (!tg || typeof tg.showAlert !== 'function') {
		window.alert(message);
		return;
	}
	try {
		tg.showAlert(message);
	} catch {
		window.alert(message);
	}
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
