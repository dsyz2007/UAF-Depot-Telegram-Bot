import { useEffect, useMemo, useState } from 'react';
import {
	api,
	apiDelete,
	alertDialog,
	confirmDialog,
	DEPARTMENTS,
	PERSONNEL_TYPES,
	APPOINTMENTS,
	deptLabel,
	personnelLabel,
	type Department,
	type Me,
	type PersonnelType,
	type Appointment,
} from '../lib/api';

interface AdminUser {
	id: number;
	telegram_id: string;
	full_name: string;
	username: string | null;
	user_role: 'user' | 'admin' | 'superadmin';
	ord_date: string | null;
	department: Department | null;
	sub_department: string | null;
	personnel_type: PersonnelType | null;
	appointment: Appointment | null;
	self_managed: number;
	off_credits: number;
	created_at: string;
}

interface Override {
	override_date: string;
	period: 'AM' | 'PM' | 'FD';
	departments: string | null; // CSV of department codes; null = all departments
	is_working_day: number;
	reason: string | null;
	set_at: string;
	set_by_name: string | null;
}

function periodLabel(p: 'AM' | 'PM' | 'FD'): string {
	return p === 'FD' ? 'Full day' : p;
}

interface Holiday {
	holiday_date: string;
	name: string;
	confirmed: number;
	refreshed_at: string;
}

type Section = 'users' | 'overrides' | 'holidays';

// Same 3-tiebreak ordering as the Parade "Show everyone" panel:
// 1) descending rights (superadmin > admin > user), 2) Regular before NSF,
// 3) alphabetical.
function cmpUser(a: AdminUser, b: AdminUser): number {
	const roleRank = (r: string) => (r === 'superadmin' ? 0 : r === 'admin' ? 1 : 2);
	const typeRank = (t: string | null) => (t === 'Regular' ? 0 : 1);
	return (
		roleRank(a.user_role) - roleRank(b.user_role) ||
		typeRank(a.personnel_type) - typeRank(b.personnel_type) ||
		a.full_name.localeCompare(b.full_name)
	);
}

// Name highlight colour by personnel type: Regular → purple, NSF → dark green.
function personnelColor(t: string | null | undefined): string | undefined {
	if (t === 'Regular') return '#5e35b1';
	if (t === 'NSF' || t === 'NSF Officer') return '#2e7d32';
	return undefined;
}

export function AdminTab({ me }: { me: Me }) {
	const [section, setSection] = useState<Section>('users');
	return (
		<div>
			<div className="seg" style={{ marginBottom: 12 }}>
				<button className={section === 'users' ? 'active' : ''} onClick={() => setSection('users')}>👥 Users</button>
				<button className={section === 'overrides' ? 'active' : ''} onClick={() => setSection('overrides')}>📆 Overrides</button>
				<button className={section === 'holidays' ? 'active' : ''} onClick={() => setSection('holidays')}>🇸🇬 Holidays</button>
			</div>
			{section === 'users' && <UsersSection me={me} />}
			{section === 'overrides' && <OverridesSection me={me} />}
			{section === 'holidays' && <HolidaysSection me={me} />}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Users section — grouped by department
// ─────────────────────────────────────────────────────────────────────────
function UsersSection({ me }: { me: Me }) {
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [editing, setEditing] = useState<AdminUser | null>(null);
	function refresh() {
		return api.get<AdminUser[]>('/api/admin/users').then(setUsers);
	}
	useEffect(() => {
		refresh().catch(console.error);
	}, []);

	const pending = users.filter((u) => u.full_name.startsWith('PENDING:'));
	const active = users.filter((u) => !u.full_name.startsWith('PENDING:'));
	const today = (() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	})();
	const ordingSoon = active
		.filter((u) => u.ord_date && u.ord_date >= today)
		.sort((a, b) => (a.ord_date! < b.ord_date! ? -1 : 1))
		.slice(0, 10);

	const byDept = useMemo(() => {
		const m = new Map<string, AdminUser[]>();
		for (const u of active) {
			const key = deptLabel(u.department, u.sub_department);
			const arr = m.get(key) ?? [];
			arr.push(u);
			m.set(key, arr);
		}
		return m;
	}, [active]);
	// Stable grouping order: DHQ, DMSP, DCS, DSP, then Others, then Unassigned.
	const deptOrder: string[] = ['DHQ', 'DMSP', 'DCS', 'DSP', 'Others', 'Unassigned'];

	return (
		<div>
			{pending.length > 0 && (
				<>
					<h3>Pending ({pending.length})</h3>
					{pending.map((u) => (
						<div key={u.id} className="row" onClick={() => setEditing(u)}>
							<span>{u.full_name.slice('PENDING:'.length)}</span>
							<span className="muted">{u.telegram_id}</span>
						</div>
					))}
				</>
			)}

			<h3 style={{ marginTop: 24 }}>Active ({active.length})</h3>
			{deptOrder.map((d) => {
				const list = byDept.get(d);
				if (!list || list.length === 0) return null;
				return (
					<div key={d} style={{ marginTop: 12 }}>
						<h4 className="section-title">{d} ({list.length})</h4>
						{[...list].sort(cmpUser).map((u) => (
							<div key={u.id} className="row" onClick={() => setEditing(u)}>
								{u.personnel_type ? (
										<span style={{ background: personnelColor(u.personnel_type), color: '#fff', padding: '2px 9px', borderRadius: 8, fontWeight: 600 }}>
											{u.full_name}
										</span>
									) : (
										<span>{u.full_name}</span>
									)}
								<span className="muted">
									{u.appointment && <><b>{u.appointment}</b> · </>}{u.self_managed ? <>self · </> : null}{u.user_role} · 🪙 {u.off_credits}
								</span>
							</div>
						))}
					</div>
				);
			})}

			{ordingSoon.length > 0 && (
				<>
					<h3 style={{ marginTop: 28 }}>Upcoming Expiry</h3>
					{ordingSoon.map((u) => (
						<div key={u.id} className="row" onClick={() => setEditing(u)}>
							<span>{u.full_name}</span>
							<span className="muted">{u.ord_date}</span>
						</div>
					))}
				</>
			)}

			{editing && (
				<EditUserModal
					user={editing}
					me={me}
					onClose={() => setEditing(null)}
					onSaved={(updated) => {
						setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
						setEditing(null);
					}}
					onDeleted={(id) => {
						setUsers((prev) => prev.filter((u) => u.id !== id));
						setEditing(null);
					}}
				/>
			)}
		</div>
	);
}

function EditUserModal({
	user,
	me,
	onClose,
	onSaved,
	onDeleted,
}: {
	user: AdminUser;
	me: Me;
	onClose: () => void;
	onSaved: (u: AdminUser) => void;
	onDeleted: (id: number) => void;
}) {
	const stripped = user.full_name.startsWith('PENDING:') ? user.full_name.slice('PENDING:'.length) : user.full_name;
	const [name, setName] = useState(stripped);
	const [role, setRole] = useState<AdminUser['user_role']>(user.user_role);
	const [ordDate, setOrdDate] = useState(user.ord_date ?? '');
	const [department, setDepartment] = useState<string>(user.department ?? '');
	const [personnelType, setPersonnelType] = useState<string>(user.personnel_type ?? '');
	const [appointment, setAppointment] = useState<string>(user.appointment ?? '');
	const [selfManaged, setSelfManaged] = useState<boolean>(!!user.self_managed);
	const [busy, setBusy] = useState(false);
	// Once this user is deleted, hide the destructive button so it can't linger or be
	// clicked a second time (the modal also closes via onDeleted).
	const [deleted, setDeleted] = useState(false);

	const canGrantSuperadmin = me.user_role === 'superadmin';
	// Only a superadmin may edit another superadmin (so admins can't demote one).
	const lockedSuperadmin = user.user_role === 'superadmin' && me.user_role !== 'superadmin';

	async function save() {
		setBusy(true);
		try {
			const res = await api.post<{ ok: boolean; user: AdminUser }>('/api/admin/users', {
				id: user.id,
				full_name: name,
				user_role: role,
				ord_date: ordDate || null,
				department: department || null,
				sub_department: null,
				personnel_type: personnelType || null,
				appointment: appointment || null,
				self_managed: selfManaged,
			});
			onSaved(res.user);
			alertDialog('Saved.');
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function del() {
		const ok = await confirmDialog(`Delete ${stripped}? This cannot be undone.`);
		if (!ok) return;
		setBusy(true);
		try {
			await api.post('/api/admin/users/delete', { id: user.id });
			setDeleted(true);
			onDeleted(user.id);
			alertDialog('Deleted.');
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Edit user</h3>
				<div className="muted">Telegram ID: {user.telegram_id}{user.username ? ` · @${user.username}` : ''} · 🪙 {user.off_credits} off credits</div>
				<label>Full name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
				<label>Personnel type
					<select value={personnelType} onChange={(e) => setPersonnelType(e.target.value)}>
						<option value="">— unspecified —</option>
						{PERSONNEL_TYPES.map((p) => <option key={p} value={p}>{personnelLabel(p)}</option>)}
					</select>
				</label>
				<label>Department
					<select value={department} onChange={(e) => setDepartment(e.target.value)}>
						<option value="">— unassigned —</option>
						{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
					</select>
				</label>
				<label>Role
					<select value={role} disabled={lockedSuperadmin} onChange={(e) => setRole(e.target.value as AdminUser['user_role'])}>
						<option value="user">user</option>
						<option value="admin">admin</option>
						{(canGrantSuperadmin || role === 'superadmin') && <option value="superadmin">superadmin</option>}
					</select>
				</label>
				{lockedSuperadmin && (
					<div className="muted danger" style={{ marginBottom: 8 }}>Only a superadmin can edit a superadmin.</div>
				)}
				<label>Appointment
					<select value={appointment} onChange={(e) => setAppointment(e.target.value)}>
						<option value="">— none —</option>
						{APPOINTMENTS.map((a) => <option key={a} value={a}>{a}</option>)}
					</select>
				</label>
				<div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
					Appointment-holders approve everyone in their department. People with no department fall back to all superadmins.
				</div>
				<label style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
					<input type="checkbox" checked={selfManaged} onChange={(e) => setSelfManaged(e.target.checked)} style={{ width: 'auto' }} />
					Self-managed (bypasses all approval)
				</label>
				<label>Expiry date (optional)
					<input type="date" value={ordDate} onChange={(e) => setOrdDate(e.target.value)} />
				</label>
				<button className="btn" disabled={busy || deleted || !name.trim() || lockedSuperadmin} onClick={save}>
					{busy ? 'Saving…' : 'Save'}
				</button>
				{me.user_role === 'superadmin' && user.id !== me.id && !deleted && (
					<button className="btn btn-danger" style={{ marginTop: 8 }} disabled={busy} onClick={del}>
						🗑 Delete user
					</button>
				)}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Working-day overrides
// ─────────────────────────────────────────────────────────────────────────
function OverridesSection({ me }: { me: Me }) {
	const [overrides, setOverrides] = useState<Override[]>([]);
	const [showAdd, setShowAdd] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	function refresh() {
		return api
			.get<Override[]>('/api/admin/overrides')
			.then((rows) => {
				setOverrides(rows);
				setLoadError(null);
			})
			.catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
	}
	useEffect(() => {
		refresh();
	}, []);

	async function remove(o: Override) {
		const ok = await confirmDialog(`Remove the ${periodLabel(o.period)} override for ${o.override_date}?`);
		if (!ok) return;
		try {
			await apiDelete(`/api/admin/overrides?date=${o.override_date}&period=${o.period}`);
			await refresh();
			alertDialog('Removed.');
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div>
			<p className="muted">Override the working-day rule for specific dates — optionally just the AM or PM half, and optionally only for selected departments (e.g. weekend exercise → working for DSP only).</p>
			{me.user_role === 'superadmin' && (
				<button className="btn" onClick={() => setShowAdd(true)}>+ Add override</button>
			)}

			{loadError && (
				<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)', marginTop: 10 }}>
					<b>⚠ Couldn't load overrides</b>
					<div className="muted">{loadError}</div>
					<div className="muted">If this mentions a missing <code>period</code>/<code>departments</code> column, apply migration <b>018</b> to the remote DB, then redeploy.</div>
				</div>
			)}

			{overrides.length === 0 ? (
				<p className="muted" style={{ marginTop: 12 }}>No overrides set.</p>
			) : (
				overrides.map((o) => (
					<div key={`${o.override_date}-${o.period}`} className="card">
						<div className="card-row">
							<span>
								<b>{o.override_date}</b> · {periodLabel(o.period)} — {o.is_working_day === 1 ? '✅ Working' : '🚫 Non-working'}
							</span>
							{me.user_role === 'superadmin' && (
								<button className="btn-link danger" onClick={() => remove(o)}>Remove</button>
							)}
						</div>
						<div className="muted">{o.departments ? `Departments: ${o.departments}` : 'All departments'}</div>
						{o.reason && <div className="muted">{o.reason}</div>}
						<div className="muted">Set by {o.set_by_name ?? '?'} at {o.set_at}</div>
					</div>
				))
			)}

			{showAdd && (
				<AddOverrideModal
					onClose={() => setShowAdd(false)}
					onDone={async (ov) => {
						// Reflect the just-saved override directly from the POST response. We
						// do NOT re-fetch here: a list GET could legitimately not include it
						// (e.g. a far-past date outside the read window) and would wipe it off
						// screen — which is exactly the "saved but shows nothing" bug.
						if (ov) {
							setOverrides((prev) => {
								const rest = prev.filter((o) => !(o.override_date === ov.override_date && o.period === ov.period));
								return [...rest, ov].sort(
									(a, b) => a.override_date.localeCompare(b.override_date) || a.period.localeCompare(b.period),
								);
							});
							setLoadError(null);
							return;
						}
						await refresh();
					}}
				/>
			)}
		</div>
	);
}

// Earliest date the overrides list shows (server GET window is today−60). Cap
// the picker to it so you can't add an override that the list would then hide.
function minOverrideDate(): string {
	const d = new Date();
	d.setDate(d.getDate() - 60);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function AddOverrideModal({ onClose, onDone }: { onClose: () => void; onDone: (override?: Override) => Promise<void> }) {
	const [date, setDate] = useState('');
	const [period, setPeriod] = useState<'FD' | 'AM' | 'PM'>('FD');
	const [isWorking, setIsWorking] = useState(true);
	const [allDepts, setAllDepts] = useState(true);
	const [depts, setDepts] = useState<Set<string>>(new Set());
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!date) return;
		// Default the toggle intelligently: a weekend likely means "force working".
		const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
		setIsWorking(dow === 0 || dow === 6);
	}, [date]);

	function toggleDept(d: string) {
		setDepts((prev) => {
			const next = new Set(prev);
			if (next.has(d)) next.delete(d);
			else next.add(d);
			return next;
		});
	}

	const deptsValid = allDepts || depts.size > 0;

	async function save() {
		setBusy(true);
		try {
			const res = await api.post<{ override?: Override }>('/api/admin/overrides', {
				override_date: date,
				period,
				is_working_day: isWorking,
				departments: allDepts ? null : [...depts],
				reason: reason.trim() || null,
			});
			await onDone(res.override);
			onClose();
			alertDialog('Saved.');
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Add working-day override</h3>
				<label>Date<input type="date" value={date} min={minOverrideDate()} onChange={(e) => setDate(e.target.value)} /></label>
				<label>Applies to
					<div className="seg">
						<button className={period === 'FD' ? 'active' : ''} onClick={() => setPeriod('FD')}>Full day</button>
						<button className={period === 'AM' ? 'active' : ''} onClick={() => setPeriod('AM')}>AM</button>
						<button className={period === 'PM' ? 'active' : ''} onClick={() => setPeriod('PM')}>PM</button>
					</div>
				</label>
				<label>
					<div className="seg">
						<button className={isWorking ? 'active' : ''} onClick={() => setIsWorking(true)}>✅ Force working</button>
						<button className={!isWorking ? 'active' : ''} onClick={() => setIsWorking(false)}>🚫 Force non-working</button>
					</div>
				</label>
				<label>Departments
					<div className="seg">
						<button className={allDepts ? 'active' : ''} onClick={() => setAllDepts(true)}>All departments</button>
						<button className={!allDepts ? 'active' : ''} onClick={() => setAllDepts(false)}>Selected</button>
					</div>
				</label>
				{!allDepts && (
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 10px' }}>
						{DEPARTMENTS.map((d) => (
							<label key={d} style={{ display: 'flex', alignItems: 'center', gap: 6, flexDirection: 'row', margin: 0 }}>
								<input type="checkbox" checked={depts.has(d)} onChange={() => toggleDept(d)} style={{ width: 'auto' }} />
								{d}
							</label>
						))}
					</div>
				)}
				<label>Reason
					<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Field exercise" />
				</label>
				<button className="btn" disabled={busy || !date || !deptsValid} onClick={save}>
					{busy ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────
// Public holidays — fetches from nager.date, confirm/reject inline
// ─────────────────────────────────────────────────────────────────────────
function HolidaysSection({ me }: { me: Me }) {
	const [holidays, setHolidays] = useState<Holiday[]>([]);
	const [busy, setBusy] = useState(false);
	const [lastReport, setLastReport] = useState<string | null>(null);
	const [showAdd, setShowAdd] = useState(false);

	function refresh() {
		return api.get<Holiday[]>('/api/admin/holidays').then(setHolidays);
	}
	useEffect(() => {
		refresh().catch(console.error);
	}, []);

	async function deleteHoliday(date: string) {
		const ok = await confirmDialog(`Remove holiday on ${date}?`);
		if (!ok) return;
		try {
			await api.post('/api/admin/holidays/delete', { date });
			await refresh();
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function forceRefresh() {
		setBusy(true);
		setLastReport(null);
		try {
			const res = await api.post<{
				ok: boolean;
				fetched: number;
				deltas: number;
				bootstrap: boolean;
				cached_total: number;
			}>('/api/admin/refresh-holidays');
			await refresh();
			let msg: string;
			if (res.fetched === 0) {
				msg = `⚠ Fetched 0 records from nager.date — the cache is unchanged (${res.cached_total} total). Check the worker logs.`;
			} else if (res.bootstrap) {
				msg = `✅ Bootstrap complete: cached ${res.fetched} holidays (auto-confirmed since this is the first fetch). Total in cache: ${res.cached_total}.`;
			} else if (res.deltas === 0) {
				msg = `✅ Already up to date — ${res.cached_total} confirmed holidays cached, no changes from nager.date.`;
			} else {
				msg = `✅ Refreshed. ${res.deltas} change(s) detected — check your Telegram DM to confirm.`;
			}
			setLastReport(msg);
			alertDialog(msg);
		} catch (e) {
			const msg = `Failed: ${e instanceof Error ? e.message : String(e)}`;
			setLastReport(msg);
			alertDialog(msg);
		} finally {
			setBusy(false);
		}
	}

	async function confirmOne(date: string, action: 'confirm' | 'reject') {
		try {
			await api.post('/api/admin/holidays/confirm', { date, action });
			await refresh();
		} catch (e) {
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div>
			<p className="muted">SG public holidays sourced from <b>nager.date</b>. Auto-refresh runs daily at 12:00 SGT; new/changed entries are DM'd to all superadmins for confirm.</p>
			{me.user_role === 'superadmin' && (
				<div className="actions">
					<button className="btn" disabled={busy} onClick={forceRefresh}>
						{busy ? 'Refreshing…' : '🔄 Force refresh'}
					</button>
					<button className="btn btn-secondary" onClick={() => setShowAdd(true)}>+ Add holiday</button>
				</div>
			)}
			{lastReport && <div className="muted" style={{ marginTop: 8 }}>{lastReport}</div>}

			{holidays.length === 0 ? (
				<p className="muted" style={{ marginTop: 12 }}>No holidays cached yet. Tap "Force refresh" or "Add holiday".</p>
			) : (
				<table style={{ marginTop: 12 }}>
					<thead><tr><th>Date</th><th>Name</th><th>Status</th>{me.user_role === 'superadmin' && <th></th>}</tr></thead>
					<tbody>
						{holidays.map((h) => (
							<tr key={h.holiday_date}>
								<td>{h.holiday_date}</td>
								<td>{h.name}</td>
								<td>{h.confirmed === 1 ? '✅' : '⏳ pending'}</td>
								{me.user_role === 'superadmin' && (
									<td>
										{h.confirmed !== 1 ? (
											<>
												<button className="btn-link" onClick={() => confirmOne(h.holiday_date, 'confirm')}>Confirm</button>
												{' · '}
												<button className="btn-link danger" onClick={() => confirmOne(h.holiday_date, 'reject')}>Reject</button>
											</>
										) : (
											<button className="btn-link danger" onClick={() => deleteHoliday(h.holiday_date)}>Remove</button>
										)}
									</td>
								)}
							</tr>
						))}
					</tbody>
				</table>
			)}

			{showAdd && <AddHolidayModal onClose={() => setShowAdd(false)} onDone={refresh} />}
		</div>
	);
}

function AddHolidayModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
	const [date, setDate] = useState('');
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);

	async function save() {
		setBusy(true);
		try {
			await api.post('/api/admin/holidays/add', { date, name });
			await onDone();
			onClose();
			alertDialog('Holiday added.');
		} catch (e) {
			setBusy(false);
			alertDialog(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Add public holiday</h3>
				<p className="muted">Use this if nager.date is unavailable or MOM declares an ad-hoc holiday. Added as confirmed immediately.</p>
				<label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
				<label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Polling Day" /></label>
				<button className="btn" disabled={busy || !date || !name.trim()} onClick={save}>
					{busy ? 'Saving…' : 'Add'}
				</button>
			</div>
		</div>
	);
}
