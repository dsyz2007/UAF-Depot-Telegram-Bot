// Inline-button handlers for off-request approval AND off-credit grant approval.
//
// Callback patterns:
//   off:approve:<id>    superior approves a user's off REQUEST → deducts credits
//   off:reject:<id>     superior rejects an off request
//   grant:approve:<id>  superior approves an off-credit GRANT → adds credits
//   grant:reject:<id>   superior rejects an off-credit grant

import type { Bot } from 'grammy';
import { tgSendMessage } from '../tg';
import { dayCountInclusive } from '../types';

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

interface GrantRow {
	id: number;
	user_id: number;
	num_days: number;
	reason: string;
	status: string;
	staff_name: string;
	staff_tid: string;
	granted_by_name: string;
	granted_by_tid: string;
}

export function registerOffCallbacks(bot: Bot, env: Env): void {
	// ────────── Off request approval ────────────────────────────────────
	bot.callbackQuery(/^off:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const offId = Number(ctx.match![2]);
		const superiorTid = String(ctx.from.id);

		const superior = await env.depot_db
			.prepare('SELECT id, full_name FROM users WHERE telegram_id = ?')
			.bind(superiorTid)
			.first<{ id: number; full_name: string }>();
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

		const days = dayCountInclusive(row.startdate, row.enddate);

		if (action === 'reject') {
			// Credits were reserved at request time — refund them on rejection.
			await env.depot_db.batch([
				env.depot_db
					.prepare(`UPDATE off_requests SET off_status = 'rejected', approved_by = ?, approved_date = datetime('now') WHERE id = ?`)
					.bind(superior.id, offId),
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, row.user_id),
			]);
			await ctx.editMessageText(
				`❌ ${row.requester_name}'s off (${row.startdate} → ${row.enddate}) — rejected by ${superior.full_name}.`,
			);
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.requester_tid,
				text: `❌ Your off request (${row.startdate} → ${row.enddate}) was rejected by ${superior.full_name}.\n🪙 ${days} credit(s) refunded.`,
			});
			return;
		}

		// Approve: credits were already reserved at request time, so just record
		// the approval (no further deduction).
		await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'approved', approved_by = ?, approved_date = datetime('now') WHERE id = ?`)
			.bind(superior.id, offId)
			.run();

		await ctx.editMessageText(
			`✅ ${row.requester_name}'s off (${row.startdate} → ${row.enddate}, ${days} day${days === 1 ? '' : 's'}) — approved by ${superior.full_name}.`,
		);
		await ctx.answerCallbackQuery({ text: 'Approved.' });
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `✅ Your off (${row.startdate} → ${row.enddate}) was approved by ${superior.full_name}.`,
		});
	});

	// ────────── Off-credit grant approval ───────────────────────────────
	bot.callbackQuery(/^grant:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const grantId = Number(ctx.match![2]);
		const approverTid = String(ctx.from.id);

		const approver = await env.depot_db
			.prepare('SELECT id, full_name FROM users WHERE telegram_id = ?')
			.bind(approverTid)
			.first<{ id: number; full_name: string }>();
		if (!approver) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status,
				        u.full_name AS staff_name, u.telegram_id AS staff_tid,
				        a.full_name AS granted_by_name, a.telegram_id AS granted_by_tid
				 FROM off_credit_grants g
				 JOIN users u ON u.id = g.user_id
				 JOIN users a ON a.id = g.granted_by
				 WHERE g.id = ?`,
			)
			.bind(grantId)
			.first<GrantRow>();
		if (!row) {
			await ctx.answerCallbackQuery({ text: 'Grant not found.' });
			return;
		}
		if (row.status !== 'pending_superior') {
			await ctx.answerCallbackQuery({ text: `Already ${row.status}.` });
			return;
		}

		// Recipients to notify, deduped — avoids double messages when the
		// recipient is also the granter and/or the approver (common in tests
		// and in self-credit flows). `approverTid` is declared above.
		const notify = (chatId: string, text: string, exclude: Set<string>) => {
			if (exclude.has(chatId)) return Promise.resolve();
			exclude.add(chatId);
			return tgSendMessage(env.BOT_TOKEN, { chat_id: chatId, text });
		};

		if (action === 'reject') {
			await env.depot_db
				.prepare(`UPDATE off_credit_grants SET status = 'rejected', superior_user_id = ? WHERE id = ?`)
				.bind(approver.id, grantId)
				.run();
			await ctx.editMessageText(
				`❌ Off-credit request rejected by ${approver.full_name}: ${row.staff_name} (${row.num_days} day[s]).`,
			);
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			const sent = new Set<string>([approverTid]); // approver already sees the edited msg
			await Promise.allSettled([
				notify(row.staff_tid, `❌ Your off-credit request (${row.num_days} day[s]) was rejected by ${approver.full_name}.`, sent),
				notify(row.granted_by_tid, `❌ Your off-credit request for ${row.staff_name} (${row.num_days} day[s]) was rejected by ${approver.full_name}.`, sent),
			]);
			return;
		}

		// Approve: add credits
		await env.depot_db.batch([
			env.depot_db
				.prepare(
					`UPDATE off_credit_grants
					 SET status = 'approved', superior_user_id = ?, approved_at = datetime('now')
					 WHERE id = ?`,
				)
				.bind(approver.id, grantId),
			env.depot_db
				.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`)
				.bind(row.num_days, row.user_id),
		]);

		const balanceAfter = await env.depot_db
			.prepare(`SELECT off_credits FROM users WHERE id = ?`)
			.bind(row.user_id)
			.first<{ off_credits: number }>();

		await ctx.editMessageText(
			`✅ Off-credit request approved by ${approver.full_name}: +${row.num_days} day(s) to ${row.staff_name}. Balance: ${balanceAfter?.off_credits ?? '?'}.`,
		);
		await ctx.answerCallbackQuery({ text: 'Approved.' });
		const sent = new Set<string>([approverTid]); // approver already sees the edited msg
		await Promise.allSettled([
			notify(
				row.staff_tid,
				`🪙 Off-credit request approved by ${approver.full_name}: +${row.num_days} day(s). Balance: ${balanceAfter?.off_credits ?? '?'}.\nReason: ${row.reason}`,
				sent,
			),
			notify(
				row.granted_by_tid,
				`✅ ${approver.full_name} approved the off-credit for ${row.staff_name}: +${row.num_days} day(s).`,
				sent,
			),
		]);
	});
}
