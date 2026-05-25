import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api } from '../lib/api';

interface AdminUser {
	id: number;
	telegram_id: string;
	full_name: string;
	user_role: 'user' | 'superior' | 'admin';
	superior_telegram_id: string | null;
	created_at: string;
}

export function AdminTab() {
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [editing, setEditing] = useState<AdminUser | null>(null);

	function refresh() {
		api.get<AdminUser[]>('/api/admin/users').then(setUsers).catch(console.error);
	}
	useEffect(refresh, []);

	const pending = users.filter((u) => u.full_name.startsWith('PENDING:'));
	const active = users.filter((u) => !u.full_name.startsWith('PENDING:'));

	return (
		<div>
			<h3>Pending ({pending.length})</h3>
			{pending.map((u) => (
				<div key={u.id} className="row" onClick={() => setEditing(u)}>
					<span>{u.full_name.slice('PENDING:'.length)}</span>
					<span className="muted">{u.telegram_id}</span>
				</div>
			))}
			<h3 style={{ marginTop: 24 }}>Active ({active.length})</h3>
			{active.map((u) => (
				<div key={u.id} className="row" onClick={() => setEditing(u)}>
					<span>{u.full_name}</span>
					<span className="muted">{u.user_role}</span>
				</div>
			))}
			{editing && <EditModal user={editing} onClose={() => setEditing(null)} onDone={refresh} />}
		</div>
	);
}

function EditModal({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
	const stripped = user.full_name.startsWith('PENDING:') ? user.full_name.slice('PENDING:'.length) : user.full_name;
	const [name, setName] = useState(stripped);
	const [role, setRole] = useState<AdminUser['user_role']>(user.user_role);
	const [supTid, setSupTid] = useState(user.superior_telegram_id ?? '');
	const [busy, setBusy] = useState(false);

	async function save() {
		setBusy(true);
		try {
			await api.post('/api/admin/users', {
				id: user.id,
				full_name: name,
				user_role: role,
				superior_telegram_id: supTid || null,
			});
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
				<h3>Edit user</h3>
				<div className="muted">Telegram ID: {user.telegram_id}</div>
				<label>Full name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
				<label>Role
					<select value={role} onChange={(e) => setRole(e.target.value as AdminUser['user_role'])}>
						<option value="user">user</option>
						<option value="superior">superior</option>
						<option value="admin">admin</option>
					</select>
				</label>
				<label>Superior's Telegram ID (optional)
					<input value={supTid} onChange={(e) => setSupTid(e.target.value)} placeholder="e.g. 123456789" />
				</label>
				<button className="btn" disabled={busy || !name.trim()} onClick={save}>
					{busy ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	);
}
