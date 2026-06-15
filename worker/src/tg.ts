// Minimal helpers for calling the Telegram Bot API directly (outside of
// the webhook flow). Used by /api/* handlers and the scheduled() worker
// when we need to DM someone without an incoming `ctx`.

interface TgSendOpts {
	chat_id: number | string;
	text: string;
	parse_mode?: 'HTML' | 'MarkdownV2';
	reply_markup?: unknown;
}

export async function tgSendMessage(botToken: string, opts: TgSendOpts): Promise<{ message_id?: number } | null> {
	const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(opts),
	});
	if (!res.ok) {
		console.error('tgSendMessage failed', res.status, await res.text());
		return null;
	}
	const json = (await res.json()) as { ok: boolean; result?: { message_id: number } };
	return json.ok && json.result ? { message_id: json.result.message_id } : null;
}

// Fetch a chat/user's current profile by id. Works for any user the bot has an
// existing chat with (i.e. anyone who has /start-ed). Returns null on error.
export async function tgGetChat(
	botToken: string,
	chatId: number | string,
): Promise<{ id: number; username?: string; first_name?: string; last_name?: string } | null> {
	const res = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`);
	if (!res.ok) {
		console.error('tgGetChat failed', chatId, res.status);
		return null;
	}
	const json = (await res.json()) as {
		ok: boolean;
		result?: { id: number; username?: string; first_name?: string; last_name?: string };
	};
	return json.ok && json.result ? json.result : null;
}

// Broadcast helper: run `send` over `items` in chunks with a pause between
// chunks, so a large fan-out (e.g. nudging ~90 users) doesn't trip Telegram's
// ~30-messages/second global limit. Returns settled results in the SAME order
// as `items` so callers can correlate (e.g. capture each message_id).
export async function sendThrottled<T, R>(
	items: T[],
	send: (item: T, index: number) => Promise<R>,
	opts: { chunkSize?: number; pauseMs?: number } = {},
): Promise<PromiseSettledResult<R>[]> {
	const chunkSize = opts.chunkSize ?? 10;
	const pauseMs = opts.pauseMs ?? 2000;
	const out: PromiseSettledResult<R>[] = [];
	for (let i = 0; i < items.length; i += chunkSize) {
		const chunk = items.slice(i, i + chunkSize);
		const settled = await Promise.allSettled(chunk.map((item, j) => send(item, i + j)));
		out.push(...settled);
		if (i + chunkSize < items.length) {
			await new Promise((resolve) => setTimeout(resolve, pauseMs));
		}
	}
	return out;
}

export async function tgEditMessageText(
	botToken: string,
	chatId: number | string,
	messageId: number | string,
	text: string,
	replyMarkup?: unknown,
): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		// Default (no replyMarkup) clears the inline keyboard — removes any
		// Approve/Reject buttons once an item is resolved. Pass a replyMarkup to
		// keep a button (e.g. the parade nudge keeps its "Open Parade page").
		body: JSON.stringify({
			chat_id: chatId,
			message_id: messageId,
			text,
			parse_mode: 'HTML',
			reply_markup: replyMarkup ?? { inline_keyboard: [] },
		}),
	});
}

export async function tgAnswerCallback(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
	});
}

// Send a file (e.g. CSV export) to a chat. Telegram's in-app WebView blocks
// browser blob downloads, so the reliable way to deliver a file is to push it
// into the user's chat with the bot via sendDocument (multipart upload).
export async function tgSendDocument(
	botToken: string,
	chatId: number | string,
	filename: string,
	content: string | Uint8Array,
	caption?: string,
	contentType = 'text/csv',
): Promise<boolean> {
	const form = new FormData();
	form.append('chat_id', String(chatId));
	if (caption) form.append('caption', caption);
	form.append('document', new Blob([content], { type: contentType }), filename);
	const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
		method: 'POST',
		body: form,
	});
	if (!res.ok) {
		console.error('tgSendDocument failed', res.status, await res.text());
		return false;
	}
	return true;
}
