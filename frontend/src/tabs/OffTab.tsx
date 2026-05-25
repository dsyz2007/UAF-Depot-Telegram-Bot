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
	approved_by_name: string | null;
}
interface StaffRow {
	id: number;
	full_name: string;
}

export function OffTab({ me }: { me: Me }) {
	const [summary, setSummary] = useState<SummaryRow[]>([]);
	const [detailUser, setDetailUser] = useState<SummaryRow | null>(null);
	const [details, setDetails] = useState<DetailRow[]>([]);
	const [showRequest, setShowRequest] = useState(false);
	const [showAddApproved, setShowAddApproved] = useState(false);
	const canAddApproved = me.user_role === 'superior' || me.user_role === 'admin';

	useEffect(() => {
		api.get<SummaryRow[]>('/api/off/summary').then(setSummary).catch(console.error);
	}, []);

	useEffect(() => {
		if (!detailUser) return;
		api.get<DetailRow[]>(`/api/off/user?id=${detailUser.id}`).then(setDetails).catch(console.error);
	}, [detailUser]);

	function refreshSummary() {
		api.get<SummaryRow[]>('/api/off/summary').then(setSummary);
	}

	if (detailUser) {
		return (
			<div>
				<button className="btn btn-secondary" onClick={() => setDetailUser(null)}>
					← Back
				</button>
				<h3>{detailUser.full_name} — {detailUser.off_count} approved off(s)</h3>
				{details.length === 0 ? (
					<p className="muted">No approved offs.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Reason</th>
								<th>Approved by</th>
								<th>Approved date</th>
							</tr>
						</thead>
						<tbody>
							{details.map((d) => (
								<tr key={d.id}>
									<td>
										{d.startdate === d.enddate ? d.startdate : `${d.startdate} → ${d.enddate}`}
										<br />
										<span className="muted">{d.reason}</span>
									</td>
									<td>{d.approved_by_name ?? '—'}</td>
									<td>{d.approved_date?.slice(0, 10) ?? '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		);
	}

	return (
		<div>
			<div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
				<button className="btn" onClick={() => setShowRequest(true)}>+ Request Off</button>
				{canAddApproved && (
					<button className="btn btn-secondary" onClick={() => setShowAddApproved(true)}>
						+ Add Approved (Staff)
					</button>
				)}
			</div>
			{summary.map((row) => (
				<div key={row.id} className="row" onClick={() => setDetailUser(row)}>
					<span>{row.full_name}</span>
					<span className="badge">{row.off_count}</span>
				</div>
			))}
			{showRequest && <RequestOffModal onClose={() => setShowRequest(false)} onDone={refreshSummary} />}
			{showAddApproved && (
				<AddApprovedModal onClose={() => setShowAddApproved(false)} onDone={refreshSummary} />
			)}
		</div>
	);
}

function RequestOffModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
	const [startdate, setStart] = useState('');
	const [enddate, setEnd] = useState('');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit() {
		setBusy(true);
		try {
			await api.post('/api/off/request', { startdate, enddate, reason });
			WebApp.showAlert('Submitted — awaiting superior approval.');
			onDone();
			onClose();
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Request Off</h3>
				<label>Start date<input type="date" value={startdate} onChange={(e) => setStart(e.target.value)} /></label>
				<label>End date<input type="date" value={enddate} onChange={(e) => setEnd(e.target.value)} /></label>
				<label>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
				<button
					className="btn"
					disabled={busy || !startdate || !enddate || !reason.trim()}
					onClick={submit}
				>
					{busy ? 'Submitting…' : 'Submit'}
				</button>
			</div>
		</div>
	);
}

function AddApprovedModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
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
			WebApp.showAlert('Added.');
			onDone();
			onClose();
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Add Approved Off (Staff)</h3>
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
