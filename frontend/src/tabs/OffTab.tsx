import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api, confirmDialog, type Me } from '../lib/api';

interface SummaryRow {
	id: number;
	full_name: string;
	off_count: number;
	off_credits: number;
	department: string | null;
}
interface DetailRow {
	id: number;
	startdate: string;
	enddate: string;
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

export function OffTab({ me }: { me: Me }) {
	const [summary, setSummary] = useState<SummaryRow[]>([]);
	const [detailUser, setDetailUser] = useState<SummaryRow | null>(null);
	const [details, setDetails] = useState<DetailRow[]>([]);
	const [mine, setMine] = useState<MyOffRow[]>([]);
	const [grants, setGrants] = useState<GrantRow[]>([]);
	const [credits, setCredits] = useState<number>(me.off_credits);
	const [showRequest, setShowRequest] = useState(false);
	const [showGive, setShowGive] = useState(false);

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

	async function cancelMine(id: number) {
		const ok = await confirmDialog('Cancel this off request?');
		if (!ok) return;
		try {
			await api.post('/api/off/cancel', { id });
			await refreshAll();
			WebApp.showAlert('Cancelled.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	async function revertApproval(id: number) {
		const ok = await confirmDialog('Revert this approval? Credits will be refunded.');
		if (!ok) return;
		try {
			await api.post('/api/off/revert', { id });
			await refreshAll();
			WebApp.showAlert('Approval reverted, credits refunded.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ----- Detail view -----------------------------------------------------
	if (detailUser) {
		return (
			<div>
				<button className="btn btn-secondary" onClick={() => setDetailUser(null)}>← Back</button>
				<h3 style={{ marginTop: 12 }}>
					{detailUser.full_name} — {detailUser.off_count} approved off{detailUser.off_count === 1 ? '' : 's'}
					<span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>🪙 {detailUser.off_credits}</span>
				</h3>
				{details.length === 0 ? (
					<p className="muted">No approved offs yet.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Dates (reason)</th>
								<th>Approved by</th>
								<th>Approved date</th>
								{isAdminish(me.user_role) && <th></th>}
							</tr>
						</thead>
						<tbody>
							{details.map((d) => (
								<tr key={d.id}>
									<td>
										{fmtDates(d)}
										<br />
										<span className="muted">{d.reason}</span>
									</td>
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
					<span>🪙 <b>{credits}</b> off credit{credits === 1 ? '' : 's'}</span>
					<span style={{ fontSize: 12, opacity: 0.85 }}>Used when superior approves an off</span>
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
						<div key={g.id} className="card">
							<div className="card-row">
								<span><b>+{g.num_days} credit{g.num_days === 1 ? '' : 's'}</b> from {g.granted_by_name ?? '?'}</span>
								<span className="badge status-pending_superior">pending</span>
							</div>
							<div className="muted">{g.reason}</div>
						</div>
					))}
				</>
			)}

			{mine.length > 0 && (
				<>
					<h4 className="section-title">My recent requests</h4>
					{mine.map((m) => (
						<div key={m.id} className="card">
							<div className="card-row">
								<span>
									<b>{fmtDates(m)}</b> · {m.off_status}
									{' · '}<span className="muted">{dayCount(m.startdate, m.enddate)} day(s)</span>
								</span>
								{m.off_status === 'pending' && (
									<button className="btn-link danger" onClick={() => cancelMine(m.id)}>🗑 Cancel</button>
								)}
							</div>
							<div className="muted">{m.reason}</div>
						</div>
					))}
				</>
			)}

			<h4 className="section-title">Everyone</h4>
			{summary.map((row) => (
				<div key={row.id} className="row" onClick={() => setDetailUser(row)}>
					<span>
						{row.full_name}
						{row.department && <span className="muted" style={{ marginLeft: 6 }}>· {row.department}</span>}
					</span>
					<span className="muted" style={{ fontSize: 13 }}>
						🪙 {row.off_credits} · taken {row.off_count}
					</span>
				</div>
			))}

			{showRequest && (
				<RequestOffModal balance={credits} onClose={() => setShowRequest(false)} onDone={refreshAll} />
			)}
			{showGive && (
				<CreditOffModal me={me} onClose={() => setShowGive(false)} onDone={refreshAll} />
			)}
		</div>
	);
}

function RequestOffModal({
	balance,
	onClose,
	onDone,
}: {
	balance: number;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const [startdate, setStart] = useState('');
	const [enddate, setEnd] = useState('');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	const days = startdate && enddate && startdate <= enddate ? dayCount(startdate, enddate) : 0;
	const datesValid = !!startdate && !!enddate && startdate <= enddate;
	const sufficient = days > 0 && days <= balance;
	let hint: string | null = null;
	if (!startdate || !enddate) hint = 'Pick start and end dates.';
	else if (startdate > enddate) hint = 'End date must be on or after start date.';
	else if (!sufficient) hint = `Need ${days} credit(s) but only have ${balance}. Ask an admin to grant you more credits first.`;
	else if (!reason.trim()) hint = 'Reason is required.';

	async function submit() {
		setBusy(true);
		try {
			await api.post('/api/off/request', { startdate, enddate, reason });
			await onDone();
			onClose();
			WebApp.showAlert(`Submitted — awaiting approval (${days} credit${days === 1 ? '' : 's'} will be deducted on approval).`);
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Request Off</h3>
				<div className="muted">Balance: 🪙 {balance} · This request: {days} day{days === 1 ? '' : 's'}</div>
				<label>Start date<input type="date" value={startdate} onChange={(e) => setStart(e.target.value)} /></label>
				<label>End date<input type="date" value={enddate} onChange={(e) => setEnd(e.target.value)} /></label>
				<label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
				{hint && <div className="muted danger" style={{ marginBottom: 8 }}>{hint}</div>}
				<button
					className="btn"
					disabled={busy || !datesValid || !sufficient || !reason.trim()}
					onClick={submit}
				>
					{busy ? 'Submitting…' : 'Submit'}
				</button>
			</div>
		</div>
	);
}

function CreditOffModal({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => Promise<void> }) {
	const canCreditOthers = isAdminish(me.user_role);
	const [staff, setStaff] = useState<StaffRow[]>([]);
	// '' means self for normal users; admins pick from the dropdown.
	const [staffId, setStaffId] = useState<number | ''>('');
	const [numDays, setNumDays] = useState<number | ''>('');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (canCreditOthers) api.get<StaffRow[]>('/api/off/staff').then(setStaff);
	}, [canCreditOthers]);

	const selfSelected = !canCreditOthers || staffId === '' || staffId === me.id;
	const selected = staff.find((s) => s.id === staffId);

	async function submit() {
		setBusy(true);
		try {
			// Omit staff_id to default to self on the server.
			const payload: Record<string, unknown> = { num_days: Number(numDays), reason };
			if (canCreditOthers && staffId !== '') payload.staff_id = staffId;
			await api.post('/api/off/grant', payload);
			await onDone();
			onClose();
			WebApp.showAlert(`Submitted — ${numDays} off credit(s) pending superior approval.`);
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	const ok = typeof numDays === 'number' && numDays > 0 && reason.trim().length > 0;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Credit Off(s)</h3>
				<p className="muted">
					Request a number of off days to be credited to your balance. Your superior must approve before the credits are added.
					{canCreditOthers && ' As an admin, you can also credit your staff.'}
				</p>
				{canCreditOthers && (
					<>
						<label>Recipient
							<select value={staffId} onChange={(e) => setStaffId(e.target.value === '' ? '' : Number(e.target.value))}>
								<option value="">Myself ({me.full_name})</option>
								{staff.map((s) => (
									<option key={s.id} value={s.id}>
										{s.full_name}{s.department ? ` (${s.department})` : ''} — 🪙 {s.off_credits}
									</option>
								))}
							</select>
						</label>
						{!selfSelected && selected && (
							<div className="muted" style={{ marginBottom: 8 }}>
								{selected.full_name} currently has 🪙 {selected.off_credits} credit{selected.off_credits === 1 ? '' : 's'}.
							</div>
						)}
					</>
				)}
				<label>Number of off days
					<input
						type="number"
						min={1}
						value={numDays}
						onChange={(e) => setNumDays(e.target.value === '' ? '' : Number(e.target.value))}
						placeholder="e.g. 3"
					/>
				</label>
				<label>Reason
					<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Off in lieu for weekend duty" />
				</label>
				<button className="btn" disabled={busy || !ok} onClick={submit}>
					{busy ? 'Submitting…' : 'Submit for superior approval'}
				</button>
			</div>
		</div>
	);
}
