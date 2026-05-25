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

export async function tgEditMessageText(
	botToken: string,
	chatId: number | string,
	messageId: number | string,
	text: string,
): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }),
	});
}

export async function tgAnswerCallback(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
	});
}
