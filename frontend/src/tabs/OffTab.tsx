import { useEffect, useRef, useState } from 'react';
import { api, alertDialog, confirmDialog, deptLabel, type Me } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

// Department heading order for the "Everyone" list (matches the Parade tab).
const DEPT_ORDER: readonly string[] = ['DHQ', 'DMSP', 'DCS', 'DSP', 'Others', 'Unassigned'];

interface SummaryRow {
	id: number;
	full_name: string;
	off_credits: number;
	department: string | null;
	sub_department: string | null;
	personnel_type: string | null;
	user_role: string;
}

// Sort within a department: Regulars first, then NSFs, each alphabetical.
function cmpOffRow(a: SummaryRow, b: SummaryRow): number {
	const ra = a.personnel_type === 'Regular' ? 0 : 1;
	const rb = b.personnel_type === 'Regular' ? 0 : 1;
	return ra - rb || a.full_name.localeCompare(b.full_name);
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
interface StaffRow {
	id: number;
	full_name: string;
	off_credits: number;
	department: string | null;
	user_role: string;
	personnel_type: string | null;
}

// Same 3-tiebreak ordering as the Parade "Show everyone" panel:
// 1) descending rights (superadmin > admin > user), 2) Regular before NSF,
// 3) alphabetical.
function cmpStaff(a: StaffRow, b: StaffRow): number {
	const roleRank = (r: string) => (r === 'superadmin' ? 0 : r === 'admin' ? 1 : 2);
	const typeRank = (t: string | null) => (t === 'Regular' ? 0 : 1);
	return roleRank(a.user_role) - roleRank(b.user_role) || typeRank(a.personnel_type) - typeRank(b.personnel_type) || a.full_name.localeCompare(b.full_name);
}
interface GrantRow {
	id: number;
	user_id: number;
	num_days: number;
	reason: string;
	status: string;
	granted_by_name: string | null;
	created_at: string;
	approved_at: string | null;
}

function isAdminish(role: Me['user_role']) {
	return role === 'admin' || role === 'superadmin';
}

function fmtDates(r: { startdate: string; enddate: string }) {
	return r.startdate === r.enddate ? r.startdate : `${r.startdate} → ${r.enddate}`;
}

function dayCount(start: string, end: string): number {
	const a = new Date(`${start}T00:00:00Z`).getTime();
	const b = new Date(`${end}T00:00:00Z`).getTime();
	return Math.floor((b - a) / 86_400_000) + 1;
}

// Credit-days: a half-day (AM/PM) costs 0.5 per day, a full day costs 1.
function offDays(start: string, end: string, period: string): number {
	return period === 'AM' || period === 'PM' ? dayCount(start, end) * 0.5 : dayCount(start, end);
}

export function OffTab({
	me,
	initialOff,
	onConsumed,
}: {
	me: Me;
	initialOff?: { start: string; end: string } | null;
	onConsumed?: () => void;
}) {
	const [summary, setSummary] = useState<SummaryRow[]>([]);
	const [detailUser, setDetailUser] = useState<SummaryRow | null>(null);
	const [details, setDetails] = useState<DetailRow[]>([]);
	const [mine, setMine] = useState<MyOffRow[]>([]);
	const [grants, setGrants] = useState<GrantRow[]>([]);
	const [credits, setCredits] = useState<number>(me.off_credits);
	const [showRequest, setShowRequest] = useState(false);
	const [reqPrefill, setReqPrefill] = useState<{ start: string; end: string } | null>(null);
	const [showGive, setShowGive] = useState(false);
	// Everyone's off library is hidden until explicitly shown (declutters the page).
	const [showEveryone, setShowEveryone] = useState(false);
	const [everyoneSearch, setEveryoneSearch] = useState('');
	// "My recent requests" shows only the latest 3 until expanded.
	const [showAllMine, setShowAllMine] = useState(false);

	// When routed here from the Parade tab (user marked OFF without applying),
	// open the Request Off modal prefilled with the dates. The ref guards
	// against re-opening on every re-render while the action is still set.
	const routeHandled = useRef(false);
	useEffect(() => {
		if (initialOff && !routeHandled.current) {
			routeHandled.current = true;
			setReqPrefill(initialOff);
			setShowRequest(true);
			onConsumed?.();
		}
		if (!initialOff) routeHandled.current = false;
	}, [initialOff, onConsumed]);

	function loadSummary() {
		return api.get<SummaryRow[]>('/api/off/summary').then(setSummary);
	}
	function loadMine() {
		return api.get<MyOffRow[]>('/api/off/mine').then(setMine);
	}
	function loadGrants() {
		return api.get<GrantRow[]>('/api/off/grants/mine').then(setGrants);
	}
	function loadMyCredits() {
		return api.get<Me>('/api/me').then((m) => setCredits(m.off_credits));
	}

	useEffect(() => {
		loadSummary().catch(console.error);
		loadMine().catch(console.error);
		loadGrants().catch(console.error);
		// Re-fetch the live balance on every mount (e.g. switching back to this
		// tab) — the `credits` state otherwise starts from the stale app-load
		// value and self-managed auto-approvals wouldn't show until reopening.
		loadMyCredits().catch(console.error);
	}, []);

	useEffect(() => {
		if (!detailUser) return;
		api.get<DetailRow[]>(`/api/off/user?id=${detailUser.id}`).then(setDetails).catch(console.error);
	}, [detailUser]);

	async function refreshAll() {
		await Promise.all([loadSummary(), loadMine(), loadGrants(), loadMyCredits()]);
		if (detailUser) {
			const fresh = await api.get<DetailRow[]>(`/api/off/user?id=${detailUser.id}`);
			setDetails(fresh);
		}
	}

	// Sync when the user returns to the app (e.g. after a superior's approval DM).
	useFocusRefresh(() => {
		void Promise.all([loadMine(), loadGrants(), loadMyCredits()]);
	});

	async function cancelMine(id: number) {
		const ok = await confirmDialog('Cancel this off request?');
		if (!ok) return;
		try {
			await api.post('/api/off/cancel', { id });
			await refreshAll();
			alertDialog('Cancelled.');
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	async function revertApproval(id: number) {
		const ok = await confirmDialog('Revert this approval back to pending? Credits stay reserved while it awaits re-approval (refunded only if it is then rejected or cancelled).');
		if (!ok) return;
		try {
			await api.post('/api/off/revert', { id });
			await refreshAll();
			alertDialog('Reverted — back to pending approval.');
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ----- Detail view -----------------------------------------------------
	if (detailUser) {
		// Total off-days used across all approved requests (one request can
		// span multiple days; we sum each range inclusive).
		const totalDaysUsed = details.reduce((sum, d) => sum + offDays(d.startdate, d.enddate, d.period), 0);
		return (
			<div>
				<button className="btn btn-secondary" onClick={() => setDetailUser(null)}>← Back</button>
				<h3 style={{ marginTop: 12 }}>
					{detailUser.full_name} — {totalDaysUsed} off day{totalDaysUsed === 1 ? '' : 's'} used
					<span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>🪙 {detailUser.off_credits}</span>
				</h3>
				{details.length === 0 ? (
					<p className="muted">No approved offs yet.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Dates (reason)</th>
								<th>Num of Offs Used</th>
								<th>Approved by</th>
								<th>Approved date</th>
								{isAdminish(me.user_role) && <th></th>}
							</tr>
						</thead>
						<tbody>
							{details.map((d) => (
								<tr key={d.id}>
									<td>
										{fmtDates(d)}{d.period === 'AM' || d.period === 'PM' ? ` (${d.period})` : ''}
										<br />
										<span className="muted">{d.reason}</span>
									</td>
									<td>{offDays(d.startdate, d.enddate, d.period)}</td>
									<td>{d.approved_by_name ?? '—'}</td>
									<td>{d.approved_date?.slice(0, 10) ?? '—'}</td>
									{isAdminish(me.user_role) && (
										<td>
											{(me.user_role === 'superadmin' || d.approved_by_id === me.id) && (
												<button className="btn-link danger" onClick={() => revertApproval(d.id)}>↩ Revert</button>
											)}
										</td>
									)}
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		);
	}

	// ----- Summary view ----------------------------------------------------
	const pendingGrants = grants.filter((g) => g.status === 'pending_superior');

	return (
		<div>
			<div className="card" style={{ background: 'var(--depot-success)', color: '#fff' }}>
				<div className="card-row">
					<span>🪙 Off Credit Balance: <b>{credits}</b></span>
				</div>
			</div>

			<div className="actions" style={{ marginTop: 10 }}>
				<button className="btn" onClick={() => setShowRequest(true)}>+ Request Off</button>
				<button className="btn btn-secondary" onClick={() => setShowGive(true)}>+ Credit Off(s)</button>
			</div>

			{pendingGrants.length > 0 && (
				<>
					<h4 className="section-title">Pending credit grants ({pendingGrants.length})</h4>
					{pendingGrants.map((g) => (
						<div key={g.id} className="entry-card acc-pending">
							<div className="entry-head">
								<span className="entry-title">🪙 +{g.num_days} credit{g.num_days === 1 ? '' : 's'}</span>
								<span className="badge status-pending_superior">pending</span>
							</div>
							<div className="entry-meta"><span>from {g.granted_by_name ?? '?'}</span></div>
							{g.reason && <div className="entry-reason">{g.reason}</div>}
						</div>
					))}
				</>
			)}

			{mine.length > 0 && (
				<>
					<h4 className="section-title">My recent requests</h4>
					{(showAllMine ? mine : mine.slice(0, 3)).map((m) => {
						const days = offDays(m.startdate, m.enddate, m.period);
						return (
							<div key={m.id} className={`entry-card acc-${m.off_status}`}>
								<div className="entry-head">
									<span className="entry-title">📅 {fmtDates(m)}{m.period === 'AM' || m.period === 'PM' ? ` (${m.period})` : ''}</span>
									<span className={`badge status-${m.off_status}`}>{m.off_status}</span>
								</div>
								<div className="entry-meta">
									<span>🗓 {days} day{days === 1 ? '' : 's'}</span>
									{m.approved_by_name && <span>✓ {m.approved_by_name}</span>}
								</div>
								{m.reason && <div className="entry-reason">{m.reason}</div>}
								{m.off_status === 'pending' && (
									<div className="entry-actions">
										<button className="btn-link danger" onClick={() => cancelMine(m.id)}>🗑 Cancel</button>
									</div>
								)}
							</div>
						);
					})}
					{mine.length > 3 && (
						<button className="btn-link" onClick={() => setShowAllMine((v) => !v)}>
							{showAllMine ? '▲ Show less' : `▾ Show more (${mine.length - 3})`}
						</button>
					)}
				</>
			)}

			{showEveryone && (
				<>
					<input
						value={everyoneSearch}
						onChange={(e) => setEveryoneSearch(e.target.value)}
						placeholder="🔎 Search name"
						style={{ width: '100%', margin: '8px 0' }}
					/>
					{(() => {
						const q = everyoneSearch.trim().toLowerCase();
						const filtered = q ? summary.filter((r) => r.full_name.toLowerCase().includes(q)) : summary;
						const groups = new Map<string, SummaryRow[]>();
						for (const row of filtered) {
							const key = deptLabel(row.department, row.sub_department);
							const arr = groups.get(key) ?? [];
							arr.push(row);
							groups.set(key, arr);
						}
						const order = [...DEPT_ORDER, ...[...groups.keys()].filter((k) => !DEPT_ORDER.includes(k))];
						const shown = order.filter((dept) => groups.has(dept));
						if (shown.length === 0) return <p className="muted">No matching names.</p>;
						return shown.map((dept) => (
							<div key={dept}>
								<h4 className="section-title">{dept} ({groups.get(dept)!.length})</h4>
								{[...groups.get(dept)!].sort(cmpOffRow).map((row) => (
									<div key={row.id} className="row" onClick={() => setDetailUser(row)}>
										<span>{row.full_name}</span>
										<span className="muted" style={{ fontSize: 13 }}>🪙 {row.off_credits}</span>
									</div>
								))}
							</div>
						));
					})()}
				</>
			)}

			{/* Everyone's off library is collapsed by default — full-width toggle
			    at the bottom so the page stays focused on your own off info. */}
			<button
				className="btn btn-secondary"
				style={{ width: '100%', marginTop: 14 }}
				onClick={() => setShowEveryone((v) => !v)}
			>
				{showEveryone ? '▲ Hide everyone' : `👥 Show Everyone (${summary.length})`}
			</button>

			{showRequest && (
				<RequestOffModal
					balance={credits}
					initialStart={reqPrefill?.start}
					initialEnd={reqPrefill?.end}
					onClose={() => {
						setShowRequest(false);
						setReqPrefill(null);
					}}
					onDone={refreshAll}
				/>
			)}
			{showGive && (
				<CreditOffModal me={me} onClose={() => setShowGive(false)} onDone={refreshAll} />
			)}
		</div>
	);
}

function RequestOffModal({
	balance,
	initialStart,
	initialEnd,
	onClose,
	onDone,
}: {
	balance: number;
	initialStart?: string;
	initialEnd?: string;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const [startdate, setStart] = useState(initialStart ?? '');
	const [enddate, setEnd] = useState(initialEnd ?? '');
	const [period, setPeriod] = useState<'FD' | 'AM' | 'PM'>('FD');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	const datesValid = !!startdate && !!enddate && startdate <= enddate;
	// A half-day (AM/PM) costs 0.5 credits per day; full day costs 1.
	const creditDays = datesValid ? offDays(startdate, enddate, period) : 0;
	// Balance may go negative — no sufficiency check at all.
	let hint: string | null = null;
	if (!startdate || !enddate) hint = 'Pick start and end dates.';
	else if (startdate > enddate) hint = 'End date must be on or after start date.';

	async function submit() {
		setBusy(true);
		try {
			const res = await api.post<{ auto_approved?: boolean; balance_after?: number }>('/api/off/request', { startdate, enddate, reason, period });
			await onDone();
			onClose();
			alertDialog(
				res.auto_approved
					? `✅ Off applied (no approval needed). ${creditDays} credit${creditDays === 1 ? '' : 's'} used${res.balance_after != null ? `. Balance: ${res.balance_after}` : ''}.`
					: `Submitted — awaiting approval. ${creditDays} credit${creditDays === 1 ? '' : 's'} reserved now (refunded if rejected or cancelled).`,
			);
		} catch (e) {
			setBusy(false);
			const msg = e instanceof Error ? e.message : String(e);
			alertDialog(
				msg.includes('overlapping_request')
					? '⚠ You already have a pending or approved off that overlaps those dates — manage it in your list below instead of re-requesting.'
					: `Failed: ${msg}`,
			);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Request Off</h3>
				<div className="muted">Balance: 🪙 {balance} · This request: {creditDays} credit{creditDays === 1 ? '' : 's'}</div>
				<label>Start date<input
					type="date"
					value={startdate}
					onChange={(e) => {
						const v = e.target.value;
						setStart(v);
						// Snap end date to start when it's empty or now before start.
						if (!enddate || enddate < v) setEnd(v);
					}}
				/></label>
				<label>End date<input type="date" value={enddate} min={startdate || undefined} onChange={(e) => setEnd(e.target.value)} /></label>
				<label>Half / full day
					<div className="seg">
						<button type="button" className={period === 'FD' ? 'active' : ''} onClick={() => setPeriod('FD')}>Full day</button>
						<button type="button" className={period === 'AM' ? 'active' : ''} onClick={() => setPeriod('AM')}>AM only</button>
						<button type="button" className={period === 'PM' ? 'active' : ''} onClick={() => setPeriod('PM')}>PM only</button>
					</div>
				</label>
				<label>Reason <span className="muted">(optional)</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
				{hint && <div className="muted danger" style={{ marginBottom: 8 }}>{hint}</div>}
				<button
					className="btn"
					disabled={busy || !datesValid}
					onClick={submit}
				>
					{busy ? 'Submitting…' : 'Submit'}
				</button>
			</div>
		</div>
	);
}

function CreditOffModal({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => Promise<void> }) {
	// Admins/superadmins can credit anyone (subject to approval); an
	// appointment+self user can credit their own department (incl self).
	const canCreditOthers = isAdminish(me.user_role) || (!!me.appointment && !!me.self_managed);
	const [staff, setStaff] = useState<StaffRow[]>([]);
	// '' means self for normal users; admins pick a recipient from the list.
	const [staffId, setStaffId] = useState<number | ''>('');
	const [staffSearch, setStaffSearch] = useState('');
	const [staffDept, setStaffDept] = useState<string>('all');
	const [numDays, setNumDays] = useState<number | ''>('');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (canCreditOthers) api.get<StaffRow[]>('/api/off/staff').then(setStaff);
	}, [canCreditOthers]);

	const selfSelected = !canCreditOthers || staffId === '' || staffId === me.id;
	const selected = staff.find((s) => s.id === staffId);

	// Name search + department filter over the recipient list (client-side, like
	// the Parade "Show everyone" panel).
	const staffQuery = staffSearch.trim().toLowerCase();
	const staffDeptOptions = DEPT_ORDER.filter((d) => staff.some((s) => deptLabel(s.department, null) === d));
	const filteredStaff = staff
		.filter((s) => (staffQuery ? s.full_name.toLowerCase().includes(staffQuery) : true))
		.filter((s) => (staffDept === 'all' ? true : deptLabel(s.department, null) === staffDept))
		.sort(cmpStaff);
	// Group the (already sorted) matches by department, in DEPT_ORDER.
	const staffGroups: [string, StaffRow[]][] = (() => {
		const m = new Map<string, StaffRow[]>();
		for (const s of filteredStaff) {
			const k = deptLabel(s.department, null);
			const arr = m.get(k) ?? [];
			arr.push(s);
			m.set(k, arr);
		}
		const order = [...DEPT_ORDER, ...[...m.keys()].filter((k) => !DEPT_ORDER.includes(k))];
		return order.filter((d) => m.has(d)).map((d) => [d, m.get(d)!] as [string, StaffRow[]]);
	})();

	async function submit() {
		setBusy(true);
		try {
			// Round to 1 decimal place (half-days like 3.5 are allowed) + trimmed
			// reason. (The server also coerces.) Omit staff_id to default to self.
			const payload: Record<string, unknown> = { num_days: Math.round(Number(numDays) * 10) / 10, reason: reason.trim() };
			if (canCreditOthers && staffId !== '') payload.staff_id = staffId;
			const res = await api.post<{ auto_approved?: boolean; balance?: number; recipient_name?: string }>('/api/off/grant', payload);
			await onDone();
			onClose();
			const recipientName = res.recipient_name ?? (selfSelected ? me.full_name : selected?.full_name ?? 'the recipient');
			alertDialog(
				res.auto_approved
					? `✅ ${numDays} off credit(s) credited to ${recipientName} (no approval needed)${res.balance != null ? `. Their balance: ${res.balance}` : ''}.`
					: `Submitted — ${numDays} off credit(s) for ${recipientName}, pending superior approval.`,
			);
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	const ok = typeof numDays === 'number' && numDays > 0 && reason.trim().length > 0;
	// Immediate (no approval) only when the granter holds an appointment AND is
	// self-managed AND the recipient is in their own department (incl self).
	// Everyone else's credit (incl admin/superadmin → others) is a proposal.
	const recipientDept = selfSelected ? me.department : selected?.department ?? null;
	const immediate = !!me.appointment && !!me.self_managed && me.department === recipientDept;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Credit Off(s)</h3>
				<p className="muted">
					{immediate
						? 'Credits are applied immediately — no approval needed (you hold an appointment, are self-managed, and the recipient is in your department).'
						: 'This is a proposal — it will be sent to the recipient’s approver(s) for approval before the credits are added.'}
				</p>
				{canCreditOthers && (
					<>
						<label style={{ marginBottom: 6 }}>Recipient</label>
						<input
							value={staffSearch}
							onChange={(e) => setStaffSearch(e.target.value)}
							placeholder="🔎 Search name"
							style={{ marginTop: 0, marginBottom: 6 }}
						/>
						<select
							value={staffDept}
							onChange={(e) => setStaffDept(e.target.value)}
							style={{ marginTop: 0, marginBottom: 6 }}
						>
							<option value="all">All departments</option>
							{staffDeptOptions.map((d) => (
								<option key={d} value={d}>
									{d}
								</option>
							))}
						</select>
						<div className="credit-list">
							{/* Myself — pinned at the top. */}
							<button
								type="button"
								className={`credit-option${selfSelected ? ' selected' : ''}`}
								onClick={() => setStaffId('')}
							>
								<span className="credit-option-name">
									Myself <span className="muted">(you)</span>
									{selfSelected && <span className="credit-chip-check"> ✓</span>}
								</span>
								<span className="muted">🪙 {me.off_credits}</span>
							</button>
							{staffGroups.length === 0 ? (
								<p className="muted" style={{ padding: '10px 12px', margin: 0 }}>No matching names.</p>
							) : (
								staffGroups.map(([dept, list]) => (
									<div key={dept}>
										<div className="credit-group-header">{dept} ({list.length})</div>
										{list.map((s) => (
											<button
												type="button"
												key={s.id}
												className={`credit-option${s.id === staffId ? ' selected' : ''}`}
												onClick={() => setStaffId(s.id)}
											>
												<span className="credit-option-name">
													{s.full_name}
													{s.id === staffId && <span className="credit-chip-check"> ✓</span>}
												</span>
												<span className="muted">🪙 {s.off_credits}</span>
											</button>
										))}
									</div>
								))
							)}
						</div>
						{!selfSelected && selected && (
							<div className="muted" style={{ marginTop: 6 }}>
								Crediting <b>{selected.full_name}</b> ({deptLabel(selected.department, null)}).
							</div>
						)}
					</>
				)}
				<label>Number of off days (half-days allowed, e.g. 3.5)
					<input
						type="number"
						min={0.5}
						step={0.5}
						value={numDays}
						onChange={(e) => setNumDays(e.target.value === '' ? '' : Number(e.target.value))}
						placeholder="e.g. 3 or 3.5"
					/>
				</label>
				<label>Reason
					<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Off in lieu for weekend duty" />
				</label>
				<button className="btn" disabled={busy || !ok} onClick={submit}>
					{busy ? 'Submitting…' : immediate ? 'Credit now' : 'Submit for superior approval'}
				</button>
			</div>
		</div>
	);
}
