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
	created_at: string;
}

export function SickTab(_: { me: Me }) {
	const [open, setOpen] = useState<OpenCase | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [updateText, setUpdateText] = useState('');

	function refresh() {
		api.get<OpenCase | null>('/api/sick/my-open').then(setOpen).catch(console.error);
	}
	useEffect(refresh, []);

	async function report(case_type: 'RSI' | 'RSO') {
		setBusy(true);
		try {
			await api.post('/api/sick/report', { case_type });
			WebApp.showAlert(`${case_type} submitted — awaiting superior approval.`);
			refresh();
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function submitUpdate() {
		if (!open) return;
		setBusy(true);
		try {
			await api.post('/api/sick/update', { id: open.id, updated_status: updateText });
			WebApp.showAlert('Update sent.');
			setUpdateText('');
			refresh();
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
				<div style={{ display: 'flex', gap: 12 }}>
					<button className="btn" disabled={busy} onClick={() => report('RSI')}>RSI (In-Camp)</button>
					<button className="btn" disabled={busy} onClick={() => report('RSO')}>RSO (Outside)</button>
				</div>
			</div>
		);
	}

	return (
		<div>
			<h3>{open.case_type} — {open.reportsick_status.replace('_', ' ')}</h3>
			<div className="card">
				<div className="muted">Submitted: {open.created_at}</div>
				{open.approved_at && <div className="muted">Approved: {open.approved_at}</div>}
			</div>

			{open.reportsick_status === 'pending_superior' && (
				<p className="muted">Awaiting your superior's approval.</p>
			)}

			{(open.reportsick_status === 'approved' || open.reportsick_status === 'flagged') && (
				<>
					<h4>Update status</h4>
					<textarea
						placeholder="e.g. 2 days MC, Lozenges, follow-up Mon"
						value={updateText}
						onChange={(e) => setUpdateText(e.target.value)}
					/>
					<button className="btn" disabled={busy || !updateText.trim()} onClick={submitUpdate}>
						Submit Update
					</button>
				</>
			)}
		</div>
	);
}
