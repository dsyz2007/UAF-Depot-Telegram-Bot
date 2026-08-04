import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { api, alertDialog, deptLabel, DEPARTMENTS, type Me, type RouteAction } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

interface Entry {
	user_id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	user_role: string | null;
	personnel_type: string | null;
	// /api/parade/day LEFT JOINs from users, so unfilled users return rows
	// where the parade fields are null. The bottom panel still renders them so
	// admins can see at a glance who hasn't submitted.
	parade_state_date: string | null;
	period: 'AM' | 'PM' | null;
	parade_status: string | null;
	reason: string | null;
	pending: number;
}

// Ranking for the Everyone-panel sort: 1st descending rights
// (superadmin > admin > user), 2nd type R before N, 3rd alphabetical.
function roleRank(r: string | null): number {
	return r === 'superadmin' ? 0 : r === 'admin' ? 1 : 2;
}
function typeRank(t: string | null): number {
	return t === 'Regular' ? 0 : 1; // Regular before NSF
}
function cmpPersonnel(a: { user_role: string | null; personnel_type: string | null; full_name: string }, b: typeof a): number {
	return (
		roleRank(a.user_role) - roleRank(b.user_role) ||
		typeRank(a.personnel_type) - typeRank(b.personnel_type) ||
		a.full_name.localeCompare(b.full_name)
	);
}

// One row per user in the Everyone panel: their AM/PM entries plus the fields
// the filter/sort needs.
type UserAgg = {
	id: number;
	full_name: string;
	department: string | null;
	sub_department: string | null;
	user_role: string | null;
	personnel_type: string | null;
	AM?: Entry;
	PM?: Entry;
};

// Stable ordering of department headings in the day-details panel.
const DEPT_ORDER: readonly string[] = ['DHQ', 'DMSP', 'DCS', 'DSP', 'Others', 'Unassigned'];

// Render a single AM-or-PM cell: coloured status badge stacked above the
// (truncated) reason. Empty cell when there's no entry for that period.
// Label a row, prefixing "Pending " while its backing request still awaits approval.
const statusLabel = (row?: { parade_status: string | null; pending?: number }): string =>
	row && row.parade_status ? (row.pending ? `Pending ${row.parade_status}` : row.parade_status) : '—';

function renderStatusCell(entry: { parade_status: string | null; reason: string | null; pending?: number } | undefined) {
	if (!entry || !entry.parade_status) return <span className="muted">—</span>;
	return (
		<div>
			<span className="badge" style={{ background: COLORS[entry.parade_status] }}>
				{entry.pending ? `Pending ${entry.parade_status}` : entry.parade_status}
			</span>
			{entry.reason && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{entry.reason}</div>}
		</div>
	);
}

const STATUSES = [
	'Present',
	'Course',
	'AO',
	'MA',
	'MC',
	'RSO',
	'RSI',
	'OFF',
	'LL',
	'OL',
	'Leave (Others)',
	'Others',
	'Incoming Opr',
	'Outgoing Opr',
	'Incoming ADS',
	'Outgoing ADS',
	'Incoming DS',
	'Outgoing DS',
	'Incoming DO',
	'Outgoing DO',
	'NTM Swap-In',
	'NTM Swap-Out',
	'Operator Off',
] as const;
type Status = (typeof STATUSES)[number];

// Incoming/Outgoing duty statuses count as "present" for the strength tally
// and are hidden from the per-status breakdown in the View-state report.
const DUTY_PRESENT_STATUSES = new Set<string>([
	'Incoming Opr',
	'Outgoing Opr',
	'Incoming ADS',
	'Outgoing ADS',
	'Incoming DS',
	'Outgoing DS',
	'Incoming DO',
	'Outgoing DO',
	'NTM Swap-In',
	'NTM Swap-Out',
]);
function isPresentish(status: string | null): boolean {
	return status === 'Present' || (status !== null && DUTY_PRESENT_STATUSES.has(status));
}

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
	'Incoming Opr': 'Incoming Opr',
	'Outgoing Opr': 'Outgoing Opr',
	'Incoming ADS': 'Incoming ADS',
	'Outgoing ADS': 'Outgoing ADS',
	'Incoming DS': 'Incoming DS',
	'Outgoing DS': 'Outgoing DS',
	'Incoming DO': 'Incoming DO',
	'Outgoing DO': 'Outgoing DO',
	'Leave (Others)': 'Leave (Others)',
	Others: 'Others',
	'NTM Swap-In': 'NTM Swap-In',
	'NTM Swap-Out': 'NTM Swap-Out',
	'Operator Off': 'Operator Off',
};

const PRESENT_COLOR = '#4caf50';
const COLORS: Record<string, string> = {
	Present: PRESENT_COLOR,
	Course: '#ff9800',
	AO: '#795548',
	MA: '#26c6da',
	MC: '#f44336',
	RSO: '#c62828',
	RSI: '#c62828',
	OFF: '#9e9e9e',
	LL: '#03a9f4',
	OL: '#00897b',
	'Leave (Others)': '#9c27b0',
	Others: '#607d8b',
	// Duty (Incoming/Outgoing) statuses share the Present colour — they count
	// as present on the ground.
	'Incoming Opr': PRESENT_COLOR,
	'Outgoing Opr': PRESENT_COLOR,
	'Incoming ADS': PRESENT_COLOR,
	'Outgoing ADS': PRESENT_COLOR,
	'Incoming DS': PRESENT_COLOR,
	'Outgoing DS': PRESENT_COLOR,
	'Incoming DO': PRESENT_COLOR,
	'Outgoing DO': PRESENT_COLOR,
	'NTM Swap-In': PRESENT_COLOR,
	'NTM Swap-Out': PRESENT_COLOR,
	'Operator Off': '#9e9e9e', // same grey as OFF
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

// Statuses shown in the View-state per-status breakdown. Incoming/Outgoing duty
// statuses are intentionally excluded — they're folded into the Present count.
const NON_PRESENT_STATUSES = [
	'Course',
	'AO',
	'MA',
	'MC',
	'RSO',
	'RSI',
	'OFF',
	'LL',
	'OL',
	'Leave (Others)',
	'Others',
] as const;

// Statuses that make the reason field compulsory in the submit modal.
const REASON_REQUIRED = new Set<string>(['Course', 'AO', 'MA', 'MC', 'RSO', 'RSI', 'OL', 'Leave (Others)', 'Others']);

// Leave statuses route through the dedicated Take Leave flow (superior approval
// + OneNS reminder) instead of being written to the calendar directly. MA
// (medical appointment) also needs superior approval, so it routes through the
// same flow — but WITHOUT the OneNS reminder.
const LEAVE_SET = new Set<string>(['LL', 'OL', 'Leave (Others)']);
const APPROVAL_ROUTED_SET = new Set<string>([...LEAVE_SET, 'MA']);

function isNsfish(t: string | null): boolean {
	return t === 'NSF' || t === 'NSF Officer';
}

function countSplit(rows: StrengthRow[]) {
	// Everyone who isn't a Regular counts under N (incl. anyone with an unset
	// personnel_type) — so N + R always equals the department's headcount and the
	// grand total reconciles with the per-department breakdown.
	const reg = rows.filter((r) => r.personnel_type === 'Regular');
	const nsf = rows.filter((r) => r.personnel_type !== 'Regular');
	// Present = literal Present + anyone on an Incoming/Outgoing duty.
	const present = (arr: StrengthRow[]) => arr.filter((r) => isPresentish(r.status)).length;
	return { nsf, reg, nsfPresent: present(nsf), regPresent: present(reg) };
}

function buildStrengthReport(amUsers: StrengthRow[], pmUsers: StrengthRow[], period: 'AM' | 'PM'): string {
	// Header/counts reflect the current period; the absence listing below merges
	// both half-days (AM / PM / FD) so a full-day picture is shown.
	const users = period === 'AM' ? amUsers : pmUsers;
	const lines: string[] = [];

	// Not-submitted (blank) — listed FIRST and prominently so it's the first thing
	// seen. "Blank" = no parade entry for this half-day (status is null).
	const blanks = users.filter((u) => u.status === null).sort((a, b) => a.full_name.localeCompare(b.full_name));
	lines.push(`⚠️ NOT SUBMITTED — ${period} (${blanks.length})`);
	if (blanks.length) {
		for (const u of blanks) lines.push(`• ${u.full_name}`);
	} else {
		lines.push('(everyone submitted 🎉)');
	}
	lines.push('');
	lines.push('━━━━━━━━━━━━━━');
	lines.push('');

	lines.push(`*${period} Present Strength*`);
	lines.push('');

	// DSP (formerly STG, now a single combined department).
	const dsp = countSplit(users.filter((u) => u.department === 'DSP' || u.department === 'STG'));
	lines.push('DSP');
	lines.push(`N: ${dsp.nsfPresent}/${dsp.nsf.length}`);
	lines.push(`R: ${dsp.regPresent}/${dsp.reg.length}`);
	lines.push('');

	// DMSP / DCS / DHQ
	for (const dept of ['DMSP', 'DCS', 'DHQ'] as const) {
		const inDept = users.filter((u) => u.department === dept);
		const s = countSplit(inDept);
		lines.push(dept);
		lines.push(`N: ${s.nsfPresent}/${s.nsf.length}`);
		lines.push(`R: ${s.regPresent}/${s.reg.length}`);
		lines.push('');
	}

	// Total — Present folds in everyone on an Incoming/Outgoing duty.
	const totalRegistered = users.length;
	const totalPresent = users.filter((u) => isPresentish(u.status)).length;
	lines.push(`Total Strength: ${totalPresent}/${totalRegistered}`);
	lines.push('');

	// List Regulars + NSF Officers who are non-present for at least half a day,
	// with an AM / PM / FD breakdown. Merge both periods by user id.
	const label = (status: string | null, reason: string | null) =>
		`${status ?? 'Not submitted'}${reason ? ` (${reason})` : ''}`;
	type Merged = { id: number; full_name: string; personnel_type: string | null; am?: StrengthRow; pm?: StrengthRow };
	const byId = new Map<number, Merged>();
	for (const u of amUsers) byId.set(u.id, { id: u.id, full_name: u.full_name, personnel_type: u.personnel_type, am: u });
	for (const u of pmUsers) {
		const cur = byId.get(u.id) ?? { id: u.id, full_name: u.full_name, personnel_type: u.personnel_type };
		cur.pm = u;
		byId.set(u.id, cur);
	}
	const listed = [...byId.values()]
		.filter(
			(e) =>
				(e.personnel_type === 'Regular' || e.personnel_type === 'NSF Officer') &&
				(!isPresentish(e.am?.status ?? null) || !isPresentish(e.pm?.status ?? null)),
		)
		.sort((a, b) => a.full_name.localeCompare(b.full_name));
	for (const e of listed) {
		const amS = e.am?.status ?? null;
		const pmS = e.pm?.status ?? null;
		const amR = e.am?.reason ?? null;
		const pmR = e.pm?.reason ?? null;
		const amAbsent = !isPresentish(amS);
		const pmAbsent = !isPresentish(pmS);
		let detail: string;
		if (amAbsent && pmAbsent && amS === pmS && amR === pmR) {
			detail = `FD ${label(amS, amR)}`;
		} else {
			const parts: string[] = [];
			if (amAbsent) parts.push(`AM ${label(amS, amR)}`);
			if (pmAbsent) parts.push(`PM ${label(pmS, pmR)}`);
			detail = parts.join(', ');
		}
		lines.push(`${e.full_name} ${detail}`);
	}
	lines.push('');

	// Counts per non-Present status (everyone, not just Regulars/Officers). The
	// OFF line folds in Operator Off (it counts toward the total OFF).
	lines.push('*Other status*');
	for (const s of NON_PRESENT_STATUSES) {
		const n =
			s === 'OFF'
				? users.filter((u) => u.status === 'OFF' || u.status === 'Operator Off').length
				: users.filter((u) => u.status === s).length;
		lines.push(`${s}: ${n}`);
	}
	lines.push(`Not submitted (blank): ${blanks.length}`);
	lines.push(`Total absent: ${totalRegistered - totalPresent}`);

	return lines.join('\n');
}

// My own parade entries for the visible month (calendar chips). Subset of Entry.
interface MyMonthRow {
	parade_state_date: string;
	period: 'AM' | 'PM';
	parade_status: string;
	reason: string | null;
	pending: number;
}

// ±3 month navigation cap. Computed once on mount; the UI restricts navigation
// to this window so the calendar can't be scrolled into arbitrarily-distant
// months (defensive bound on /api/parade/day cost).
function calendarBounds(): { start: Date; end: Date; minIso: string; maxIso: string } {
	const t = todayLocal();
	const start = new Date(t.getFullYear(), t.getMonth() - 2, 1);
	const end = new Date(t.getFullYear(), t.getMonth() + 2, 1);
	// Last day of (current month + 2) — pass 0 as day of the month *after* end.
	const lastDayEnd = new Date(t.getFullYear(), t.getMonth() + 3, 0);
	return {
		start,
		end,
		minIso: ymdKey(start),
		maxIso: ymdKey(lastDayEnd),
	};
}

// Initial calendar date — honours ?date=YYYY-MM-DD from reminder deep-links
// (e.g. the 9pm nudge points at tomorrow), clamped to the ±2-month window.
// Falls back to today for anything missing / malformed / out of range.
function initialDate(minIso: string, maxIso: string): Date {
	const t = todayLocal();
	const raw = new URLSearchParams(window.location.search).get('date');
	if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && raw >= minIso && raw <= maxIso) {
		const d = new Date(`${raw}T00:00:00`);
		if (!Number.isNaN(d.getTime())) return d;
	}
	// From 5:30pm onwards, parade state is usually being filled for the NEXT day —
	// default the calendar to tomorrow so the common case needs no extra taps.
	const now = new Date();
	if (now.getHours() * 60 + now.getMinutes() >= 17 * 60 + 30) {
		const tmr = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
		if (ymdKey(tmr) <= maxIso) return tmr;
	}
	return t;
}

export function ParadeTab({ me, onRoute }: { me: Me; onRoute: (action: RouteAction) => void }) {
	const bounds = useMemo(() => calendarBounds(), []);
	const initial = useMemo(() => initialDate(bounds.minIso, bounds.maxIso), [bounds]);
	const [month, setMonth] = useState<Date>(initial);
	// Store the month-data WITH the ym it belongs to, so a stale /my-month response
	// (one that resolved out-of-order while the user switched months / refocused the
	// app) can never be shown for the wrong month. See refreshMyMonth.
	type MonthMap = Map<string, { AM?: MyMonthRow; PM?: MyMonthRow }>;
	const [myMonth, setMyMonth] = useState<{ ym: string; byDate: MonthMap } | null>(null);
	const [dayDetails, setDayDetails] = useState<Entry[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selectedDate, setSelectedDate] = useState<Date>(initial);
	const [showSubmit, setShowSubmit] = useState(false);
	const [strengthData, setStrengthData] = useState<{ am: StrengthRow[]; pm: StrengthRow[]; date: string } | null>(null);
	// "Everyone's status" is collapsed by default — its /api/parade/day fetch
	// only fires when expanded, so most users never pay that read cost.
	const [showEveryone, setShowEveryone] = useState(false);
	// Everyone-panel filters (all client-side over the already-fetched /day data —
	// zero extra reads, so safe for the free tier).
	const [everyoneSearch, setEveryoneSearch] = useState('');
	const [everyoneDept, setEveryoneDept] = useState<string>('all');
	const [everyonePersonnel, setEveryonePersonnel] = useState<'all' | 'Regular' | 'NSF'>('all');
	// Who this caller may edit parade state for (superadmin → all; superiors →
	// their reports). Drives the inline ✏️ buttons in the Everyone panel.
	const [staffEdit, setStaffEdit] = useState<{ all: boolean; ids: Set<number> }>({ all: false, ids: new Set() });
	const [editTarget, setEditTarget] = useState<{ id: number; name: string } | null>(null);
	const [forecastTarget, setForecastTarget] = useState<{ id: number; name: string } | null>(null);
	const canEditParade = (uid: number) => staffEdit.all || staffEdit.ids.has(uid);

	// Always-current ym, so an in-flight fetch can tell at resolve time whether the
	// user has since switched away from the month it was fetching.
	const curYm = ymKey(month);
	const curYmRef = useRef(curYm);
	curYmRef.current = curYm;

	// Fetch only the current user's entries for the visible month (~60 rows max).
	function refreshMyMonth() {
		setLoadError(null);
		const requestedYm = ymKey(month);
		return api
			.get<MyMonthRow[]>(`/api/parade/my-month?ym=${requestedYm}`)
			.then((rows) => {
				// Drop a stale response: if the user navigated to another month (or a
				// focus-refresh raced this) the displayed month no longer matches what we
				// fetched, so applying it would blank the calendar with the wrong month's
				// (non-matching) date keys. Whichever month is shown, only ITS response wins.
				if (requestedYm !== curYmRef.current) return;
				const m = new Map<string, { AM?: MyMonthRow; PM?: MyMonthRow }>();
				for (const r of rows) {
					const cur = m.get(r.parade_state_date) ?? {};
					cur[r.period] = r;
					m.set(r.parade_state_date, cur);
				}
				setMyMonth({ ym: requestedYm, byDate: m });
			})
			.catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
	}

	// Fetch everyone's entries for the selected date (~180 rows max).
	function refreshDay() {
		return api
			.get<Entry[]>(`/api/parade/day?date=${ymdKey(selectedDate)}`)
			.then(setDayDetails)
			.catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
	}

	async function refresh(): Promise<void> {
		// Only refetch everyone's data if that panel is open.
		await Promise.all([refreshMyMonth(), showEveryone ? refreshDay() : Promise.resolve()]);
	}

	useEffect(() => {
		api
			.get<{ all: boolean; ids: number[] }>('/api/parade/staff-ids')
			.then((r) => setStaffEdit({ all: r.all, ids: new Set(r.ids) }))
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshMyMonth();
	}, [month]);
	useEffect(() => {
		if (showEveryone) refreshDay();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedDate, showEveryone]);
	// Sync when the user returns to the app (e.g. a late-change was approved).
	useFocusRefresh(refresh);

	// Render guard: only expose the month map when it belongs to the displayed
	// month. During a month switch (before the new fetch lands) this is an empty
	// map → cells render blank (loading) rather than stale, and a late stale write
	// can't leak through either.
	const myMonthByDate: MonthMap = myMonth && myMonth.ym === curYm ? myMonth.byDate : new Map();

	const myToday = myMonthByDate.get(ymdKey(selectedDate));

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
			{/* Key on the MONTH only. Including myMonthByDate.size here used to force a
			    full remount every time the month data loaded — so switching months
			    remounted the grid against stale/empty data and the AM/PM chips blanked
			    out until the fetch landed (the legend below, hard-coded, stayed). The
			    inline DayButton closure already re-reads the fresh map on each parent
			    re-render, so chips update on edits without the remount flicker. */}
			<DayPicker
				key={`cal-${ymKey(month)}`}
				mode="single"
				month={month}
				onMonthChange={setMonth}
				selected={selectedDate}
				onSelect={(d) => d && setSelectedDate(d)}
				startMonth={bounds.start}
				endMonth={bounds.end}
				disabled={{
					before: bounds.start,
					after: new Date(bounds.end.getFullYear(), bounds.end.getMonth() + 1, 0),
				}}
				components={{
					DayButton: (props) => {
						const dateKey = ymdKey(props.day.date);
						const my = myMonthByDate.get(dateKey);
						const { day: _day, modifiers: _modifiers, ...buttonProps } = props;
						void _day;
						void _modifiers;
						return (
							<button {...buttonProps} className={`${buttonProps.className ?? ''} day-cell`}>
								<div className="day-num">{props.day.date.getDate()}</div>
								<div className="day-chips">
									<span
										className="chip-half am"
										style={{ background: my?.AM ? COLORS[my.AM.parade_status] : 'transparent', opacity: my?.AM?.pending ? 0.45 : 1 }}
									/>
									<span
										className="chip-half pm"
										style={{ background: my?.PM ? COLORS[my.PM.parade_status] : 'transparent', opacity: my?.PM?.pending ? 0.45 : 1 }}
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
									My AM: <b>{statusLabel(myToday.AM)}</b>
									{' · '}
									My PM: <b>{statusLabel(myToday.PM)}</b>
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

			{isAdminish(me.user_role) && <ExportButton selectedDate={ymdKey(selectedDate)} minIso={bounds.minIso} maxIso={bounds.maxIso} />}

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
				{/* Full-width buttons so the action is obvious (the old inline
				    "Show" link was too easy to miss in the cramped header). */}
				<div className="actions">
					<button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowEveryone((v) => !v)}>
						{showEveryone ? '▲ Hide everyone' : `👥 Show everyone's status (${ymdKey(selectedDate)})`}
					</button>
					<button
						className="btn btn-secondary"
						style={{ flex: 1 }}
						onClick={async () => {
							try {
								const d = ymdKey(selectedDate);
								const [am, pm] = await Promise.all([
									api.get<{ users: StrengthRow[] }>(`/api/parade/strength?date=${d}&period=AM`),
									api.get<{ users: StrengthRow[] }>(`/api/parade/strength?date=${d}&period=PM`),
								]);
								setStrengthData({ am: am.users, pm: pm.users, date: d });
							} catch (e) {
								alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
							}
						}}
					>
						📋 View state
					</button>
				</div>
				{showEveryone && (
					<div style={{ marginTop: 12 }}>
						<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
							<input
								value={everyoneSearch}
								onChange={(e) => setEveryoneSearch(e.target.value)}
								placeholder="🔎 Search name"
								style={{ flex: '1 1 140px' }}
							/>
							<select value={everyoneDept} onChange={(e) => setEveryoneDept(e.target.value)}>
								<option value="all">All depts</option>
								{DEPT_ORDER.map((d) => (
									<option key={d} value={d}>{d}</option>
								))}
							</select>
							<select value={everyonePersonnel} onChange={(e) => setEveryonePersonnel(e.target.value as 'all' | 'Regular' | 'NSF')}>
								<option value="all">All types</option>
								<option value="Regular">R</option>
								<option value="NSF">N</option>
							</select>
						</div>
						{(() => {
							const byUser = new Map<number, UserAgg>();
							for (const e of dayDetails) {
								const cur =
									byUser.get(e.user_id) ?? {
										id: e.user_id,
										full_name: e.full_name,
										department: e.department,
										sub_department: e.sub_department,
										user_role: e.user_role,
										personnel_type: e.personnel_type,
									};
								if (e.period === 'AM') cur.AM = e;
								else if (e.period === 'PM') cur.PM = e;
								byUser.set(e.user_id, cur);
							}
							let users = [...byUser.values()];
							const q = everyoneSearch.trim().toLowerCase();
							const filtersActive = q !== '' || everyoneDept !== 'all' || everyonePersonnel !== 'all';
							if (q) users = users.filter((u) => u.full_name.toLowerCase().includes(q));
							if (everyoneDept !== 'all') users = users.filter((u) => deptLabel(u.department, u.sub_department) === everyoneDept);
							if (everyonePersonnel === 'Regular') users = users.filter((u) => u.personnel_type === 'Regular');
							else if (everyonePersonnel === 'NSF') users = users.filter((u) => isNsfish(u.personnel_type));

							if (users.length === 0) {
								return <p className="muted">{filtersActive ? 'No matching users.' : 'No active users.'}</p>;
							}

							const renderRow = (u: UserAgg) => (
								<tr key={u.id}>
									<td>
										{u.full_name}
										{canEditParade(u.id) && (
											<button
												className="btn-link"
												style={{ marginLeft: 6 }}
												title="Edit this person's state for the selected date"
												onClick={() => {
													setEditTarget({ id: u.id, name: u.full_name });
													setShowSubmit(true);
												}}
											>
												✏️
											</button>
										)}
										{isAdminish(me.user_role) && (
											<button
												className="btn-link"
												style={{ marginLeft: 4 }}
												title="View this person's next-30-days forecast"
												onClick={() => setForecastTarget({ id: u.id, name: u.full_name })}
											>
												📅
											</button>
										)}
									</td>
									<td>{renderStatusCell(u.AM)}</td>
									<td>{renderStatusCell(u.PM)}</td>
								</tr>
							);
							const table = (rows: UserAgg[]) => (
								<table>
									<thead><tr><th>Name</th><th>AM</th><th>PM</th></tr></thead>
									<tbody>{rows.map(renderRow)}</tbody>
								</table>
							);

							if (filtersActive) {
								const sorted = [...users].sort(cmpPersonnel);
								return (
									<div style={{ marginTop: 4 }}>
										<h5 className="section-title" style={{ margin: '0 0 4px' }}>Results ({sorted.length})</h5>
										{table(sorted)}
									</div>
								);
							}
							const groups = new Map<string, UserAgg[]>();
							for (const u of users) {
								const k = deptLabel(u.department, u.sub_department);
								const arr = groups.get(k) ?? [];
								arr.push(u);
								groups.set(k, arr);
							}
							const order = [...DEPT_ORDER, ...[...groups.keys()].filter((k) => !DEPT_ORDER.includes(k))];
							return (
								<>
									{order
										.filter((d) => groups.has(d))
										.map((dept) => {
											const list = [...groups.get(dept)!].sort(cmpPersonnel);
											return (
												<div key={dept} style={{ marginTop: 12 }}>
													<h5 className="section-title" style={{ margin: '0 0 4px' }}>{dept} ({list.length})</h5>
													{table(list)}
												</div>
											);
										})}
								</>
							);
						})()}
					</div>
				)}
			</div>

			{showSubmit && (
				<SubmitModal
					initialDate={ymdKey(selectedDate)}
					minIso={bounds.minIso}
					maxIso={bounds.maxIso}
					canEditPast={me.user_role === 'superadmin'}
					target={editTarget}
					onClose={() => {
						setShowSubmit(false);
						setEditTarget(null);
					}}
					onDone={refresh}
					onRoute={onRoute}
					onSaved={(d) => {
						const dt = new Date(`${d}T00:00:00`);
						setMonth(dt);
						setSelectedDate(dt);
					}}
				/>
			)}

			{strengthData && (
				<StrengthModal amUsers={strengthData.am} pmUsers={strengthData.pm} date={strengthData.date} onClose={() => setStrengthData(null)} />
			)}

			{forecastTarget && (
				<ForecastModal target={forecastTarget} onClose={() => setForecastTarget(null)} />
			)}
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
	minIso,
	maxIso,
	canEditPast,
	target,
	onClose,
	onDone,
	onRoute,
	onSaved,
}: {
	initialDate: string;
	minIso: string;
	maxIso: string;
	// Superadmins may edit days that have already ended; everyone else is capped
	// at today (past-day parade state is locked).
	canEditPast: boolean;
	// When set, a superior/superadmin is editing this person's state for the
	// single `initialDate` (no range, no auto-routing).
	target?: { id: number; name: string } | null;
	onClose: () => void;
	onDone: () => Promise<void>;
	onRoute: (action: RouteAction) => void;
	// After a clean SELF save, jump the calendar to the saved start date so the new
	// colour is visible immediately (esp. when submitting for a different month).
	onSaved?: (startdate: string) => void;
}) {
	const [startdate, setStartdate] = useState(initialDate);
	const [enddate, setEnddate] = useState(initialDate);
	// 'fd' = full-day same status for both AM & PM; 'diff' = separate AM / PM.
	const [mode, setMode] = useState<'fd' | 'diff'>('fd');
	const [fdStatus, setFdStatus] = useState<Status | 'Blank' | typeof NONE>(NONE);
	const [fdReason, setFdReason] = useState('');
	const [amStatus, setAmStatus] = useState<Status | 'Blank' | typeof NONE>(NONE);
	const [amReason, setAmReason] = useState('');
	const [pmStatus, setPmStatus] = useState<Status | 'Blank' | typeof NONE>(NONE);
	const [pmReason, setPmReason] = useState('');
	const [busy, setBusy] = useState(false);

	const reasonNeeded = (s: Status | 'Blank' | typeof NONE) => s !== NONE && REASON_REQUIRED.has(s);
	const noReasonField = (s: Status | 'Blank' | typeof NONE) => s === NONE || s === 'Present' || s === 'Blank';

	// Past-day lock: non-superadmins can't pick a date before today.
	const todayIso = ymdKey(todayLocal());
	const effMinIso = canEditPast ? minIso : minIso > todayIso ? minIso : todayIso;

	const datesValid = !!startdate && !!enddate && startdate <= enddate;
	const inRange = !!startdate && !!enddate && startdate >= effMinIso && enddate <= maxIso;

	// Build the period entries from whichever mode is active.
	const entries: { period: 'AM' | 'PM'; status: string; reason: string | null }[] = [];
	let reasonOk = true;
	if (mode === 'fd') {
		if (fdStatus !== NONE) {
			const r = noReasonField(fdStatus) ? null : fdReason.trim() || null;
			if (reasonNeeded(fdStatus) && !r) reasonOk = false;
			entries.push({ period: 'AM', status: fdStatus, reason: r });
			entries.push({ period: 'PM', status: fdStatus, reason: r });
		}
	} else {
		if (amStatus !== NONE) {
			const r = noReasonField(amStatus) ? null : amReason.trim() || null;
			if (reasonNeeded(amStatus) && !r) reasonOk = false;
			entries.push({ period: 'AM', status: amStatus, reason: r });
		}
		if (pmStatus !== NONE) {
			const r = noReasonField(pmStatus) ? null : pmReason.trim() || null;
			if (reasonNeeded(pmStatus) && !r) reasonOk = false;
			entries.push({ period: 'PM', status: pmStatus, reason: r });
		}
	}
	const atLeastOne = entries.length > 0;
	const canSave = datesValid && inRange && atLeastOne && reasonOk;

	// Leave selection — choosing LL / OL / Leave (Others) / MA routes into the
	// dedicated approval flow (self-service only; an approver editing a staff
	// member writes the status directly). It can be full-day (FD) or a half
	// (AM/PM) depending on which period(s) carry the routed status.
	const leaveSel: { type: string; reason: string; period: 'AM' | 'PM' | 'FD' } | null = (() => {
		if (mode === 'fd') return APPROVAL_ROUTED_SET.has(fdStatus) ? { type: fdStatus, reason: fdReason.trim(), period: 'FD' } : null;
		const amLeave = APPROVAL_ROUTED_SET.has(amStatus);
		const pmLeave = APPROVAL_ROUTED_SET.has(pmStatus);
		if (amLeave && pmLeave && amStatus === pmStatus) return { type: amStatus, reason: amReason.trim() || pmReason.trim(), period: 'FD' };
		if (amLeave) return { type: amStatus, reason: amReason.trim(), period: 'AM' };
		if (pmLeave) return { type: pmStatus, reason: pmReason.trim(), period: 'PM' };
		return null;
	})();
	const isLeaveRequest = !target && leaveSel != null;
	// MA routes through the same approval flow as leave, but is NOT leave: no
	// OneNS reminder, different wording.
	const isMaRequest = isLeaveRequest && leaveSel?.type === 'MA';

	let hint: string | null = null;
	if (!startdate || !enddate) hint = 'Pick start and end dates.';
	else if (startdate > enddate) hint = 'End date must be on or after start date.';
	else if (!canEditPast && startdate < todayIso) hint = 'Only a superadmin can edit days that have already passed.';
	else if (!inRange) hint = `Dates must be within ${effMinIso} → ${maxIso}.`;
	else if (!atLeastOne) hint = mode === 'fd' ? 'Pick a status.' : 'Set at least one of AM / PM status.';
	else if (!reasonOk) hint = 'A reason is required for that status.';

	const dayCount = datesValid
		? Math.floor(
				(new Date(`${enddate}T00:00:00`).getTime() - new Date(`${startdate}T00:00:00`).getTime()) / 86_400_000,
			) + 1
		: 0;

	async function submit() {
		if (!canSave) return;
		setBusy(true);
		try {
			// Leave / MA (LL/OL/Leave Others/MA) goes through the dedicated approval
			// flow, not the parade calendar write.
			if (isLeaveRequest && leaveSel) {
				// One-shot: save any NON-routed, no-approval half submitted alongside
				// (e.g. PM=Present) via the normal parade write so the user doesn't have
				// to submit twice. OFF/RSI/RSO are EXCLUDED — they need their own
				// backing/routing (the worker would just strip them here, silently), so
				// we don't pre-save them and instead warn the user to do that half
				// separately on the Off/Sick page.
				const NEEDS_OWN_FLOW = new Set(['OFF', 'RSI', 'RSO']);
				const nonRouted = entries.filter((e) => !APPROVAL_ROUTED_SET.has(e.status) && !NEEDS_OWN_FLOW.has(e.status));
				const droppedOther = entries.some((e) => NEEDS_OWN_FLOW.has(e.status));
				let savedOther = false;
				if (nonRouted.length > 0) {
					try {
						const pr = await api.post<{ applied: number }>('/api/parade/submit', { startdate, enddate, entries: nonRouted });
						savedOther = (pr.applied ?? 0) > 0;
					} catch {
						// Non-fatal — the leave request still proceeds.
					}
				}
				const lres = await api.post<{ auto_approved?: boolean }>('/api/leave/request', {
					leave_type: leaveSel.type,
					period: leaveSel.period,
					startdate,
					enddate,
					reason: leaveSel.reason || null,
				});
				await onDone();
				onClose();
				if (!target) onSaved?.(startdate);
				const lrange = startdate === enddate ? startdate : `${startdate} → ${enddate} (${dayCount} days)`;
				const half = leaveSel.period === 'FD' ? 'full-day' : `${leaveSel.period} half-day`;
				const otherNote =
					(savedOther ? '\n\n(Your other half-day status was also saved.)' : '') +
					(droppedOther ? '\n\n⚠ An OFF / RSI / RSO half can’t be set together with leave — set that half separately on the Off / Sick page.' : '');
				if (isMaRequest) {
					alertDialog(
						(lres.auto_approved
							? `🩺 ${half} MA applied for ${lrange} (no approval needed).`
							: `🩺 Your ${half} MA (${lrange}) has been forwarded to your superior for approval — you'll be notified here and on Telegram.`) + otherNote,
					);
				} else {
					alertDialog(
						(lres.auto_approved
							? `✅ ${half} ${leaveSel.type} leave applied for ${lrange} (no approval needed).\n\n‼️ You still need to submit the leave on OneNS yourself — the bot cannot do that for you.`
							: `🏝️ Your ${half} ${leaveSel.type} leave (${lrange}) has been forwarded to your superior for approval — you'll be notified here and on Telegram.\n\n‼️ You still need to submit the leave on OneNS yourself — the bot cannot do that for you.`) + otherNote,
					);
				}
				return;
			}
			const payload: Record<string, unknown> = { startdate, enddate, entries };
			if (target) payload.user_id = target.id;
			const res = await api.post<{
				applied: number;
				informed: number;
				skipped_weekends: number;
				skipped_slots?: { date: string; period: 'AM' | 'PM'; reason: string }[];
				skipped_past?: number;
				blocked_off?: boolean;
				blocked_sick?: 'RSI' | 'RSO' | null;
				blocked_mc?: boolean;
				off_period?: 'FD' | 'AM' | 'PM';
			}>('/api/parade/submit', payload);
			await onDone();
			onClose();
			// COMPULSORY backing: an OFF / RSI / RSO half had no matching application
			// yet, so it was stripped — any OTHER half was still saved (res.applied).
			// Route to the apply form (pre-filled). (Self only; staff edits never block.)
			if (!target && res.blocked_off) {
				// Derive the off period (FD if both halves OFF, else the one half) and
				// carry the reason so the Off form is pre-filled.
				// Prefer the worker's computed period (accounts for per-dept overrides that
				// make one half non-working); fall back to deriving from the submitted halves.
				const amOff = entries.some((e) => e.period === 'AM' && e.status === 'OFF');
				const pmOff = entries.some((e) => e.period === 'PM' && e.status === 'OFF');
				const offPeriod: 'FD' | 'AM' | 'PM' = res.off_period ?? (amOff && pmOff ? 'FD' : amOff ? 'AM' : 'PM');
				const offReason = entries.find((e) => e.status === 'OFF')?.reason ?? undefined;
				onRoute({ kind: 'off', start: startdate, end: enddate, period: offPeriod, reason: offReason });
				const savedNote = res.applied > 0 ? ' Your other status change(s) were saved.' : '';
				alertDialog(`⚠ OFF needs an approved Take Off first — opening the Off page (pre-filled). Submit it there; once approved your parade state will show OFF.${savedNote}`);
				return;
			}
			if (!target && res.blocked_sick) {
				// Carry the reason the user typed for the RSI/RSO cell over to the Sick
				// page so they don't have to retype it (reason is compulsory there too).
				const sickReason = entries.find((e) => e.status === res.blocked_sick)?.reason ?? undefined;
				onRoute({ kind: 'sick', sickType: res.blocked_sick, reason: sickReason ?? undefined });
				const savedNote = res.applied > 0 ? ' Your other status change(s) were saved.' : '';
				alertDialog(`⚠ ${res.blocked_sick} isn't set from the calendar — report it on the Sick page, where it's recorded as one half-day (today's current half, or tomorrow's AM if tomorrow is a working day). Opening the Sick page now.${savedNote}`);
				return;
			}
			if (!target && res.blocked_mc) {
				onRoute({ kind: 'sick', sickType: null });
				const savedNote = res.applied > 0 ? ' Your other status change(s) were saved.' : '';
				alertDialog(`⚠ You have an active RSI/RSO — record your MC on the Sick page (open your case → Update status), not the calendar. Opening the Sick page.${savedNote}`);
				return;
			}
			// Clean self save — jump the calendar to the saved start date so the new
			// colour is visible immediately (covers submitting for a different month).
			if (!target) onSaved?.(startdate);
			const parts =
				mode === 'fd'
					? `Full day: ${entries[0].status}`
					: entries.map((e) => `${e.period}: ${e.status}`).join(' · ');
			const range = startdate === enddate ? startdate : `${startdate} → ${enddate} (${dayCount} days)`;
			let msg = target ? `✅ Updated ${target.name}\n${parts}\nfor ${range}` : `✅ ${parts}\nfor ${range}`;
			if (res.informed > 0) {
				msg += `\n\n🔔 ${res.informed} late ${res.informed === 1 ? 'change was' : 'changes were'} applied immediately and your superior was notified (today AM after 07:00 / PM after 13:00, non-Present).`;
			}
			if (res.skipped_slots && res.skipped_slots.length > 0) {
				// Detailed per-day reasons (forced non-working overrides, holidays,
				// weekends) so the user knows WHY a slot wasn't saved. Collapse AM+PM
				// with the same reason into one "full day" line.
				const byKey = new Map<string, { date: string; reason: string; periods: Set<string> }>();
				for (const s of res.skipped_slots) {
					const key = `${s.date}|${s.reason}`;
					const g = byKey.get(key) ?? { date: s.date, reason: s.reason, periods: new Set<string>() };
					g.periods.add(s.period);
					byKey.set(key, g);
				}
				const lines = [...byKey.values()].map((g) => {
					const half = g.periods.size >= 2 ? 'full day' : [...g.periods][0];
					return `• ${g.date} (${half}): ${g.reason}`;
				});
				msg += `\n\n🟦 Not saved — non-working slot(s):\n${lines.join('\n')}`;
			} else if (res.skipped_weekends > 0) {
				msg += `\n\n🟦 ${res.skipped_weekends} non-working day(s) skipped (weekend or force non-working).`;
			}
			if (res.skipped_past && res.skipped_past > 0) {
				msg += `\n\n🔒 ${res.skipped_past} past day(s) skipped — only a superadmin can edit days that have ended.`;
			}
			if (res.applied === 0 && res.informed === 0) {
				if (res.skipped_past && res.skipped_past > 0) msg = '⚠ Nothing saved — those days have already passed (locked).';
				else msg = res.skipped_weekends > 0 ? '⚠ Nothing saved — all selected days were non-working.' : '⚠ Nothing saved.';
			}
			alertDialog(msg);
		} catch (e) {
			setBusy(false);
			const emsg = e instanceof Error ? e.message : String(e);
			alertDialog(
				emsg.includes('overlapping_request')
					? '⚠ You already have a pending or approved leave/MA that overlaps those dates — it’s awaiting approval. Manage it from the Pending page instead of re-requesting.'
					: `Failed: ${emsg}`,
			);
		}
	}

	const statusField = (
		value: Status | 'Blank' | typeof NONE,
		setValue: (s: Status | 'Blank' | typeof NONE) => void,
		reason: string,
		setReason: (s: string) => void,
	) => (
		<>
			<label>Status
				<select value={value} onChange={(e) => setValue(e.target.value as Status | 'Blank' | typeof NONE)}>
					<option value={NONE}>— leave unchanged —</option>
					<option value="Blank">⬜ Blank — clear this period</option>
					{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
				</select>
			</label>
			{!noReasonField(value) && (
				<label>
					Reason {reasonNeeded(value) ? <span className="danger">*required</span> : <span className="muted">(optional)</span>}
					<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonNeeded(value) ? 'Specify' : 'Optional'} />
				</label>
			)}
		</>
	);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>{target ? `Edit ${target.name}` : 'Submit / Edit Parade Status'}</h3>

				{target && (
					<div className="muted" style={{ marginBottom: 8 }}>
						Editing <b>{target.name}</b>'s state (applies immediately — pick a single day or a date range).
					</div>
				)}
				<label>Start date<input
					type="date"
					value={startdate}
					min={effMinIso}
					max={maxIso}
					onChange={(e) => {
						const v = e.target.value;
						setStartdate(v);
						// Snap end date to start if it's empty or now before start.
						if (!enddate || enddate < v) setEnddate(v);
					}}
				/></label>
				<label>End date<input type="date" value={enddate} min={startdate || effMinIso} max={maxIso} onChange={(e) => setEnddate(e.target.value)} /></label>

				<div className="seg" style={{ marginBottom: 10 }}>
					<button className={mode === 'fd' ? 'active' : ''} onClick={() => setMode('fd')}>FD Same Status</button>
					<button className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>Diff AM, PM Status</button>
				</div>

				{mode === 'fd' ? (
					<div className="card" style={{ background: 'var(--tg-theme-bg-color, #fff)', border: '1px solid var(--tg-theme-section-separator-color, #ddd)' }}>
						<b>📅 Full Day (AM + PM)</b>
						{statusField(fdStatus, setFdStatus, fdReason, setFdReason)}
					</div>
				) : (
					<>
						<div className="card" style={{ background: 'var(--tg-theme-bg-color, #fff)', border: '1px solid var(--tg-theme-section-separator-color, #ddd)' }}>
							<b>🌅 AM</b>
							{statusField(amStatus, setAmStatus, amReason, setAmReason)}
						</div>
						<div className="card" style={{ background: 'var(--tg-theme-bg-color, #fff)', border: '1px solid var(--tg-theme-section-separator-color, #ddd)' }}>
							<b>🌇 PM</b>
							{statusField(pmStatus, setPmStatus, pmReason, setPmReason)}
						</div>
					</>
				)}

				{isLeaveRequest && (
					<div
						style={{
							margin: '0 0 10px',
							padding: '10px 12px',
							borderRadius: 12,
							background: 'var(--depot-info, #0288d1)',
							color: '#fff',
							lineHeight: 1.4,
						}}
					>
						{isMaRequest ? (
							<>
								🩺 This is a <b>medical appointment (MA)</b>{leaveSel ? ` (${leaveSel.period === 'FD' ? 'full-day' : leaveSel.period + ' half-day'})` : ''}. Pressing <b>Request MA</b> forwards
								the request to your superior for approval via the Telegram bot. You'll be notified here and on Telegram once it's actioned.
							</>
						) : (
							<>
								🏝️ This is <b>leave</b>{leaveSel ? ` (${leaveSel.period === 'FD' ? 'full-day' : leaveSel.period + ' half-day'})` : ''}. Pressing <b>Take Leave</b> automatically forwards
								the request to your superior for approval via the Telegram bot. <b>You still need to SUBMIT the leave on{' '}
								<u>OneNS</u> yourself after approval via the telegram bot</b> — the bot cannot do that for you.
							</>
						)}
					</div>
				)}

				{hint && <div className="muted danger" style={{ marginBottom: 8 }}>{hint}</div>}

				<button className="btn" disabled={busy || !canSave} onClick={submit}>
					{busy ? 'Saving…' : isLeaveRequest ? (isMaRequest ? '🩺 Request MA (needs approval)' : '🏝️ Take Leave (request approval)') : 'Save'}
				</button>
			</div>
		</div>
	);
}

// Max days per Excel export — one worksheet (tab) per date, so this also caps
// the number of tabs. Mirrors EXPORT_MAX_DAYS on the worker (7 = up to a week,
// which keeps the build well within the free-tier CPU budget).
const EXPORT_MAX_DAYS = 7;

// Compact label-beside-field rows for the export box (keeps it from getting tall).
const EXPORT_FIELD_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const EXPORT_FIELD_LABEL: CSSProperties = { flexShrink: 0, width: 92 };
const EXPORT_FIELD_INPUT: CSSProperties = { marginTop: 0, marginBottom: 8, flex: 1, minWidth: 0 };

function ExportButton({ selectedDate, minIso, maxIso }: { selectedDate: string; minIso: string; maxIso: string }) {
	// Picker spans the whole calendar window (±2 months). Future dates export the
	// already-submitted forecast; dates beyond the retention window come back empty.
	const clamp = (d: string) => (d < minIso ? minIso : d > maxIso ? maxIso : d);
	const [start, setStart] = useState(clamp(selectedDate));
	const [end, setEnd] = useState(clamp(selectedDate));
	const [dept, setDept] = useState('all');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const d = clamp(selectedDate);
		setStart(d);
		setEnd(d);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedDate]);

	const validRange = !!start && !!end && start <= end;
	const dayCount = validRange
		? Math.floor((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86_400_000) + 1
		: 0;
	const tooLong = dayCount > EXPORT_MAX_DAYS;
	const rangeLabel = start === end ? start : `${start} → ${end}`;

	async function exportXls() {
		setBusy(true);
		try {
			const res = await api.post<{ ok: boolean; rows: number; sheets: number }>('/api/parade/export', {
				start,
				end,
				department: dept,
			});
			if (res.rows === 0) {
				alertDialog(`No parade entries found for ${rangeLabel}${dept === 'all' ? '' : ` (${dept})`}.`);
			} else {
				alertDialog(
					`📊 Excel (.xlsx) sent to your Telegram chat — ${res.sheets} date tab(s). Each date is its own tab; one row per person with AM/PM side-by-side (Present = green, otherwise red; Unfilled = red).`,
				);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			alertDialog(
				msg.includes('too_many_rows')
					? '⚠ Too many entries for one file — narrow to a single department, or pick a shorter date range, then try again.'
					: `Failed: ${msg}`,
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="card" style={{ marginTop: 12 }}>
			<h4 style={{ marginTop: 0 }}>Export to Excel (Admin/Superadmin)</h4>
			<p className="muted" style={{ marginTop: 0 }}>
				One worksheet (tab) per date, for all departments or a single one. Sent to your chat with the bot.
				Up to {EXPORT_MAX_DAYS} days per export (parade data is kept for the ±2-month calendar window).
			</p>
			{/* Label + field on one line each, so this section stays compact. */}
			<label style={EXPORT_FIELD_ROW}>
				<span style={EXPORT_FIELD_LABEL}>Start date</span>
				<input
					type="date"
					style={EXPORT_FIELD_INPUT}
					value={start}
					min={minIso}
					max={maxIso}
					onChange={(e) => {
						const v = e.target.value;
						setStart(v);
						if (!end || end < v) setEnd(v);
					}}
				/>
			</label>
			<label style={EXPORT_FIELD_ROW}>
				<span style={EXPORT_FIELD_LABEL}>End date</span>
				<input type="date" style={EXPORT_FIELD_INPUT} value={end} min={start || minIso} max={maxIso} onChange={(e) => setEnd(e.target.value)} />
			</label>
			<label style={EXPORT_FIELD_ROW}>
				<span style={EXPORT_FIELD_LABEL}>Department</span>
				<select style={EXPORT_FIELD_INPUT} value={dept} onChange={(e) => setDept(e.target.value)}>
					<option value="all">All departments</option>
					{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
				</select>
			</label>
			{!validRange && <p className="muted danger" style={{ marginBottom: 6 }}>End date must be on or after start date.</p>}
			{tooLong && <p className="muted danger" style={{ marginBottom: 6 }}>Max {EXPORT_MAX_DAYS} days per export — narrow the range (you picked {dayCount}).</p>}
			<button className="btn" disabled={busy || !validRange || tooLong} onClick={exportXls}>
				{busy ? 'Sending…' : `📤 Send Excel for ${rangeLabel}`}
			</button>
		</div>
	);
}

// Strength report with an AM / PM toggle — pick which half-day's strength to
// view/copy for the selected date. Defaults to the current half-day.
function StrengthModal({ amUsers, pmUsers, date, onClose }: { amUsers: StrengthRow[]; pmUsers: StrengthRow[]; date: string; onClose: () => void }) {
	const [period, setPeriod] = useState<'AM' | 'PM'>(periodByTimeSgt());
	const [copied, setCopied] = useState(false);
	const text = buildStrengthReport(amUsers, pmUsers, period);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			alertDialog('Clipboard blocked by Telegram. Long-press the text to select, then copy.');
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3 style={{ marginBottom: 6 }}>Parade State — {date}</h3>
				<div className="seg" style={{ marginBottom: 8 }}>
					<button className={period === 'AM' ? 'active' : ''} onClick={() => setPeriod('AM')}>🌅 AM strength</button>
					<button className={period === 'PM' ? 'active' : ''} onClick={() => setPeriod('PM')}>🌇 PM strength</button>
				</div>
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

// Read-only forecast for ONE person (admin/superadmin). Default window is the
// NEXT 30 days; switchable to the PAST 30 days. Each window is fetched lazily and
// cached, so opening the modal costs one read and the past view costs another only
// if actually toggled. Rate-limited server-side per viewer per day.
type ForecastData = { full_name: string; entries: MyMonthRow[]; cap: number; remaining: number };
function ForecastModal({ target, onClose }: { target: { id: number; name: string }; onClose: () => void }) {
	const [range, setRange] = useState<'next' | 'past'>('next');
	const [cache, setCache] = useState<{ next?: ForecastData; past?: ForecastData }>({});
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		setErr(null);
		if (cache[range]) return; // lazily fetch each window once, then cache it
		setLoading(true);
		api
			.get<ForecastData>(`/api/parade/user-month?user_id=${target.id}&range=${range}`)
			.then((d) => setCache((c) => ({ ...c, [range]: d })))
			.catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target.id, range]);

	const data = cache[range];
	const byDate = new Map<string, { AM?: MyMonthRow; PM?: MyMonthRow }>();
	for (const e of data?.entries ?? []) {
		const cur = byDate.get(e.parade_state_date) ?? {};
		cur[e.period] = e;
		byDate.set(e.parade_state_date, cur);
	}
	const dates = [...byDate.keys()].sort();
	const limitHit = err != null && (err.includes('view_limit') || err.includes('429'));
	const label = range === 'next' ? 'next 30 days' : 'past 30 days';

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3 style={{ marginBottom: 4 }}>📅 {target.name} — {label}</h3>
				<div className="seg" style={{ marginBottom: 8 }}>
					<button className={range === 'next' ? 'active' : ''} onClick={() => setRange('next')}>Next 30 days</button>
					<button className={range === 'past' ? 'active' : ''} onClick={() => setRange('past')}>Past 30 days</button>
				</div>
				{err ? (
					<p className="muted danger">{limitHit ? "You've hit your daily forecast-view limit. Try again tomorrow." : err}</p>
				) : loading || !data ? (
					<p className="muted">Loading…</p>
				) : (
					<>
						<p className="muted" style={{ marginTop: 0 }}>{data.remaining} view{data.remaining === 1 ? '' : 's'} left today.</p>
						{dates.length === 0 ? (
							<p className="muted">No parade state submitted in the {label}.</p>
						) : (
							<table>
								<thead><tr><th>Date</th><th>AM</th><th>PM</th></tr></thead>
								<tbody>
									{dates.map((d) => {
										const r = byDate.get(d)!;
										return (
											<tr key={d}>
												<td>{d}</td>
												<td>{renderStatusCell(r.AM)}</td>
												<td>{renderStatusCell(r.PM)}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						)}
					</>
				)}
				<div className="actions" style={{ marginTop: 10 }}>
					<button className="btn btn-secondary" onClick={onClose}>Close</button>
				</div>
			</div>
		</div>
	);
}
