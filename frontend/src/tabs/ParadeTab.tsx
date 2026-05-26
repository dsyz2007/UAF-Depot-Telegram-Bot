import { useEffect, useMemo, useState } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
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

function ymKey(d: Date) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymdKey(d: Date) {
	return d.toISOString().slice(0, 10);
}

function isAdminish(role: Me['user_role']) {
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
	const [month, setMonth] = useState(new Date());
	const [entries, setEntries] = useState<Entry[]>([]);
	const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
	const [showSubmit, setShowSubmit] = useState(false);
	const [copyModalText, setCopyModalText] = useState<string | null>(null);

	function refresh() {
		return api.get<Entry[]>(`/api/parade/month?ym=${ymKey(month)}`).then(setEntries);
	}
	useEffect(() => {
		refresh().catch(console.error);
	}, [month]);

	// Map (date → {AM?, PM?}) for me
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

	// All entries grouped by date (for the day-details panel)
	const allByDate = useMemo(() => {
		const map = new Map<string, Entry[]>();
		entries.forEach((e) => {
			const arr = map.get(e.parade_state_date) ?? [];
			arr.push(e);
			map.set(e.parade_state_date, arr);
		});
		return map;
	}, [entries]);

	// Custom DayContent renderer — colored chips for AM and PM
	const dayDetails = selectedDate ? allByDate.get(ymdKey(selectedDate)) ?? [] : [];

	return (
		<div>
			<DayPicker
				mode="single"
				month={month}
				onMonthChange={setMonth}
				selected={selectedDate ?? undefined}
				onSelect={(d) => setSelectedDate(d ?? null)}
				components={{
					DayButton: (props) => {
						// react-day-picker passes day info via props.day.date
						const dateKey = ymdKey(props.day.date);
						const my = myByDate.get(dateKey);
						const { day: _day, modifiers: _modifiers, ...buttonProps } = props;
						void _day; void _modifiers;
						return (
							<button {...buttonProps} className={`${buttonProps.className ?? ''} day-cell`}>
								<div className="day-num">{props.day.date.getDate()}</div>
								<div className="day-chips">
									<span
										className="chip-half am"
										style={{ background: my?.AM ? COLORS[my.AM.parade_status] : 'transparent' }}
										title={my?.AM ? `AM: ${my.AM.parade_status}` : 'AM: —'}
									/>
									<span
										className="chip-half pm"
										style={{ background: my?.PM ? COLORS[my.PM.parade_status] : 'transparent' }}
										title={my?.PM ? `PM: ${my.PM.parade_status}` : 'PM: —'}
									/>
								</div>
							</button>
						);
					},
				}}
			/>

			<button className="btn" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowSubmit(true)}>
				+ Submit Status
			</button>

			{me.user_role === 'superadmin' && <ExportButton />}

			<div style={{ marginTop: 16 }}>
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

			{selectedDate && (
				<div style={{ marginTop: 16 }}>
					<div className="card-row">
						<h4 style={{ margin: 0 }}>{ymdKey(selectedDate)}</h4>
						{isAdminish(me.user_role) && dayDetails.length > 0 && (
							<button
								className="btn-link"
								onClick={async () => {
									const text = buildCopyText(ymdKey(selectedDate), dayDetails);
									try {
										await navigator.clipboard.writeText(text);
										WebApp.showAlert('Parade state copied to clipboard.');
									} catch {
										// Telegram WebView often blocks clipboard.writeText → show modal
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
			)}

			{showSubmit && (
				<SubmitModal
					initialDate={selectedDate ?? new Date()}
					onClose={() => setShowSubmit(false)}
					onDone={refresh}
				/>
			)}

			{copyModalText && <CopyTextModal text={copyModalText} onClose={() => setCopyModalText(null)} />}
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

function SubmitModal({
	initialDate,
	onClose,
	onDone,
}: {
	initialDate: Date;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const [mode, setMode] = useState<'single' | 'range'>('single');
	const [single, setSingle] = useState<Date | undefined>(initialDate);
	const [range, setRange] = useState<DateRange | undefined>({ from: initialDate, to: initialDate });
	const [periods, setPeriods] = useState<('AM' | 'PM')[]>(['AM', 'PM']);
	const [status, setStatus] = useState<Status>('Present');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	const startdate = mode === 'single' ? (single ? ymdKey(single) : '') : range?.from ? ymdKey(range.from) : '';
	const enddate = mode === 'single'
		? (single ? ymdKey(single) : '')
		: range?.to ? ymdKey(range.to) : (range?.from ? ymdKey(range.from) : '');
	const reasonRequired = status === 'Others';
	const canSave = !!startdate && !!enddate && periods.length > 0 && (!reasonRequired || reason.trim().length > 0);

	function togglePeriod(p: 'AM' | 'PM') {
		setPeriods((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
	}

	async function submit() {
		if (!canSave) return;
		setBusy(true);
		try {
			await api.post('/api/parade/submit', { startdate, enddate, status, reason: reason.trim() || null, periods });
			await onDone();
			onClose();
			WebApp.showAlert('Saved.');
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Submit Parade Status</h3>

				<div className="seg" style={{ marginBottom: 10 }}>
					<button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>Single day</button>
					<button className={mode === 'range' ? 'active' : ''} onClick={() => setMode('range')}>Range</button>
				</div>

				{mode === 'single' ? (
					<DayPicker mode="single" selected={single} onSelect={setSingle} />
				) : (
					<DayPicker mode="range" selected={range} onSelect={setRange} />
				)}

				<div style={{ marginTop: 6, marginBottom: 12 }} className="muted">
					{startdate ? (startdate === enddate ? startdate : `${startdate} → ${enddate}`) : 'Pick a date'}
				</div>

				<label>
					Period
					<div className="seg">
						<button className={periods.includes('AM') ? 'active' : ''} onClick={() => togglePeriod('AM')}>AM</button>
						<button className={periods.includes('PM') ? 'active' : ''} onClick={() => togglePeriod('PM')}>PM</button>
					</div>
				</label>

				<label>Status
					<select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
						{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
					</select>
				</label>

				<label>
					Reason {reasonRequired && <span className="danger">*required for Others</span>}
					<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Specify…' : '(optional)'} />
				</label>

				<button className="btn" disabled={busy || !canSave} onClick={submit}>
					{busy ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	);
}

function ExportButton() {
	const today = new Date();
	const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
	const [from, setFrom] = useState(ymdKey(firstOfMonth));
	const [to, setTo] = useState(ymdKey(today));

	async function download() {
		try {
			const blob = await api.getBlob(`/api/parade/export?from=${from}&to=${to}`);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `parade-state_${from}_to_${to}.csv`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="card" style={{ marginTop: 12 }}>
			<h4 style={{ marginTop: 0 }}>Export CSV (Superadmin)</h4>
			<div style={{ display: 'flex', gap: 8 }}>
				<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
				<input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
			</div>
			<button className="btn" onClick={download}>📥 Download</button>
		</div>
	);
}
