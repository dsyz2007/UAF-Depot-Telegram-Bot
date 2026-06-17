// Inline-button handler for late-submission parade-state change approvals.
// Callback data shape: paradechg:<approve|reject>:<request_id>
//
// On approve: the proposed new_status / new_reason gets upserted into
// parade_state_entries for the (user, date, period); the request row flips
// to 'approved'; the user is DM'd.
// On reject: request row flips to 'rejected'; the user is DM'd; nothing
// is written to parade_state_entries.

import type { Bot } from 'grammy';
import { tgSendMessage } from '../tg';
import { canApprove } from '../superiors';
import { resolveApprovalDms } from '../approval-dms';

interface ChangeRow {
	id: number;
	user_id: number;
	parade_state_date: string;
	period: 'AM' | 'PM';
	new_status: string;
	new_reason: string | null;
	status: string;
	user_tid: string;
	user_name: string;
	user_dept: string | null;
	user_sub: string | null;
}

export function registerParadeChangeCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^paradechg:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const changeId = Number(ctx.match![2]);
		const approverTid = String(ctx.from.id);

		const approver = await env.depot_db
			.prepare(`SELECT id, full_name, user_role, appointment, department, sub_department FROM users WHERE telegram_id = ?`)
			.bind(approverTid)
			.first<{ id: number; full_name: string; user_role: string; appointment: string | null; department: string | null; sub_department: string | null }>();
		if (!approver) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		const row = await env.depot_db
			.prepare(
				`SELECT c.id, c.user_id, c.parade_state_date, c.period, c.new_status, c.new_reason, c.status,
				        u.telegram_id AS user_tid, u.full_name AS user_name,
				        u.department AS user_dept, u.sub_department AS user_sub
				 FROM parade_change_requests c
				 JOIN users u ON u.id = c.user_id
				 WHERE c.id = ?`,
			)
			.bind(changeId)
			.first<ChangeRow>();
		if (!row) {
			await ctx.answerCallbackQuery({ text: 'Change request not found.' });
			return;
		}
		if (row.status !== 'pending') {
			await ctx.answerCallbackQuery({ text: `Already ${row.status}.` });
			return;
		}
		if (!(await canApprove(env, approver, row.user_dept, row.user_sub, row.user_id))) {
			await ctx.answerCallbackQuery({ text: 'Not authorised to action this.' });
			return;
		}

		if (action === 'reject') {
			const flipR = await env.depot_db
				.prepare(
					`UPDATE parade_change_requests
					 SET status = 'rejected', superior_user_id = ?, approved_at = datetime('now')
					 WHERE id = ? AND status = 'pending'`,
				)
				.bind(approver.id, changeId)
				.run();
			if ((flipR.meta.changes ?? 0) === 0) {
				await ctx.answerCallbackQuery({ text: 'Already handled.' });
				return;
			}
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			await resolveApprovalDms(env, 'parade_change_requests', 'approval_message_id', changeId, `❌ Late ${row.period} change rejected by ${approver.full_name}: ${row.user_name} on ${row.parade_state_date} → ${row.new_status}.`);
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.user_tid,
				text: `❌ Your late ${row.period} change for ${row.parade_state_date} (${row.new_status}) was rejected by ${approver.full_name}.`,
			});
			return;
		}

		// Approve: flip request status atomically first, then apply the change.
		const flipApprove = await env.depot_db
			.prepare(
				`UPDATE parade_change_requests
				 SET status = 'approved', superior_user_id = ?, approved_at = datetime('now')
				 WHERE id = ? AND status = 'pending'`,
			)
			.bind(approver.id, changeId)
			.run();
		if ((flipApprove.meta.changes ?? 0) === 0) {
			await ctx.answerCallbackQuery({ text: 'Already handled.' });
			return;
		}
		await env.depot_db
			.prepare(
				`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, parade_state_date, period)
				 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
			)
			.bind(row.user_id, row.parade_state_date, row.period, row.new_status, row.new_reason)
			.run();

		await ctx.answerCallbackQuery({ text: 'Approved.' });
		await resolveApprovalDms(env, 'parade_change_requests', 'approval_message_id', changeId, `✅ Late ${row.period} change approved by ${approver.full_name}: ${row.user_name} on ${row.parade_state_date} → ${row.new_status}.`);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.user_tid,
			text: `✅ Your late ${row.period} change for ${row.parade_state_date} (${row.new_status}) was approved by ${approver.full_name}.`,
			reply_markup: {
				inline_keyboard: [[{ text: '🪖 Open Parade page', web_app: { url: `${env.WEBAPP_URL}?tab=parade` } }]],
			},
		});
	});
}
