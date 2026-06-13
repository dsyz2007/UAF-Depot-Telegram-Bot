// Inline-button handlers for Leave-request approval.
//
//   leave:approve:<id>   superior approves a leave request
//   leave:reject:<id>    superior rejects it (parade entry reverted)
//
// The DM to the leave-taker (incl. the OneNS reminder on approval) is sent by
// approveLeave(); here we just edit the approver's message + ack the tap.

import type { Bot } from 'grammy';
import { approveLeave } from '../api/leave';
import { canApprove } from '../superiors';

export function registerLeaveCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^leave:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const id = Number(ctx.match![2]);
		const approverTid = String(ctx.from.id);

		const approver = await env.depot_db
			.prepare('SELECT id, full_name, telegram_id, user_role, appointment, department, sub_department FROM users WHERE telegram_id = ?')
			.bind(approverTid)
			.first<{ id: number; full_name: string; telegram_id: string; user_role: string; appointment: string | null; department: string | null; sub_department: string | null }>();
		if (!approver) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		// Authorize against the requester's unit (mirrors the in-app inbox).
		const lr = await env.depot_db
			.prepare(`SELECT l.user_id, l.status, u.department, u.sub_department FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.id = ?`)
			.bind(id)
			.first<{ user_id: number; status: string; department: string | null; sub_department: string | null }>();
		if (!lr || lr.status !== 'pending') {
			await ctx.answerCallbackQuery({ text: 'Already handled or not found.' });
			return;
		}
		if (!(await canApprove(env, approver, lr.department, lr.sub_department, lr.user_id))) {
			await ctx.answerCallbackQuery({ text: 'Not authorised to action this.' });
			return;
		}

		const res = await approveLeave(env, approver, id, action);
		if (!res.ok) {
			await ctx.answerCallbackQuery({ text: 'Already handled or not found.' });
			return;
		}
		// MA rides the same flow but isn't "leave" — drop the word for it.
		const noun = res.leave_type === 'MA' ? '' : ' leave';
		await ctx.editMessageText(
			action === 'approve'
				? `✅ ${res.leave_type}${noun} (${res.range}) — approved by ${approver.full_name}.`
				: `❌ ${res.leave_type}${noun} (${res.range}) — rejected by ${approver.full_name}.`,
		);
		await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Approved.' : 'Rejected.' });
	});
}
