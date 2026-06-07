import { useEffect, useRef, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api, confirmDialog, type Me } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

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
	location: string | null;
	approx_time: string | null;
	mc_file_id: string | null;
	created_at: string;
}

export function SickTab({
	me,
	initialSick,
	onConsumed,
}: {
	me: Me;
	initialSick?: 'RSI' | 'RSO' | null;
	onConsumed?: () => void;
}) {
	const selfManaged = !!me.superior_telegram_id && me.superior_telegram_id === me.telegram_id;
	const [open, setOpen] = useState<OpenCase | null | undefined>(undefined);
	const [pendingReport, setPendingReport] = useState<'RSI' | 'RSO' | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [mcDays, setMcDays] = useState<number | ''>('');
	const [startDate, setStartDate] = useState('');
	const [endDate, setEndDate] = useState('');
	const [location, setLocation] = useState('');
	const [approxTime, setApproxTime] = useState('');

	function refresh() {
		setLoadError(null);
		return api
			.get<OpenCase | null>('/api/sick/my-open')
			.then(setOpen)
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setLoadError(msg);
				setOpen(null);
			});
	}
	useEffect(() => {
		refresh();
	}, []);
	// Sync the case (e.g. superior approved it) when the user returns to the app.
	useFocusRefresh(refresh);

	// When routed here from the Parade tab (user marked RSI/RSO without
	// reporting), stash the type; act on it once the open-case state has loaded.
	const routeHandled = useRef(false);
	useEffect(() => {
		if (initialSick && !routeHandled.current) {
			routeHandled.current = true;
			setPendingReport(initialSick);
			onConsumed?.();
		}
		if (!initialSick) routeHandled.current = false;
	}, [initialSick, onConsumed]);

	useEffect(() => {
		if (!pendingReport || open === undefined) return;
		const type = pendingReport;
		setPendingReport(null);
		(async () => {
			if (open) {
				WebApp.showAlert(`You already have an open ${open.case_type} case — no new report needed.`);
				return;
			}
			const ok = await confirmDialog(`Report ${type} now? Your superior will be notified.`);
			if (ok) await report(type);
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingReport, open]);

	async function report(case_type: 'RSI' | 'RSO') {
		setBusy(true);
		try {
			await api.post('/api/sick/report', { case_type });
			await refresh();
			WebApp.showAlert(
				selfManaged
					? `${case_type} logged (no approval needed). Update your status below.`
					: `${case_type} submitted — awaiting approval.`,
			);
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function cancelPending() {
		if (!open) return;
		const ok = await confirmDialog('Cancel this sick report?');
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
				location: location.trim() || null,
				approx_time: approxTime.trim() || null,
			});
			setMcDays('');
			setStartDate('');
			setEndDate('');
			setLocation('');
			setApproxTime('');
			await refresh();
			WebApp.showAlert('Update sent.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (loadError) {
		return (
			<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)' }}>
				<h3>⚠ Couldn't load sick page</h3>
				<p className="muted">{loadError}</p>
				<p className="muted">
					This usually means migration 002 wasn't fully applied yet. Run:
				</p>
				<pre style={{ background: 'var(--tg-theme-secondary-bg-color, #eee)', padding: 10, borderRadius: 8, fontSize: 12, overflow: 'auto' }}>
{`npx wrangler d1 execute depot_db --remote \\
  --file worker/src/db/migrations/002_round2.sql`}
				</pre>
				<button className="btn" onClick={() => refresh()}>Retry</button>
			</div>
		);
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
	const sickIcon = open.case_type === 'RSI' ? '🏥' : '🩺';
	const sickAcc =
		open.reportsick_status === 'approved' || open.reportsick_status === 'updated'
			? 'acc-approved'
			: open.reportsick_status === 'flagged'
				? 'acc-rejected'
				: 'acc-pending';

	return (
		<div>
			<div className={`entry-card ${sickAcc}`}>
				<div className="entry-head">
					<span className="entry-title">{sickIcon} {open.case_type}</span>
					<span className={`badge status-${open.reportsick_status}`}>{open.reportsick_status.replace(/_/g, ' ')}</span>
				</div>
				<div className="entry-meta">
					<span>📝 {open.created_at}</span>
					{open.approved_at && <span>✓ {open.approved_at}</span>}
				</div>
				{open.num_of_mc_days != null && open.num_of_mc_days >= 1 && (
					<div className="entry-reason">
						{open.num_of_mc_days} day(s) MC · {open.mc_start_date} → {open.mc_end_date}
					</div>
				)}
				{open.reportsick_status === 'pending_superior' && (
					<div className="entry-actions">
						<button className="btn-link danger" disabled={busy} onClick={cancelPending}>🗑 Cancel request</button>
					</div>
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
						Location
						<input
							value={location}
							onChange={(e) => setLocation(e.target.value)}
							placeholder="e.g. Khatib Medical Centre"
						/>
					</label>
					<label>
						Approximate Time
						<input
							value={approxTime}
							onChange={(e) => setApproxTime(e.target.value)}
							placeholder="e.g. 0930"
						/>
					</label>
					<button className="btn" disabled={busy || mcDays === ''} onClick={submitUpdate}>
						{busy ? 'Saving…' : 'Submit update'}
					</button>
					<p className="muted" style={{ marginTop: 8 }}>
						📎 To attach your MC, send the photo or PDF directly to this bot in the chat. It auto-forwards to your superior.
					</p>
				</>
			)}
		</div>
	);
}
