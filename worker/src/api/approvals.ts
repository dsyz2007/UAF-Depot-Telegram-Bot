// Consolidated approvals inbox. Lets a superior see every pending item they
// approve (offs, sick, off-credit grants, late parade changes) and approve /
// reject them — individually or in bulk ("Approve all").
//
// The approvers of an item are the appointment-holders (WOIC/2IC/PC) in the
// requester's unit; superadmins handle their own unit + orphan/no-appointment
// units. See canApprove() in superiors.ts.

import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { dayCountInclusive } from '../types';
import { canApprove, sameUnit, departmentsWithHolders } from '../superiors';
import { approveLeave, setParadeForLeave } from './leave';
import { setParadeForSick } from './sick';
import { setParadeForOff } from './off';
import { resolveApprovalDms, restoreApprovalDms } from '../approval-dms';
import { sgtToday } from '../holidays';

// Credit-days for an off request: half-day (AM/PM) = 0.5 per day, full day = 1.
function offCreditDays(start: string, end: string, period: string): number {
	const d = dayCountInclusive(start, end);
	return period === 'AM' || period === 'PM' ? d * 0.5 : d;
}

interface Dept {
	user_id: number;
	department: string | null;
	sub_department: string | null;
}
interface OffItem extends Dept {
	id: number;
	full_name: string;
	startdate: string;
	enddate: string;
	period: string;
	reason: string;
	days: number;
}
interface SickItem extends Dept {
	id: number;
	full_name: string;
	case_type: string;
	reason: string | null;
	created_at: string;
}
interface GrantItem extends Dept {
	id: number;
	full_name: string;
	num_days: number;
	reason: string;
}
interface ParadeItem extends Dept {
	id: number;
	full_name: string;
	parade_state_date: string;
	period: string;
	new_status: string;
	new_reason: string | null;
}
interface LeaveItem extends Dept {
	id: number;
	full_name: string;
	leave_type: string;
	period: string;
	startdate: string;
	enddate: string;
	reason: string | null;
}

function isSuperadmin(role: string): boolean {
	return role === 'superadmin';
}

export async function handleApprovals(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/approvals'.length);

	if (request.method === 'GET' && (sub === '' || sub === '/')) {
		// Pending requests, scope-selectable:
		//   ?scope = mine | dept | all
		//     • mine → requests I submitted that are still pending (DEFAULT for
		//              normal users, who can't approve anything)
		//     • dept → every pending request in my department (DEFAULT for approvers)
		//     • all  → every pending request (any department)
		// Each item carries can_action — whether THIS viewer may approve/reject it
		// (false = view-only, e.g. a superadmin viewing a unit whose own
		// appointment-holders are the proper approvers, or a normal user's own row).
		const canSeeOthers = user.user_role === 'admin' || user.user_role === 'superadmin' || !!user.appointment;
		const scopeParam = url.searchParams.get('scope');
		const defaultScope: 'mine' | 'dept' | 'all' = user.user_role === 'superadmin' ? 'all' : canSeeOthers ? 'dept' : 'mine';
		let scope: 'mine' | 'dept' | 'all' =
			scopeParam === 'mine' || scopeParam === 'dept' || scopeParam === 'all' ? scopeParam : defaultScope;
		if (!canSeeOthers) scope = 'mine'; // normal users only ever see their own

		const sc = ((): { clause: string; binds: (string | number)[] } => {
			if (scope === 'mine') return { clause: 'AND u.id = ?', binds: [user.id] };
			if (scope === 'dept') {
				return {
					clause: `AND u.department = ? AND IFNULL(u.sub_department,'') = IFNULL(?, '')`,
					binds: [user.department ?? '', user.sub_department ?? ''],
				};
			}
			return { clause: '', binds: [] };
		})();

		const offsRaw = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, u.full_name, u.department, u.sub_department, o.startdate, o.enddate, o.period, o.reason
				 FROM off_requests o JOIN users u ON u.id = o.user_id
				 WHERE o.off_status = 'pending' ${sc.clause} ORDER BY o.created_at`,
			)
			.bind(...sc.binds)
			.all<{ id: number; user_id: number; full_name: string; department: string | null; sub_department: string | null; startdate: string; enddate: string; period: string; reason: string }>();
		const sickRaw = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, u.full_name, u.department, u.sub_department, s.case_type, s.reason, s.created_at
				 FROM sick_cases s JOIN users u ON u.id = s.user_id
				 WHERE s.reportsick_status = 'pending_superior'
				   -- Drop stale pending reports whose date has already passed (the daily
				   -- runSickExpiry cron cancels them; this hides them immediately).
				   AND (s.sick_date IS NULL OR date(s.sick_date) >= date('now','+8 hours'))
				   ${sc.clause} ORDER BY s.created_at`,
			)
			.bind(...sc.binds)
			.all<SickItem>();
		const grantsRaw = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, u.full_name, u.department, u.sub_department, g.num_days, g.reason
				 FROM off_credit_grants g JOIN users u ON u.id = g.user_id
				 WHERE g.status = 'pending_superior' ${sc.clause} ORDER BY g.created_at`,
			)
			.bind(...sc.binds)
			.all<GrantItem>();
		const paradeRaw = await env.depot_db
			.prepare(
				`SELECT p.id, p.user_id, u.full_name, u.department, u.sub_department, p.parade_state_date, p.period, p.new_status, p.new_reason
				 FROM parade_change_requests p JOIN users u ON u.id = p.user_id
				 WHERE p.status = 'pending' ${sc.clause} ORDER BY p.created_at`,
			)
			.bind(...sc.binds)
			.all<{ id: number; user_id: number; full_name: string; department: string | null; sub_department: string | null; parade_state_date: string; period: string; new_status: string; new_reason: string | null }>();
		const leaveRaw = await env.depot_db
			.prepare(
				`SELECT l.id, l.user_id, u.full_name, u.department, u.sub_department, l.leave_type, l.period, l.startdate, l.enddate, l.reason
				 FROM leave_requests l JOIN users u ON u.id = l.user_id
				 WHERE l.status = 'pending' ${sc.clause} ORDER BY l.created_at`,
			)
			.bind(...sc.binds)
			.all<LeaveItem>();

		// Action authority, computed in batch (one query) to avoid a per-row probe.
		const holderDepts = await departmentsWithHolders(env);
		const isSuper = isSuperadmin(user.user_role);
		const appointed = !!user.appointment;
		const canActOn = (dept: string | null, subDept: string | null): boolean =>
			(appointed && sameUnit(user, dept, subDept)) || (isSuper && (dept == null || !holderDepts.has(dept)));
		const withAct = <T extends Dept>(rows: T[]): (T & { can_action: boolean })[] =>
			rows.map((r) => ({ ...r, can_action: canActOn(r.department, r.sub_department) }));

		const offItems = withAct(offsRaw.results ?? []).map((o) => ({ ...o, days: offCreditDays(o.startdate, o.enddate, o.period) }));
		return json({
			scope,
			offs: offItems,
			sick: withAct(sickRaw.results ?? []),
			grants: withAct(grantsRaw.results ?? []),
			parade: withAct(paradeRaw.results ?? []),
			leave: withAct(leaveRaw.results ?? []),
		});
	}

	// Recently approved OR rejected items (last 14 days), with a selectable scope.
	//   ?status = approved | rejected            (which list; default approved)
	//   ?scope  = mine | self | dept | all
	//     • mine → requests I SUBMITTED that were approved/rejected (DEFAULT for
	//              normal users — lets them track their own processed requests)
	//     • self → items I personally approved/rejected (any department — incl. my
	//              own dept when I really did it myself)
	//     • dept → every item for a requester in my department
	//              (incl. fellow appointment-holders' actions) — DEFAULT for approvers
	//     • all  → every department (items outside my remit are view-only)
	// Each item carries can_undo — whether THIS caller may undo it:
	//   appointment-holder (own unit) · superadmin (orphan / no-holder units) ·
	//   anyone who personally performed the action (so "self" items stay undoable).
	if (request.method === 'GET' && sub === '/recent') {
		const status: 'approved' | 'rejected' = url.searchParams.get('status') === 'rejected' ? 'rejected' : 'approved';
		const canSeeOthers = user.user_role === 'admin' || user.user_role === 'superadmin' || !!user.appointment;
		const scopeParam = url.searchParams.get('scope');
		const defaultScope: 'mine' | 'self' | 'dept' | 'all' = user.user_role === 'superadmin' ? 'all' : canSeeOthers ? 'dept' : 'mine';
		let scope: 'mine' | 'self' | 'dept' | 'all' =
			scopeParam === 'mine' || scopeParam === 'self' || scopeParam === 'all' || scopeParam === 'dept'
				? scopeParam
				: defaultScope;
		if (!canSeeOthers) scope = 'mine'; // normal users only ever see their own submissions
		const isSuper = isSuperadmin(user.user_role);
		const appointed = !!user.appointment;
		const holderDepts = await departmentsWithHolders(env);

		// Extra WHERE clause + binds restricting which rows come back, given the
		// row's actor column (who approved/rejected). `u` is the requester join.
		const scopeSql = (actorCol: string): { clause: string; binds: (string | number)[] } => {
			if (scope === 'mine') return { clause: 'AND u.id = ?', binds: [user.id] };
			if (scope === 'self') return { clause: `AND ${actorCol} = ?`, binds: [user.id] };
			if (scope === 'dept') {
				return {
					clause: `AND u.department = ? AND IFNULL(u.sub_department,'') = IFNULL(?, '')`,
					binds: [user.department ?? '', user.sub_department ?? ''],
				};
			}
			return { clause: '', binds: [] }; // 'all'
		};
		const canUndo = (dept: string | null, subDept: string | null, actorId: number | null): boolean =>
			(appointed && sameUnit(user, dept, subDept)) ||
			(isSuper && (dept == null || !holderDepts.has(dept))) ||
			(actorId != null && actorId === user.id);

		// Per-status column config (status value + actor column + timestamp column).
		const approved = status === 'approved';

		const offActor = approved ? 'o.approved_by' : 'o.rejected_by';
		const offAt = approved ? 'o.approved_date' : 'o.rejected_at';
		const offSt = approved ? "off_status = 'approved'" : "off_status = 'rejected'";
		const offScope = scopeSql(offActor);
		const offs = await env.depot_db
			.prepare(
				`SELECT o.id, u.full_name, u.department, u.sub_department, o.startdate, o.enddate, o.period, o.reason,
				        ${offAt} AS approved_date, ${offActor} AS actor_id, ab.full_name AS approved_by_name
				 FROM off_requests o JOIN users u ON u.id = o.user_id
				 LEFT JOIN users ab ON ab.id = ${offActor}
				 WHERE o.${offSt}
				   AND ${offAt} >= datetime('now','-14 days') ${offScope.clause}
				 ORDER BY ${offAt} DESC LIMIT 50`,
			)
			.bind(...offScope.binds)
			.all<{
				id: number; full_name: string; department: string | null; sub_department: string | null;
				startdate: string; enddate: string; period: string; reason: string;
				approved_date: string | null; actor_id: number | null; approved_by_name: string | null;
			}>();

		const sickActor = approved ? 's.superior_user_id' : 's.rejected_by';
		const sickAt = approved ? 's.approved_at' : 's.rejected_at';
		const sickSt = approved ? "reportsick_status IN ('approved','updated','flagged')" : "reportsick_status = 'rejected'";
		const sickScope = scopeSql(sickActor);
		const sick = await env.depot_db
			.prepare(
				`SELECT s.id, u.full_name, u.department, u.sub_department, s.case_type, s.reportsick_status, s.sick_date, s.reason,
				        ${sickAt} AS approved_at, s.updated_status, ${sickActor} AS actor_id, ab.full_name AS approved_by_name
				 FROM sick_cases s JOIN users u ON u.id = s.user_id
				 LEFT JOIN users ab ON ab.id = ${sickActor}
				 WHERE s.${sickSt}
				   AND ${sickAt} >= datetime('now','-14 days') ${sickScope.clause}
				 ORDER BY ${sickAt} DESC LIMIT 50`,
			)
			.bind(...sickScope.binds)
			.all<{
				id: number; full_name: string; department: string | null; sub_department: string | null;
				case_type: string; reportsick_status: string; sick_date: string | null; reason: string | null;
				approved_at: string | null; updated_status: string | null; actor_id: number | null; approved_by_name: string | null;
			}>();

		const grantActor = approved ? 'g.superior_user_id' : 'g.rejected_by';
		const grantAt = approved ? 'g.approved_at' : 'g.rejected_at';
		const grantSt = approved ? "status = 'approved'" : "status = 'rejected'";
		const grantScope = scopeSql(grantActor);
		const grants = await env.depot_db
			.prepare(
				`SELECT g.id, u.full_name, u.department, u.sub_department, g.num_days, g.reason,
				        ${grantAt} AS approved_at, ${grantActor} AS actor_id, ab.full_name AS approved_by_name
				 FROM off_credit_grants g JOIN users u ON u.id = g.user_id
				 LEFT JOIN users ab ON ab.id = ${grantActor}
				 WHERE g.${grantSt}
				   AND ${grantAt} >= datetime('now','-14 days') ${grantScope.clause}
				 ORDER BY ${grantAt} DESC LIMIT 50`,
			)
			.bind(...grantScope.binds)
			.all<{
				id: number; full_name: string; department: string | null; sub_department: string | null;
				num_days: number; reason: string; approved_at: string | null; actor_id: number | null; approved_by_name: string | null;
			}>();

		const leaveActor = approved ? 'l.approved_by' : 'l.rejected_by';
		const leaveAt = approved ? 'l.approved_at' : 'l.rejected_at';
		const leaveSt = approved ? "status = 'approved'" : "status = 'rejected'";
		const leaveScope = scopeSql(leaveActor);
		const leave = await env.depot_db
			.prepare(
				`SELECT l.id, u.full_name, u.department, u.sub_department, l.leave_type, l.period, l.startdate, l.enddate, l.reason,
				        ${leaveAt} AS approved_at, ${leaveActor} AS actor_id, ab.full_name AS approved_by_name
				 FROM leave_requests l JOIN users u ON u.id = l.user_id
				 LEFT JOIN users ab ON ab.id = ${leaveActor}
				 WHERE l.${leaveSt}
				   AND ${leaveAt} >= datetime('now','-14 days') ${leaveScope.clause}
				 ORDER BY ${leaveAt} DESC LIMIT 50`,
			)
			.bind(...leaveScope.binds)
			.all<{
				id: number; full_name: string; department: string | null; sub_department: string | null;
				leave_type: string; period: string; startdate: string; enddate: string; reason: string | null;
				approved_at: string | null; actor_id: number | null; approved_by_name: string | null;
			}>();

		// Strip the internal department/actor fields and attach can_undo.
		const offItems = (offs.results ?? []).map((o) => ({
			id: o.id, full_name: o.full_name, startdate: o.startdate, enddate: o.enddate, period: o.period,
			days: offCreditDays(o.startdate, o.enddate, o.period), reason: o.reason,
			approved_date: o.approved_date, approved_by_name: o.approved_by_name,
			can_undo: canUndo(o.department, o.sub_department, o.actor_id),
		}));
		const sickItems = (sick.results ?? []).map((s) => ({
			id: s.id, full_name: s.full_name, case_type: s.case_type, reportsick_status: s.reportsick_status,
			sick_date: s.sick_date, reason: s.reason, approved_at: s.approved_at, updated_status: s.updated_status,
			approved_by_name: s.approved_by_name, can_undo: canUndo(s.department, s.sub_department, s.actor_id),
		}));
		const grantItems = (grants.results ?? []).map((g) => ({
			id: g.id, full_name: g.full_name, num_days: g.num_days, reason: g.reason,
			approved_at: g.approved_at, approved_by_name: g.approved_by_name,
			can_undo: canUndo(g.department, g.sub_department, g.actor_id),
		}));
		const leaveItems = (leave.results ?? []).map((l) => ({
			id: l.id, full_name: l.full_name, leave_type: l.leave_type, period: l.period,
			startdate: l.startdate, enddate: l.enddate, reason: l.reason,
			approved_at: l.approved_at, approved_by_name: l.approved_by_name,
			can_undo: canUndo(l.department, l.sub_department, l.actor_id),
		}));
		return json({ status, scope, offs: offItems, sick: sickItems, grants: grantItems, leave: leaveItems });
	}

	// Un-reject: reopen a previously-REJECTED item back to pending, restoring the
	// side-effects rejection rolled back (re-reserve off credits, re-paint the
	// optimistic calendar entry). Authorised exactly like an approval (canApprove).
	if (request.method === 'POST' && sub === '/unreject') {
		const body = (await request.json()) as { type?: string; id?: number };
		const type = body.type;
		if (!Number.isInteger(body.id) || (type !== 'off' && type !== 'sick' && type !== 'grant' && type !== 'leave')) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		const result = await unrejectItem(env, user, type, body.id as number);
		return json(result, result.ok ? undefined : { status: result.status ?? 409 });
	}

	if (request.method === 'POST' && sub === '/act') {
		const body = (await request.json()) as {
			actions?: { type: 'off' | 'sick' | 'grant' | 'parade' | 'leave'; id: number; action: 'approve' | 'reject' }[];
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
// not authorised). (Off credits are reserved at request time, so there's no
// insufficient-credits skip here anymore.)
async function applyAction(
	env: Env,
	approver: AuthedContext['user'],
	type: 'off' | 'sick' | 'grant' | 'parade' | 'leave',
	id: number,
	action: 'approve' | 'reject',
): Promise<boolean> {
	if (type === 'leave') {
		const row = await env.depot_db
			.prepare(
				`SELECT l.id, l.user_id, l.status, u.department, u.sub_department
				 FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.id = ?`,
			)
			.bind(id)
			.first<{ id: number; user_id: number; status: string; department: string | null; sub_department: string | null }>();
		if (!row || row.status !== 'pending') return false;
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return false;
		const res = await approveLeave(env, approver, id, action);
		return res.ok;
	}
	if (type === 'off') {
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.period, o.superior_message_id,
				        u.full_name, u.telegram_id AS requester_tid, u.department, u.sub_department, u.off_credits
				 FROM off_requests o JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
			)
			.bind(id)
			.first<{
				id: number;
				user_id: number;
				off_status: string;
				startdate: string;
				enddate: string;
				period: string;
				superior_message_id: string | null;
				full_name: string;
				requester_tid: string;
				department: string | null;
				sub_department: string | null;
				off_credits: number;
			}>();
		if (!row || row.off_status !== 'pending') return false;
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return false;
		const range = `${row.startdate} → ${row.enddate}`;
		const days = offCreditDays(row.startdate, row.enddate, row.period);

		if (action === 'reject') {
			// Credits were reserved at request time — refund them on rejection.
			// Also blank any parade days the requester had marked OFF for this range,
			// scoped to the off's period (FD = both halves, AM/PM = that half).
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
			const flipReject = await env.depot_db
				.prepare(`UPDATE off_requests SET off_status='rejected', rejected_by=?, rejected_at=datetime('now') WHERE id=? AND off_status='pending'`)
				.bind(approver.id, id)
				.run();
			if ((flipReject.meta.changes ?? 0) === 0) return false;
			// Durable side-effects (refund + clear OFF) BEFORE the best-effort DM edit,
			// mirroring the chat-button path so ordering is consistent across paths.
			await env.depot_db.batch([
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, row.user_id),
				clearOff,
			]);
			await resolveApprovalDms(env, 'off_requests', 'superior_message_id', id, `❌ ${row.full_name}'s off (${range}) — rejected by ${approver.full_name}.`);
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.requester_tid,
				text: `❌ Your off request (${range}) was rejected by ${approver.full_name}.\n🪙 ${days} credit(s) refunded.\nYour parade status for ${range} is now blank (unfilled).`,
			});
			return true;
		}
		// Approve: credits already reserved at request time — just record it (atomic).
		const flipApprove = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status='approved', approved_by=?, approved_date=datetime('now') WHERE id=? AND off_status='pending'`)
			.bind(approver.id, id)
			.run();
		if ((flipApprove.meta.changes ?? 0) === 0) return false;
		await resolveApprovalDms(env, 'off_requests', 'superior_message_id', id, `✅ ${row.full_name}'s off (${range}, ${days} day${days === 1 ? '' : 's'}) — approved by ${approver.full_name}.`);
		// Reflect the approved off on the parade calendar (covers offs requested from
		// the Off page; parade-initiated ones are already painted — re-paint is a
		// harmless no-op).
		await setParadeForOff(env, row.user_id, row.department, row.startdate, row.enddate, row.period);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `✅ Your off (${range}) was approved by ${approver.full_name}.\nYour parade state for ${range} now shows OFF.`,
		});
		return true;
	}

	if (type === 'sick') {
		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.approval_message_id, s.sick_date,
				        u.full_name, u.telegram_id AS requester_tid, u.department, u.sub_department
				 FROM sick_cases s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
			)
			.bind(id)
			.first<{
				id: number;
				user_id: number;
				case_type: string;
				reportsick_status: string;
				approval_message_id: string | null;
				sick_date: string | null;
				full_name: string;
				requester_tid: string;
				department: string | null;
				sub_department: string | null;
			}>();
		if (!row || row.reportsick_status !== 'pending_superior') return false;
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return false;

		if (action === 'reject') {
			const flipSickR = await env.depot_db
				.prepare(`UPDATE sick_cases SET reportsick_status='rejected', rejected_by=?, rejected_at=datetime('now') WHERE id=? AND reportsick_status='pending_superior'`)
				.bind(approver.id, id)
				.run();
			if ((flipSickR.meta.changes ?? 0) === 0) return false;
			await resolveApprovalDms(env, 'sick_cases', 'approval_message_id', id, `❌ ${row.full_name}'s ${row.case_type} request — rejected by ${approver.full_name}.`);
			// Roll back the optimistic parade entry for that day (if still set).
			if (row.sick_date) {
				await env.depot_db
					.prepare(`DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date = ? AND parade_status = ?`)
					.bind(row.user_id, row.sick_date, row.case_type)
					.run();
			}
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.requester_tid,
				text: `❌ Your ${row.case_type} request was rejected by ${approver.full_name}.${row.sick_date ? `\nYour parade status for ${row.sick_date} is now blank (unfilled).` : ''}`,
			});
			return true;
		}
		const flipSickA = await env.depot_db
			.prepare(`UPDATE sick_cases SET reportsick_status='approved', superior_user_id=?, approved_at=datetime('now') WHERE id=? AND reportsick_status='pending_superior'`)
			.bind(approver.id, id)
			.run();
		if ((flipSickA.meta.changes ?? 0) === 0) return false;
		await resolveApprovalDms(env, 'sick_cases', 'approval_message_id', id, `✅ ${row.full_name}'s ${row.case_type} approved by ${approver.full_name}.`);
		// Schedule the 3h/6h personnel + 8h superior-flag reminders. For a case dated
		// LATER than today (i.e. reported for tomorrow), anchor the timers to 08:00
		// SGT of the sick day instead of approval time — so an evening approval
		// doesn't fire (and flag) the user the night before. 08:00 SGT = 00:00 UTC,
		// so the base is '<sick_date> 00:00:00'; a same-day case counts from 'now'.
		const anchor = row.sick_date && row.sick_date > sgtToday() ? `${row.sick_date} 00:00:00` : 'now';
		const stmt = env.depot_db.prepare(
			`INSERT INTO reminders (user_id, related_type, related_id, due_at, reminder_type)
			 VALUES (?, 'sick_case', ?, datetime(?, ?), ?)`,
		);
		await env.depot_db.batch([
			stmt.bind(row.user_id, id, anchor, '+3 hours', 'sick_update_personnel'),
			stmt.bind(row.user_id, id, anchor, '+6 hours', 'sick_update_personnel_2'),
			stmt.bind(row.user_id, id, anchor, '+8 hours', 'sick_update_superior_flag'),
		]);
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `✅ Your ${row.case_type} request was approved by ${approver.full_name}.\n\nOnce seen, update your status (MC days, dates, location, time) in Depot App → 🤒 Sick.\n\n📎 Got an MC? Just send the photo/PDF here in this chat (no upload in the app) — it auto-forwards to your superior.`,
			reply_markup: { inline_keyboard: [[{ text: '🤒 Open Sick page', web_app: { url: `${env.WEBAPP_URL}?tab=sick` } }]] },
		});
		return true;
	}

	if (type === 'grant') {
		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status, g.granted_by, g.approval_message_id,
				        u.telegram_id AS staff_tid, u.full_name AS staff_name, u.department, u.sub_department,
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
				department: string | null;
				sub_department: string | null;
				granter_tid: string;
			}>();
		if (!row || row.status !== 'pending_superior') return false;
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return false;

		if (action === 'reject') {
			const flipGrantR = await env.depot_db
				.prepare(`UPDATE off_credit_grants SET status='rejected', rejected_by=?, rejected_at=datetime('now') WHERE id=? AND status='pending_superior'`)
				.bind(approver.id, id)
				.run();
			if ((flipGrantR.meta.changes ?? 0) === 0) return false;
			await resolveApprovalDms(env, 'off_credit_grants', 'approval_message_id', id, `❌ Off-credit request rejected by ${approver.full_name}: ${row.staff_name} (${row.num_days} day[s]).`);
			const sent = new Set<string>([approver.telegram_id]);
			const notify = (tid: string, text: string) => (sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text })));
			await Promise.allSettled([
				notify(row.staff_tid, `❌ Your off-credit request (${row.num_days} day[s]) was rejected by ${approver.full_name}.`),
				notify(row.granter_tid, `❌ Off-credit request for ${row.staff_name} (${row.num_days} day[s]) was rejected by ${approver.full_name}.`),
			]);
			return true;
		}
		const flipGrantA = await env.depot_db
			.prepare(`UPDATE off_credit_grants SET status='approved', superior_user_id=?, approved_at=datetime('now') WHERE id=? AND status='pending_superior'`)
			.bind(approver.id, id)
			.run();
		if ((flipGrantA.meta.changes ?? 0) === 0) return false;
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(row.num_days, row.user_id).run();
		const bal = await env.depot_db.prepare(`SELECT off_credits FROM users WHERE id=?`).bind(row.user_id).first<{ off_credits: number }>();
		await resolveApprovalDms(env, 'off_credit_grants', 'approval_message_id', id, `✅ Off-credit request approved by ${approver.full_name}: +${row.num_days} day(s) to ${row.staff_name}. Balance: ${bal?.off_credits ?? '?'}.`);
		const sent = new Set<string>([approver.telegram_id]);
		const notify = (tid: string, text: string) => (sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text })));
		await Promise.allSettled([
			notify(row.staff_tid, `🪙 Off-credit request approved by ${approver.full_name}: +${row.num_days} day(s). Balance: ${bal?.off_credits ?? '?'}.`),
			notify(row.granter_tid, `✅ ${approver.full_name} approved the off-credit for ${row.staff_name}: +${row.num_days} day(s).`),
		]);
		return true;
	}

	if (type === 'parade') {
		const row = await env.depot_db
			.prepare(
				`SELECT p.id, p.user_id, p.parade_state_date, p.period, p.new_status, p.new_reason, p.status, p.approval_message_id,
				        u.full_name, u.telegram_id AS user_tid, u.department, u.sub_department
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
				department: string | null;
				sub_department: string | null;
			}>();
		if (!row || row.status !== 'pending') return false;
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return false;

		if (action === 'reject') {
			const flipParaR = await env.depot_db
				.prepare(`UPDATE parade_change_requests SET status='rejected', superior_user_id=?, approved_at=datetime('now') WHERE id=? AND status='pending'`)
				.bind(approver.id, id)
				.run();
			if ((flipParaR.meta.changes ?? 0) === 0) return false;
			await resolveApprovalDms(env, 'parade_change_requests', 'approval_message_id', id, `❌ ${row.full_name}'s late ${row.period} change for ${row.parade_state_date} (${row.new_status}) — rejected by ${approver.full_name}.`);
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.user_tid,
				text: `❌ Your late ${row.period} change for ${row.parade_state_date} (${row.new_status}) was rejected by ${approver.full_name}.`,
			});
			return true;
		}
		const flipParaA = await env.depot_db
			.prepare(`UPDATE parade_change_requests SET status='approved', superior_user_id=?, approved_at=datetime('now') WHERE id=? AND status='pending'`)
			.bind(approver.id, id)
			.run();
		if ((flipParaA.meta.changes ?? 0) === 0) return false;
		await resolveApprovalDms(env, 'parade_change_requests', 'approval_message_id', id, `✅ ${row.full_name}'s late ${row.period} change for ${row.parade_state_date} (${row.new_status}) — approved by ${approver.full_name}.`);
		await env.depot_db
			.prepare(
				`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, parade_state_date, period)
				 DO UPDATE SET parade_status = excluded.parade_status, reason = excluded.reason`,
			)
			.bind(row.user_id, row.parade_state_date, row.period, row.new_status, row.new_reason)
			.run();
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.user_tid,
			text: `✅ Your late ${row.period} change for ${row.parade_state_date} (${row.new_status}) was approved by ${approver.full_name}.`,
			reply_markup: { inline_keyboard: [[{ text: '🪖 Open Parade page', web_app: { url: `${env.WEBAPP_URL}?tab=parade` } }]] },
		});
		return true;
	}

	return false;
}

// Reopen a rejected item to pending, restoring rejection's side-effects.
// Returns { ok } on success, or { ok:false, error, status } to surface to the API.
type UnrejectResult = { ok: true; reopened: true } | { ok: false; error: string; status?: number };

async function unrejectItem(
	env: Env,
	approver: AuthedContext['user'],
	type: 'off' | 'sick' | 'grant' | 'leave',
	id: number,
): Promise<UnrejectResult> {
	if (type === 'off') {
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.period,
				        u.full_name AS requester_name, u.telegram_id AS requester_tid, u.department, u.sub_department
				 FROM off_requests o JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
			)
			.bind(id)
			.first<{ id: number; user_id: number; off_status: string; startdate: string; enddate: string; period: string; requester_name: string; requester_tid: string; department: string | null; sub_department: string | null }>();
		if (!row || row.off_status !== 'rejected') return { ok: false, error: 'not_rejected' };
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return { ok: false, error: 'forbidden', status: 403 };
		const flip = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status='pending', rejected_by=NULL, rejected_at=NULL WHERE id=? AND off_status='rejected'`)
			.bind(id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return { ok: false, error: 'not_rejected' };
		// Credits were refunded on rejection — re-reserve them now (matches request-time reservation).
		const days = offCreditDays(row.startdate, row.enddate, row.period);
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(days, row.user_id).run();
		const range = `${row.startdate} → ${row.enddate}`;
		// Re-arm the chat Approve/Reject buttons on every approver's DM.
		await restoreApprovalDms(env, 'off_requests', 'superior_message_id', id, `🟡 Off request (re-opened for approval): ${row.requester_name} — ${range}`, 'off');
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `↩ Your previously-rejected off request (${range}) was reopened for approval by ${approver.full_name}.\n🪙 ${days} credit(s) re-reserved pending the decision.`,
		});
		return { ok: true, reopened: true };
	}

	if (type === 'sick') {
		const row = await env.depot_db
			.prepare(
				`SELECT s.id, s.user_id, s.case_type, s.reportsick_status, s.sick_date,
				        u.full_name AS requester_name, u.telegram_id AS requester_tid, u.department, u.sub_department
				 FROM sick_cases s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
			)
			.bind(id)
			.first<{ id: number; user_id: number; case_type: string; reportsick_status: string; sick_date: string | null; requester_name: string; requester_tid: string; department: string | null; sub_department: string | null }>();
		if (!row || row.reportsick_status !== 'rejected') return { ok: false, error: 'not_rejected' };
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return { ok: false, error: 'forbidden', status: 403 };
		const flip = await env.depot_db
			.prepare(`UPDATE sick_cases SET reportsick_status='pending_superior', rejected_by=NULL, rejected_at=NULL WHERE id=? AND reportsick_status='rejected'`)
			.bind(id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return { ok: false, error: 'not_rejected' };
		// Re-show optimistically on the calendar (it was blanked on rejection).
		if (row.sick_date) await setParadeForSick(env, row.user_id, row.department, row.sick_date, row.case_type);
		await restoreApprovalDms(env, 'sick_cases', 'approval_message_id', id, `🟡 ${row.case_type} request (re-opened for approval): ${row.requester_name}`, 'sick');
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `↩ Your previously-rejected ${row.case_type} was reopened for approval by ${approver.full_name}.`,
		});
		return { ok: true, reopened: true };
	}

	if (type === 'grant') {
		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.status,
				        u.full_name AS staff_name, u.telegram_id AS requester_tid, u.department, u.sub_department
				 FROM off_credit_grants g JOIN users u ON u.id = g.user_id WHERE g.id = ?`,
			)
			.bind(id)
			.first<{ id: number; user_id: number; num_days: number; status: string; staff_name: string; requester_tid: string; department: string | null; sub_department: string | null }>();
		if (!row || row.status !== 'rejected') return { ok: false, error: 'not_rejected' };
		if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return { ok: false, error: 'forbidden', status: 403 };
		const flip = await env.depot_db
			.prepare(`UPDATE off_credit_grants SET status='pending_superior', rejected_by=NULL, rejected_at=NULL WHERE id=? AND status='rejected'`)
			.bind(id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return { ok: false, error: 'not_rejected' };
		// Grants only add credits on approval, so there's nothing to restore here.
		await restoreApprovalDms(env, 'off_credit_grants', 'approval_message_id', id, `🟡 Off-credit request (re-opened for approval): ${row.staff_name} (+${row.num_days} day(s))`, 'grant');
		await tgSendMessage(env.BOT_TOKEN, {
			chat_id: row.requester_tid,
			text: `↩ Your previously-rejected off-credit request (+${row.num_days} day[s]) was reopened for approval by ${approver.full_name}.`,
		});
		return { ok: true, reopened: true };
	}

	// leave (and MA, which rides the same table)
	const row = await env.depot_db
		.prepare(
			`SELECT l.id, l.user_id, l.leave_type, l.period, l.startdate, l.enddate, l.reason, l.status,
			        u.full_name AS requester_name, u.telegram_id AS requester_tid, u.department, u.sub_department
			 FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.id = ?`,
		)
		.bind(id)
		.first<{ id: number; user_id: number; leave_type: string; period: 'AM' | 'PM' | 'FD'; startdate: string; enddate: string; reason: string | null; status: string; requester_name: string; requester_tid: string; department: string | null; sub_department: string | null }>();
	if (!row || row.status !== 'rejected') return { ok: false, error: 'not_rejected' };
	if (!(await canApprove(env, approver, row.department, row.sub_department, row.user_id))) return { ok: false, error: 'forbidden', status: 403 };
	const flip = await env.depot_db
		.prepare(`UPDATE leave_requests SET status='pending', rejected_by=NULL, rejected_at=NULL WHERE id=? AND status='rejected'`)
		.bind(id)
		.run();
	if ((flip.meta.changes ?? 0) === 0) return { ok: false, error: 'not_rejected' };
	// Re-paint the optimistic leave on the calendar (blanked on rejection).
	await setParadeForLeave(env, row.user_id, row.department, row.startdate, row.enddate, row.leave_type, row.reason, row.period);
	const noun = row.leave_type === 'MA' ? '' : ' leave';
	const range = row.startdate === row.enddate ? row.startdate : `${row.startdate} → ${row.enddate}`;
	await restoreApprovalDms(env, 'leave_requests', 'superior_message_id', id, `${row.leave_type === 'MA' ? '🩺 MA' : '🏖 Leave'} request (re-opened for approval): ${row.requester_name} — ${range}`, 'leave');
	await tgSendMessage(env.BOT_TOKEN, {
		chat_id: row.requester_tid,
		text: `↩ Your previously-rejected ${row.leave_type}${noun} (${range}) was reopened for approval by ${approver.full_name}.`,
	});
	return { ok: true, reopened: true };
}
