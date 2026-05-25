// Handles inline-button taps on the "Approve / Reject" message DM'd to a
// superior when their staff requests an off. Callback data is encoded as
// "off:<action>:<request_id>" — kept short to stay under Telegram's 64-byte limit.

import type { Bot } from 'grammy';
import { tgSendMessage } from '../tg';

interface OffRow {
	id: number;
	user_id: number;
	requester_name: string;
	requester_tid: string;
	startdate: string;
	enddate: string;
	reason: string;
	off_status: string;
}

export function registerOffCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^off:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const offId = Number(ctx.match![2]);
		const superiorTid = String(ctx.from.id);

		const superior = await env.depot_db
			.prepare('SELECT id, full_name, user_role FROM users WHERE telegram_id = ?')
			.bind(superiorTid)
			.first<{ id: number; full_name: string; user_role: string }>();
		if (!superior) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.startdate, o.enddate, o.reason, o.off_status,
				        u.full_name AS requester_name, u.telegram_id AS requester_tid
				 FROM off_requests o JOIN users u ON u.id = o.user_id
				 WHERE o.id = ?`,
			)
			.bind(offId)
			.first<OffRow>();
		if (!row) {
			await ctx.answerCallbackQuery({ text: 'Request not found.' });
			return;
		}
		if (row.off_status !== 'pending') {
			await ctx.answerCallbackQuery({ text: `Already ${row.off_status}.` });
			return;
		}

		const newStatus = action === 'approve' ? 'approved' : 'rejected';
		await env.depot_db
			.prepare(
				`UPDATE off_requests SET off_status = ?, approved_by = ?, approved_date = datetime('now') WHERE id = ?`,
			)
			.bind(newStatus, superior.id, offId)
			.run();

		const verbPast = action === 'approve' ? 'approved' : 'rejected';
		const emoji = action === 'approve' ? '✅' : '❌';
		await ctx.editMessageText(
			`${emoji} ${row.requester_name}'s off (${row.startdate} → ${row.enddate}) — ${verbPast} by ${superior.full_name}.`,
		);
		await ctx.answerCallbackQuery({ text: `Marked as ${verbPast}.` });

		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `${emoji} Your off request (${row.startdate} → ${row.enddate}) has been ${verbPast} by ${superior.full_name}.`,
		});
	});
}
