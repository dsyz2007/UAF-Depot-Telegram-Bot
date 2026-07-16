import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, alertDialog, confirmDialog, sgtDateTime, type Me } from '../lib/api';
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
	period: string | null;
	created_at: string;
}

interface UserSickStat {
	id: number;
	full_name: string;
	department: string | null;
	sick_count: number;
	mc_days: number;
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
// True while it's 09:00 SGT or earlier — a same-day RSI/RSO reported by then is an AM
// one; reported later in the day it defaults to PM.
function sgtAtOrBefore9am(): boolean {
	const d = new Date(Date.now() + 8 * 3_600_000);
	return d.getUTCHours() * 60 + d.getUTCMinutes() <= 9 * 60;
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
	// ALL currently-active cases (RSI/RSO can be reported concurrently), newest first.
	const [cases, setCases] = useState<OpenCase[] | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | null>(null);

	function refresh() {
		setLoadError(null);
		return api
			.get<OpenCase[]>('/api/sick/my-open')
			.then((rows) => setCases(rows ?? []))
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				setLoadError(msg);
				setCases([]);
			});
	}
	useEffect(() => {
		refresh();
	}, []);
	// Sync (e.g. superior approved it) when the user returns to the app.
	useFocusRefresh(refresh);

	// When routed here from the Parade tab, just land on the report UI; consume the
	// route so it doesn't re-fire.
	const routeHandled = useRef(false);
	useEffect(() => {
		if (initialSick && !routeHandled.current) {
			routeHandled.current = true;
			onConsumed?.();
		}
		if (!initialSick) routeHandled.current = false;
	}, [initialSick, onConsumed]);

	if (loadError) {
		return (
			<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)' }}>
				<h3>⚠ Couldn't load sick page</h3>
				<p className="muted">{loadError}</p>
				<p className="muted">This usually means a migration wasn't fully applied yet. Run the latest migrations, then:</p>
				<button className="btn" onClick={() => refresh()}>Retry</button>
			</div>
		);
	}

	if (cases === undefined) return <div className="muted">Loading…</div>;

	return (
		<div>
			{/* Report buttons are ALWAYS available — even with active cases (concurrent
			    reporting: multiple visits or consecutive sick days). */}
			<ReportForm initialReason={initialReason} onReported={refresh} />

			{cases.length > 0 && <h4 className="section-title" style={{ marginTop: 20 }}>Your active RSI/RSO ({cases.length})</h4>}
			{cases.map((c) => (
				<CaseCard key={c.id} me={me} c={c} onChanged={refresh} />
			))}

			{me.user_role === 'superadmin' && <SickStats />}
		</div>
	);
}

// ── The report form (day + half-day + reason + RSI/RSO buttons) ──────────────
function ReportForm({ initialReason, onReported }: { initialReason?: string; onReported: () => Promise<void> }) {
	// Day default (unchanged): tomorrow once it's past 3pm SGT, else today.
	// Half-day default follows THAT day and is computed once, when the page opens:
	//   • tomorrow → AM
	//   • today    → AM while it's still 09:00 SGT or earlier, otherwise PM
	// After it opens, both toggles are the user's to change (we don't re-default).
	const initialDay: 'today' | 'tomorrow' = sgtPastSickCutoff() ? 'tomorrow' : 'today';
	const [sickDay, setSickDay] = useState<'today' | 'tomorrow'>(initialDay);
	const [period, setPeriod] = useState<'AM' | 'PM'>(initialDay === 'tomorrow' ? 'AM' : sgtAtOrBefore9am() ? 'AM' : 'PM');
	const [reportReason, setReportReason] = useState(initialReason ?? '');
	const [busy, setBusy] = useState(false);

	// Carry the calendar reason over if it arrives after mount.
	useEffect(() => {
		if (initialReason) setReportReason(initialReason);
	}, [initialReason]);

	async function report(case_type: 'RSI' | 'RSO') {
		setBusy(true);
		try {
			const sickDate = sickDay === 'today' ? sgtDateStr(0) : sgtDateStr(1);
			const res = await api.post<{ auto_approved?: boolean }>('/api/sick/report', {
				case_type,
				sick_date: sickDate,
				reason: reportReason.trim() || null,
				period,
			});
			setReportReason('');
			await onReported();
			const half = `${period} half-day`;
			alertDialog(
				res.auto_approved
					? `${case_type} logged for ${sickDate} (${period}) — no approval needed. Update your status in the card below.`
					: `${case_type} submitted for ${sickDate} (${period}) — awaiting approval. Your parade state for that ${half} now shows ${case_type}.`,
			);
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	const pastCutoff = sgtPastSickCutoff();
	return (
		<div>
			<h3>Report Sick</h3>
			<p className="muted" style={{ marginBottom: 8 }}>
				You can report RSI/RSO anytime — even if you already have an active case (e.g. multiple doctor visits or several days sick).
			</p>
			<p className="muted" style={{ marginBottom: 6 }}>Which day is this RSI/RSO for?</p>
			<div className="seg" style={{ marginBottom: 8 }}>
				<button className={sickDay === 'today' ? 'active' : ''} onClick={() => setSickDay('today')}>
					Today · {sgtDateStr(0)}
				</button>
				<button className={sickDay === 'tomorrow' ? 'active' : ''} onClick={() => setSickDay('tomorrow')}>
					Tomorrow · {sgtDateStr(1)}
				</button>
			</div>
			<p className="muted" style={{ marginBottom: 6 }}>Which half-day?</p>
			<div className="seg" style={{ marginBottom: 8 }}>
				<button className={period === 'AM' ? 'active' : ''} onClick={() => setPeriod('AM')}>AM</button>
				<button className={period === 'PM' ? 'active' : ''} onClick={() => setPeriod('PM')}>PM</button>
			</div>
			{sickDay === 'tomorrow' && period === 'PM' && (
				<p className="muted" style={{ marginBottom: 6, fontSize: 12 }}>
					⏱ A next-day PM report starts its update/flag timer from 12:00 (not 08:00).
				</p>
			)}
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
					⚠ It's past 3pm — afternoon/evening reports are usually for <b>TOMORROW</b>. You've selected{' '}
					<b>{sickDay === 'today' ? 'TODAY' : 'TOMORROW'}</b> ({sickDay === 'today' ? sgtDateStr(0) : sgtDateStr(1)}). Double-check before submitting.
				</div>
			)}
			<label>
				Reason / symptoms <span className="danger">*required</span> <span className="muted">(shown to your approver)</span>
				<textarea value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder="e.g. Fever and sore throat" />
			</label>
			<p className="muted" style={{ marginBottom: 6 }}>
				Report for <b>{sickDay === 'today' ? sgtDateStr(0) : sgtDateStr(1)}</b> ({period} half-day):
			</p>
			{!reportReason.trim() && <p className="muted danger" style={{ marginBottom: 6 }}>Enter a reason / symptoms to report.</p>}
			<div className="actions">
				<button className="btn" disabled={busy || !reportReason.trim()} onClick={() => report('RSI')}>🏥 RSI (In-Camp)</button>
				<button className="btn" disabled={busy || !reportReason.trim()} onClick={() => report('RSO')}>🩺 RSO (Outside)</button>
			</div>
		</div>
	);
}

// ── One active case: status card + (when approved/flagged) the MC update form ─
function CaseCard({ me, c, onChanged }: { me: Me; c: OpenCase; onChanged: () => Promise<void> }) {
	const selfManaged = !!me.self_managed;
	const [busy, setBusy] = useState(false);
	const [mcDays, setMcDays] = useState<number | ''>('');
	const [startDate, setStartDate] = useState('');
	const [endDate, setEndDate] = useState('');
	const [location, setLocation] = useState('');
	const [approxTime, setApproxTime] = useState('');

	async function cancelCase() {
		const isPending = c.reportsick_status === 'pending_superior';
		const ok = await confirmDialog(
			isPending ? 'Cancel this sick report?' : 'Cancel this RSI/RSO? It will be withdrawn and your parade status for those days reverted.',
		);
		if (!ok) return;
		setBusy(true);
		try {
			await api.post('/api/sick/cancel', { id: c.id });
			await onChanged();
			alertDialog('Cancelled.');
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function submitUpdate() {
		if (mcDays === '' || mcDays < 0) {
			alertDialog('Please enter number of MC days (0 if none).');
			return;
		}
		if (mcDays >= 1 && (!startDate || !endDate)) {
			alertDialog('Please enter MC start and end dates.');
			return;
		}
		if (!location.trim() || !approxTime.trim()) {
			alertDialog('Please enter both location and approximate time.');
			return;
		}
		setBusy(true);
		try {
			const res = await api.post<{ ok: boolean; mc_dates?: string[] }>('/api/sick/update', {
				id: c.id,
				num_of_mc_days: Number(mcDays),
				mc_start_date: mcDays >= 1 ? startDate : null,
				mc_end_date: mcDays >= 1 ? endDate : null,
				location: location.trim() || null,
				approx_time: approxTime.trim() || null,
			});
			await onChanged();
			const mc = res.mc_dates ?? [];
			if (mc.length > 0) {
				const range = mc.length === 1 ? mc[0] : `${mc[0]} → ${mc[mc.length - 1]}`;
				alertDialog(
					`Update sent.\n\n🗓 The bot set your Parade State to MC for ${range} (${mc.length} working day${mc.length === 1 ? '' : 's'}). Your RSI/RSO half-day is kept as-is.\n\n📎 IMPORTANT: now SEND the MC photo/PDF as a message in your Telegram chat with this bot (there is no upload here)${selfManaged ? '.' : ' — it auto-forwards to your superior.'}`,
				);
			} else {
				alertDialog('Update sent.');
			}
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	const showUpdateForm = c.reportsick_status === 'approved' || c.reportsick_status === 'flagged';
	const sickIcon = c.case_type === 'RSI' ? '🏥' : '🩺';
	const sickAcc =
		c.reportsick_status === 'approved' || c.reportsick_status === 'updated'
			? 'acc-approved'
			: c.reportsick_status === 'flagged'
				? 'acc-rejected'
				: 'acc-pending';

	return (
		<div style={{ marginBottom: 14 }}>
			<div className={`entry-card ${sickAcc}`}>
				<div className="entry-head">
					<span className="entry-title">
						{sickIcon} {c.case_type}
						{c.period && c.period !== 'FD' ? ` · ${c.period}` : ''}
					</span>
					<span className={`badge status-${c.reportsick_status}`}>{c.reportsick_status.replace(/_/g, ' ')}</span>
				</div>
				<div className="entry-meta">
					{c.sick_date && <span>📅 for {c.sick_date}</span>}
					<span>📝 Submitted {sgtDateTime(c.created_at)}</span>
					{c.approved_at && <span>✓ Approved {sgtDateTime(c.approved_at)}</span>}
				</div>
				{c.reason && <div className="entry-reason">Reason: {c.reason}</div>}
				{c.num_of_mc_days != null && c.num_of_mc_days >= 1 && (
					<div className="entry-reason">
						{c.num_of_mc_days} day(s) MC · {c.mc_start_date} → {c.mc_end_date}
					</div>
				)}
				<div className="entry-actions">
					<button className="btn-link danger" disabled={busy} onClick={cancelCase}>
						{c.reportsick_status === 'pending_superior' ? '🗑 Cancel request' : '🗑 Cancel RSI/RSO'}
					</button>
				</div>
			</div>

			{showUpdateForm && (
				<>
					<h4 className="section-title">Update status</h4>
					<div
						style={{
							margin: '0 0 12px',
							padding: '10px 12px',
							borderRadius: 12,
							border: '2px dashed var(--depot-info, #0288d1)',
							lineHeight: 1.45,
						}}
					>
						📄 <b>Got an MC?</b> There is <u>no upload in this app</u>. Open your Telegram chat with this bot and <b>send the MC photo or PDF as a message</b> —{' '}
						{selfManaged ? 'the bot saves it to your latest RSI/RSO case.' : 'it auto-forwards to your superior and is saved to your latest RSI/RSO case.'} Fill the dates below too.{' '}
						<span className="muted">(No MC? Just enter 0 below.)</span>
					</div>
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
									background: 'var(--depot-danger)',
									color: '#fff',
									fontWeight: 600,
									lineHeight: 1.45,
								}}
							>
								📎 SEND YOUR MC NOW — not here. ⚠️ This app has <u>no upload</u>.<br />
								Go to your <b>Telegram chat with this bot</b> and send the MC <b>photo or PDF as a normal message</b>. The bot replies “MC received”
								{selfManaged ? ' and attaches it to your case.' : ' and auto-forwards it to your superior.'}
							</div>
						</>
					)}
					<label>
						Location *
						<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Khatib Medical Centre" />
					</label>
					<label>
						Approximate Time *
						<input value={approxTime} onChange={(e) => setApproxTime(e.target.value)} placeholder="e.g. 0930" />
					</label>
					<button className="btn" disabled={busy || mcDays === '' || !location.trim() || !approxTime.trim()} onClick={submitUpdate}>
						{busy ? 'Saving…' : 'Submit update'}
					</button>
				</>
			)}
		</div>
	);
}

// ── Superadmin-only: per-user RSI/RSO frequency + total MC days (this month),
//    hidden behind a button and lazy-loaded on first open. ───────────────────
function SickStats() {
	const [open, setOpen] = useState(false);
	const [stats, setStats] = useState<UserSickStat[] | undefined>(undefined);

	function toggle() {
		const next = !open;
		setOpen(next);
		if (next && stats === undefined) {
			api
				.get<UserSickStat[]>('/api/sick/stats')
				.then((r) => setStats(r ?? []))
				.catch(() => setStats([]));
		}
	}

	const cell: CSSProperties = { padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid var(--tg-theme-hint-color, #ccc)' };
	const num: CSSProperties = { ...cell, textAlign: 'right' };

	return (
		<div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid var(--tg-theme-hint-color, #ccc)' }}>
			<button className="btn" onClick={toggle}>
				{open ? '▲ Hide sick stats' : '📊 Sick stats — this month (superadmin)'}
			</button>
			{open &&
				(stats === undefined ? (
					<p className="muted" style={{ marginTop: 10 }}>Loading…</p>
				) : (
					<div style={{ overflowX: 'auto', marginTop: 10 }}>
						<table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
							<thead>
								<tr>
									<th style={cell}>Name</th>
									<th style={num}>Sick Frequency</th>
									<th style={num}>Total MC Days</th>
								</tr>
							</thead>
							<tbody>
								{stats.map((r) => (
									<tr key={r.id}>
										<td style={cell}>
											{r.full_name}
											{r.department && <span className="muted"> · {r.department}</span>}
										</td>
										<td style={num}>{r.sick_count}</td>
										<td style={num}>{r.mc_days}</td>
									</tr>
								))}
								{stats.length > 0 && (
									<tr>
										<td style={cell}><b>Total ({stats.length})</b></td>
										<td style={num}><b>{stats.reduce((s, r) => s + r.sick_count, 0)}</b></td>
										<td style={num}><b>{stats.reduce((s, r) => s + r.mc_days, 0)}</b></td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				))}
		</div>
	);
}
