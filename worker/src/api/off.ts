import { json, type AuthedContext } from './router';
import { tgSendMessage } from '../tg';
import { dayCountInclusive, autoApprovesOwn, periodsOverlap } from '../types';
import { approverTidsFor, sameUnit, departmentsWithHolders, isHqHolder } from '../superiors';
import { getRangeWorkInfo, slotWorking } from '../holidays';
import { packApprovalMsgs, resolveApprovalDms, restoreApprovalDms, type MsgPair } from '../approval-dms';

function expandRange(start: string, end: string): string[] {
	const out: string[] = [];
	const cur = new Date(`${start}T00:00:00Z`);
	const stop = new Date(`${end}T00:00:00Z`);
	while (cur <= stop && out.length < 95) {
		out.push(cur.toISOString().slice(0, 10));
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

// Paint the parade calendar OFF for an approved off — every working slot of the
// off's period(s) in the range, for the requester's department. Idempotent
// (upsert). This makes an off requested from the OFF PAGE show on the calendar
// once it's approved; offs initiated from the parade calendar are already painted
// at submit time, so re-painting them here is a harmless no-op.
export async function setParadeForOff(
	env: Env,
	userId: number,
	dept: string | null,
	start: string,
	end: string,
	period: string,
): Promise<void> {
	const dates = expandRange(start, end);
	const info = await getRangeWorkInfo(env, dates);
	const periods: ('AM' | 'PM')[] = period === 'AM' || period === 'PM' ? [period] : ['AM', 'PM'];
	const stmt = env.depot_db.prepare(
		`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
		 VALUES (?, ?, ?, 'OFF', NULL)
		 ON CONFLICT(user_id, parade_state_date, period)
		 DO UPDATE SET parade_status = 'OFF', reason = NULL
		   WHERE parade_state_entries.parade_status NOT IN ('RSI','RSO','MC')`,
	);
	const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
	for (const d of dates) {
		const di = info.get(d);
		if (!di) continue;
		for (const p of periods) {
			if (slotWorking(di, dept, p)) ops.push(stmt.bind(userId, d, p));
		}
	}
	if (ops.length) await env.depot_db.batch(ops);
}

// ── Mass-action helpers (superadmin Mass Credit / Mass Apply) ───────────────
interface MassTarget {
	id: number;
	full_name: string;
	telegram_id: string;
	off_credits: number;
	department: string | null;
	sub_department: string | null;
}

const unitKey = (d: string | null, s: string | null) => `${d ?? ''}|${s ?? ''}`;

// Paint OFF on the parade calendar for MANY users at once — one work-info fetch
// for the range, then all upserts pushed through chunked batches (each batch is a
// single D1 round-trip) so even a whole-depot apply stays well within the
// 50-subrequest/invocation Free-tier cap. Mirrors setParadeForOff's preserve rules.
async function bulkPaintOff(env: Env, targets: MassTarget[], dates: string[], period: string): Promise<void> {
	if (!targets.length) return;
	const info = await getRangeWorkInfo(env, dates);
	const periods: ('AM' | 'PM')[] = period === 'AM' || period === 'PM' ? [period] : ['AM', 'PM'];
	const stmt = env.depot_db.prepare(
		`INSERT INTO parade_state_entries (user_id, parade_state_date, period, parade_status, reason)
		 VALUES (?, ?, ?, 'OFF', NULL)
		 ON CONFLICT(user_id, parade_state_date, period)
		 DO UPDATE SET parade_status = 'OFF', reason = NULL
		   WHERE parade_state_entries.parade_status NOT IN ('RSI','RSO','MC')`,
	);
	const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
	for (const t of targets) {
		for (const d of dates) {
			const di = info.get(d);
			if (!di) continue;
			for (const p of periods) if (slotWorking(di, t.department, p)) ops.push(stmt.bind(t.id, d, p));
		}
	}
	for (let i = 0; i < ops.length; i += 100) await env.depot_db.batch(ops.slice(i, i + 100));
}

// Tell each appointment-holder, in ONE summary DM, that mass-routed requests are
// waiting in their in-app inbox. Bounded by the number of distinct holders (not by
// the number of requests) so it never fans out — the inbox is the source of truth.
async function notifyRoutedHolders(env: Env, routed: MassTarget[], label: string, initiatorName: string): Promise<void> {
	if (!routed.length) return;
	const { results: holders } = await env.depot_db
		.prepare(`SELECT telegram_id, department, sub_department FROM users WHERE appointment IN ('WOIC','2IC','PC') AND full_name NOT LIKE 'PENDING:%'`)
		.all<{ telegram_id: string; department: string | null; sub_department: string | null }>();
	const byUnit = new Map<string, string[]>();
	for (const h of holders ?? []) {
		const k = unitKey(h.department, h.sub_department);
		(byUnit.get(k) ?? byUnit.set(k, []).get(k)!).push(h.telegram_id);
	}
	const countByTid = new Map<string, number>();
	for (const t of routed) {
		const tids = byUnit.get(unitKey(t.department, t.sub_department)) ?? [];
		for (const tid of new Set(tids)) countByTid.set(tid, (countByTid.get(tid) ?? 0) + 1);
	}
	await Promise.allSettled(
		[...countByTid.entries()].map(([tid, n]) =>
			tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `📋 ${n} ${label} from a mass action by ${initiatorName} await your approval. Open the depot app → 🗂 Pending to review (you can Approve all).`,
			}),
		),
	);
}

interface SummaryRow {
	id: number;
	full_name: string;
	off_credits: number;
	department: string | null;
	sub_department: string | null;
	personnel_type: string | null;
	user_role: string;
}

interface DetailRow {
	id: number;
	startdate: string;
	enddate: string;
	period: string;
	reason: string;
	approved_date: string | null;
	approved_by_id: number | null;
	approved_by_name: string | null;
	off_status: string;
}

interface MyOffRow extends DetailRow {
	requester_id: number;
}

interface GrantRow {
	id: number;
	user_id: number;
	num_days: number;
	reason: string;
	status: string;
	granted_by_name: string | null;
	approved_by_name: string | null;
	approved_by_id: number | null;
	granted_by?: number;
	created_at: string;
	approved_at: string | null;
}

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isAdminish(role: string): boolean {
	return role === 'admin' || role === 'superadmin';
}

// Credit-days for an off request: a half-day (AM/PM) costs 0.5 per day in the
// range, a full day (FD) costs 1.
function offDays(start: string, end: string, period: string): number {
	const d = dayCountInclusive(start, end);
	return period === 'AM' || period === 'PM' ? d * 0.5 : d;
}
function periodSuffix(period: string): string {
	return period === 'AM' || period === 'PM' ? ` (${period} only)` : '';
}
// "+2" / "-1.5" — credit amounts may be negative (a deduction).
function signed(n: number): string {
	return n >= 0 ? `+${n}` : `${n}`;
}

// An off-credit grant as loaded for a requester-side withdraw (see withdrawGrant).
interface WithdrawableGrant {
	id: number;
	user_id: number;
	num_days: number;
	status: string;
	staff_tid: string;
	staff_name: string;
	approver_tid: string | null;
}

// Withdraw an off-credit grant on behalf of its REQUESTER (granted_by) — the grant
// analogue of cancelling your own off: it disappears (→ cancelled) rather than
// reopening. An approved grant's credit change is reversed with a plain
// subtraction (mirrors /grant/revert, so a negative grant reverses too); a
// rejected one is just a private dismiss. Returns false if the row moved on first
// (atomic flip guarded on the observed state, so a race can't double-reverse).
async function withdrawGrant(env: Env, user: AuthedContext['user'], row: WithdrawableGrant): Promise<boolean> {
	const flip = await env.depot_db
		.prepare(`UPDATE off_credit_grants SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ? AND status = ?`)
		.bind(user.id, row.id, row.status)
		.run();
	if ((flip.meta.changes ?? 0) === 0) return false;
	if (row.status === 'rejected') return true; // never touched the balance; DMs already say "rejected"

	const wasApproved = row.status === 'approved';
	let balance: number | null = null;
	if (wasApproved) {
		const b = await env.depot_db
			.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ? RETURNING off_credits`)
			.bind(row.num_days, row.user_id)
			.first<{ off_credits: number }>();
		balance = b?.off_credits ?? null;
	}
	const amt = `${signed(row.num_days)} day(s)`;
	const forWhom = row.user_id === user.id ? '' : ` for ${row.staff_name}`;
	// Clears any live Approve/Reject buttons (pending) / rewrites the outcome (approved).
	await resolveApprovalDms(env, 'off_credit_grants', 'approval_message_id', row.id, `🚫 ${user.full_name}'s off-credit request${forWhom} (${amt}) — withdrawn by requester.${wasApproved ? ' Credit change reversed.' : ''} No action needed.`);
	const sent = new Set<string>([user.telegram_id]);
	const notify = (tid: string | null, text: string) =>
		!tid || sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text }));
	await Promise.allSettled([
		wasApproved ? notify(row.approver_tid, `🚫 ${user.full_name} cancelled the off-credit${forWhom} (${amt}) that you approved — the credit change was reversed.`) : null,
		notify(
			row.staff_tid,
			wasApproved
				? `🚫 ${user.full_name} cancelled the off-credit (${amt}) they put through for you — it has been reversed.${balance != null ? ` Balance: ${balance}.` : ''}`
				: `🚫 ${user.full_name} withdrew their pending off-credit proposal for you (${amt}).`,
		),
	]);
	return true;
}

export async function handleOff(actx: AuthedContext): Promise<Response> {
	const { url, request, env, user } = actx;
	const sub = url.pathname.slice('/api/off'.length);

	// -------- read ---------------------------------------------------------
	if (request.method === 'GET' && sub === '/summary') {
		// Just users + credit balance + department. We no longer surface
		// "taken X" so the JOIN with off_requests is removed — saves reads.
		const { results } = await env.depot_db
			.prepare(
				`SELECT id, full_name, off_credits, department, sub_department, personnel_type, user_role
				 FROM users
				 WHERE full_name NOT LIKE 'PENDING:%'
				 ORDER BY full_name`,
			)
			.all<SummaryRow>();
		return json(results ?? []);
	}

	if (request.method === 'GET' && sub === '/user') {
		const id = Number(url.searchParams.get('id'));
		if (!Number.isInteger(id)) return json({ error: 'bad_id' }, { status: 400 });
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.id, o.startdate, o.enddate, o.period, o.reason, o.approved_date, o.off_status,
				        a.id AS approved_by_id, a.full_name AS approved_by_name
				 FROM off_requests o
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.user_id = ? AND o.off_status = 'approved'
				 ORDER BY o.startdate DESC`,
			)
			.bind(id)
			.all<DetailRow>();
		return json(results ?? []);
	}

	// Approved off-CREDIT grants for one person (the credit side of their off
	// ledger). Same 2-year retention as take-offs; surfaced lazily when a person
	// is opened in the Off page. Indexed by (user_id) so it reads only their rows.
	if (request.method === 'GET' && sub === '/user-credits') {
		const id = Number(url.searchParams.get('id'));
		if (!Number.isInteger(id)) return json({ error: 'bad_id' }, { status: 400 });
		const { results } = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status, g.created_at, g.approved_at,
				        ab.id AS approved_by_id,
				        gr.full_name AS granted_by_name, ab.full_name AS approved_by_name
				 FROM off_credit_grants g
				 LEFT JOIN users gr ON gr.id = g.granted_by
				 LEFT JOIN users ab ON ab.id = g.superior_user_id
				 WHERE g.user_id = ? AND g.status = 'approved'
				 ORDER BY g.id DESC`,
			)
			.bind(id)
			.all<GrantRow>();
		return json(results ?? []);
	}

	if (request.method === 'GET' && sub === '/mine') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT o.id, o.startdate, o.enddate, o.period, o.reason, o.off_status,
				        o.approved_date, o.requested_by_user_id AS requester_id,
				        a.id AS approved_by_id, a.full_name AS approved_by_name
				 FROM off_requests o
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.user_id = ?
				 AND o.off_status != 'cancelled' -- a cancel/dismiss removes it from "My recent requests"
				 ORDER BY o.startdate DESC LIMIT 50`,
			)
			.bind(user.id)
			.all<MyOffRow>();
		return json(results ?? []);
	}

	// My credit grants (pending + recent history)
	if (request.method === 'GET' && sub === '/grants/mine') {
		const { results } = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.num_days, g.reason, g.status,
				        g.created_at, g.approved_at, g.granted_by,
				        gr.full_name AS granted_by_name
				 FROM off_credit_grants g
				 LEFT JOIN users gr ON gr.id = g.granted_by
				 WHERE g.user_id = ?
				 ORDER BY g.id DESC LIMIT 30`,
			)
			.bind(user.id)
			.all<GrantRow>();
		return json(results ?? []);
	}

	// -------- request off (uses credits) -----------------------------------
	if (request.method === 'POST' && sub === '/request') {
		const body = (await request.json()) as { startdate?: string; enddate?: string; reason?: string; period?: string };
		if (!isValidDate(body.startdate) || !isValidDate(body.enddate)) {
			return json({ error: 'invalid_body' }, { status: 400 });
		}
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });
		// Guard against a fat-fingered year deducting thousands of credits.
		if (dayCountInclusive(body.startdate, body.enddate) > 95) return json({ error: 'range_too_long' }, { status: 400 });

		// Reason is OPTIONAL for an off request. (off_requests.reason is NOT NULL, so
		// store '' when omitted.) Crediting off-days keeps its own compulsory reason.
		const reason = body.reason?.trim() || '';
		// Half-day (AM/PM) costs 0.5 credits per day; full day (FD) costs 1.
		const period = body.period === 'AM' || body.period === 'PM' ? body.period : 'FD';
		const days = offDays(body.startdate, body.enddate, period);
		const range = `${body.startdate} → ${body.enddate}`;
		// Off-credit balance is allowed to go negative — no sufficiency block.

		// Dedup: refuse if this user already has an overlapping pending/approved off
		// for the same half/period. Prevents (a) an auto-approver nullifying a
		// superior's revert by simply resubmitting (the reverted off is back to
		// 'pending', so it blocks here), and (b) double-reserving credits / duplicate
		// inbox items from an accidental re-request. A rejected/cancelled/reverted-
		// then-cleared off is NOT in this set, so a denied request can be retried.
		const { results: dupRows } = await env.depot_db
			.prepare(
				`SELECT id, period FROM off_requests
				 WHERE user_id = ? AND off_status IN ('pending','approved')
				   AND startdate <= ? AND enddate >= ?`,
			)
			.bind(user.id, body.enddate, body.startdate)
			.all<{ id: number; period: string }>();
		const clash = (dupRows ?? []).find((d) => periodsOverlap(d.period, period));
		if (clash) return json({ error: 'overlapping_request', id: clash.id }, { status: 409 });

		// No negative balances: a take-off can't cost more credits than the person
		// currently has (credits are reserved at request time). This also prevents
		// painting OFF on the parade calendar for an unaffordable range — the parade
		// OFF needs this backing request, which we're refusing here.
		if (days > user.off_credits) {
			return json({ error: 'insufficient_credits', balance: user.off_credits, needed: days }, { status: 409 });
		}

		// Self-managed users and appointment-holders skip approval — the off is
		// recorded as approved immediately and credits deducted.
		if (autoApprovesOwn(user)) {
			await env.depot_db.batch([
				env.depot_db
					.prepare(
						`INSERT INTO off_requests
						   (user_id, requested_by_user_id, startdate, enddate, period, reason, off_status, approved_by, approved_date)
						 VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'))`,
					)
					.bind(user.id, user.id, body.startdate, body.enddate, period, reason, user.id),
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(days, user.id),
			]);
			// Auto-approved → reflect OFF on the parade calendar right away.
			await setParadeForOff(env, user.id, user.department, body.startdate, body.enddate, period);
			return json({ ok: true, auto_approved: true, days_requested: days, balance_after: user.off_credits - days });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO off_requests
				   (user_id, requested_by_user_id, startdate, enddate, period, reason, off_status)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending')
				 RETURNING id`,
			)
			.bind(user.id, user.id, body.startdate, body.enddate, period, reason)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Reserve the credits NOW (at request time), not on approval — so a user
		// can't queue several pending requests that together exceed their balance.
		// Refunded if the request is rejected or cancelled.
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(days, user.id).run();

		// Optimistically paint OFF on the parade calendar right away (pending), like
		// sick/leave already do. setParadeForOff skips RSI/RSO/MC cells; reject, cancel
		// and the daily expiry all blank these OFF cells again.
		await setParadeForOff(env, user.id, user.department, body.startdate, body.enddate, period);

		// Per-request DM with inline Approve/Reject to EACH superior (either may
		// action). We store ALL their (chat,msg) pairs so that when one decides, the
		// callback / in-app action edits EVERY copy (see resolveApprovalDms).
		const approverTids = await approverTidsFor(env, user);
		const msgPairs: MsgPair[] = [];
		for (const tid of approverTids) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🟡 <b>Off request</b>\n${user.full_name}: ${range} (${days} day${days === 1 ? '' : 's'})${periodSuffix(period)}\nBalance (credits already reserved): ${user.off_credits - days}${reason ? `\nReason: ${reason}` : ''}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `off:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `off:reject:${ins.id}` },
						],
					],
				},
			});
			if (msg?.message_id) msgPairs.push([tid, String(msg.message_id)]);
		}
		if (msgPairs.length) {
			await env.depot_db.prepare('UPDATE off_requests SET superior_message_id = ? WHERE id = ?').bind(packApprovalMsgs(msgPairs), ins.id).run();
		}
		return json({ ok: true, id: ins.id, days_requested: days, balance_after: user.off_credits - days });
	}

	// -------- credit offs (self or admin→staff, needs superior approval) --
	if (request.method === 'POST' && sub === '/grant') {
		const body = (await request.json()) as {
			staff_id?: number | string;
			num_days?: number | string;
			reason?: string;
		};
		// Coerce robustly: num_days / staff_id may arrive as a number OR a numeric
		// string (older cached bundles, locale quirks). Fractional credits are
		// allowed (e.g. 3.5 for half-days) — rounded to 1 decimal place. Precise
		// errors so failures are diagnosable instead of a generic invalid_body.
		const sid = Number(body.staff_id);
		const targetId = Number.isInteger(sid) && sid > 0 ? sid : user.id;
		const rawDays = Number(body.num_days);
		const days = Number.isFinite(rawDays) ? Math.round(rawDays * 10) / 10 : NaN;
		const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
		// Negative credits are allowed (a deliberate deduction / correction by a
		// unit appointment-holder or DHQ); only zero / non-numeric is rejected.
		if (!Number.isFinite(days) || days === 0) {
			return json({ error: 'invalid_num_days', got: body.num_days ?? null }, { status: 400 });
		}
		if (!reason) return json({ error: 'reason_required' }, { status: 400 });

		const isSelf = targetId === user.id;

		const staff = await env.depot_db
			.prepare('SELECT id, telegram_id, full_name, department, sub_department, self_managed, appointment FROM users WHERE id = ?')
			.bind(targetId)
			.first<{
				id: number;
				telegram_id: string;
				full_name: string;
				department: string | null;
				sub_department: string | null;
				self_managed: number;
				appointment: string | null;
			}>();
		if (!staff) return json({ error: 'staff_not_found' }, { status: 404 });

		// Immediate (no approval) when the granter is the recipient unit's authority:
		// an appointment-holder of the recipient's OWN unit, or a DHQ appointment-
		// holder (who may credit — incl. NEGATIVE — ANY unit). A superadmin/admin who
		// is NOT that unit's holder still routes for approval; anyone may self-credit.
		const isUnitHolder = !!user.appointment && sameUnit(user, staff.department, staff.sub_department);
		const isHq = isHqHolder(user);
		const autoCredit = isUnitHolder || isHq;

		if (!isSelf && !isAdminish(user.user_role) && !autoCredit) {
			return json({ error: 'forbidden' }, { status: 403 });
		}

		if (autoCredit) {
			// The unit's appointment-holder (or DHQ) self-approves the credit/deduction.
			await env.depot_db.batch([
				env.depot_db
					.prepare(
						`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status, superior_user_id, approved_at)
						 VALUES (?, ?, ?, ?, 'approved', ?, datetime('now'))`,
					)
					.bind(staff.id, user.id, days, reason, user.id),
				env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(days, staff.id),
			]);
			const bal = await env.depot_db
				.prepare(`SELECT off_credits FROM users WHERE id = ?`)
				.bind(staff.id)
				.first<{ off_credits: number }>();
			if (staff.telegram_id !== user.telegram_id) {
				await tgSendMessage(env.BOT_TOKEN, {
					chat_id: staff.telegram_id,
					text: `🪙 Off-credit ${days >= 0 ? 'grant' : 'deduction'} by ${user.full_name}: ${days >= 0 ? '+' : ''}${days} day(s). Balance: ${bal?.off_credits ?? '?'}.`,
				});
			}
			return json({ ok: true, auto_approved: true, balance: bal?.off_credits, recipient_name: staff.full_name });
		}

		const ins = await env.depot_db
			.prepare(
				`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status)
				 VALUES (?, ?, ?, ?, 'pending_superior')
				 RETURNING id`,
			)
			.bind(staff.id, user.id, days, reason)
			.first<{ id: number }>();
		if (!ins) return json({ error: 'insert_failed' }, { status: 500 });

		// Per-request DM with inline Approve/Reject to EACH superior; store all
		// (chat,msg) pairs so a decision edits every copy.
		const approverTids = await approverTidsFor(env, staff);
		const whoLine = isSelf ? `${staff.full_name} (self-credit)` : `${user.full_name} → ${staff.full_name}`;
		const msgPairs: MsgPair[] = [];
		for (const tid of approverTids) {
			const msg = await tgSendMessage(env.BOT_TOKEN, {
				chat_id: tid,
				text: `🪙 <b>Off-credit request</b>\n${whoLine}: ${days} day(s)\nReason: ${reason}`,
				parse_mode: 'HTML',
				reply_markup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `grant:approve:${ins.id}` },
							{ text: '❌ Reject', callback_data: `grant:reject:${ins.id}` },
						],
					],
				},
			});
			if (msg?.message_id) msgPairs.push([tid, String(msg.message_id)]);
		}
		if (msgPairs.length) {
			await env.depot_db.prepare('UPDATE off_credit_grants SET approval_message_id = ? WHERE id = ?').bind(packApprovalMsgs(msgPairs), ins.id).run();
		}
		// Notify the recipient ONLY when they didn't initiate it themselves and
		// they aren't one of the approvers (avoids duplicate messages to a person).
		if (staff.telegram_id !== user.telegram_id && !approverTids.includes(staff.telegram_id)) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: staff.telegram_id,
				text: `🪙 ${user.full_name} proposed crediting you ${days} off day(s) — pending superior approval. Reason: ${reason}`,
			});
		}

		return json({ ok: true, id: ins.id, recipient_name: staff.full_name });
	}

	// -------- cancel own off (pending OR approved) — no superior needed -------
	// The requester may cancel their own off at any point (pending or already
	// approved); credits are refunded and the OFF calendar cells blanked. If it
	// was already approved, the superior who approved it is informed.
	if (request.method === 'POST' && sub === '/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.period, o.approved_by,
				        a.telegram_id AS approver_tid, a.full_name AS approver_name
				 FROM off_requests o LEFT JOIN users a ON a.id = o.approved_by WHERE o.id = ?`,
			)
			.bind(body.id)
			.first<{ id: number; user_id: number; off_status: string; startdate: string; enddate: string; period: string; approved_by: number | null; approver_tid: string | null; approver_name: string | null }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.user_id !== user.id) return json({ error: 'not_your_request' }, { status: 403 });
		// The requester may cancel their own off in ANY settled state — pending,
		// approved, or rejected (a rejected off is a private "dismiss", parallel to
		// how sick/leave already allow it).
		if (!['pending', 'approved', 'rejected'].includes(row.off_status)) {
			return json({ error: 'not_cancellable', state: row.off_status }, { status: 409 });
		}
		const wasApproved = row.off_status === 'approved';
		const wasActive = row.off_status === 'pending' || row.off_status === 'approved';

		// A rejected off was already refunded and its parade cells blanked at reject
		// time, so "cancelling" it is just a private dismiss from the requester's
		// Recent list — flip to cancelled with NO further refund, parade change or DM.
		if (!wasActive) {
			const flipD = await env.depot_db
				.prepare(`UPDATE off_requests SET off_status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ? AND off_status = 'rejected'`)
				.bind(user.id, body.id)
				.run();
			if ((flipD.meta.changes ?? 0) === 0) return json({ error: 'not_cancellable' }, { status: 409 });
			return json({ ok: true, dismissed: true, refunded: 0 });
		}

		// Refund the credits (reserved at request time; still reserved while approved).
		const refundDays = offDays(row.startdate, row.enddate, row.period);
		// Atomic flip so a cancel racing with a reject/revert can't double-refund.
		const flip = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ? AND off_status IN ('pending','approved')`)
			.bind(user.id, body.id)
			.run();
		if ((flip.meta.changes ?? 0) === 0) return json({ error: 'not_cancellable' }, { status: 409 });
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(refundDays, row.user_id).run();
		// Blank the OFF parade cells for the range (period-scoped) — a cancelled off
		// isn't off any more.
		const halfDay = row.period === 'AM' || row.period === 'PM';
		await env.depot_db
			.prepare(
				halfDay
					? `DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF' AND period = ?`
					: `DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF'`,
			)
			.bind(...(halfDay ? [row.user_id, row.startdate, row.enddate, row.period] : [row.user_id, row.startdate, row.enddate]))
			.run();

		const range = `${row.startdate} → ${row.enddate}`;
		// Sync every appointment-holder's original DM → clears any still-live
		// Approve/Reject buttons (pending) or rewrites the outcome (approved) to
		// "withdrawn". Audience-correct: edits exactly who got the request DM.
		await resolveApprovalDms(env, 'off_requests', 'superior_message_id', body.id as number, `🚫 ${user.full_name}'s off (${range}) — withdrawn by requester. 🪙 ${refundDays} credit(s) refunded. No action needed.`);
		// An edit doesn't push a notification, so if it was already approved, also ping
		// the approver who'll want to know their approval was undone.
		if (wasApproved && row.approver_tid && row.approver_tid !== user.telegram_id) {
			await tgSendMessage(env.BOT_TOKEN, {
				chat_id: row.approver_tid,
				text: `🚫 ${user.full_name} cancelled their off (${range}) that you approved. 🪙 ${refundDays} credit(s) refunded to them.`,
			});
		}
		return json({ ok: true, refunded: refundDays });
	}

	// -------- revert an approved off (refund credits) --------------------
	// Allowed for a superadmin (any) or the superior who approved it (any role).
	if (request.method === 'POST' && sub === '/revert') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT o.id, o.user_id, o.off_status, o.startdate, o.enddate, o.period, o.approved_by,
				        u.telegram_id AS requester_tid, u.full_name AS requester_name,
				        u.department AS requester_dept, u.sub_department AS requester_sub,
				        a.telegram_id AS approver_tid, a.full_name AS approver_name
				 FROM off_requests o
				 JOIN users u ON u.id = o.user_id
				 LEFT JOIN users a ON a.id = o.approved_by
				 WHERE o.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				off_status: string;
				startdate: string;
				enddate: string;
				period: string;
				approved_by: number | null;
				requester_tid: string;
				requester_name: string;
				requester_dept: string | null;
				requester_sub: string | null;
				approver_tid: string | null;
				approver_name: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.off_status !== 'approved') return json({ error: 'not_approved' }, { status: 409 });
		// Superadmin (any), the original approver, or a same-department
		// appointment-holder may revert.
		const canRevert =
			user.user_role === 'superadmin' ||
			row.approved_by === user.id ||
			(!!user.appointment && sameUnit(user, row.requester_dept, row.requester_sub)) ||
			isHqHolder(user);
		if (!canRevert) return json({ error: 'not_your_approval' }, { status: 403 });

		// Self-revert: the requester is undoing their OWN approved off (an appointment-
		// holder / self-managed user who auto-approved it — approver == recipient).
		// Reopening to 'pending' is meaningless (nobody else approves it), so CANCEL it
		// instead: it disappears, refunding the reserved credits and blanking OFF cells.
		if (row.user_id === user.id) {
			const flipSelf = await env.depot_db
				.prepare(`UPDATE off_requests SET off_status='cancelled', cancelled_by=?, cancelled_at=datetime('now') WHERE id=? AND off_status='approved'`)
				.bind(user.id, body.id)
				.run();
			if ((flipSelf.meta.changes ?? 0) === 0) return json({ error: 'not_approved' }, { status: 409 });
			const refundSelf = offDays(row.startdate, row.enddate, row.period);
			await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id = ?`).bind(refundSelf, user.id).run();
			const hdSelf = row.period === 'AM' || row.period === 'PM';
			await env.depot_db
				.prepare(
					hdSelf
						? `DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF' AND period = ?`
						: `DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF'`,
				)
				.bind(...(hdSelf ? [user.id, row.startdate, row.enddate, row.period] : [user.id, row.startdate, row.enddate]))
				.run();
			return json({ ok: true, cancelled: true });
		}

		// Reopen as pending (back to the inbox). Credits were reserved at request
		// time and stay reserved while pending — no refund here (they're only
		// returned on reject/cancel).
		const flipRevert = await env.depot_db
			.prepare(`UPDATE off_requests SET off_status = 'pending', approved_by = NULL, approved_date = NULL WHERE id = ? AND off_status = 'approved'`)
			.bind(body.id)
			.run();
		if ((flipRevert.meta.changes ?? 0) === 0) return json({ error: 'not_approved' }, { status: 409 });

		// Blank the OFF cells painted at approval so the reverted-pending off no longer
		// LOOKS approved on the calendar (a merely-pending off-page off isn't painted;
		// re-approval re-paints). Period-scoped, OFF-only.
		const revHalfDay = row.period === 'AM' || row.period === 'PM';
		await env.depot_db
			.prepare(
				revHalfDay
					? `DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF' AND period = ?`
					: `DELETE FROM parade_state_entries WHERE user_id = ? AND parade_state_date >= ? AND parade_state_date <= ? AND parade_status = 'OFF'`,
			)
			.bind(...(revHalfDay ? [row.user_id, row.startdate, row.enddate, row.period] : [row.user_id, row.startdate, row.enddate]))
			.run();

		// Re-arm the chat Approve/Reject buttons on every appointment-holder's DM.
		await restoreApprovalDms(env, 'off_requests', 'superior_message_id', body.id as number, `🟡 Off request (re-opened for approval): ${row.requester_name} — ${row.startdate} → ${row.enddate}`, 'off');
		const revertDays = offDays(row.startdate, row.enddate, row.period);
		const msg = `↩ ${user.full_name} reverted your approved off (${row.startdate} → ${row.enddate}) — it's pending approval again. Your parade state for those days is blank until it's re-approved.\n\n🪙 ${revertDays} credit(s) are STILL RESERVED while it's pending. If you no longer want this off, CANCEL it on the Off page to get the credit(s) back.`;
		const sends: Promise<unknown>[] = [tgSendMessage(env.BOT_TOKEN, { chat_id: row.requester_tid, text: msg })];
		if (row.approver_tid && row.approver_tid !== user.telegram_id) {
			sends.push(tgSendMessage(env.BOT_TOKEN, { chat_id: row.approver_tid, text: `↩ Off for ${row.requester_name} (${row.startdate} → ${row.enddate}) reverted to pending by ${user.full_name}.` }));
		}
		await Promise.allSettled(sends);
		return json({ ok: true, reopened: true });
	}

	// -------- cancel own off-credit request (pending / approved / rejected) --
	// Like /cancel for take-offs: the requester may withdraw it in ANY settled
	// state. Keyed on the REQUESTER (granted_by), never the recipient — so nobody
	// can cancel a deduction (or any credit) that someone else put through for them.
	if (request.method === 'POST' && sub === '/grant/cancel') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.granted_by, g.num_days, g.status,
				        u.telegram_id AS staff_tid, u.full_name AS staff_name,
				        ab.telegram_id AS approver_tid
				 FROM off_credit_grants g
				 JOIN users u ON u.id = g.user_id
				 LEFT JOIN users ab ON ab.id = g.superior_user_id
				 WHERE g.id = ?`,
			)
			.bind(body.id)
			.first<WithdrawableGrant & { granted_by: number }>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.granted_by !== user.id) return json({ error: 'not_your_request' }, { status: 403 });
		if (!['pending_superior', 'approved', 'rejected'].includes(row.status)) {
			return json({ error: 'not_cancellable', state: row.status }, { status: 409 });
		}
		if (!(await withdrawGrant(env, user, row))) return json({ error: 'not_cancellable' }, { status: 409 });
		return json({ ok: true, dismissed: row.status === 'rejected' });
	}

	// -------- revert an APPROVED off-credit grant (claw back credits) ------
	// Allowed for a superadmin (any) or the superior who approved it.
	if (request.method === 'POST' && sub === '/grant/revert') {
		const body = (await request.json()) as { id?: number };
		if (!Number.isInteger(body.id)) return json({ error: 'invalid_body' }, { status: 400 });
		const row = await env.depot_db
			.prepare(
				`SELECT g.id, g.user_id, g.granted_by, g.num_days, g.status, g.superior_user_id,
				        u.telegram_id AS staff_tid, u.full_name AS staff_name,
				        u.department AS staff_dept, u.sub_department AS staff_sub,
				        gr.telegram_id AS granter_tid, ab.telegram_id AS approver_tid
				 FROM off_credit_grants g
				 JOIN users u ON u.id = g.user_id
				 LEFT JOIN users gr ON gr.id = g.granted_by
				 LEFT JOIN users ab ON ab.id = g.superior_user_id
				 WHERE g.id = ?`,
			)
			.bind(body.id)
			.first<{
				id: number;
				user_id: number;
				num_days: number;
				status: string;
				superior_user_id: number | null;
				granted_by: number;
				approver_tid: string | null;
				staff_tid: string;
				staff_name: string;
				staff_dept: string | null;
				staff_sub: string | null;
				granter_tid: string | null;
			}>();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		if (row.status !== 'approved') return json({ error: 'not_approved' }, { status: 409 });
		const canRevertGrant =
			user.user_role === 'superadmin' ||
			row.superior_user_id === user.id ||
			(!!user.appointment && sameUnit(user, row.staff_dept, row.staff_sub)) ||
			isHqHolder(user);
		if (!canRevertGrant) return json({ error: 'not_your_approval' }, { status: 403 });
		// Self-revert: the REQUESTER undoing their own credit (e.g. a holder's auto-
		// approved credit). Reopening it to pending is meaningless — withdraw it
		// instead, exactly like /grant/cancel: it disappears, credit change reversed.
		if (row.granted_by === user.id) {
			if (!(await withdrawGrant(env, user, row))) return json({ error: 'not_approved' }, { status: 409 });
			return json({ ok: true, cancelled: true, days_clawed: row.num_days });
		}
		// Reopen as pending (back to the inbox) and claw the credits back — atomic
		// flip so a double-revert can't claw twice.
		const flipClaw = await env.depot_db
			.prepare(`UPDATE off_credit_grants SET status='pending_superior', superior_user_id=NULL, approved_at=NULL WHERE id=? AND status='approved'`)
			.bind(body.id)
			.run();
		if ((flipClaw.meta.changes ?? 0) === 0) return json({ error: 'not_approved' }, { status: 409 });
		// Plain subtraction (negative balances are allowed) so the clawback
		// exactly mirrors the unclamped grant-add — keeps approve/revert reversible.
		await env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ?`).bind(row.num_days, row.user_id).run();
		await restoreApprovalDms(env, 'off_credit_grants', 'approval_message_id', body.id as number, `🟡 Off-credit request (re-opened for approval): ${row.staff_name} (+${row.num_days} day(s))`, 'grant');
		const msg = `↩ Off-credit reverted by ${user.full_name}: −${row.num_days} day(s) from ${row.staff_name} (pending approval again).`;
		const sent = new Set<string>([user.telegram_id]);
		const notify = (tid: string | null) =>
			!tid || sent.has(tid) ? null : (sent.add(tid), tgSendMessage(env.BOT_TOKEN, { chat_id: tid, text: msg }));
		await Promise.allSettled([notify(row.staff_tid), notify(row.granter_tid)]);
		return json({ ok: true, days_clawed: row.num_days });
	}

	if (request.method === 'GET' && sub === '/staff') {
		// Admins, superadmins, and DHQ appointment-holders may credit anyone. Include
		// role + personnel type so the client can sort by the same tiebreaks.
		if (user.user_role === 'admin' || user.user_role === 'superadmin' || isHqHolder(user)) {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id, full_name, off_credits, department, user_role, personnel_type
					 FROM users WHERE full_name NOT LIKE 'PENDING:%' ORDER BY full_name`,
				)
				.all<{ id: number; full_name: string; off_credits: number; department: string | null; user_role: string; personnel_type: string | null }>();
			return json(results ?? []);
		}
		// Any appointment-holder may credit their OWN department's members.
		if (user.appointment) {
			const { results } = await env.depot_db
				.prepare(
					`SELECT id, full_name, off_credits, department, user_role, personnel_type
					 FROM users
					 WHERE full_name NOT LIKE 'PENDING:%'
					   AND department = ? AND IFNULL(sub_department,'') = IFNULL(?, '')
					 ORDER BY full_name`,
				)
				.bind(user.department, user.sub_department ?? null)
				.all<{ id: number; full_name: string; off_credits: number; department: string | null; user_role: string; personnel_type: string | null }>();
			return json(results ?? []);
		}
		return json([]);
	}

	// ── MASS CREDIT / MASS APPLY (superadmin only) ─────────────────────────
	// Targets: { mode:'all'|'dept'|'ids', dept?, ids? }. Per target, the action is
	// applied INSTANTLY if the initiator may approve that target's unit (appointment-
	// holder of it, or superadmin fallback for a holder-less unit), otherwise it's
	// ROUTED as a pending request to that unit's appointment-holders (shown in their
	// in-app inbox + a single summary DM). All DB writes are batched.
	if (request.method === 'POST' && (sub === '/mass-credit' || sub === '/mass-apply')) {
		if (user.user_role !== 'superadmin') return json({ error: 'forbidden' }, { status: 403 });
		const body = (await request.json()) as {
			mode?: 'all' | 'dept' | 'ids';
			dept?: string;
			ids?: number[];
			num_days?: number | string;
			startdate?: string;
			enddate?: string;
			period?: string;
			reason?: string;
		};
		// Resolve the target set (excluding PENDING stubs).
		let clause = '';
		let binds: (string | number)[] = [];
		if (body.mode === 'dept') {
			if (!body.dept) return json({ error: 'dept_required' }, { status: 400 });
			clause = ' AND department = ?';
			binds = [body.dept];
		} else if (body.mode === 'ids') {
			const ids = (body.ids ?? []).filter((n) => Number.isInteger(n));
			if (!ids.length) return json({ error: 'no_targets' }, { status: 400 });
			if (ids.length > 100) return json({ error: 'too_many_ids', max: 100 }, { status: 400 });
			clause = ` AND id IN (${ids.map(() => '?').join(',')})`;
			binds = ids;
		} else if (body.mode !== 'all') {
			return json({ error: 'bad_mode' }, { status: 400 });
		}
		const { results: targets } = await env.depot_db
			.prepare(`SELECT id, full_name, telegram_id, off_credits, department, sub_department FROM users WHERE full_name NOT LIKE 'PENDING:%'${clause} ORDER BY full_name`)
			.bind(...binds)
			.all<MassTarget>();
		if (!targets?.length) return json({ error: 'no_targets' }, { status: 400 });

		// Instant vs routed — same routing as the inbox (canActOn). Initiator is a
		// superadmin, so the fallback (holder-less / no-dept unit) also goes instant.
		const holderDepts = await departmentsWithHolders(env);
		const appointed = !!user.appointment;
		const canActOn = (dept: string | null, sub: string | null): boolean =>
			(appointed && sameUnit(user, dept, sub)) || dept == null || !holderDepts.has(dept);

		if (sub === '/mass-credit') {
			const days = Math.round(Number(body.num_days) * 10) / 10;
			const reason = (body.reason ?? '').trim();
			if (!Number.isFinite(days) || days <= 0) return json({ error: 'invalid_num_days' }, { status: 400 });
			if (!reason) return json({ error: 'reason_required' }, { status: 400 });

			const instant = targets.filter((t) => canActOn(t.department, t.sub_department));
			const routed = targets.filter((t) => !canActOn(t.department, t.sub_department));

			const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
			const approvedStmt = env.depot_db.prepare(
				`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status, superior_user_id, approved_at)
				 VALUES (?, ?, ?, ?, 'approved', ?, datetime('now'))`,
			);
			for (const t of instant) ops.push(approvedStmt.bind(t.id, user.id, days, reason, user.id));
			// Bump credits in chunks of ≤90 ids so the bound-param count stays under
			// D1's 100-per-statement cap (mode 'all' can be ~100 users).
			for (let i = 0; i < instant.length; i += 90) {
				const chunk = instant.slice(i, i + 90);
				ops.push(
					env.depot_db
						.prepare(`UPDATE users SET off_credits = off_credits + ? WHERE id IN (${chunk.map(() => '?').join(',')})`)
						.bind(days, ...chunk.map((t) => t.id)),
				);
			}
			const pendingStmt = env.depot_db.prepare(
				`INSERT INTO off_credit_grants (user_id, granted_by, num_days, reason, status) VALUES (?, ?, ?, ?, 'pending_superior')`,
			);
			for (const t of routed) ops.push(pendingStmt.bind(t.id, user.id, days, reason));
			if (ops.length) await env.depot_db.batch(ops);

			await notifyRoutedHolders(env, routed, `off-credit request(s) (+${days} day[s])`, user.full_name);
			return json({ ok: true, instant: instant.length, routed: routed.length, total: targets.length });
		}

		// ── /mass-apply ──
		const isDate = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
		const period = body.period === 'AM' || body.period === 'PM' ? body.period : 'FD';
		if (!isDate(body.startdate) || !isDate(body.enddate)) return json({ error: 'bad_dates' }, { status: 400 });
		if (body.startdate > body.enddate) return json({ error: 'bad_range' }, { status: 400 });
		const reason = (body.reason ?? '').trim() || 'Mass off (superadmin)';
		const dates = expandRange(body.startdate, body.enddate);
		// Guard the work volume so a huge (targets × days) combo can't blow the
		// per-invocation budget. ~31 days for the whole depot is plenty.
		if (targets.length * dates.length > 3000) {
			return json({ error: 'too_large', hint: 'Narrow the date range or the selection.' }, { status: 400 });
		}
		const days = offDays(body.startdate, body.enddate, period);

		// Skip anyone who already has an overlapping pending/approved off (so a
		// re-run can't double-reserve) and anyone who can't afford it (no negatives).
		// Fetch all pending/approved offs overlapping the range (no user IN-list, to
		// dodge D1's 100-param cap) and filter to our targets in memory.
		const { results: existing } = await env.depot_db
			.prepare(`SELECT user_id, period FROM off_requests WHERE off_status IN ('pending','approved') AND startdate <= ? AND enddate >= ?`)
			.bind(body.enddate, body.startdate)
			.all<{ user_id: number; period: string }>();
		const targetIds = new Set(targets.map((t) => t.id));
		const clashIds = new Set(
			(existing ?? []).filter((e) => targetIds.has(e.user_id) && periodsOverlap(e.period, period)).map((e) => e.user_id),
		);

		const alreadyOff = targets.filter((t) => clashIds.has(t.id)).map((t) => t.full_name);
		const candidates = targets.filter((t) => !clashIds.has(t.id));

		// Atomic per-row credit gate: deduct ONLY if the balance is still ≥ days at
		// execution time, and RETURNING tells us exactly who was charged. This both
		// hard-guarantees no negative balance AND closes the read-then-write race
		// (no decision is made on a stale snapshot). Each statement is one row, so
		// there's no IN-list param-cap concern either. Off rows are then created
		// only for those actually charged — so a race loser is skipped cleanly,
		// never left with an un-charged off.
		const succeededIds = new Set<number>();
		if (candidates.length) {
			const deductStmt = env.depot_db.prepare(`UPDATE users SET off_credits = off_credits - ? WHERE id = ? AND off_credits >= ?`);
			const res = await env.depot_db.batch(candidates.map((t) => deductStmt.bind(days, t.id, days)));
			// meta.changes === 1 means the guarded deduct applied (balance was enough).
			res.forEach((r, i) => {
				if ((r.meta?.changes ?? 0) > 0) succeededIds.add(candidates[i].id);
			});
		}
		const succeeded = candidates.filter((t) => succeededIds.has(t.id));
		const insufficient = candidates.filter((t) => !succeededIds.has(t.id)).map((t) => t.full_name);

		const instant = succeeded.filter((t) => canActOn(t.department, t.sub_department));
		const routed = succeeded.filter((t) => !canActOn(t.department, t.sub_department));

		// Create the off rows for the charged users only (instant=approved, routed=pending).
		const ops: ReturnType<typeof env.depot_db.prepare>[] = [];
		const apprStmt = env.depot_db.prepare(
			`INSERT INTO off_requests (user_id, requested_by_user_id, startdate, enddate, period, reason, off_status, approved_by, approved_date)
			 VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'))`,
		);
		for (const t of instant) ops.push(apprStmt.bind(t.id, user.id, body.startdate, body.enddate, period, reason, user.id));
		const pendStmt = env.depot_db.prepare(
			`INSERT INTO off_requests (user_id, requested_by_user_id, startdate, enddate, period, reason, off_status)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
		);
		for (const t of routed) ops.push(pendStmt.bind(t.id, user.id, body.startdate, body.enddate, period, reason));
		if (ops.length) await env.depot_db.batch(ops);

		// Paint OFF for the instant (approved) ones now; routed ones paint on approval.
		await bulkPaintOff(env, instant, dates, period);
		await notifyRoutedHolders(env, routed, `off request(s) (${body.startdate} → ${body.enddate})`, user.full_name);

		return json({
			ok: true,
			instant: instant.length,
			routed: routed.length,
			total: targets.length,
			days_each: days,
			insufficient,
			already_off: alreadyOff,
		});
	}

	return json({ error: 'not_found' }, { status: 404 });
}
