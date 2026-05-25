import { useEffect, useMemo, useState } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import WebApp from '@twa-dev/sdk';
import { api, type Me } from '../lib/api';

interface Entry {
	user_id: number;
	full_name: string;
	parade_state_date: string;
	parade_status: string;
	reason: string | null;
}

const STATUSES = ['Present', 'Off', 'Leave', 'MC', 'Course', 'Duty', 'Detached', 'AWOL', 'Others'] as const;
const COLORS: Record<string, string> = {
	Present: '#4caf50',
	Off: '#9e9e9e',
	Leave: '#03a9f4',
	MC: '#f44336',
	Course: '#ff9800',
	Duty: '#673ab7',
	Detached: '#795548',
	AWOL: '#000',
	Others: '#bdbdbd',
};

function ymKey(d: Date) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymdKey(d: Date) {
	return d.toISOString().slice(0, 10);
}

export function ParadeTab({ me }: { me: Me }) {
	const [month, setMonth] = useState(new Date());
	const [entries, setEntries] = useState<Entry[]>([]);
	const [selectedDate, setSelectedDate] = useState<Date | null>(null);
	const [showSubmit, setShowSubmit] = useState(false);

	function refresh() {
		api.get<Entry[]>(`/api/parade/month?ym=${ymKey(month)}`).then(setEntries).catch(console.error);
	}
	useEffect(refresh, [month]);

	const myEntriesByDate = useMemo(() => {
		const map = new Map<string, Entry>();
		entries.filter((e) => e.user_id === me.id).forEach((e) => map.set(e.parade_state_date, e));
		return map;
	}, [entries, me.id]);

	const allEntriesByDate = useMemo(() => {
		const map = new Map<string, Entry[]>();
		entries.forEach((e) => {
			const arr = map.get(e.parade_state_date) ?? [];
			arr.push(e);
			map.set(e.parade_state_date, arr);
		});
		return map;
	}, [entries]);

	const modifiers = useMemo(() => {
		const mods: Record<string, Date[]> = {};
		for (const [date, entry] of myEntriesByDate) {
			const key = `status_${entry.parade_status}`;
			(mods[key] = mods[key] ?? []).push(new Date(`${date}T00:00:00Z`));
		}
		return mods;
	}, [myEntriesByDate]);

	const modifiersStyles = useMemo(() => {
		const out: Record<string, React.CSSProperties> = {};
		for (const s of STATUSES) {
			out[`status_${s}`] = { borderBottom: `3px solid ${COLORS[s]}` };
		}
		return out;
	}, []);

	const dayDetails = selectedDate ? allEntriesByDate.get(ymdKey(selectedDate)) ?? [] : [];

	return (
		<div>
			<DayPicker
				mode="single"
				month={month}
				onMonthChange={setMonth}
				selected={selectedDate ?? undefined}
				onSelect={(d) => setSelectedDate(d ?? null)}
				modifiers={modifiers}
				modifiersStyles={modifiersStyles}
			/>

			<button className="btn" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowSubmit(true)}>
				+ Submit Status
			</button>

			{me.user_role === 'admin' && <ExportButton />}

			<div style={{ marginTop: 16 }}>
				<h4 style={{ marginBottom: 8 }}>Legend</h4>
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
					{STATUSES.map((s) => (
						<span key={s} style={{ fontSize: 12, padding: '2px 8px', borderBottom: `3px solid ${COLORS[s]}` }}>{s}</span>
					))}
				</div>
			</div>

			{selectedDate && (
				<div style={{ marginTop: 16 }}>
					<h4>{ymdKey(selectedDate)}</h4>
					{dayDetails.length === 0 ? (
						<p className="muted">No submissions yet.</p>
					) : (
						<table>
							<thead><tr><th>Name</th><th>Status</th><th>Reason</th></tr></thead>
							<tbody>
								{dayDetails.map((e) => (
									<tr key={e.user_id}>
										<td>{e.full_name}</td>
										<td>{e.parade_status}</td>
										<td>{e.reason ?? '—'}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			)}

			{showSubmit && <SubmitModal onClose={() => setShowSubmit(false)} onDone={refresh} />}
		</div>
	);
}

function SubmitModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
	const [range, setRange] = useState<DateRange | undefined>(undefined);
	const [status, setStatus] = useState<string>('Off');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit() {
		if (!range?.from) return;
		const startdate = ymdKey(range.from);
		const enddate = ymdKey(range.to ?? range.from);
		setBusy(true);
		try {
			await api.post('/api/parade/submit', { startdate, enddate, status, reason });
			WebApp.showAlert('Saved.');
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
				<h3>Submit Parade Status</h3>
				<DayPicker mode="range" selected={range} onSelect={setRange} />
				<label>Status
					<select value={status} onChange={(e) => setStatus(e.target.value)}>
						{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
					</select>
				</label>
				<label>Reason (optional)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
				<button className="btn" disabled={busy || !range?.from} onClick={submit}>
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
			<h4 style={{ marginTop: 0 }}>Export CSV (admin)</h4>
			<div style={{ display: 'flex', gap: 8 }}>
				<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
				<input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
			</div>
			<button className="btn" onClick={download}>📥 Download</button>
		</div>
	);
}
