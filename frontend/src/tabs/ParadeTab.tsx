import { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import WebApp from '@twa-dev/sdk';
import { api, type Me } from '../lib/api';

interface Entry {
	user_id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	parade_state_date: string;
	period: 'AM' | 'PM';
	parade_status: string;
	reason: string | null;
}

// Stable ordering of department headings in the day-details panel.
const DEPT_ORDER: readonly string[] = [
	'DHQ',
	'DMSP',
	'DCS',
	'STG — C1+C2',
	'STG — C3+C4',
	'STG',
	'Others',
	'Unassigned',
];
function deptKeyFor(e: { department: string | null; sub_department: string | null }): string {
	if (e.department === 'STG' && e.sub_department) return `STG — ${e.sub_department}`;
	return e.department ?? 'Unassigned';
}

const STATUSES = ['Present', 'Course', 'AO', 'MA', 'MC', 'RSO', 'RSI', 'OFF', 'LL', 'OL', 'Others'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABELS: Record<Status, string> = {
	Present: 'Present',
	Course: 'Course',
	AO: 'AO (Attached-Out)',
	MA: 'MA (Medical Appointment)',
	MC: 'MC',
	RSO: 'RSO',
	RSI: 'RSI',
	OFF: 'OFF',
	LL: 'LL (Local Leave)',
	OL: 'OL (Overseas Leave)',
	Others: 'Others',
};

const COLORS: Record<string, string> = {
	Present: '#4caf50',
	Course: '#ff9800',
	AO: '#795548',
	MA: '#26c6da',
	MC: '#f44336',
	RSO: '#e53935',
	RSI: '#c62828',
	OFF: '#9e9e9e',
	LL: '#03a9f4',
	OL: '#00897b',
	Others: '#9c27b0',
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

// Used by the strength-report copy. Pulled from /api/parade/strength.
interface StrengthRow {
	id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	personnel_type: string | null;
	status: string | null;
	reason: string | null;
}

// AM if current SGT time is before 11:30, otherwise PM.
function periodByTimeSgt(): 'AM' | 'PM' {
	const now = new Date();
	const sgt = new Date(now.getTime() + 8 * 3_600_000);
	const minutesIntoDay = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
	return minutesIntoDay < 11 * 60 + 30 ? 'AM' : 'PM';
}

// All non-Present statuses, in the order the report lists them.
const NON_PRESENT_STATUSES = ['Course', 'AO', 'MA', 'MC', 'RSO', 'RSI', 'OFF', 'LL', 'OL', 'Others'] as const;

function isNsfish(t: string | null): boolean {
	return t === 'NSF' || t === 'NSF Officer';
}

function countSplit(rows: StrengthRow[]) {
	const nsf = rows.filter((r) => isNsfish(r.personnel_type));
	const reg = rows.filter((r) => r.personnel_type === 'Regular');
	const present = (arr: StrengthRow[]) => arr.filter((r) => r.status === 'Present').length;
	return { nsf, reg, nsfPresent: present(nsf), regPresent: present(reg) };
}

function buildStrengthReport(users: StrengthRow[], period: 'AM' | 'PM'): string {
	const lines: string[] = [];
	lines.push(`*${period} Present Strength*`);
	lines.push('');

	// STG section (with C1+C2 / C3+C4 sub-departments)
	const stg = users.filter((u) => u.department === 'STG');
	const c12 = stg.filter((u) => u.sub_department === 'C1+C2');
	const c34 = stg.filter((u) => u.sub_department === 'C3+C4');
	const c12s = countSplit(c12);
	const c34s = countSplit(c34);
	lines.push('STG');
	lines.push(`C1+C2 NSF: ${c12s.nsfPresent}/${c12s.nsf.length}`);
	lines.push(`C1+C2 Regular: ${c12s.regPresent}/${c12s.reg.length}`);
	lines.push('');
	lines.push(`C3+C4 NSF: ${c34s.nsfPresent}/${c34s.nsf.length}`);
	lines.push(`C3+C4 Regular: ${c34s.regPresent}/${c34s.reg.length}`);
	lines.push('');

	// DMSP / DCS / DHQ
	for (const dept of ['DMSP', 'DCS', 'DHQ'] as const) {
		const inDept = users.filter((u) => u.department === dept);
		const s = countSplit(inDept);
		lines.push(dept);
		lines.push(`NSF: ${s.nsfPresent}/${s.nsf.length}`);
		lines.push(`Regular: ${s.regPresent}/${s.reg.length}`);
		lines.push('');
	}

	// Total
	const totalRegistered = users.length;
	const totalPresent = users.filter((u) => u.status === 'Present').length;
	lines.push(`Total Strength: ${totalPresent}/${totalRegistered}`);
	lines.push('');

	// List all non-present Regulars + NSF Officers (one per row).
	const listed = users.filter(
		(u) =>
			u.status !== 'Present' &&
			(u.personnel_type === 'Regular' || u.personnel_type === 'NSF Officer'),
	);
	for (const u of listed) {
		const status = u.status ?? 'Not submitted';
		const reason = u.reason ? ` (${u.reason})` : '';
		lines.push(`${u.full_name} ${status}${reason}`);
	}
	lines.push('');

	// Counts per non-Present status (everyone, not just Regulars/Officers).
	lines.push('*Other status*');
	for (const s of NON_PRESENT_STATUSES) {
		const n = users.filter((u) => u.status === s).length;
		lines.push(`${s}: ${n}`);
	}
	lines.push(`Total absent: ${totalRegistered - totalPresent}`);

	return lines.join('\n');
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
						<span key={s} className="legend-chip" style={{ background: COLORS[s] }} title={STATUS_LABELS[s]}>{STATUS_LABELS[s]}</span>
					))}
				</div>
				<div className="muted" style={{ marginTop: 6 }}>
					Each day shows AM (left) and PM (right) chips for your own status.
				</div>
			</div>

			<div style={{ marginTop: 16 }}>
				<div className="card-row">
					<h4 style={{ margin: 0 }}>Everyone — {ymdKey(selectedDate)}</h4>
					<button
						className="btn-link"
						onClick={async () => {
							const period = periodByTimeSgt();
							try {
								const res = await api.get<{ users: StrengthRow[] }>(
									`/api/parade/strength?date=${ymdKey(selectedDate)}&period=${period}`,
								);
								setCopyModalText(buildStrengthReport(res.users, period));
							} catch (e) {
								WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
							}
						}}
					>
						📋 View state
					</button>
				</div>
				{dayDetails.length === 0 ? (
					<p className="muted">No submissions yet.</p>
				) : (
					(() => {
						// Group the day's entries by department for clearer display.
						const groups = new Map<string, Entry[]>();
						for (const e of dayDetails) {
							const key = deptKeyFor(e);
							const arr = groups.get(key) ?? [];
							arr.push(e);
							groups.set(key, arr);
						}
						return (
							<>
								{DEPT_ORDER.map((dept) => {
									const list = groups.get(dept);
									if (!list || list.length === 0) return null;
									return (
										<div key={dept} style={{ marginTop: 12 }}>
											<h5 className="section-title" style={{ margin: '0 0 4px' }}>
												{dept} ({list.length})
											</h5>
											<table>
												<thead>
													<tr><th>Name</th><th>Period</th><th>Status</th><th>Reason</th></tr>
												</thead>
												<tbody>
													{list.map((e) => (
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
										</div>
									);
								})}
							</>
						);
					})()
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
// Submit modal — separate AM and PM status selectors. Fill one or both;
// at least one is required. "None" leaves that period untouched.
// ──────────────────────────────────────────────────────────────────────────
const NONE = '' as const;

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
	const [amStatus, setAmStatus] = useState<Status | typeof NONE>(NONE);
	const [amReason, setAmReason] = useState('');
	const [pmStatus, setPmStatus] = useState<Status | typeof NONE>(NONE);
	const [pmReason, setPmReason] = useState('');
	const [busy, setBusy] = useState(false);

	const datesValid = !!startdate && !!enddate && startdate <= enddate;
	const amFilled = amStatus !== NONE;
	const pmFilled = pmStatus !== NONE;
	const amReasonOk = amStatus !== 'Others' || amReason.trim().length > 0;
	const pmReasonOk = pmStatus !== 'Others' || pmReason.trim().length > 0;
	const atLeastOne = amFilled || pmFilled;
	const canSave = datesValid && atLeastOne && amReasonOk && pmReasonOk;

	let hint: string | null = null;
	if (!startdate || !enddate) hint = 'Pick start and end dates.';
	else if (startdate > enddate) hint = 'End date must be on or after start date.';
	else if (!atLeastOne) hint = 'Set at least one of AM / PM status.';
	else if (amFilled && !amReasonOk) hint = 'AM reason is required when AM status = Others.';
	else if (pmFilled && !pmReasonOk) hint = 'PM reason is required when PM status = Others.';

	const dayCount = datesValid
		? Math.floor(
				(new Date(`${enddate}T00:00:00`).getTime() - new Date(`${startdate}T00:00:00`).getTime()) / 86_400_000,
			) + 1
		: 0;

	async function submit() {
		if (!canSave) return;
		const entries: { period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];
		// Present never carries a reason.
		if (amFilled) entries.push({ period: 'AM', status: amStatus, reason: amStatus === 'Present' ? null : amReason.trim() || null });
		if (pmFilled) entries.push({ period: 'PM', status: pmStatus, reason: pmStatus === 'Present' ? null : pmReason.trim() || null });

		setBusy(true);
		try {
			await api.post('/api/parade/submit', { startdate, enddate, entries });
			await onDone();
			onClose();
			const parts = entries.map((e) => `${e.period}: ${e.status}`).join(' · ');
			const range = startdate === enddate ? startdate : `${startdate} → ${enddate} (${dayCount} days)`;
			WebApp.showAlert(`✅ Saved\n${parts}\nfor ${range}`);
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

				<div className="card" style={{ background: 'var(--tg-theme-bg-color, #fff)', border: '1px solid var(--tg-theme-section-separator-color, #ddd)' }}>
					<b>🌅 AM</b>
					<label>Status
						<select value={amStatus} onChange={(e) => setAmStatus(e.target.value as Status | typeof NONE)}>
							<option value={NONE}>— leave unchanged —</option>
							{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
						</select>
					</label>
					{amFilled && amStatus !== 'Present' && (
						<label>
							Reason {amStatus === 'Others' ? <span className="danger">*required</span> : <span className="muted">(optional)</span>}
							<input value={amReason} onChange={(e) => setAmReason(e.target.value)} placeholder={amStatus === 'Others' ? 'Specify' : 'Optional'} />
						</label>
					)}
				</div>

				<div className="card" style={{ background: 'var(--tg-theme-bg-color, #fff)', border: '1px solid var(--tg-theme-section-separator-color, #ddd)' }}>
					<b>🌇 PM</b>
					<label>Status
						<select value={pmStatus} onChange={(e) => setPmStatus(e.target.value as Status | typeof NONE)}>
							<option value={NONE}>— leave unchanged —</option>
							{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
						</select>
					</label>
					{pmFilled && pmStatus !== 'Present' && (
						<label>
							Reason {pmStatus === 'Others' ? <span className="danger">*required</span> : <span className="muted">(optional)</span>}
							<input value={pmReason} onChange={(e) => setPmReason(e.target.value)} placeholder={pmStatus === 'Others' ? 'Specify' : 'Optional'} />
						</label>
					)}
				</div>

				{hint && <div className="muted danger" style={{ marginBottom: 8 }}>{hint}</div>}

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

	const [busy, setBusy] = useState(false);

	async function exportCsv() {
		setBusy(true);
		try {
			const res = await api.post<{ ok: boolean; rows: number }>('/api/parade/export', { date });
			WebApp.showAlert(`📄 CSV for ${date} (${res.rows} entries) sent to your Telegram chat with the bot.`);
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="card" style={{ marginTop: 12 }}>
			<h4 style={{ marginTop: 0 }}>Export CSV (Admin/Superadmin)</h4>
			<p className="muted" style={{ marginTop: 0 }}>Single-date export, grouped by department. The file is sent to your chat with the bot (Telegram blocks in-app downloads).</p>
			<input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
			<button className="btn" disabled={busy} onClick={exportCsv}>
				{busy ? 'Sending…' : `📤 Send CSV for ${date}`}
			</button>
		</div>
	);
}

function CopyTextModal({ text, onClose }: { text: string; onClose: () => void }) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			WebApp.showAlert('Clipboard blocked by Telegram. Long-press the text to select, then copy.');
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3 style={{ marginBottom: 4 }}>Parade State</h3>
				<p className="muted" style={{ marginTop: 0 }}>
					Tap <b>Copy</b> below, or long-press the text to select manually.
				</p>
				<textarea
					readOnly
					value={text}
					rows={18}
					style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
					onFocus={(e) => e.currentTarget.select()}
				/>
				<div className="actions">
					<button className="btn" onClick={copy}>{copied ? '✅ Copied' : '📋 Copy'}</button>
					<button className="btn btn-secondary" onClick={onClose}>Close</button>
				</div>
			</div>
		</div>
	);
}
