import { useEffect, useState, type CSSProperties } from 'react';
import { api, alertDialog, confirmDialog, deptLabel, type Me } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

// Pill-style toggle used by the Pending page type filter.
function chipStyle(active: boolean): CSSProperties {
	return {
		padding: '4px 10px',
		borderRadius: 999,
		fontSize: 12,
		cursor: 'pointer',
		border: '1px solid var(--tg-theme-section-separator-color, #ccc)',
		background: active ? 'var(--depot-info, #0288d1)' : 'transparent',
		color: active ? '#fff' : 'inherit',
	};
}
type InboxTypeFilter = 'all' | 'off' | 'sick' | 'leave' | 'ma' | 'grant' | 'parade';

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
	const [typeFilter, setTypeFilter] = useState<InboxTypeFilter>('all');
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
	// If the selected type empties (e.g. after approving the last item of that
	// type), fall back to All so remaining pending items don't get hidden.
	useEffect(() => {
		if (!data || typeFilter === 'all') return;
		const c =
			typeFilter === 'off'
				? data.offs.length
				: typeFilter === 'sick'
					? data.sick.length
					: typeFilter === 'grant'
						? data.grants.length
						: typeFilter === 'parade'
							? data.parade.length
							: typeFilter === 'ma'
								? data.leave.filter((l) => l.leave_type === 'MA').length
								: data.leave.filter((l) => l.leave_type !== 'MA').length;
		if (c === 0) setTypeFilter('all');
	}, [data, typeFilter]);

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

	// Requester withdraws their OWN still-pending request (Mine view only). Off,
	// sick and leave/MA each have their own cancel endpoint.
	async function cancelMine(kind: 'off' | 'sick' | 'leave', id: number) {
		const ok = await confirmDialog('Cancel this request? It will be withdrawn and any parade status reverted.');
		if (!ok) return;
		setBusy(true);
		try {
			const path = kind === 'off' ? '/api/off/cancel' : kind === 'sick' ? '/api/sick/cancel' : '/api/leave/cancel';
			await api.post(path, { id });
			await refresh();
			alertDialog('Cancelled.');
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

	// Leave and MA share the leave_requests table but are filtered separately.
	const leaveOnly = data.leave.filter((l) => l.leave_type !== 'MA');
	const maItems = data.leave.filter((l) => l.leave_type === 'MA');
	const counts: Record<Exclude<InboxTypeFilter, 'all'>, number> = {
		off: data.offs.length,
		sick: data.sick.length,
		leave: leaveOnly.length,
		ma: maItems.length,
		grant: data.grants.length,
		parade: data.parade.length,
	};
	const FILTERS: { key: Exclude<InboxTypeFilter, 'all'>; label: string }[] = [
		{ key: 'off', label: 'Off' },
		{ key: 'sick', label: 'Sick' },
		{ key: 'leave', label: 'Leave' },
		{ key: 'ma', label: 'MA' },
		{ key: 'grant', label: 'Credit' },
		{ key: 'parade', label: 'Parade' },
	];
	const available = FILTERS.filter((f) => counts[f.key] > 0);
	const show = (k: Exclude<InboxTypeFilter, 'all'>) => typeFilter === 'all' || typeFilter === k;
	// If the active filter's type emptied out (e.g. after a refresh), nothing renders.
	const filterEmpty = total > 0 && typeFilter !== 'all' && counts[typeFilter] === 0;

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
			{available.length > 1 && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
					<button style={chipStyle(typeFilter === 'all')} onClick={() => setTypeFilter('all')}>All ({total})</button>
					{available.map((f) => (
						<button key={f.key} style={chipStyle(typeFilter === f.key)} onClick={() => setTypeFilter(f.key)}>
							{f.label} ({counts[f.key]})
						</button>
					))}
				</div>
			)}
			{total === 0 ? (
				<p className="muted">{emptyMsg}</p>
			) : filterEmpty ? (
				<p className="muted">Nothing of this type pending.</p>
			) : (
				<>
					{data.offs.length > 0 && show('off') && (
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
								onCancel: mineView ? () => cancelMine('off', o.id) : undefined,
							}))}
						/>
					)}
					{data.sick.length > 0 && show('sick') && (
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
								onCancel: mineView ? () => cancelMine('sick', s.id) : undefined,
							}))}
						/>
					)}
					{data.grants.length > 0 && show('grant') && (
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
					{data.parade.length > 0 && show('parade') && (
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
					{leaveOnly.length > 0 && show('leave') && (
						<ApprovalGroup
							title={`Leave requests (${leaveOnly.length})`}
							type="leave"
							chip="Leave"
							busy={busy}
							onApproveAll={() => act(leaveOnly.filter((l) => l.can_action).map((l) => ({ type: 'leave', id: l.id, action: 'approve' })), 'Approve all leave')}
							rows={sortByDept(leaveOnly).map((l) => ({
								id: l.id,
								canAct: l.can_action,
								main: `${deptLabel(l.department, l.sub_department)} · ${l.full_name} · ${leaveLabel(l.leave_type, l.period)} · ${l.startdate === l.enddate ? l.startdate : `${l.startdate}→${l.enddate}`}`,
								sub: l.reason ?? '',
								onApprove: () => act([{ type: 'leave', id: l.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'leave', id: l.id, action: 'reject' }], 'Reject'),
								onCancel: mineView ? () => cancelMine('leave', l.id) : undefined,
							}))}
						/>
					)}
					{maItems.length > 0 && show('ma') && (
						<ApprovalGroup
							title={`MA (medical appointment) requests (${maItems.length})`}
							type="leave"
							chip="MA"
							busy={busy}
							onApproveAll={() => act(maItems.filter((l) => l.can_action).map((l) => ({ type: 'leave', id: l.id, action: 'approve' })), 'Approve all MA')}
							rows={sortByDept(maItems).map((l) => ({
								id: l.id,
								canAct: l.can_action,
								main: `${deptLabel(l.department, l.sub_department)} · ${l.full_name} · ${l.period && l.period !== 'FD' ? `${l.period} ` : ''}MA · ${l.startdate === l.enddate ? l.startdate : `${l.startdate}→${l.enddate}`}`,
								sub: l.reason ?? '',
								onApprove: () => act([{ type: 'leave', id: l.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'leave', id: l.id, action: 'reject' }], 'Reject'),
								onCancel: mineView ? () => cancelMine('leave', l.id) : undefined,
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
	rows: { id: number; main: string; sub: string; canAct: boolean; onApprove: () => void; onReject: () => void; onCancel?: () => void }[];
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
						) : r.onCancel ? (
							<button className="btn-link danger" style={{ flexShrink: 0 }} disabled={busy} onClick={r.onCancel}>🗑 Cancel</button>
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
	const [recentType, setRecentType] = useState<'all' | 'off' | 'grant' | 'leave' | 'ma' | 'sick'>('all');
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
	// If the selected type empties (e.g. after switching status/scope), fall back to All.
	useEffect(() => {
		if (!data || recentType === 'all') return;
		const maN = data.leave.filter((l) => l.leave_type === 'MA').length;
		const leaveN = data.leave.length - maN;
		const c =
			recentType === 'off' ? data.offs.length
				: recentType === 'grant' ? data.grants.length
					: recentType === 'sick' ? data.sick.length
						: recentType === 'ma' ? maN
							: leaveN;
		if (c === 0) setRecentType('all');
	}, [data, recentType]);

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

	// Requester withdraws/dismisses their OWN processed request (Mine view only).
	async function cancelMine(kind: 'off' | 'sick' | 'grant' | 'leave', id: number, label: string) {
		const ok = await confirmDialog(
			isRejected
				? `Dismiss this rejected ${label}? It will be cleared from your list.`
				: `Cancel this ${label}? It will be withdrawn and your parade status reverted.`,
		);
		if (!ok) return;
		setBusy(true);
		try {
			const path = kind === 'sick' ? '/api/sick/cancel' : kind === 'leave' ? '/api/leave/cancel' : '/api/off/cancel';
			await api.post(path, { id });
			await refresh();
			alertDialog(isRejected ? 'Dismissed.' : 'Cancelled.');
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (!data) return null;
	const mineView = scope === 'mine';

	// Approver view → Undo/Reopen (gated by can_undo). Mine view → the requester's
	// own Cancel/Dismiss (a rejected OFF can't be cancelled — its credits were
	// already refunded on rejection; an off-credit grant has no requester-cancel).
	const undoBtn = (kind: 'off' | 'sick' | 'grant' | 'leave', id: number, label: string, can: boolean) => {
		if (mineView) {
			if (kind === 'grant' || (kind === 'off' && isRejected)) return null;
			return (
				<button className="btn-link danger" disabled={busy} onClick={() => cancelMine(kind, id, label)}>
					{isRejected ? '🗑 Dismiss' : '🗑 Cancel'}
				</button>
			);
		}
		return can ? (
			<button className="btn-link danger" disabled={busy} onClick={() => undo(kind, id, label)}>
				{isRejected ? '↩ Reopen' : '↩ Undo'}
			</button>
		) : (
			<span className="muted" style={{ fontSize: 12 }}>view only</span>
		);
	};

	// Type filter (Leave and MA shown separately — they are different types).
	const leaveOnly = data.leave.filter((l) => l.leave_type !== 'MA');
	const maItems = data.leave.filter((l) => l.leave_type === 'MA');
	type RT = 'off' | 'grant' | 'leave' | 'ma' | 'sick';
	const rCounts: Record<RT, number> = {
		off: data.offs.length,
		grant: data.grants.length,
		leave: leaveOnly.length,
		ma: maItems.length,
		sick: data.sick.length,
	};
	const RFILTERS: { key: RT; label: string }[] = [
		{ key: 'off', label: 'Take Off' },
		{ key: 'sick', label: 'Sick' },
		{ key: 'leave', label: 'Leave' },
		{ key: 'ma', label: 'MA' },
		{ key: 'grant', label: 'Credit' },
	];
	const rAvailable = RFILTERS.filter((f) => rCounts[f.key] > 0);
	const showT = (k: RT) => recentType === 'all' || recentType === k;
	const total = data.offs.length + data.sick.length + data.grants.length + data.leave.length;
	const empty = total === 0;
	const filterEmpty = !empty && recentType !== 'all' && rCounts[recentType] === 0;

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
			{rAvailable.length > 1 && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
					<button style={chipStyle(recentType === 'all')} onClick={() => setRecentType('all')}>All ({total})</button>
					{rAvailable.map((f) => (
						<button key={f.key} style={chipStyle(recentType === f.key)} onClick={() => setRecentType(f.key)}>
							{f.label} ({rCounts[f.key]})
						</button>
					))}
				</div>
			)}
			<p className="muted" style={{ marginTop: -2 }}>
				{isRejected ? 'Rejections' : 'Approvals'} in the last 14 days{whoText}.
				{' '}
				{mineView
					? 'These are your own requests — use Cancel/Dismiss to withdraw or clear one.'
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
			) : filterEmpty ? (
				<p className="muted">Nothing of this type in this view.</p>
			) : (
				<>
					{showT('off') && data.offs.map((o) => (
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
					{showT('sick') && data.sick.map((s) => (
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
					{showT('grant') && data.grants.map((g) => (
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
					{showT('leave') && leaveOnly.map((l) => (
						<div key={`l${l.id}`} className="entry-card acc-leave">
							<div className="entry-head">
								<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
									<span className="type-chip leave">Leave</span>
									<span className="entry-title" style={{ fontSize: 14 }}>{l.full_name}</span>
								</span>
								{undoBtn('leave', l.id, 'leave', l.can_undo)}
							</div>
							<FieldLine label="Type" value={leaveLabel(l.leave_type, l.period)} />
							<FieldLine label="Dates" value={l.startdate === l.enddate ? l.startdate : `${l.startdate} → ${l.enddate}`} />
							<FieldLine label="Reason" value={l.reason} />
							<FieldLine label={actorLabel} value={l.approved_by_name} />
						</div>
					))}
					{showT('ma') && maItems.map((l) => (
						<div key={`l${l.id}`} className="entry-card acc-leave">
							<div className="entry-head">
								<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
									<span className="type-chip leave">MA</span>
									<span className="entry-title" style={{ fontSize: 14 }}>{l.full_name}</span>
								</span>
								{undoBtn('leave', l.id, 'MA request', l.can_undo)}
							</div>
							<FieldLine label="Type" value={l.period && l.period !== 'FD' ? `${l.period} MA` : 'MA'} />
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
	reason: string | null;
	location: string | null;
	approx_time: string | null;
	updated_status: string | null;
	approved_by_name: string | null;
}

interface TodayPayload {
	today: string;
	offs_today: OffRow[];
	sick_open: SickRow[];
	sick_pending: SickRow[];
	offs_pending: OffRow[];
}

export function TodayTab({ me }: { me: Me }) {
	// Three switchable views (one at a time, so the page doesn't grow into one long
	// scroll): Pending approvals (default), Recent (processed), and Active Today.
	// "Active Today" (/api/today: who's on off / open sick unit-wide) is approver-
	// only, so normal users only get Pending + Recent (their own requests).
	const canSeeOthers = me.is_approver;
	const [view, setView] = useState<'pending' | 'recent' | 'active'>('pending');
	const [data, setData] = useState<TodayPayload | null>(null);
	const [error, setError] = useState<string | null>(null);

	function loadToday() {
		if (!canSeeOthers) return Promise.resolve();
		setError(null);
		return api
			.get<TodayPayload>('/api/today')
			.then(setData)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}
	// Fetch Active Today lazily — only when that view is opened.
	useEffect(() => {
		if (view === 'active') loadToday();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view]);
	useFocusRefresh(() => (view === 'active' ? loadToday() : Promise.resolve()));

	return (
		<div>
			<div className="seg" style={{ marginBottom: 12 }}>
				<button className={view === 'pending' ? 'active' : ''} onClick={() => setView('pending')}>🗂 Pending</button>
				<button className={view === 'recent' ? 'active' : ''} onClick={() => setView('recent')}>↩ Recent</button>
				{canSeeOthers && (
					<button className={view === 'active' ? 'active' : ''} onClick={() => setView('active')}>📊 Active Today</button>
				)}
			</div>

			{view === 'pending' && <ApprovalsInbox me={me} />}
			{view === 'recent' && <RecentApprovals me={me} />}

			{view === 'active' && canSeeOthers && (
				error ? (
					<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)' }}>
						<h3>⚠ Couldn't load Active Today</h3>
						<p className="muted">{error}</p>
					</div>
				) : !data ? (
					<div className="muted">Loading…</div>
				) : (
					<>
						<h3>📊 Active Today — {data.today}</h3>

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
												{s.reason && <div className="muted">Reason: {s.reason}</div>}
												{s.num_of_mc_days != null && s.num_of_mc_days >= 1 && (
													<div className="muted">
														{s.num_of_mc_days} day(s) MC — {s.mc_start_date} → {s.mc_end_date}
													</div>
												)}
												{s.location && <div className="muted">Location: {s.location}</div>}
												{s.approx_time && <div className="muted">Time: {s.approx_time}</div>}
												{s.approved_by_name && <div className="muted">Approved by {s.approved_by_name}{s.approved_at ? ` · ${s.approved_at}` : ''}</div>}
												{!s.approved_by_name && s.approved_at && <div className="muted">Approved {s.approved_at}</div>}
											</div>
										))}
									</div>
								))
							)}
						</Section>
					</>
				)
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
