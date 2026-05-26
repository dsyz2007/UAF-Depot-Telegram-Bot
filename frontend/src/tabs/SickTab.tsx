import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api, type Me } from '../lib/api';

interface OpenCase {
	id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	approved_at: string | null;
	updated_status: string | null;
	updated_at: string | null;
	num_of_mc_days: number | null;
	mc_start_date: string | null;
	mc_end_date: string | null;
	medicine_prescribed: string | null;
	created_at: string;
}

export function SickTab(_: { me: Me }) {
	const [open, setOpen] = useState<OpenCase | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [mcDays, setMcDays] = useState<number | ''>('');
	const [startDate, setStartDate] = useState('');
	const [endDate, setEndDate] = useState('');
	const [medicine, setMedicine] = useState('');

	function refresh() {
		return api.get<OpenCase | null>('/api/sick/my-open').then(setOpen);
	}
	useEffect(() => {
		refresh().catch(console.error);
	}, []);

	async function report(case_type: 'RSI' | 'RSO') {
		setBusy(true);
		try {
			await api.post('/api/sick/report', { case_type });
			await refresh();
			WebApp.showAlert(`${case_type} submitted — awaiting approval.`);
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function cancelPending() {
		if (!open) return;
		const ok = await new Promise<boolean>((resolve) => WebApp.showConfirm('Cancel this sick report?', resolve));
		if (!ok) return;
		setBusy(true);
		try {
			await api.post('/api/sick/cancel', { id: open.id });
			await refresh();
			WebApp.showAlert('Cancelled.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function submitUpdate() {
		if (!open) return;
		if (mcDays === '' || mcDays < 0) {
			WebApp.showAlert('Please enter number of MC days (0 if none).');
			return;
		}
		if (mcDays >= 1 && (!startDate || !endDate)) {
			WebApp.showAlert('Please enter MC start and end dates.');
			return;
		}
		setBusy(true);
		try {
			await api.post('/api/sick/update', {
				id: open.id,
				num_of_mc_days: Number(mcDays),
				mc_start_date: mcDays >= 1 ? startDate : null,
				mc_end_date: mcDays >= 1 ? endDate : null,
				medicine_prescribed: medicine.trim() || null,
			});
			setMcDays('');
			setStartDate('');
			setEndDate('');
			setMedicine('');
			await refresh();
			WebApp.showAlert('Update sent.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (open === undefined) return <div className="muted">Loading…</div>;

	if (!open) {
		return (
			<div>
				<h3>Report Sick</h3>
				<p className="muted">No open case. Choose:</p>
				<div className="actions">
					<button className="btn" disabled={busy} onClick={() => report('RSI')}>🏥 RSI (In-Camp)</button>
					<button className="btn" disabled={busy} onClick={() => report('RSO')}>🩺 RSO (Outside)</button>
				</div>
			</div>
		);
	}

	const showUpdateForm = open.reportsick_status === 'approved' || open.reportsick_status === 'flagged';

	return (
		<div>
			<div className="card">
				<div className="card-row">
					<h3 style={{ margin: 0 }}>{open.case_type}</h3>
					<span className={`badge status-${open.reportsick_status}`}>{open.reportsick_status.replace(/_/g, ' ')}</span>
				</div>
				<div className="muted">Submitted: {open.created_at}</div>
				{open.approved_at && <div className="muted">Approved: {open.approved_at}</div>}
				{open.reportsick_status === 'pending_superior' && (
					<button className="btn-link danger" style={{ marginTop: 8 }} disabled={busy} onClick={cancelPending}>
						🗑 Cancel request
					</button>
				)}
			</div>

			{showUpdateForm && (
				<>
					<h4 className="section-title">Update status</h4>
					<label>
						Number of MC days *
						<input
							type="number"
							min={0}
							value={mcDays}
							onChange={(e) => setMcDays(e.target.value === '' ? '' : Number(e.target.value))}
							placeholder="0 if none"
						/>
					</label>
					{typeof mcDays === 'number' && mcDays >= 1 && (
						<>
							<label>MC start date *<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
							<label>MC end date *<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
						</>
					)}
					<label>
						Medicine prescribed (if any)
						<textarea
							value={medicine}
							onChange={(e) => setMedicine(e.target.value)}
							placeholder="e.g. Paracetamol 500mg, Lozenges"
						/>
					</label>
					<button className="btn" disabled={busy || mcDays === ''} onClick={submitUpdate}>
						{busy ? 'Saving…' : 'Submit update'}
					</button>
				</>
			)}
		</div>
	);
}
