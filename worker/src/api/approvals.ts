// Consolidated approvals inbox. Lets a superior see every pending item they
// approve (offs, sick, off-credit grants, late parade changes) and approve /
// reject them — individually or in bulk ("Approve all").
//
// The approver of an item is the requester's superior_telegram_id. Superadmins
// may action any pending item.

import { json, type AuthedContext } from './router';
import { tgSendMessage, tgEditMessageText } from '../tg';
import { dayCountInclusive } from '../types';

// After an inbox approve/reject, rewrite the original per-request DM (if we have
// its chat + message id) so its inline buttons disappear — keeps chat in sync
// with the app. Best-effort: silently ignores missing ids / edit failures.
async function syncChatMessage(
	env: Env,
	chatTid: string | null,
	messageId: string | null,
	text: string,
): Promise<void> {
	if (!chatTid || !messageId) return;
	try {
		await tgEditMessageText(env.BOT_TOKEN, chatTid, messageId, text);
	} catch {
		// message too old / already edited / wrong chat — ignore
	}
}

interface OffItem {
	id: number;
	full_name: string;
	startdate: string;
	enddate: string;
	reason: string;
	days: number;
}
interface SickItem {
	id: number;
	full_name: string;
	case_type: string;
	created_at: string;
}
interface GrantItem {
	id: number;
	full_name: string;
	num_days: number;
	reason: string;
}
interface ParadeItem {
	id: number;
	full_name: string;
	parade_state_date: string;
	period: string;
	new_status: string;
	new_reason: string | null;
}

function isSuperadmin(role: string): boolean {
	return role === 'superadmin';
}

export async function handleApprovals(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/approvals'.length);

	// Items where I'm one of the approvers. Superadmins see all pending items.
	const meTid = user.telegram_id;
	const superClause = isSuperadmin(user.user_role)
		? ''
		: 'AND (u.superior_telegram_id = ? OR u.superior_telegram_id_2 = ?)';
	const bindTid = (stmt: D1PreparedStatement) => (isSuperadmin(user.user_role) ? stmt : stmt.bind(meTid, meTid));

	if (request.method === 'GET' && (sub === '' || sub === '/')) {
		const offs = await bindTid(
			env.depot_db.prepare(
				`SELECT o.id, u.full_name, o.startdate, o.enddate, o.reason
				 FROM off_requests o JOIN users u ON u.id = o.user_id
				 WHERE o.off_status = 'pending' ${superClause}
				 ORDER BY o.created_at`,
			),
		).all<{ id: number; full_name: string; startdate: string; enddate: string; reason: string }>();

		const sick = await bindTid(
			env.depot_db.prepare(
				`SELECT s.id, u.full_name, s.case_type, s.created_at
				 FROM sick_cases s JOIN users u ON u.id = s.user_id
				 WHERE s.reportsick_status = 'pending_superior' ${superClause}
				 ORDER BY s.created_at`,
			),
		).all<SickItem>();

		const grants = await bindTid(
			env.depot_db.prepare(
				`SELECT g.id, u.full_name, g.num_days, g.reason
				 FROM off_credit_grants g JOIN users u ON u.id = g.user_id
				 WHERE g.status = 'pending_superior' ${superClause}
				 ORDER BY g.created_at`,
			),
		).all<GrantItem>();

		const parade = await bindTid(
			env.depot_db.prepare(
				`SELECT p.id, u.full_name, p.parade_state_date, p.period, p.new_status, p.new_reason
				 FROM parade_change_requests p JOIN users u ON u.id = p.user_id
				 WHERE p.status = 'pending' ${superClause}
				 ORDER BY p.created_at`,
			),
		).all<ParadeItem>();

		const offItems: OffItem[] = (offs.results ?? []).map((o) => ({ ...o, days: dayCountInclusive(o.startdate, o.enddate) }));
		return json({
			offs: offItems,
			sick: sick.results ?? [],
			grants: grants.results ?? [],
			parade: parade.results ?? [],
		});
	}

	// Recently-approved items the caller may UNDO: sick cases + credit grants
	// they approved (superadmin sees all), within the last 14 days.
	if (request.method === 'GET' && sub === '/recent') {
		const isSuper = isSuperadmin(user.user_role);
		const offClause = isSuper ? '' : 'AND o.approved_by = ?';
		const offStmt = env.depot_db.prepare(
			`SELECT o.id, u.full_name, o.startdate, o.enddate, o.approved_date
			 FROM off_requests o JOIN users u ON u.id = o.user_id
			 WHERE o.off_status = 'approved'
			   AND o.approved_date >= datetime('now','-14 days') ${offClause}
			 ORDER BY o.approved_date DESC LIMIT 50`,
		);
		const offs = await (isSuper ? offStmt : offStmt.bind(user.id)).all<{
			id: number;
			full_name: string;
			startdate: string;
			enddate: string;
			approved_date: string | null;
		}>();
		const sickClause = isSuper ? '' : 'AND s.superior_user_id = ?';
		const sickStmt = env.depot_db.prepare(
			`SELECT s.id, u.full_name, s.case_type, s.reportsick_status, s.approved_at, s.updated_status
			 FROM sick_cases s JOIN users u ON u.id = s.user_id
			 WHERE s.reportsick_status IN ('approved','updated','flagged')
			   AND s.approved_at >= datetime('now','-14 days') ${sickClause}
			 ORDER BY s.approved_at DESC LIMIT 50`,
		);
		const sick = await (isSuper ? sickStmt : sickStmt.bind(user.id)).all<{
			id: number;
			full_name: string;
			case_type: string;
			reportsick_status: string;
			approved_at: string | null;
			updated_status: string | null;
		}>();
		const grantClause = isSuper ? '' : 'AND g.superior_user_id = ?';
		const grantStmt = env.depot_db.prepare(
			`SELECT g.id, u.full_name, g.num_days, g.reason, g.approved_at
			 FROM off_credit_grants g JOIN users u ON u.id = g.user_id
			 WHERE g.status = 'approved'
			   AND g.approved_at >= datetime('now','-14 days') ${grantClause}
			 ORDER BY g.approved_at DESC LIMIT 50`,
		);
		const grants = await (isSuper ? grantStmt : grantStmt.bind(user.id)).all<{
			id: number;
			full_name: string;
			num_days: number;
			reason: string;
			approved_at: string | null;
		}>();
		const offItems = (offs.results ?? []).map((o) => ({ ...o, days: dayCountInclusive(o.startdate, o.enddate) }));
		return json({ offs: offItems, sick: sick.results ?? [], grants: grants.results ?? [] });
	}

	if (request.method === 'POST' && sub === '/act') {
		const body = (await request.json()) as {
			actions?: { type: 'off' | 'sick' | 'grant' | 'parade'; id: number; action: 'approve' | 'reject' }[];
		};
		const actions = Array.isArray(body.actions) ? body.actions : [];
		if (actions.length === 0) return json({ error: 'no_actions' }, { status: 400 });

		let done = 0;
		const errors: { type: string; id: number; error: string }[] = [];
		for (const a of actions) {
			try {
				const ok = await applyAction(env, user, a.type, a.id, a.action);
				if (ok) done++;
				else errors.push({ type: a.type, id: a.id, error: 'skipped' });
			} catch (e) {
				errors.push({ type: a.type, id: a.id, error: e instanceof Error ? e.message : String(e) });
			}
		}
		return json({ ok: true, done, errors });
	}

	return json({ error: 'not_found' }, { status: 404 });
}

// Returns true if the action was applied, false if skipped (not pending /
// not authorised / insufficient credits etc.).
async function applyAction(
	env: Env,
	approver: AuthedContext['user'],
	type: 'off' | 'sick' | 'grant' | 'parade',
	id: number,
	action: 'approve' | 'reject',
): Promise<boolean> {
	const isSuper = isSuperadmin(approver.user_role);

	if (type === 'off') {
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.superior_message_id,
				        u.full_name, u.telegram_id AS requester_tid, u.superior_telegram_id, u.superior_telegram_id_2, u.off_credits
				 FROM off_requests o JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
			)
			.bind(id)
			.first<{
				id: number;
				user_id: number;
				off_status: string;
				startdate: string;
				enddate: string;
				superior_message_id: string | null;
				full_name: string;
				requester_tid: string;
				superior_telegram_id: string | null;
				superior_telegram_id_2: string | null;
				off_credits: number;
			}>();
		if (!row || row.off_status !== 'pending') return false;
		if (!isSuper && row.superior_telegram_id !== approver.telegram_id && row.superior_telegram_id_2 !== approver.telegram_id) return false;
		const range = `${row.startdate} → ${row.enddate}`;
		const days = dayCountInclusive(row.startdate, row.enddate);

		if (action === 'reject') {
			// Credits were reserved at request time — refund them on rejection.
			await env.depot_db.batch([
				env.depot_db
					.prepare(`UPDATE off_requests SET off_status='rejected', approved_by=?, approved_date=datetime('now') WHERE id=?`)
					.bind(approver.id, id),
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, row.user_id),
			]);
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.requester_tid,
				text: `❌ Your off request (${range}) was rejected by ${approver.full_name}.\n🪙 ${days} credit(s) refunded.`,
			});
			await syncChatMessage(env, row.superior_telegram_id, row.superior_message_id, `❌ ${row.full_name}'s off (${range}) — rejected by ${approver.full_name}.`);
			return true;
		}
		// Approve: credits already reserved at request time — just record it.
		await env.depot_db
			.prepare(`UPDATE off_requests SET off_status='approved', approved_by=?, approved_date=datetime('now') WHERE id=?`)
			.bind(approver.id, id)
			.run();
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `✅ Your off (${range}) was approved by ${approver.full_name}.`,
		});
		await syncChatMessage(env, row.superior_telegram_id, row.superior_message_id, `✅ ${row.full_name}'s off (${range}, ${days}d) — approved by ${approver.full_name}.`);
		return true;
	}

	if (type === 'sick') {
		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.approval_message_id,
				        u.full_name, u.telegram_id AS requester_tid, u.superior_telegram_id, u.superior_telegram_id_2
				 FROM sick_cases s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
			)
			.bind(id)
			.first<{
				id: number;
				user_id: number;
				case_type: string;
				reportsick_status: string;
				approval_message_id: string | null;
				full_name: string;
				requester_tid: string;
				superior_telegram_id: string | null;
				superior_telegram_id_2: string | null;
			}>();
		if (!row || row.reportsick_status !== 'pending_superior') return false;
		if (!isSuper && row.superior_telegram_id !== approver.telegram_id && row.superior_telegram_id_2 !== approver.telegram_id) return false;

		if (action === 'reject') {
			await env.depot_db
				.prepare(`UPDATE sick_cases SET reportsick_status='rejected' WHERE id=?`)
				.bind(id)
				.run();
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.requester_tid,
				text: `❌ Your ${row.case_type} request has been rejected by ${approver.full_name}.`,
			});
			await syncChatMessage(env, row.superior_telegram_id, row.approval_message_id, `❌ ${row.full_name}'s ${row.case_type} request was rejected by ${approver.full_name}.`);
			return true;
		}
		await env.depot_db
			.prepare(`UPDATE sick_cases SET reportsick_status='approved', superior_user_id=?, approved_at=datetime('now') WHERE id=?`)
			.bind(approver.id, id)
			.run();
		// Schedule the 3h/6h personnel + 8h superior-flag reminders.
		const stmt = env.depot_db.prepare(
			`INSERT INTO reminders (user_id, related_type, related_id, due_at, reminder_type)
			 VALUES (?, 'sick_case', ?, datetime('now', ?), ?)`,
		);
		await env.depot_db.batch([
			stmt.bind(row.user_id, id, '+3 hours', 'sick_update_personnel'),
			stmt.bind(row.user_id, id, '+6 hours', 'sick_update_personnel_2'),
			stmt.bind(row.user_id, id, '+8 hours', 'sick_update_superior_flag'),
		]);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `✅ Your ${row.case_type} request was approved by ${approver.full_name}.\n\nOnce seen, update your status (MC days, dates, location, time) in Depot App → 🤒 Sick.`,
			reply_markup: { inline_keyboard: [[{ text: '🤒 Open Sick page', web_app: { url: `${env.WEBAPP_URL}?tab=sick` } }]] },
		});
		await syncChatMessage(env, row.superior_telegram_id, row.approval_message_id, `✅ ${row.full_name}'s ${row.case_type} approved by ${approver.full_name}.`);
		return true;
	}

	if (type === 'grant') {
		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status, g.granted_by, g.approval_message_id,
				        u.telegram_id AS staff_tid, u.full_name AS staff_name, u.superior_telegram_id, u.superior_telegram_id_2,
				        gr.telegram_id AS granter_tid
				 FROM off_credit_grants g JOIN users u ON u.id = g.user_id
				 JOIN users gr ON gr.id = g.granted_by WHERE g.id = ?`,
			)
			.bind(id)
			.first<{
				id: number;
				user_id: number;
				num_days: number;
				reason: string;
				status: string;
				approval_message_id: string | null;
				staff_tid: string;
				staff_name: string;
				superior_telegram_id: string | null;
				superior_telegram_id_2: string | null;
				granter_tid: string;
			}>();
		if (!row || row.status !== 'pending_superior') return false;
		if (!isSuper && row.superior_telegram_id !== approver.telegram_id && row.superior_telegram_id_2 !== approver.telegram_id) return false;

		if (action === 'reject') {
			await env.depot_db
				.prepare(`UPDATE off_credit_grants SET status='rejected', superior_user_id=? WHERE id=?`)
				.bind(approver.id, id)
				.run();
			const sent = new Set<string>([approver.telegram_id]);
			const notify = (tid: string, text: string) => (sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text })));
			await Promise.allSettled([
				notify(row.staff_tid, `❌ Your off-credit request (${row.num_days} day[s]) was rejected by ${approver.full_name}.`),
				notify(row.granter_tid, `❌ Off-credit request for ${row.staff_name} (${row.num_days} day[s]) was rejected by ${approver.full_name}.`),
			]);
			await syncChatMessage(env, row.superior_telegram_id, row.approval_message_id, `❌ Off-credit request rejected by ${approver.full_name}: ${row.staff_name} (${row.num_days} day[s]).`);
			return true;
		}
		await env.depot_db.batch([
			env.depot_db
				.prepare(`UPDATE off_credit_grants SET status='approved', superior_user_id=?, approved_at=datetime('now') WHERE id=?`)
				.bind(approver.id, id),
			env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(row.num_days, row.user_id),
		]);
		const bal = await env.depot_db.prepare(`SELECT off_credits FROM users WHERE id=?`).bind(row.user_id).first<{ off_credits: number }>();
		const sent = new Set<string>([approver.telegram_id]);
		const notify = (tid: string, text: string) => (sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text })));
		await Promise.allSettled([
			notify(row.staff_tid, `🪙 Off-credit request approved by ${approver.full_name}: +${row.num_days} day(s). Balance: ${bal?.off_credits ?? '?'}.`),
			notify(row.granter_tid, `✅ ${approver.full_name} approved the off-credit for ${row.staff_name}: +${row.num_days} day(s).`),
		]);
		await syncChatMessage(env, row.superior_telegram_id, row.approval_message_id, `✅ Off-credit request approved by ${approver.full_name}: +${row.num_days} day(s) to ${row.staff_name}. Balance: ${bal?.off_credits ?? '?'}.`);
		return true;
	}

	if (type === 'parade') {
		const row = await env.depot_db
			.prepare(
				`SELECT p.id, p.user_id, p.parade_state_date, p.period, p.new_status, p.new_reason, p.status, p.approval_message_id,
				        u.full_name, u.telegram_id AS user_tid, u.superior_telegram_id, u.superior_telegram_id_2
				 FROM parade_change_requests p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
			)
			.bind(id)
			.first<{
				id: number;
				user_id: number;
				parade_state_date: string;
				period: string;
				new_status: string;
				new_reason: string | null;
				status: string;
				approval_message_id: string | null;
				full_name: string;
				user_tid: string;
				superior_telegram_id: string | null;
				superior_telegram_id_2: string | null;
			}>();
		if (!row || row.status !== 'pending') return false;
		if (!isSuper && row.superior_telegram_id !== approver.telegram_id && row.superior_telegram_id_2 !== approver.telegram_id) return false;

		if (action === 'reject') {
			await env.depot_db
				.prepare(`UPDATE parade_change_requests SET status='rejected', superior_user_id=?, approved_at=datetime('now') WHERE id=?`)
				.bind(approver.id, id)
				.run();
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.user_tid,
				text: `❌ Your late ${row.period} change for ${row.parade_state_date} (${row.new_status}) was rejected by ${approver.full_name}.`,
			});
			await syncChatMessage(env, row.superior_telegram_id, row.approval_message_id, `❌ Late ${row.period} change rejected by ${approver.full_name}: ${row.full_name} on ${row.parade_state_date} → ${row.new_status}.`);
			return true;
		}
		await env.depot_db.batch([
			env.depot_db
				.prepare(
					`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(user_id, parade_state_date, period)
					 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
				)
				.bind(row.user_id, row.parade_state_date, row.period, row.new_status, row.new_reason),
			env.depot_db
				.prepare(`UPDATE parade_change_requests SET status='approved', superior_user_id=?, approved_at=datetime('now') WHERE id=?`)
				.bind(approver.id, id),
		]);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.user_tid,
			text: `✅ Your late ${row.period} change for ${row.parade_state_date} (${row.new_status}) was approved by ${approver.full_name}.`,
			reply_markup: { inline_keyboard: [[{ text: '🪖 Open Parade page', web_app: { url: `${env.WEBAPP_URL}?tab=parade` } }]] },
		});
		await syncChatMessage(env, row.superior_telegram_id, row.approval_message_id, `✅ Late ${row.period} change approved by ${approver.full_name}: ${row.full_name} on ${row.parade_state_date} → ${row.new_status}.`);
		return true;
	}

	return false;
}
