// When a registered user sends a photo or document to the bot, attach it as
// the MC for their latest active RSI/RSO case (stored as a Telegram file_id —
// the bytes stay on Telegram's servers, nothing lands in D1/R2). If the user
// has a distinct superior, the MC is auto-forwarded to them.

import type { Bot } from 'grammy';

export function registerMcUpload(bot: Bot, env: Env): void {
	bot.on(['message:photo', 'message:document'], async (ctx) => {
		const from = ctx.from;
		if (!from) return;
		const uploaderTid = String(from.id);

		const user = await env.depot_db
			.prepare('SELECT id, full_name, telegram_id FROM users WHERE telegram_id = ?')
			.bind(uploaderTid)
			.first<{ id: number; full_name: string; telegram_id: string }>();
		if (!user) {
			await ctx.reply('You are not registered. Send /start first.');
			return;
		}

		// Attach to the most recent case that's expecting an MC.
		const sickCase = await env.depot_db
			.prepare(
				`SELECT sc.id, sc.case_type, sc.sick_date, su.telegram_id AS superior_tid
				 FROM sick_cases sc
				 LEFT JOIN users su ON su.id = sc.superior_user_id
				 WHERE sc.user_id = ? AND sc.reportsick_status IN ('approved','flagged','updated')
				 ORDER BY sc.id DESC LIMIT 1`,
			)
			.bind(user.id)
			.first<{ id: number; case_type: string; sick_date: string | null; superior_tid: string | null }>();
		if (!sickCase) {
			await ctx.reply('No active RSI/RSO case to attach this to. Report sick in the depot app first.');
			return;
		}

		// Pull the file_id. For photos, the last array element is the largest size.
		let fileId: string | undefined;
		let fileType: 'photo' | 'document' | undefined;
		if (ctx.message.photo && ctx.message.photo.length > 0) {
			fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
			fileType = 'photo';
		} else if (ctx.message.document) {
			fileId = ctx.message.document.file_id;
			fileType = 'document';
		}
		if (!fileId || !fileType) return;

		await env.depot_db
			.prepare('UPDATE sick_cases SET mc_file_id = ?, mc_file_type = ? WHERE id = ?')
			.bind(fileId, fileType, sickCase.id)
			.run();

		await ctx.reply(`📎 MC received and attached to your ${sickCase.case_type} case${sickCase.sick_date ? ` (for ${sickCase.sick_date})` : ''}.`);

		// Auto-forward to the superior who approved the case, if distinct —
		// copyMessage preserves the original photo/document and adds a caption.
		const superiorTid = sickCase.superior_tid;
		if (superiorTid && superiorTid !== uploaderTid) {
			try {
				await ctx.api.copyMessage(superiorTid, ctx.chat.id, ctx.message.message_id, {
					caption: `📎 MC from ${user.full_name} (${sickCase.case_type}${sickCase.sick_date ? ` for ${sickCase.sick_date}` : ''}).`,
				});
			} catch (e) {
				console.error('MC forward failed', e);
			}
		}
	});
}
