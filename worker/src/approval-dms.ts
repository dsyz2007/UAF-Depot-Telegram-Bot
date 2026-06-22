// Helpers for the "edit every superior's copy" approval-DM model.
//
// When a request is DM'd to multiple appointment-holders, each gets a SEPARATE
// message. We store ALL their (chat_id, message_id) pairs as a JSON array in the
// row's existing message-id column (superior_message_id / approval_message_id),
// so that when ONE superior decides (via a chat button OR in-app), we can edit
// EVERY copy to show the outcome and drop the buttons — no stale live buttons on
// the other superiors' phones.

import { tgEditMessageText } from './tg';

export type MsgPair = [string, string]; // [chatId, messageId]

// Serialise the pairs collected while sending the per-superior DMs.
export function packApprovalMsgs(pairs: MsgPair[]): string {
	return JSON.stringify(pairs);
}

// tgEditMessageText always sends parse_mode:'HTML'. Outcome strings interpolate
// user-supplied names/statuses that can contain &, <, > (Telegram display names
// are arbitrary Unicode); unescaped, Telegram rejects the edit with 400 and the
// stale Approve/Reject buttons would never clear. These strings carry no
// intentional markup, so escaping the whole thing is correct.
function htmlEscape(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parsePairs(raw: string | null): MsgPair[] {
	if (!raw) return [];
	try {
		const p = JSON.parse(raw);
		// New format = array of [chat, msg]. Old rows held a bare message-id string
		// (no chat) — uneditable, so just ignore those.
		return Array.isArray(p) ? (p as MsgPair[]).filter((x) => Array.isArray(x) && x.length === 2) : [];
	} catch {
		return [];
	}
}

// Edit every stored copy of an approval DM to `text` (clearing the buttons).
// `table`/`col` are fixed code literals (never user input) — safe to interpolate.
export async function resolveApprovalDms(
	env: Env,
	table: 'off_requests' | 'sick_cases' | 'leave_requests' | 'off_credit_grants' | 'parade_change_requests',
	col: 'superior_message_id' | 'approval_message_id',
	id: number,
	text: string,
): Promise<void> {
	// Fully best-effort: editing the superior copies is a cosmetic follow-up to a
	// decision that has ALREADY been committed by the caller. A transient D1 read
	// error or a Telegram failure here must NEVER throw, or it would abort the
	// caller's remaining durable side-effects (e.g. an off refund). Swallow all.
	try {
		const row = await env.depot_db.prepare(`SELECT ${col} AS m FROM ${table} WHERE id = ?`).bind(id).first<{ m: string | null }>();
		const pairs = parsePairs(row?.m ?? null);
		if (!pairs.length) return;
		const safe = htmlEscape(text);
		await Promise.allSettled(pairs.map(([chatId, messageId]) => tgEditMessageText(env.BOT_TOKEN, chatId, messageId, safe)));
	} catch {
		/* best-effort — never let a DM-edit failure break the decision flow */
	}
}

// Re-edit every stored copy of an approval DM BACK to a live Approve/Reject
// prompt — used when a decision is UNDONE (reopened to pending via revert or
// unreject) so each appointment-holder can action it again straight from chat.
// callbackPrefix is the callback_data namespace the chat handlers expect
// ('off' | 'sick' | 'leave' | 'grant' | 'paradechg'). Best-effort, never throws.
export async function restoreApprovalDms(
	env: Env,
	table: 'off_requests' | 'sick_cases' | 'leave_requests' | 'off_credit_grants' | 'parade_change_requests',
	col: 'superior_message_id' | 'approval_message_id',
	id: number,
	text: string,
	callbackPrefix: 'off' | 'sick' | 'leave' | 'grant' | 'paradechg',
): Promise<void> {
	try {
		const row = await env.depot_db.prepare(`SELECT ${col} AS m FROM ${table} WHERE id = ?`).bind(id).first<{ m: string | null }>();
		const pairs = parsePairs(row?.m ?? null);
		if (!pairs.length) return;
		const safe = htmlEscape(text);
		const reply_markup = {
			inline_keyboard: [
				[
					{ text: '✅ Approve', callback_data: `${callbackPrefix}:approve:${id}` },
					{ text: '❌ Reject', callback_data: `${callbackPrefix}:reject:${id}` },
				],
			],
		};
		await Promise.allSettled(pairs.map(([chatId, messageId]) => tgEditMessageText(env.BOT_TOKEN, chatId, messageId, safe, reply_markup)));
	} catch {
		/* best-effort — never let a DM-edit failure break the reopen flow */
	}
}
