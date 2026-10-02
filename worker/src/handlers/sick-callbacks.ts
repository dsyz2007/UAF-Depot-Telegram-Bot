// Inline Approve/Reject on a sick-case DM to a superior.
// On approve: set status=approved, enqueue 3 reminders (3h, 6h, 8h), DM personnel.
// On reject:  set status=rejected, DM personnel.

import type { Bot } from 'grammy';
import { tgSendMessage } from '../tg';
import { canApprove } from '../superiors';
import { resolveApprovalDms } from '../approval-dms';
import { sgtToday } from '../holidays';

interface SickRow {
	id: number;
	user_id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	sick_date: string | null;
	period: string | null;
	personnel_name: string;
	personnel_tid: string;
	dept: string | null;
	sub: string | null;
}

export function registerSickCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^sick:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const sickId = Number(ctx.match![2]);
		const superiorTid = String(ctx.from.id);

		const superior = await env.depot_db
			.prepare('SELECT id, full_name, user_role, appointment, department, sub_department FROM users WHERE telegram_id = ?')
			.bind(superiorTid)
			.first<{ id: number; full_name: string; user_role: string; appointment: string | null; department: string | null; sub_department: string | null }>();
		if (!superior) {
			await ctx.answerCallbackQuery({ text: 'You are not registered.' });
			return;
		}

		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.sick_date, s.period,
				        u.full_name AS personnel_name, u.telegram_id AS personnel_tid,
				        u.department AS dept, u.sub_department AS sub
				 FROM sick_cases s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
			)
			.bind(sickId)
			.first<SickRow>();
		if (!row) {
			await ctx.answerCallbackQuery({ text: 'Case not found.' });
			return;
		}
		if (row.reportsick_status !== 'pending_superior') {
			await ctx.answerCallbackQuery({ text: `Already ${row.reportsick_status}.` });
			return;
		}
		if (!(await canApprove(env, superior, row.dept, row.sub, row.user_id))) {
			await ctx.answerCallbackQuery({ text: 'Not authorised to action this.' });
			return;
		}

		if (action === 'reject') {
			const flipR = await env.depot_db
				.prepare(`UPDATE sick_cases SET reportsick_status = 'rejected', rejected_by = ?, rejected_at = datetime('now') WHERE id = ? AND reportsick_status = 'pending_superior'`)
				.bind(superior.id, sickId)
				.run();
			if ((flipR.meta.changes ?? 0) === 0) {
				await ctx.answerCallbackQuery({ text: 'Already handled.' });
				return;
			}
			// Roll back the optimistic parade entry for that day (if still set).
			if (row.sick_date) {
				await env.depot_db
					.prepare(`DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date = ? AND parade_status = ?`)
					.bind(row.user_id, row.sick_date, row.case_type)
					.run();
			}
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			await resolveApprovalDms(env, 'sick_cases', 'approval_message_id', sickId, `❌ ${row.personnel_name}'s ${row.case_type} request was rejected by ${superior.full_name}.`);
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.personnel_tid,
				text: `❌ Your ${row.case_type} request was rejected by ${superior.full_name}.${row.sick_date ? `\nYour parade status for ${row.sick_date} is now blank (unfilled).` : ''}`,
			});
			return;
		}

		// Approve flow: atomic flip first, then enqueue 3 reminders.
		const flipA = await env.depot_db
			.prepare(
				`UPDATE sick_cases
				 SET reportsick_status = 'approved', superior_user_id = ?, approved_at = datetime('now')
				 WHERE id = ? AND reportsick_status = 'pending_superior'`,
			)
			.bind(superior.id, sickId)
			.run();
		if ((flipA.meta.changes ?? 0) === 0) {
			await ctx.answerCallbackQuery({ text: 'Already handled.' });
			return;
		}

		// D1 supports batched prepared statements — one round-trip. For a case dated
		// later than today (reported for tomorrow), anchor the timers to the START of
		// the reported half-day so an evening approval doesn't flag the user the night
		// before: AM/FD → 08:00 SGT (= 00:00 UTC), PM → 12:00 SGT (= 04:00 UTC). A
		// same-day case counts from approval ('now').
		const anchorTime = row.period === 'PM' ? '04:00:00' : '00:00:00';
		const anchor = row.sick_date && row.sick_date > sgtToday() ? `${row.sick_date} ${anchorTime}` : 'now';
		const stmt = env.depot_db.prepare(
			`INSERT INTO reminders (user_id, related_type, related_id, due_at, reminder_type)
			 VALUES (?, 'sick_case', ?, datetime(?, ?), ?)`,
		);
		await env.depot_db.batch([
			stmt.bind(row.user_id, sickId, anchor, '+3 hours', 'sick_update_personnel'),
			stmt.bind(row.user_id, sickId, anchor, '+6 hours', 'sick_update_personnel_2'),
			stmt.bind(row.user_id, sickId, anchor, '+8 hours', 'sick_update_superior_flag'),
		]);

		await ctx.answerCallbackQuery({ text: 'Approved.' });
		await resolveApprovalDms(env, 'sick_cases', 'approval_message_id', sickId, `✅ ${row.personnel_name}'s ${row.case_type} approved by ${superior.full_name}.`);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.personnel_tid,
			text: `✅ Your ${row.case_type} request was approved by ${superior.full_name}.\n\nOnce seen, update your status (MC days, dates, medicine) in Depot App → 🤒 Sick.\n\n📎 Got an MC? Just send the photo/PDF here in this chat (no upload in the app). It auto-forwards to your superior.`,
			reply_markup: {
				inline_keyboard: [[{ text: '🤒 Open Sick page', web_app: { url: `${env.WEBAPP_URL}?tab=sick` } }]],
			},
		});
	});
}
