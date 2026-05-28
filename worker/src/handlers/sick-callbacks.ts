// Inline Approve/Reject on a sick-case DM to a superior.
// On approve: set status=approved, enqueue 3 reminders (3h, 6h, 8h), DM personnel.
// On reject:  set status=rejected, DM personnel.

import type { Bot } from 'grammy';
import { tgSendMessage } from '../tg';

interface SickRow {
	id: number;
	user_id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	personnel_name: string;
	personnel_tid: string;
}

export function registerSickCallbacks(bot: Bot, env: Env): void {
	bot.callbackQuery(/^sick:(approve|reject):(\d+)$/, async (ctx) => {
		const action = ctx.match![1] as 'approve' | 'reject';
		const sickId = Number(ctx.match![2]);
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
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status,
				        u.full_name AS personnel_name, u.telegram_id AS personnel_tid
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

		if (action === 'reject') {
			await env.depot_db
				.prepare('UPDATE sick_cases SET reportsick_status = ? WHERE id = ?')
				.bind('rejected', sickId)
				.run();
			await ctx.editMessageText(`❌ ${row.personnel_name}'s ${row.case_type} request was rejected by ${superior.full_name}.`);
			await ctx.answerCallbackQuery({ text: 'Rejected.' });
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.personnel_tid,
				text: `❌ Your ${row.case_type} request has been rejected by ${superior.full_name}.`,
			});
			return;
		}

		// Approve flow: set approved + enqueue 3 reminders.
		await env.depot_db
			.prepare(
				`UPDATE sick_cases
				 SET reportsick_status = 'approved', superior_user_id = ?, approved_at = datetime('now')
				 WHERE id = ?`,
			)
			.bind(superior.id, sickId)
			.run();

		// D1 supports batched prepared statements — one round-trip.
		const stmt = env.depot_db.prepare(
			`INSERT INTO reminders (user_id, related_type, related_id, due_at, reminder_type)
			 VALUES (?, 'sick_case', ?, datetime('now', ?), ?)`,
		);
		await env.depot_db.batch([
			stmt.bind(row.user_id, sickId, '+3 hours', 'sick_update_personnel'),
			stmt.bind(row.user_id, sickId, '+6 hours', 'sick_update_personnel_2'),
			stmt.bind(row.user_id, sickId, '+8 hours', 'sick_update_superior_flag'),
		]);

		await ctx.editMessageText(`✅ ${row.personnel_name}'s ${row.case_type} approved by ${superior.full_name}.`);
		await ctx.answerCallbackQuery({ text: 'Approved.' });
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.personnel_tid,
			text: `✅ Your ${row.case_type} request was approved by ${superior.full_name}.\n\nOnce seen, update your status (MC days, dates, medicine) in Depot App → 🤒 Sick.`,
		});
	});
}
