import { useEffect, useState } from 'react';
import { api, type Me } from './lib/api';
import { OffTab } from './tabs/OffTab';
import { SickTab } from './tabs/SickTab';
import { ParadeTab } from './tabs/ParadeTab';
import { AdminTab } from './tabs/AdminTab';
import { TodayTab } from './tabs/TodayTab';
import './app.css';

type TabKey = 'today' | 'off' | 'sick' | 'parade' | 'admin';

export default function App() {
	const [me, setMe] = useState<Me | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<TabKey>('parade');

	useEffect(() => {
		api
			.get<Me>('/api/me')
			.then(setMe)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	if (error) return <Centered>⚠ {error}</Centered>;
	if (!me) return <Centered>Loading…</Centered>;

	if (me.pending) {
		return (
			<Centered>
				<h2>Account pending</h2>
				<p>{me.full_name}, your account is awaiting admin approval.</p>
			</Centered>
		);
	}

	const isAdminish = me.user_role === 'admin' || me.user_role === 'superadmin';
	const tabs: { key: TabKey; label: string; show: boolean }[] = [
		{ key: 'parade', label: '🪖 Parade', show: true },
		{ key: 'off', label: '📅 Off', show: true },
		{ key: 'sick', label: '🤒 Sick', show: true },
		{ key: 'today', label: '📊 Today', show: isAdminish },
		{ key: 'admin', label: '⚙ Admin', show: isAdminish },
	];

	return (
		<div className="app">
			<header className="appbar">
				<span className="brand">Depot</span>
				<span className="username">{me.full_name} · {roleLabel(me.user_role)}</span>
			</header>

			<main className="content">
				{tab === 'today' && isAdminish && <TodayTab me={me} />}
				{tab === 'off' && <OffTab me={me} />}
				{tab === 'sick' && <SickTab me={me} />}
				{tab === 'parade' && <ParadeTab me={me} />}
				{tab === 'admin' && isAdminish && <AdminTab me={me} />}
			</main>

			<nav className="tabbar">
				{tabs
					.filter((t) => t.show)
					.map((t) => (
						<button key={t.key} className={t.key === tab ? 'active' : ''} onClick={() => setTab(t.key)}>
							{t.label}
						</button>
					))}
			</nav>
		</div>
	);
}

function roleLabel(r: Me['user_role']): string {
	switch (r) {
		case 'user':
			return 'User';
		case 'admin':
			return 'Admin';
		case 'superadmin':
			return 'Superadmin';
	}
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="centered">{children}</div>;
}
