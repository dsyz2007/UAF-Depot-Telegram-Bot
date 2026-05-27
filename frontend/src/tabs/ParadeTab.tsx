import { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import WebApp from '@twa-dev/sdk';
import { api, type Me } from '../lib/api';

interface Entry {
	user_id: number;
	full_name: string;
	parade_state_date: string;
	period: 'AM' | 'PM';
	parade_status: string;
	reason: string | null;
}

const STATUSES = ['Present', 'Off', 'Leave', 'Overseas Leave', 'MC', 'Attached-Out', 'Others'] as const;
type Status = (typeof STATUSES)[number];

const COLORS: Record<string, string> = {
	Present: '#4caf50',
	Off: '#9e9e9e',
	Leave: '#03a9f4',
	'Overseas Leave': '#00897b',
	MC: '#f44336',
	'Attached-Out': '#795548',
	Others: '#ff9800',
};

// IMPORTANT: use local-time components, NOT toISOString — DayPicker gives us
// local-time Date objects; toISOString shifts by the timezone offset and
// (in SGT) makes us read/write the wrong calendar date.
function ymdKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ymKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function todayLocal(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isAdminish(role: Me['user_role']): boolean {
	return role === 'admin' || role === 'superadmin';
}

function buildCopyText(date: string, rows: Entry[]): string {
	const am = rows.filter((r) => r.period === 'AM');
	const pm = rows.filter((r) => r.period === 'PM');
	const groupByStatus = (arr: Entry[]) => {
		const map = new Map<string, Entry[]>();
		for (const r of arr) {
			const cur = map.get(r.parade_status) ?? [];
			cur.push(r);
			map.set(r.parade_status, cur);
		}
		return map;
	};
	const renderPeriod = (label: string, arr: Entry[]) => {
		if (arr.length === 0) return `${label}: (no submissions)`;
		const byStatus = groupByStatus(arr);
		const lines: string[] = [`${label}:`];
		for (const s of STATUSES) {
			const list = byStatus.get(s);
			if (!list || list.length === 0) continue;
			lines.push(`  ${s} (${list.length}):`);
			for (const r of list) {
				lines.push(`    - ${r.full_name}${r.reason ? ` — ${r.reason}` : ''}`);
			}
		}
		return lines.join('\n');
	};
	return [`PARADE STATE — ${date}`, '', renderPeriod('AM', am), '', renderPeriod('PM', pm)].join('\n');
}

export function ParadeTab({ me }: { me: Me }) {
	const [month, setMonth] = useState<Date>(todayLocal());
	const [entries, setEntries] = useState<Entry[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selectedDate, setSelectedDate] = useState<Date>(todayLocal());
	const [showSubmit, setShowSubmit] = useState(false);
	const [copyModalText, setCopyModalText] = useState<string | null>(null);

	function refresh() {
		setLoadError(null);
		return api
			.get<Entry[]>(`/api/parade/month?ym=${ymKey(month)}`)
			.then(setEntries)
			.catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
	}
	useEffect(() => {
		refresh();
	}, [month]);

	// Map (date → {AM?, PM?}) for me, recomputed when entries change.
	const myByDate = useMemo(() => {
		const map = new Map<string, { AM?: Entry; PM?: Entry }>();
		entries
			.filter((e) => e.user_id === me.id)
			.forEach((e) => {
				const cur = map.get(e.parade_state_date) ?? {};
				cur[e.period] = e;
				map.set(e.parade_state_date, cur);
			});
		return map;
	}, [entries, me.id]);

	const allByDate = useMemo(() => {
		const map = new Map<string, Entry[]>();
		entries.forEach((e) => {
			const arr = map.get(e.parade_state_date) ?? [];
			arr.push(e);
			map.set(e.parade_state_date, arr);
		});
		return map;
	}, [entries]);

	const dayDetails = allByDate.get(ymdKey(selectedDate)) ?? [];
	const myToday = myByDate.get(ymdKey(selectedDate));

	if (loadError) {
		return (
			<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)' }}>
				<h3>⚠ Couldn't load parade state</h3>
				<p className="muted">{loadError}</p>
				<p className="muted">If you just changed the schema, re-apply migration 002:</p>
				<pre style={{ background: 'var(--tg-theme-secondary-bg-color, #eee)', padding: 10, borderRadius: 8, fontSize: 12, overflow: 'auto' }}>
{`npx wrangler d1 execute depot_db --remote \\
  --file worker/src/db/migrations/002_round2.sql`}
				</pre>
				<button className="btn" onClick={() => refresh()}>Retry</button>
			</div>
		);
	}

	return (
		<div>
			{/* Key forces DayPicker to fully re-render whenever entries change. */}
			<DayPicker
				key={`cal-${entries.length}-${ymKey(month)}`}
				mode="single"
				month={month}
				onMonthChange={setMonth}
				selected={selectedDate}
				onSelect={(d) => d && setSelectedDate(d)}
				components={{
					DayButton: (props) => {
						const dateKey = ymdKey(props.day.date);
						const my = myByDate.get(dateKey);
						const { day: _day, modifiers: _modifiers, ...buttonProps } = props;
						void _day;
						void _modifiers;
						return (
							<button {...buttonProps} className={`${buttonProps.className ?? ''} day-cell`}>
								<div className="day-num">{props.day.date.getDate()}</div>
								<div className="day-chips">
									<span
										className="chip-half am"
										style={{ background: my?.AM ? COLORS[my.AM.parade_status] : 'transparent' }}
									/>
									<span
										className="chip-half pm"
										style={{ background: my?.PM ? COLORS[my.PM.parade_status] : 'transparent' }}
									/>
								</div>
							</button>
						);
					},
				}}
			/>

			<div className="card" style={{ marginTop: 10 }}>
				<div className="card-row">
					<div>
						<b>{ymdKey(selectedDate)}</b>
						<div className="muted" style={{ marginTop: 2 }}>
							{myToday ? (
								<>
									My AM: <b>{myToday.AM?.parade_status ?? '—'}</b>
									{' · '}
									My PM: <b>{myToday.PM?.parade_status ?? '—'}</b>
								</>
							) : (
								<span>You have not submitted for this date.</span>
							)}
						</div>
					</div>
					<button className="btn" onClick={() => setShowSubmit(true)}>
						+ Submit / Edit
					</button>
				</div>
			</div>

			{isAdminish(me.user_role) && <ExportButton selectedDate={ymdKey(selectedDate)} />}

			<div style={{ marginTop: 14 }}>
				<h4 style={{ marginBottom: 8 }}>Legend</h4>
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
					{STATUSES.map((s) => (
						<span key={s} className="legend-chip" style={{ background: COLORS[s] }}>{s}</span>
					))}
				</div>
				<div className="muted" style={{ marginTop: 6 }}>
					Each day shows AM (left) and PM (right) chips for your own status.
				</div>
			</div>

			<div style={{ marginTop: 16 }}>
				<div className="card-row">
					<h4 style={{ margin: 0 }}>Everyone — {ymdKey(selectedDate)}</h4>
					{isAdminish(me.user_role) && dayDetails.length > 0 && (
						<button
							className="btn-link"
							onClick={async () => {
								const text = buildCopyText(ymdKey(selectedDate), dayDetails);
								try {
									await navigator.clipboard.writeText(text);
									WebApp.showAlert('Parade state copied to clipboard.');
								} catch {
									setCopyModalText(text);
								}
							}}
						>
							📋 Copy state
						</button>
					)}
				</div>
				{dayDetails.length === 0 ? (
					<p className="muted">No submissions yet.</p>
				) : (
					<table>
						<thead>
							<tr><th>Name</th><th>Period</th><th>Status</th><th>Reason</th></tr>
						</thead>
						<tbody>
							{dayDetails.map((e) => (
								<tr key={`${e.user_id}-${e.period}`}>
									<td>{e.full_name}</td>
									<td>{e.period}</td>
									<td>
										<span className="badge" style={{ background: COLORS[e.parade_status] }}>
											{e.parade_status}
										</span>
									</td>
									<td>{e.reason ?? '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{showSubmit && (
				<SubmitModal
					initialDate={ymdKey(selectedDate)}
					onClose={() => setShowSubmit(false)}
					onDone={refresh}
				/>
			)}

			{copyModalText && <CopyTextModal text={copyModalText} onClose={() => setCopyModalText(null)} />}
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────────
// Redesigned submit modal — simple date inputs + 3-way period segmented
// control + always-on preview + explicit "why disabled" hint.
// ──────────────────────────────────────────────────────────────────────────
type PeriodChoice = 'AM' | 'PM' | 'BOTH';

function SubmitModal({
	initialDate,
	onClose,
	onDone,
}: {
	initialDate: string;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const [startdate, setStartdate] = useState(initialDate);
	const [enddate, setEnddate] = useState(initialDate);
	const [periodChoice, setPeriodChoice] = useState<PeriodChoice>('BOTH');
	const [status, setStatus] = useState<Status>('Present');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	const reasonRequired = status === 'Others';
	const datesValid = !!startdate && !!enddate && startdate <= enddate;
	const reasonOk = !reasonRequired || reason.trim().length > 0;
	const canSave = datesValid && reasonOk;

	let disabledHint: string | null = null;
	if (!startdate || !enddate) disabledHint = 'Pick start and end dates.';
	else if (startdate > enddate) disabledHint = 'End date must be on or after start date.';
	else if (reasonRequired && !reason.trim()) disabledHint = 'Reason is required when status = Others.';

	// Day count
	const dayCount = (() => {
		if (!datesValid) return 0;
		const a = new Date(`${startdate}T00:00:00`);
		const b = new Date(`${enddate}T00:00:00`);
		return Math.floor((b.getTime() - a.getTime()) / 86_400_000) + 1;
	})();
	const periods: ('AM' | 'PM')[] = periodChoice === 'BOTH' ? ['AM', 'PM'] : [periodChoice];
	const periodLabel = periodChoice === 'BOTH' ? 'AM and PM' : `${periodChoice} only`;

	async function submit() {
		if (!canSave) return;
		setBusy(true);
		try {
			await api.post('/api/parade/submit', {
				startdate,
				enddate,
				status,
				reason: reason.trim() || null,
				periods,
			});
			await onDone();
			onClose();
			const summary =
				startdate === enddate
					? `${startdate} (${periodLabel})`
					: `${startdate} → ${enddate} (${periodLabel}, ${dayCount} day${dayCount === 1 ? '' : 's'})`;
			WebApp.showAlert(`✅ Saved\n${status} for ${summary}`);
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Submit / Edit Parade Status</h3>

				<label>Start date<input type="date" value={startdate} onChange={(e) => setStartdate(e.target.value)} /></label>
				<label>End date<input type="date" value={enddate} onChange={(e) => setEnddate(e.target.value)} /></label>

				<label>
					Period
					<div className="seg">
						<button className={periodChoice === 'AM' ? 'active' : ''} onClick={() => setPeriodChoice('AM')}>AM only</button>
						<button className={periodChoice === 'PM' ? 'active' : ''} onClick={() => setPeriodChoice('PM')}>PM only</button>
						<button className={periodChoice === 'BOTH' ? 'active' : ''} onClick={() => setPeriodChoice('BOTH')}>Both</button>
					</div>
				</label>

				<label>Status
					<select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
						{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
					</select>
				</label>

				<label>
					Reason {reasonRequired ? <span className="danger">*required for Others</span> : <span className="muted">(optional)</span>}
					<input
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder={reasonRequired ? 'Specify the reason' : 'Optional context'}
					/>
				</label>

				<div className="card" style={{ background: 'var(--tg-theme-bg-color, #fff)', border: '1px solid var(--tg-theme-section-separator-color, #ddd)' }}>
					<b>Preview</b>
					<div className="muted" style={{ marginTop: 4 }}>
						{datesValid
							? `${status} · ${startdate === enddate ? startdate : `${startdate} → ${enddate}`} · ${periodLabel}${dayCount > 1 ? ` · ${dayCount} days` : ''}`
							: 'Fill in the dates above.'}
					</div>
				</div>

				{disabledHint && (
					<div className="muted danger" style={{ marginBottom: 8 }}>{disabledHint}</div>
				)}

				<button className="btn" disabled={busy || !canSave} onClick={submit}>
					{busy ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	);
}

function ExportButton({ selectedDate }: { selectedDate: string }) {
	const [date, setDate] = useState(selectedDate);

	// Keep the export date in sync with the calendar's selected date so the
	// CSV button reflects what the user is currently viewing.
	useEffect(() => {
		setDate(selectedDate);
	}, [selectedDate]);

	async function download() {
		try {
			const blob = await api.getBlob(`/api/parade/export?date=${date}`);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `parade-state_${date}.csv`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="card" style={{ marginTop: 12 }}>
			<h4 style={{ marginTop: 0 }}>Export CSV (Admin/Superadmin)</h4>
			<p className="muted" style={{ marginTop: 0 }}>Single-date export — grouped by department.</p>
			<input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
			<button className="btn" onClick={download}>📥 Download {date}</button>
		</div>
	);
}

function CopyTextModal({ text, onClose }: { text: string; onClose: () => void }) {
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Parade state (long-press to copy)</h3>
				<p className="muted">Clipboard API blocked by Telegram — long-press the text below to select all, then copy.</p>
				<textarea
					readOnly
					value={text}
					rows={16}
					style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
					onFocus={(e) => e.currentTarget.select()}
				/>
				<button className="btn" onClick={onClose}>Done</button>
			</div>
		</div>
	);
}
