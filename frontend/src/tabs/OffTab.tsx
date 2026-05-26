import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api, type Me } from '../lib/api';

interface SummaryRow {
	id: number;
	full_name: string;
	off_count: number;
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
}

function isAdminish(role: Me['user_role']) {
	return role === 'admin' || role === 'superadmin';
}

function fmtDates(r: { startdate: string; enddate: string }) {
	return r.startdate === r.enddate ? r.startdate : `${r.startdate} → ${r.enddate}`;
}

export function OffTab({ me }: { me: Me }) {
	const [summary, setSummary] = useState<SummaryRow[]>([]);
	const [detailUser, setDetailUser] = useState<SummaryRow | null>(null);
	const [details, setDetails] = useState<DetailRow[]>([]);
	const [mine, setMine] = useState<MyOffRow[]>([]);
	const [showRequest, setShowRequest] = useState(false);
	const [showGive, setShowGive] = useState(false);

	function loadSummary() {
		return api.get<SummaryRow[]>('/api/off/summary').then(setSummary);
	}
	function loadMine() {
		return api.get<MyOffRow[]>('/api/off/mine').then(setMine);
	}

	useEffect(() => {
		loadSummary().catch(console.error);
		loadMine().catch(console.error);
	}, []);

	useEffect(() => {
		if (!detailUser) return;
		api.get<DetailRow[]>(`/api/off/user?id=${detailUser.id}`).then(setDetails).catch(console.error);
	}, [detailUser]);

	async function refreshAll() {
		await Promise.all([loadSummary(), loadMine()]);
		if (detailUser) {
			const fresh = await api.get<DetailRow[]>(`/api/off/user?id=${detailUser.id}`);
			setDetails(fresh);
		}
	}

	async function cancelMine(id: number) {
		const ok = await new Promise<boolean>((resolve) => WebApp.showConfirm('Cancel this off request?', resolve));
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
		const ok = await new Promise<boolean>((resolve) =>
			WebApp.showConfirm('Revert this approval? The user and original approver will be notified.', resolve),
		);
		if (!ok) return;
		try {
			await api.post('/api/off/revert', { id });
			await refreshAll();
			WebApp.showAlert('Approval reverted.');
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
	return (
		<div>
			<div className="actions">
				<button className="btn" onClick={() => setShowRequest(true)}>+ Request Off</button>
				{isAdminish(me.user_role) && (
					<button className="btn btn-secondary" onClick={() => setShowGive(true)}>+ Give Off (Admins Only)</button>
				)}
			</div>

			{mine.length > 0 && (
				<>
					<h4 className="section-title">My recent requests</h4>
					{mine.map((m) => (
						<div key={m.id} className="card">
							<div className="card-row">
								<span><b>{fmtDates(m)}</b> · {m.off_status}</span>
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
					<span>{row.full_name}</span>
					<span className="badge">{row.off_count}</span>
				</div>
			))}

			{showRequest && (
				<RequestOffModal onClose={() => setShowRequest(false)} onDone={refreshAll} />
			)}
			{showGive && (
				<GiveOffModal onClose={() => setShowGive(false)} onDone={refreshAll} />
			)}
		</div>
	);
}

function RequestOffModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
	const [startdate, setStart] = useState('');
	const [enddate, setEnd] = useState('');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit() {
		setBusy(true);
		try {
			await api.post('/api/off/request', { startdate, enddate, reason });
			await onDone();
			onClose();
			WebApp.showAlert('Submitted — awaiting approval.');
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Request Off</h3>
				<label>Start date<input type="date" value={startdate} onChange={(e) => setStart(e.target.value)} /></label>
				<label>End date<input type="date" value={enddate} onChange={(e) => setEnd(e.target.value)} /></label>
				<label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
				<button className="btn" disabled={busy || !startdate || !enddate || !reason.trim()} onClick={submit}>
					{busy ? 'Submitting…' : 'Submit'}
				</button>
			</div>
		</div>
	);
}

function GiveOffModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
	const [staff, setStaff] = useState<StaffRow[]>([]);
	const [staffId, setStaffId] = useState<number | ''>('');
	const [startdate, setStart] = useState('');
	const [enddate, setEnd] = useState('');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		api.get<StaffRow[]>('/api/off/staff').then(setStaff);
	}, []);

	async function submit() {
		setBusy(true);
		try {
			await api.post('/api/off/add-approved', { staff_id: staffId, startdate, enddate, reason });
			await onDone();
			onClose();
			WebApp.showAlert('Added.');
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Give Off (Admins Only)</h3>
				<label>Staff
					<select value={staffId} onChange={(e) => setStaffId(Number(e.target.value))}>
						<option value="">— select —</option>
						{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
					</select>
				</label>
				<label>Start date<input type="date" value={startdate} onChange={(e) => setStart(e.target.value)} /></label>
				<label>End date<input type="date" value={enddate} onChange={(e) => setEnd(e.target.value)} /></label>
				<label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
				<button className="btn" disabled={busy || !staffId || !startdate || !enddate || !reason.trim()} onClick={submit}>
					{busy ? 'Adding…' : 'Add'}
				</button>
			</div>
		</div>
	);
}
