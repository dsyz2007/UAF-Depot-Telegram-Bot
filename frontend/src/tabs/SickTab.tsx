import { useEffect, useRef, useState } from 'react';
import { api, alertDialog, confirmDialog, type Me } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

interface OpenCase {
	id: number;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	sick_date: string | null;
	reason: string | null;
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

// SGT (UTC+8) date string, optionally offset by N days.
function sgtDateStr(offsetDays = 0): string {
	const d = new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000);
	return d.toISOString().slice(0, 10);
}
// True once it's 15:00 (3pm) SGT or later — past then, RSI/RSO is usually for tomorrow.
function sgtPastSickCutoff(): boolean {
	const d = new Date(Date.now() + 8 * 3_600_000);
	return d.getUTCHours() * 60 + d.getUTCMinutes() >= 15 * 60;
}

export function SickTab({
	me,
	initialSick,
	initialReason,
	onConsumed,
}: {
	me: Me;
	initialSick?: 'RSI' | 'RSO' | null;
	// Reason pre-filled when routed here from the Parade calendar (RSI/RSO needs a
	// compulsory reason there; we carry it over so the user doesn't retype it).
	initialReason?: string;
	onConsumed?: () => void;
}) {
	const selfManaged = !!me.self_managed;
	// Appointment-holders & self-managed users auto-approve their own RSI/RSO, so
	// they can also one-step-undo it (no separate superior to ask).
	const autoApproves = !!me.self_managed || !!me.appointment;
	const [open, setOpen] = useState<OpenCase | null | undefined>(undefined);
	// Which day a new RSI/RSO is for — defaults to tomorrow once it's past 17:30.
	const [sickDay, setSickDay] = useState<'today' | 'tomorrow'>(sgtPastSickCutoff() ? 'tomorrow' : 'today');
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [mcDays, setMcDays] = useState<number | ''>('');
	const [startDate, setStartDate] = useState('');
	const [endDate, setEndDate] = useState('');
	const [location, setLocation] = useState('');
	const [approxTime, setApproxTime] = useState('');
	// Reason / symptoms captured at report time, shown to the approver. Pre-filled
	// from the Parade-calendar reason when routed here.
	const [reportReason, setReportReason] = useState(initialReason ?? '');

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

	// When routed here from the Parade tab, just land on the report UI (below);
	// the user picks the day + RSI/RSO. Consume the route so it doesn't re-fire.
	const routeHandled = useRef(false);
	useEffect(() => {
		if (initialSick && !routeHandled.current) {
			routeHandled.current = true;
			// Carry the calendar reason over (covers the case where this tab was
			// already mounted when the route fired).
			if (initialReason) setReportReason(initialReason);
			onConsumed?.();
		}
		if (!initialSick) routeHandled.current = false;
	}, [initialSick, initialReason, onConsumed]);

	async function report(case_type: 'RSI' | 'RSO') {
		setBusy(true);
		try {
			const sickDate = sickDay === 'today' ? sgtDateStr(0) : sgtDateStr(1);
			await api.post('/api/sick/report', { case_type, sick_date: sickDate, reason: reportReason.trim() || null });
			await refresh();
			alertDialog(
				selfManaged
					? `${case_type} logged for ${sickDate} (no approval needed). Update your status below.`
					: `${case_type} submitted for ${sickDate} — awaiting approval. Your parade state for that day now shows ${case_type}.`,
			);
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function cancelPending() {
		if (!open) return;
		const isPending = open.reportsick_status === 'pending_superior';
		const ok = await confirmDialog(
			isPending ? 'Cancel this sick report?' : 'Undo this RSI/RSO? It will be removed and your parade status for that day reverted.',
		);
		if (!ok) return;
		setBusy(true);
		try {
			await api.post('/api/sick/cancel', { id: open.id });
			await refresh();
			alertDialog('Cancelled.');
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	async function submitUpdate() {
		if (!open) return;
		if (mcDays === '' || mcDays < 0) {
			alertDialog('Please enter number of MC days (0 if none).');
			return;
		}
		if (mcDays >= 1 && (!startDate || !endDate)) {
			alertDialog('Please enter MC start and end dates.');
			return;
		}
		setBusy(true);
		try {
			const res = await api.post<{ ok: boolean; mc_dates?: string[] }>('/api/sick/update', {
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
			const mc = res.mc_dates ?? [];
			if (mc.length > 0) {
				const range = mc.length === 1 ? mc[0] : `${mc[0]} → ${mc[mc.length - 1]}`;
				alertDialog(`Update sent.\n\n🗓 The bot set your Parade State to MC for ${range} (${mc.length} working day${mc.length === 1 ? '' : 's'}). Your RSI/RSO half-day is kept as-is.`);
			} else {
				alertDialog('Update sent.');
			}
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
		const pastCutoff = sgtPastSickCutoff();
		return (
			<div>
				<h3>Report Sick</h3>
				<p className="muted" style={{ marginBottom: 6 }}>Which day is this RSI/RSO for?</p>
				<div className="seg" style={{ marginBottom: 8 }}>
					<button className={sickDay === 'today' ? 'active' : ''} onClick={() => setSickDay('today')}>
						Today · {sgtDateStr(0)}
					</button>
					<button className={sickDay === 'tomorrow' ? 'active' : ''} onClick={() => setSickDay('tomorrow')}>
						Tomorrow · {sgtDateStr(1)}
					</button>
				</div>
				{pastCutoff && (
					<div
						style={{
							margin: '0 0 10px',
							padding: '10px 12px',
							borderRadius: 12,
							background: sickDay === 'today' ? 'var(--depot-danger)' : 'var(--depot-warning)',
							color: '#fff',
							fontWeight: 600,
							lineHeight: 1.4,
						}}
					>
						⚠ It's past 3pm — afternoon/evening reports are usually for <b>TOMORROW</b>. You've selected <b>{sickDay === 'today' ? 'TODAY' : 'TOMORROW'}</b> ({sickDay === 'today' ? sgtDateStr(0) : sgtDateStr(1)}). Double-check before submitting.
					</div>
				)}
				<label>Reason / symptoms <span className="danger">*required</span> <span className="muted">(shown to your approver)</span>
					<textarea value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder="e.g. Fever and sore throat" />
				</label>
				<p className="muted" style={{ marginBottom: 6 }}>Report for <b>{sickDay === 'today' ? sgtDateStr(0) : sgtDateStr(1)}</b>:</p>
				{!reportReason.trim() && <p className="muted danger" style={{ marginBottom: 6 }}>Enter a reason / symptoms to report.</p>}
				<div className="actions">
					<button className="btn" disabled={busy || !reportReason.trim()} onClick={() => report('RSI')}>🏥 RSI (In-Camp)</button>
					<button className="btn" disabled={busy || !reportReason.trim()} onClick={() => report('RSO')}>🩺 RSO (Outside)</button>
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
					{open.sick_date && <span>📅 for {open.sick_date}</span>}
					<span>📝 {open.created_at}</span>
					{open.approved_at && <span>✓ {open.approved_at}</span>}
				</div>
				{open.reason && <div className="entry-reason">Reason: {open.reason}</div>}
				{open.num_of_mc_days != null && open.num_of_mc_days >= 1 && (
					<div className="entry-reason">
						{open.num_of_mc_days} day(s) MC · {open.mc_start_date} → {open.mc_end_date}
					</div>
				)}
				{(open.reportsick_status === 'pending_superior' ||
					(autoApproves && ['approved', 'updated', 'flagged'].includes(open.reportsick_status))) && (
					<div className="entry-actions">
						<button className="btn-link danger" disabled={busy} onClick={cancelPending}>
							{open.reportsick_status === 'pending_superior' ? '🗑 Cancel request' : '↩ Undo RSI/RSO'}
						</button>
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
							<div
								style={{
									margin: '6px 0 12px',
									padding: '12px 14px',
									borderRadius: 12,
									background: 'var(--depot-warning)',
									color: '#fff',
									fontWeight: 600,
									lineHeight: 1.4,
								}}
							>
								📎 Attach your MC document now — send the <b>photo or PDF</b> of your MC <u>directly to this bot in the chat</u>. It auto-forwards to your superior.
							</div>
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
				</>
			)}
		</div>
	);
}
