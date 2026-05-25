// Telegram WebApp initData verification.
// Algorithm spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// initData is a URL-encoded query string. The signed payload is every field
// EXCEPT `hash`, sorted alphabetically, joined with "\n" as "key=value".
// secret_key = HMAC_SHA256("WebAppData", bot_token)
// expected   = HMAC_SHA256(secret_key, data_check_string)
// Compare expected (hex) to the supplied `hash`.

import type { TgWebAppUser } from './types';

const enc = new TextEncoder();

async function hmacSha256(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
}

function toHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export interface VerifiedInitData {
	user: TgWebAppUser;
	authDate: number;
	raw: string;
}

export async function verifyInitData(
	initData: string,
	botToken: string,
	maxAgeSeconds = 86_400,
): Promise<VerifiedInitData | null> {
	if (!initData) return null;

	const params = new URLSearchParams(initData);
	const hash = params.get('hash');
	if (!hash) return null;
	params.delete('hash');

	const dataCheckString = [...params.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');

	const secretKey = await hmacSha256(enc.encode('WebAppData'), botToken);
	const expected = toHex(await hmacSha256(secretKey, dataCheckString));

	if (expected !== hash) return null;

	const authDate = Number(params.get('auth_date'));
	if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

	const userJson = params.get('user');
	if (!userJson) return null;
	let user: TgWebAppUser;
	try {
		user = JSON.parse(userJson);
	} catch {
		return null;
	}
	if (typeof user.id !== 'number') return null;

	return { user, authDate, raw: initData };
}
