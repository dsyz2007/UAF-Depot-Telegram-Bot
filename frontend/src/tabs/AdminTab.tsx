import { useEffect, useMemo, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import {
	api,
	apiDelete,
	confirmDialog,
	DEPARTMENTS,
	STG_SUB_DEPARTMENTS,
	PERSONNEL_TYPES,
	type Department,
	type StgSubDepartment,
	type Me,
	type PersonnelType,
} from '../lib/api';

interface AdminUser {
	id: number;
	telegram_id: string;
	full_name: string;
	user_role: 'user' | 'admin' | 'superadmin';
	superior_telegram_id: string | null;
	ord_date: string | null;
	department: Department | null;
	sub_department: StgSubDepartment | null;
	personnel_type: PersonnelType | null;
	off_credits: number;
	created_at: string;
}

interface Override {
	override_date: string;
	is_working_day: number;
	reason: string | null;
	set_at: string;
	set_by_name: string | null;
}

interface Holiday {
	holiday_date: string;
	name: string;
	confirmed: number;
	refreshed_at: string;
}

type Section = 'users' | 'overrides' | 'holidays';

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
			let key: string;
			if (u.department === 'STG' && u.sub_department) key = `STG — ${u.sub_department}`;
			else key = u.department ?? 'Unassigned';
			const arr = m.get(key) ?? [];
			arr.push(u);
			m.set(key, arr);
		}
		return m;
	}, [active]);
	// Stable grouping order: DHQ, DMSP, DCS, STG (C1+C2), STG (C3+C4), STG (no sub),
	// then Others, then Unassigned.
	const deptOrder: string[] = [
		'DHQ',
		'DMSP',
		'DCS',
		'STG — C1+C2',
		'STG — C3+C4',
		'STG',
		'Others',
		'Unassigned',
	];

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
						{list.map((u) => (
							<div key={u.id} className="row" onClick={() => setEditing(u)}>
								<span>
									{u.full_name}
									{u.personnel_type && (
										<span
											className="badge"
											style={{
												marginLeft: 6,
												background:
													u.personnel_type === 'NSF'
														? '#2e7d32'
														: u.personnel_type === 'NSF Officer'
															? '#b8860b'
															: '#5e35b1',
											}}
										>
											{u.personnel_type}
										</span>
									)}
								</span>
								<span className="muted">
									{u.user_role} · 🪙 {u.off_credits}
								</span>
							</div>
						))}
					</div>
				);
			})}

			{ordingSoon.length > 0 && (
				<>
					<h3 style={{ marginTop: 28 }}>Upcoming ORD</h3>
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
	const [supTid, setSupTid] = useState(user.superior_telegram_id ?? '');
	const [ordDate, setOrdDate] = useState(user.ord_date ?? '');
	const [department, setDepartment] = useState<string>(user.department ?? '');
	const [subDepartment, setSubDepartment] = useState<string>(user.sub_department ?? '');
	const [personnelType, setPersonnelType] = useState<string>(user.personnel_type ?? '');
	const [busy, setBusy] = useState(false);

	const canGrantSuperadmin = me.user_role === 'superadmin';

	function onDepartmentChange(next: string) {
		setDepartment(next);
		// Sub-department only meaningful for STG — clear it otherwise.
		if (next !== 'STG') setSubDepartment('');
	}

	async function save() {
		setBusy(true);
		try {
			const res = await api.post<{ ok: boolean; user: AdminUser }>('/api/admin/users', {
				id: user.id,
				full_name: name,
				user_role: role,
				superior_telegram_id: supTid || null,
				ord_date: ordDate || null,
				department: department || null,
				sub_department: department === 'STG' ? subDepartment || null : null,
				personnel_type: personnelType || null,
			});
			onSaved(res.user);
			WebApp.showAlert('Saved.');
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function del() {
		const ok = await confirmDialog(`Delete ${stripped}? This cannot be undone.`);
		if (!ok) return;
		setBusy(true);
		try {
			await api.post('/api/admin/users/delete', { id: user.id });
			onDeleted(user.id);
			WebApp.showAlert('Deleted.');
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3>Edit user</h3>
				<div className="muted">Telegram ID: {user.telegram_id} · 🪙 {user.off_credits} off credits</div>
				<label>Full name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
				<label>Personnel type
					<select value={personnelType} onChange={(e) => setPersonnelType(e.target.value)}>
						<option value="">— unspecified —</option>
						{PERSONNEL_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
					</select>
				</label>
				<label>Department
					<select value={department} onChange={(e) => onDepartmentChange(e.target.value)}>
						<option value="">— unassigned —</option>
						{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
					</select>
				</label>
				{department === 'STG' && (
					<label>STG sub-department
						<select value={subDepartment} onChange={(e) => setSubDepartment(e.target.value)}>
							<option value="">— select —</option>
							{STG_SUB_DEPARTMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
						</select>
					</label>
				)}
				<label>Role
					<select value={role} onChange={(e) => setRole(e.target.value as AdminUser['user_role'])}>
						<option value="user">user</option>
						<option value="admin">admin</option>
						{(canGrantSuperadmin || role === 'superadmin') && <option value="superadmin">superadmin</option>}
					</select>
				</label>
				<label>Superior's Telegram ID (optional)
					<input value={supTid} onChange={(e) => setSupTid(e.target.value)} placeholder="e.g. 123456789" />
				</label>
				<label>ORD date (optional)
					<input type="date" value={ordDate} onChange={(e) => setOrdDate(e.target.value)} />
				</label>
				<button className="btn" disabled={busy || !name.trim()} onClick={save}>
					{busy ? 'Saving…' : 'Save'}
				</button>
				{me.user_role === 'superadmin' && user.id !== me.id && (
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

	function refresh() {
		return api.get<Override[]>('/api/admin/overrides').then(setOverrides);
	}
	useEffect(() => {
		refresh().catch(console.error);
	}, []);

	async function remove(date: string) {
		const ok = await confirmDialog(`Remove override for ${date}?`);
		if (!ok) return;
		try {
			await apiDelete(`/api/admin/overrides?date=${date}`);
			await refresh();
			WebApp.showAlert('Removed.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<div>
			<p className="muted">Override the working-day rule for specific dates (e.g. weekend exercise → working).</p>
			{me.user_role === 'superadmin' && (
				<button className="btn" onClick={() => setShowAdd(true)}>+ Add override</button>
			)}

			{overrides.length === 0 ? (
				<p className="muted" style={{ marginTop: 12 }}>No overrides set.</p>
			) : (
				overrides.map((o) => (
					<div key={o.override_date} className="card">
						<div className="card-row">
							<span>
								<b>{o.override_date}</b> — {o.is_working_day === 1 ? '✅ Working' : '🚫 Non-working'}
							</span>
							{me.user_role === 'superadmin' && (
								<button className="btn-link danger" onClick={() => remove(o.override_date)}>Remove</button>
							)}
						</div>
						{o.reason && <div className="muted">{o.reason}</div>}
						<div className="muted">Set by {o.set_by_name ?? '?'} at {o.set_at}</div>
					</div>
				))
			)}

			{showAdd && <AddOverrideModal onClose={() => setShowAdd(false)} onDone={refresh} />}
		</div>
	);
}

function AddOverrideModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
	const [date, setDate] = useState('');
	const [isWorking, setIsWorking] = useState(true);
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!date) return;
		const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
		setIsWorking(dow === 0 || dow === 6);
	}, [date]);

	async function save() {
		setBusy(true);
		try {
			await api.post('/api/admin/overrides', {
				override_date: date,
				is_working_day: isWorking,
				reason: reason.trim() || null,
			});
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
				<h3>Add working-day override</h3>
				<label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
				<label>
					<div className="seg">
						<button className={isWorking ? 'active' : ''} onClick={() => setIsWorking(true)}>✅ Force working</button>
						<button className={!isWorking ? 'active' : ''} onClick={() => setIsWorking(false)}>🚫 Force non-working</button>
					</div>
				</label>
				<label>Reason
					<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Field exercise" />
				</label>
				<button className="btn" disabled={busy || !date} onClick={save}>
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
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
			WebApp.showAlert(msg);
		} catch (e) {
			const msg = `Failed: ${e instanceof Error ? e.message : String(e)}`;
			setLastReport(msg);
			WebApp.showAlert(msg);
		} finally {
			setBusy(false);
		}
	}

	async function confirmOne(date: string, action: 'confirm' | 'reject') {
		try {
			await api.post('/api/admin/holidays/confirm', { date, action });
			await refresh();
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
			WebApp.showAlert('Holiday added.');
		} catch (e) {
			setBusy(false);
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
