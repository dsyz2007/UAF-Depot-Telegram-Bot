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
import { canApprove } from '../superiors';

// Half-day (AM/PM) off costs 0.5 credits per day; full day (FD) costs 1.
function offDays(start: string, end: string, period: string): number {
	const d = dayCountInclusive(start, end);
	return period === 'AM' || period === 'PM' ? d * 0.5 : d;
}

interface OffRow {
	id: number;
	user_id: number;
	requester_name: string;
	requester_tid: string;
	requester_dept: string | null;
	requester_sub: string | null;
	startdate: string;
	enddate: string;
	period: string;
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
	staff_dept: string | null;
	staff_sub: string | null;
	granted_by_name: string;
	granted_by_tid: string;
}

// Approver row with the fields canApprove() needs.
interface Approver {
	id: number;
	full_name: string;
	user_role: string;
	appointment: string | null;
	department: string | null;
	sub_department: string | null;
}
const APPROVER_COLS = 'id, full_name, user_role, appointment, department, sub_department';

export function registerOffCallbacks(bot: Bot, env: Env): void {
	// ────────── Off request approval ────────────────────────────────────
	bot.callbackQuery(/^off:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const offId = Number(ctx.match![2]);
		const superiorTid = String(ctx.from.id);

		const superior = await env.depot_db
			.prepare(`SELECT ${APPROVER_COLS} FROM users WHERE telegram_id = ?`)
			.bind(superiorTid)
			.first<Approver>();
		if (!superior) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.startdate, o.enddate, o.period, o.reason, o.off_status,
				        u.full_name AS requester_name, u.telegram_id AS requester_tid,
				        u.department AS requester_dept, u.sub_department AS requester_sub
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
		if (!(await canApprove(env, superior, row.requester_dept, row.requester_sub, row.user_id))) {
			await ctx.answerCallbackQuery({ text: 'Not authorised to action this.' });
			return;
		}

		const days = offDays(row.startdate, row.enddate, row.period);
		const periodSuffix = row.period === 'AM' || row.period === 'PM' ? ` (${row.period} only)` : '';

		if (action === 'reject') {
			// Credits were reserved at request time — refund them on rejection. Also
			// blank parade OFF days for this range, scoped to the off's period.
			const range = `${row.startdate} → ${row.enddate}`;
			const halfDay = row.period === 'AM' || row.period === 'PM';
			const clearOff = halfDay
				? env.depot_db
						.prepare(
							`DELETE FROM parade_state_entries
							 WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF' AND period = ?`,
						)
						.bind(row.user_id, row.startdate, row.enddate, row.period)
				: env.depot_db
						.prepare(
							`DELETE FROM parade_state_entries
							 WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF'`,
						)
						.bind(row.user_id, row.startdate, row.enddate);
			// Atomic flip — only the first actor (chat vs in-app) proceeds to refund.
			const flip = await env.depot_db
				.prepare(`UPDATE off_requests SET off_status = 'rejected', rejected_by = ?, rejected_at = datetime('now') WHERE id = ? AND off_status = 'pending'`)
				.bind(superior.id, offId)
				.run();
			if ((flip.meta.changes ?? 0) === 0) {
				await ctx.answerCallbackQuery({ text: 'Already handled.' });
				return;
			}
			await env.depot_db.batch([
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, row.user_id),
				clearOff,
			]);
			await ctx.editMessageText(`❌ ${row.requester_name}'s off (${range})${periodSuffix} — rejected by ${superior.full_name}.`);
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.requester_tid,
				text: `❌ Your off request (${range})${periodSuffix} was rejected by ${superior.full_name}.\n🪙 ${days} credit(s) refunded.\nYour parade status for ${range} is now blank (unfilled).`,
			});
			return;
		}

		// Approve: credits were already reserved at request time, so just record
		// the approval (atomic flip so a double-tap can't double-process).
		const flipA = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'approved', approved_by = ?, approved_date = datetime('now') WHERE id = ? AND off_status = 'pending'`)
			.bind(superior.id, offId)
			.run();
		if ((flipA.meta.changes ?? 0) === 0) {
			await ctx.answerCallbackQuery({ text: 'Already handled.' });
			return;
		}

		await ctx.editMessageText(
			`✅ ${row.requester_name}'s off (${row.startdate} → ${row.enddate}, ${days} day${days === 1 ? '' : 's'})${periodSuffix} — approved by ${superior.full_name}.`,
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
			.prepare(`SELECT ${APPROVER_COLS} FROM users WHERE telegram_id = ?`)
			.bind(approverTid)
			.first<Approver>();
		if (!approver) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status,
				        u.full_name AS staff_name, u.telegram_id AS staff_tid,
				        u.department AS staff_dept, u.sub_department AS staff_sub,
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
		if (!(await canApprove(env, approver, row.staff_dept, row.staff_sub, row.user_id))) {
			await ctx.answerCallbackQuery({ text: 'Not authorised to action this.' });
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
			const flipR = await env.depot_db
				.prepare(`UPDATE off_credit_grants SET status = 'rejected', rejected_by = ?, rejected_at = datetime('now') WHERE id = ? AND status = 'pending_superior'`)
				.bind(approver.id, grantId)
				.run();
			if ((flipR.meta.changes ?? 0) === 0) {
				await ctx.answerCallbackQuery({ text: 'Already handled.' });
				return;
			}
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

		// Approve: atomic flip first, then credit — so a double-tap can't double-add.
		const flipApprove = await env.depot_db
			.prepare(
				`UPDATE off_credit_grants
				 SET status = 'approved', superior_user_id = ?, approved_at = datetime('now')
				 WHERE id = ? AND status = 'pending_superior'`,
			)
			.bind(approver.id, grantId)
			.run();
		if ((flipApprove.meta.changes ?? 0) === 0) {
			await ctx.answerCallbackQuery({ text: 'Already handled.' });
			return;
		}
		await env.depot_db
			.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`)
			.bind(row.num_days, row.user_id)
			.run();

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
