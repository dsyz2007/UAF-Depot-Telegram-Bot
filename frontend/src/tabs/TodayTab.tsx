import { useEffect, useState } from 'react';
import { api, alertDialog, confirmDialog, deptLabel, type Me } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

const DEPT_ORDER: readonly string[] = ['DHQ', 'DMSP', 'DCS', 'DSP', 'Others', 'Unassigned'];
interface HasDept { department: string | null; sub_department: string | null }
// Group items by department label, emitting groups in DEPT_ORDER (extras after).
function groupByDept<T extends HasDept>(items: T[]): [string, T[]][] {
	const groups = new Map<string, T[]>();
	for (const it of items) {
		const key = deptLabel(it.department, it.sub_department);
		const arr = groups.get(key) ?? [];
		arr.push(it);
		groups.set(key, arr);
	}
	const order = [...DEPT_ORDER, ...[...groups.keys()].filter((k) => !DEPT_ORDER.includes(k))];
	return order.filter((d) => groups.has(d)).map((d) => [d, groups.get(d)!]);
}
function deptRank(d: string): number {
	const i = DEPT_ORDER.indexOf(d);
	return i < 0 ? 99 : i;
}
// Sort items by department (DEPT_ORDER), then by name — used to arrange the
// approvals inbox rows by department.
function sortByDept<T extends HasDept & { full_name: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => {
		const da = deptLabel(a.department, a.sub_department);
		const db = deptLabel(b.department, b.sub_department);
		return da === db ? a.full_name.localeCompare(b.full_name) : deptRank(da) - deptRank(db);
	});
}

// ── Pending requests (inbox) ───────────────────────────────────────────────
type InboxScope = 'mine' | 'dept' | 'all';
interface WithAction { can_action: boolean }
interface ApprovalsPayload {
	scope: InboxScope;
	offs: ({ id: number; full_name: string; department: string | null; sub_department: string | null; startdate: string; enddate: string; period: string; reason: string; days: number } & WithAction)[];
	sick: ({ id: number; full_name: string; department: string | null; sub_department: string | null; case_type: string; reason: string | null; created_at: string } & WithAction)[];
	grants: ({ id: number; full_name: string; department: string | null; sub_department: string | null; num_days: number; reason: string } & WithAction)[];
	parade: ({ id: number; full_name: string; department: string | null; sub_department: string | null; parade_state_date: string; period: string; new_status: string; new_reason: string | null } & WithAction)[];
	leave: ({ id: number; full_name: string; department: string | null; sub_department: string | null; leave_type: string; period: string; startdate: string; enddate: string; reason: string | null } & WithAction)[];
}
type ApprovalType = 'off' | 'sick' | 'grant' | 'parade' | 'leave';

// "LL", or "AM LL" for a half-day.
function leaveLabel(leaveType: string, period: string): string {
	return period && period !== 'FD' ? `${period} ${leaveType}` : leaveType;
}
interface ActionItem {
	type: ApprovalType;
	id: number;
	action: 'approve' | 'reject';
}

function ApprovalsInbox({ me }: { me: Me }) {
	const canSeeOthers = me.is_approver;
	// Normal users → their own requests; superadmins → all depts (that's where
	// the units they're the fallback approver for live); appointment-holders → dept.
	const [scope, setScope] = useState<InboxScope>(!canSeeOthers ? 'mine' : me.user_role === 'superadmin' ? 'all' : 'dept');
	const [data, setData] = useState<ApprovalsPayload | null>(null);
	const [busy, setBusy] = useState(false);

	function refresh() {
		return api.get<ApprovalsPayload>(`/api/approvals?scope=${scope}`).then(setData).catch(console.error);
	}
	useEffect(() => {
		refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scope]);
	// New requests arrive as Telegram DMs; sync the inbox when the superior
	// returns to the app.
	useFocusRefresh(refresh);

	async function act(actions: ActionItem[], label: string) {
		if (actions.length === 0) return;
		if (actions.length > 1) {
			const ok = await confirmDialog(`${label} ${actions.length} item(s)?`);
			if (!ok) return;
		}
		setBusy(true);
		try {
			const res = await api.post<{ done: number }>('/api/approvals/act', { actions });
			await refresh();
			alertDialog(`${label}: ${res.done} done.`);
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (!data) return <div className="muted">Loading…</div>;
	const total = data.offs.length + data.sick.length + data.grants.length + data.parade.length + data.leave.length;
	const mineView = scope === 'mine';
	const emptyMsg = mineView
		? 'You have no pending requests.'
		: scope === 'dept'
			? 'Nothing pending in your department. 🎉'
			: 'Nothing pending anywhere. 🎉';

	return (
		<div style={{ marginBottom: 18 }}>
			<h3>{mineView ? `🗂 My pending requests (${total})` : `✅ Pending approvals (${total})`}</h3>
			{canSeeOthers && (
				<div className="seg" style={{ marginBottom: 8 }}>
					<button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>Mine</button>
					<button className={scope === 'dept' ? 'active' : ''} onClick={() => setScope('dept')}>My dept</button>
					<button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All depts</button>
				</div>
			)}
			{total === 0 ? (
				<p className="muted">{emptyMsg}</p>
			) : (
				<>
					{data.offs.length > 0 && (
						<ApprovalGroup
							title={`Off requests (${data.offs.length})`}
							type="off"
							chip="Off"
							busy={busy}
							onApproveAll={() => act(data.offs.filter((o) => o.can_action).map((o) => ({ type: 'off', id: o.id, action: 'approve' })), 'Approve all offs')}
							rows={sortByDept(data.offs).map((o) => ({
								id: o.id,
								canAct: o.can_action,
								main: `${deptLabel(o.department, o.sub_department)} · ${o.full_name} · ${o.startdate === o.enddate ? o.startdate : `${o.startdate}→${o.enddate}`} (${o.days}d${o.period === 'AM' || o.period === 'PM' ? `, ${o.period}` : ''})`,
								sub: o.reason,
								onApprove: () => act([{ type: 'off', id: o.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'off', id: o.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.sick.length > 0 && (
						<ApprovalGroup
							title={`Sick — RSI/RSO (${data.sick.length})`}
							type="sick"
							chip="Sick"
							busy={busy}
							onApproveAll={() => act(data.sick.filter((s) => s.can_action).map((s) => ({ type: 'sick', id: s.id, action: 'approve' })), 'Approve all sick')}
							rows={sortByDept(data.sick).map((s) => ({
								id: s.id,
								canAct: s.can_action,
								main: `${deptLabel(s.department, s.sub_department)} · ${s.full_name} · ${s.case_type}`,
								sub: s.reason ? `Reason: ${s.reason}` : s.created_at,
								onApprove: () => act([{ type: 'sick', id: s.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'sick', id: s.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.grants.length > 0 && (
						<ApprovalGroup
							title={`Off-credit grants (${data.grants.length})`}
							type="grant"
							chip="Credit"
							busy={busy}
							onApproveAll={() => act(data.grants.filter((g) => g.can_action).map((g) => ({ type: 'grant', id: g.id, action: 'approve' })), 'Approve all credits')}
							rows={sortByDept(data.grants).map((g) => ({
								id: g.id,
								canAct: g.can_action,
								main: `${deptLabel(g.department, g.sub_department)} · ${g.full_name} · +${g.num_days} credit${g.num_days === 1 ? '' : 's'}`,
								sub: g.reason,
								onApprove: () => act([{ type: 'grant', id: g.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'grant', id: g.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.parade.length > 0 && (
						<ApprovalGroup
							title={`Late parade changes (${data.parade.length})`}
							type="parade"
							chip="Parade"
							busy={busy}
							onApproveAll={() => act(data.parade.filter((p) => p.can_action).map((p) => ({ type: 'parade', id: p.id, action: 'approve' })), 'Approve all parade changes')}
							rows={sortByDept(data.parade).map((p) => ({
								id: p.id,
								canAct: p.can_action,
								main: `${deptLabel(p.department, p.sub_department)} · ${p.full_name} · ${p.parade_state_date} ${p.period} → ${p.new_status}`,
								sub: p.new_reason ?? '',
								onApprove: () => act([{ type: 'parade', id: p.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'parade', id: p.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.leave.length > 0 && (
						<ApprovalGroup
							title={`Leave / MA requests (${data.leave.length})`}
							type="leave"
							chip="Leave"
							busy={busy}
							onApproveAll={() => act(data.leave.filter((l) => l.can_action).map((l) => ({ type: 'leave', id: l.id, action: 'approve' })), 'Approve all leave')}
							rows={sortByDept(data.leave).map((l) => ({
								id: l.id,
								canAct: l.can_action,
								main: `${deptLabel(l.department, l.sub_department)} · ${l.full_name} · ${leaveLabel(l.leave_type, l.period)} · ${l.startdate === l.enddate ? l.startdate : `${l.startdate}→${l.enddate}`}`,
								sub: l.reason ?? '',
								onApprove: () => act([{ type: 'leave', id: l.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'leave', id: l.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
				</>
			)}
		</div>
	);
}

function ApprovalGroup({
	title,
	type,
	chip,
	rows,
	busy,
	onApproveAll,
}: {
	title: string;
	type: ApprovalType;
	chip: string;
	busy: boolean;
	onApproveAll: () => void;
	rows: { id: number; main: string; sub: string; canAct: boolean; onApprove: () => void; onReject: () => void }[];
}) {
	const accent = type === 'grant' ? 'acc-grant' : `acc-${type}`;
	const actionable = rows.filter((r) => r.canAct).length;
	return (
		<div style={{ marginTop: 14 }}>
			<div className="card-row">
				<h4 className="section-title" style={{ margin: 0 }}>{title}</h4>
				{actionable > 1 && (
					<button className="btn-link" disabled={busy} onClick={onApproveAll}>✅ Approve all</button>
				)}
			</div>
			{rows.map((r) => (
				<div key={r.id} className={`entry-card ${accent}`}>
					<div className="entry-head">
						<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
							<span className={`type-chip ${type}`}>{chip}</span>
							<span className="entry-title" style={{ fontSize: 14 }}>{r.main}</span>
						</span>
						{r.canAct ? (
							<div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
								<button className="pill-btn approve" disabled={busy} onClick={r.onApprove}>✅</button>
								<button className="pill-btn reject" disabled={busy} onClick={r.onReject}>❌</button>
							</div>
						) : (
							<span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>pending</span>
						)}
					</div>
					{r.sub && <div className="entry-meta"><span>{r.sub}</span></div>}
				</div>
			))}
		</div>
	);
}
// ───────────────────────────────────────────────────────────────────────────

// ── Undo recently approved / rejected requests ─────────────────────────────
type RecentStatus = 'approved' | 'rejected';
// mine = requests I submitted · self = items I actioned · dept/all = department views.
type RecentScope = 'mine' | 'self' | 'dept' | 'all';
// can_undo tells the UI whether THIS viewer may reverse the item (false for
// view-only rows, e.g. another department under the "all" scope).
interface RecentPayload {
	status: RecentStatus;
	scope: RecentScope;
	offs: { id: number; full_name: string; startdate: string; enddate: string; period: string; days: number; reason: string; approved_date: string | null; approved_by_name: string | null; can_undo: boolean }[];
	sick: { id: number; full_name: string; case_type: string; reportsick_status: string; sick_date: string | null; reason: string | null; approved_at: string | null; updated_status: string | null; approved_by_name: string | null; can_undo: boolean }[];
	grants: { id: number; full_name: string; num_days: number; reason: string; approved_at: string | null; approved_by_name: string | null; can_undo: boolean }[];
	leave: { id: number; full_name: string; leave_type: string; period: string; startdate: string; enddate: string; reason: string | null; approved_at: string | null; approved_by_name: string | null; can_undo: boolean }[];
}

// One labelled field per line — keeps each request readable instead of a messy
// space-separated blob.
function FieldLine({ label, value }: { label: string; value: React.ReactNode }) {
	if (value === null || value === undefined || value === '') return null;
	return (
		<div className="entry-line">
			<span className="muted" style={{ marginRight: 6 }}>{label}:</span>
			<span>{value}</span>
		</div>
	);
}

function RecentApprovals({ me }: { me: Me }) {
	const canSeeOthers = me.is_approver;
	const [status, setStatus] = useState<RecentStatus>('approved');
	// Normal users only ever see their OWN processed requests. Superadmins oversee
	// every unit (and may have no department of their own) → default all-depts;
	// appointment-holders default to their department.
	const [scope, setScope] = useState<RecentScope>(!canSeeOthers ? 'mine' : me.user_role === 'superadmin' ? 'all' : 'dept');
	const [data, setData] = useState<RecentPayload | null>(null);
	const [busy, setBusy] = useState(false);

	function refresh() {
		return api.get<RecentPayload>(`/api/approvals/recent?status=${status}&scope=${scope}`).then(setData).catch(console.error);
	}
	useEffect(() => {
		refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status, scope]);
	useFocusRefresh(refresh);

	const isRejected = status === 'rejected';
	const actorLabel = isRejected ? 'Rejected by' : 'Approved by';

	async function undo(kind: 'off' | 'sick' | 'grant' | 'leave', id: number, label: string) {
		const ok = await confirmDialog(
			isRejected
				? `Reopen this ${label} for approval? It goes back to Pending approvals.`
				: `Undo this ${label}? This reverses the approval.`,
		);
		if (!ok) return;
		setBusy(true);
		try {
			if (isRejected) {
				await api.post('/api/approvals/unreject', { type: kind, id });
			} else {
				const path =
					kind === 'sick'
						? '/api/sick/revert'
						: kind === 'grant'
							? '/api/off/grant/revert'
							: kind === 'leave'
								? '/api/leave/revert'
								: '/api/off/revert';
				await api.post(path, { id });
			}
			await refresh();
			alertDialog(isRejected ? 'Reopened for approval.' : 'Reverted.');
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (!data) return null;
	const mineView = scope === 'mine';

	const undoBtn = (kind: 'off' | 'sick' | 'grant' | 'leave', id: number, label: string, can: boolean) =>
		can ? (
			<button className="btn-link danger" disabled={busy} onClick={() => undo(kind, id, label)}>
				{isRejected ? '↩ Reopen' : '↩ Undo'}
			</button>
		) : mineView ? null : (
			// In the "Mine" view every row is your own request — there's nothing to
			// undo, so the "view only" tag would just be noise.
			<span className="muted" style={{ fontSize: 12 }}>view only</span>
		);

	const empty = data.offs.length + data.sick.length + data.grants.length + data.leave.length === 0;

	const whoText =
		scope === 'mine'
			? ' that you submitted'
			: scope === 'self'
				? ' that you actioned'
				: scope === 'dept'
					? ' in your department (incl. fellow appointment-holders)'
					: ' across all departments';

	return (
		<div style={{ marginBottom: 18 }}>
			<h3>{mineView ? `↩ My recent ${isRejected ? 'rejections' : 'approvals'}` : `↩ Recent ${isRejected ? 'rejections' : 'approvals'}`}</h3>
			<div className="seg" style={{ marginBottom: 8 }}>
				<button className={status === 'approved' ? 'active' : ''} onClick={() => setStatus('approved')}>✅ Past approvals</button>
				<button className={status === 'rejected' ? 'active' : ''} onClick={() => setStatus('rejected')}>❌ Past rejections</button>
			</div>
			{canSeeOthers && (
				<div className="seg" style={{ marginBottom: 8 }}>
					<button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>Mine</button>
					<button className={scope === 'self' ? 'active' : ''} onClick={() => setScope('self')}>By me</button>
					<button className={scope === 'dept' ? 'active' : ''} onClick={() => setScope('dept')}>My dept</button>
					<button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All depts</button>
				</div>
			)}
			<p className="muted" style={{ marginTop: -2 }}>
				{isRejected ? 'Rejections' : 'Approvals'} in the last 14 days{whoText}.
				{' '}
				{mineView
					? 'These are your own requests — view only.'
					: isRejected
						? 'Reopening sends the request back to Pending approvals (off credits are re-reserved).'
						: 'Undoing sends the request back to Pending approvals (an off-credit grant’s credits are clawed back; off-day credits stay reserved).'}
				{scope === 'all' && ' Items outside your department are view-only.'}
			</p>
			{empty ? (
				<p className="muted">
					{mineView
						? `You have no ${isRejected ? 'rejected' : 'approved'} requests in the last 14 days.`
						: `No ${isRejected ? 'rejections' : 'approvals'} match this view.`}
				</p>
			) : (
				<>
					{data.offs.map((o) => (
						<div key={`o${o.id}`} className="entry-card acc-off">
							<div className="entry-head">
								<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
									<span className="type-chip off">Off</span>
									<span className="entry-title" style={{ fontSize: 14 }}>{o.full_name}</span>
								</span>
								{undoBtn('off', o.id, 'off', o.can_undo)}
							</div>
							<FieldLine label="Dates" value={`${o.startdate === o.enddate ? o.startdate : `${o.startdate} → ${o.enddate}`}${o.period === 'AM' || o.period === 'PM' ? ` (${o.period} only)` : ''}`} />
							<FieldLine label="Days" value={`${o.days} day${o.days === 1 ? '' : 's'}`} />
							<FieldLine label="Reason" value={o.reason} />
							<FieldLine label={actorLabel} value={o.approved_by_name} />
						</div>
					))}
					{data.sick.map((s) => (
						<div key={`s${s.id}`} className="entry-card acc-sick">
							<div className="entry-head">
								<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
									<span className="type-chip sick">Sick</span>
									<span className="entry-title" style={{ fontSize: 14 }}>{s.full_name}</span>
								</span>
								{undoBtn('sick', s.id, `${s.case_type}`, s.can_undo)}
							</div>
							<FieldLine label="Type" value={s.case_type} />
							<FieldLine label="For date" value={s.sick_date} />
							<FieldLine label="Reason" value={s.reason} />
							{!isRejected && <FieldLine label="Status" value={s.reportsick_status.replace(/_/g, ' ')} />}
							{!isRejected && <FieldLine label="Update" value={s.updated_status} />}
							<FieldLine label={actorLabel} value={s.approved_by_name} />
						</div>
					))}
					{data.grants.map((g) => (
						<div key={`g${g.id}`} className="entry-card acc-grant">
							<div className="entry-head">
								<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
									<span className="type-chip grant">Credit</span>
									<span className="entry-title" style={{ fontSize: 14 }}>{g.full_name}</span>
								</span>
								{undoBtn('grant', g.id, 'credit grant', g.can_undo)}
							</div>
							<FieldLine label="Credits" value={`+${g.num_days} credit${g.num_days === 1 ? '' : 's'}`} />
							<FieldLine label="Reason" value={g.reason} />
							<FieldLine label={actorLabel} value={g.approved_by_name} />
						</div>
					))}
					{data.leave.map((l) => (
						<div key={`l${l.id}`} className="entry-card acc-leave">
							<div className="entry-head">
								<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
									<span className="type-chip leave">{l.leave_type === 'MA' ? 'MA' : 'Leave'}</span>
									<span className="entry-title" style={{ fontSize: 14 }}>{l.full_name}</span>
								</span>
								{undoBtn('leave', l.id, l.leave_type === 'MA' ? 'MA request' : 'leave', l.can_undo)}
							</div>
							<FieldLine label="Type" value={leaveLabel(l.leave_type, l.period)} />
							<FieldLine label="Dates" value={l.startdate === l.enddate ? l.startdate : `${l.startdate} → ${l.enddate}`} />
							<FieldLine label="Reason" value={l.reason} />
							<FieldLine label={actorLabel} value={l.approved_by_name} />
						</div>
					))}
				</>
			)}
		</div>
	);
}
// ───────────────────────────────────────────────────────────────────────────

interface OffRow {
	id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	startdate: string;
	enddate: string;
	reason: string;
	approved_by_name: string | null;
}

interface SickRow {
	id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	created_at: string;
	approved_at: string | null;
	num_of_mc_days: number | null;
	mc_start_date: string | null;
	mc_end_date: string | null;
}

interface TodayPayload {
	today: string;
	offs_today: OffRow[];
	sick_open: SickRow[];
	sick_pending: SickRow[];
	offs_pending: OffRow[];
}

export function TodayTab({ me }: { me: Me }) {
	// The /api/today dashboard (who's on off / open sick cases unit-wide) is
	// approver-only (403 for normal users), so only approvers fetch it. Normal
	// users still get the page — their own pending + processed requests below.
	const canSeeOthers = me.is_approver;
	const [data, setData] = useState<TodayPayload | null>(null);
	const [error, setError] = useState<string | null>(null);

	function loadToday() {
		if (!canSeeOthers) return Promise.resolve();
		return api
			.get<TodayPayload>('/api/today')
			.then(setData)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}
	useEffect(() => {
		loadToday();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useFocusRefresh(loadToday);

	return (
		<div>
			<ApprovalsInbox me={me} />
			<RecentApprovals me={me} />

			{canSeeOthers && error && (
				<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)' }}>
					<h3>⚠ Couldn't load today</h3>
					<p className="muted">{error}</p>
				</div>
			)}

			{canSeeOthers && !error && data && (
				<>
					<h3>📊 Today — {data.today}</h3>

					<Section title={`On Off (${data.offs_today.length})`} accent="success">
						{data.offs_today.length === 0 ? (
							<p className="muted">Nobody on approved off today.</p>
						) : (
							groupByDept(data.offs_today).map(([dept, rows]) => (
								<div key={dept}>
									<h5 className="section-title" style={{ margin: '8px 0 4px' }}>{dept} ({rows.length})</h5>
									{rows.map((o) => (
										<div key={o.id} className="card">
											<div className="card-row">
												<b>{o.full_name}</b>
												<span className="muted">{rangeOrSingle(o.startdate, o.enddate)}</span>
											</div>
											<div className="muted">{o.reason}</div>
											{o.approved_by_name && <div className="muted">Approved by {o.approved_by_name}</div>}
										</div>
									))}
								</div>
							))
						)}
					</Section>

					<Section title={`Open Sick Cases (${data.sick_open.length})`} accent="danger">
						{data.sick_open.length === 0 ? (
							<p className="muted">No open RSI/RSO cases.</p>
						) : (
							groupByDept(data.sick_open).map(([dept, rows]) => (
								<div key={dept}>
									<h5 className="section-title" style={{ margin: '8px 0 4px' }}>{dept} ({rows.length})</h5>
									{rows.map((s) => (
										<div key={s.id} className="card">
											<div className="card-row">
												<b>{s.full_name}</b>
												<span className={`badge status-${s.reportsick_status}`}>
													{s.case_type} · {s.reportsick_status.replace(/_/g, ' ')}
												</span>
											</div>
											{s.num_of_mc_days != null && s.num_of_mc_days >= 1 && (
												<div className="muted">
													{s.num_of_mc_days} day(s) MC — {s.mc_start_date} → {s.mc_end_date}
												</div>
											)}
											{s.approved_at && <div className="muted">Approved {s.approved_at}</div>}
										</div>
									))}
								</div>
							))
						)}
					</Section>
				</>
			)}
		</div>
	);
}

function Section({ title, accent, children }: { title: string; accent: 'success' | 'warning' | 'danger'; children: React.ReactNode }) {
	const color = accent === 'success' ? 'var(--depot-success)' : accent === 'warning' ? 'var(--depot-warning)' : 'var(--depot-danger)';
	return (
		<div style={{ marginTop: 18 }}>
			<h4 style={{ margin: '0 0 8px', borderLeft: `4px solid ${color}`, paddingLeft: 8 }}>{title}</h4>
			{children}
		</div>
	);
}

function rangeOrSingle(start: string, end: string): string {
	return start === end ? start : `${start} → ${end}`;
}
