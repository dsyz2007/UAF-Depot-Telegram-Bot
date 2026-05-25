import { useEffect, useState } from 'react';
import { api, type Me } from './lib/api';
import { OffTab } from './tabs/OffTab';
import { SickTab } from './tabs/SickTab';
import { ParadeTab } from './tabs/ParadeTab';
import { AdminTab } from './tabs/AdminTab';
import './app.css';

type TabKey = 'off' | 'sick' | 'parade' | 'admin';

export default function App() {
	const [me, setMe] = useState<Me | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<TabKey>('off');

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

	const tabs: { key: TabKey; label: string; show: boolean }[] = [
		{ key: 'off', label: 'Off', show: true },
		{ key: 'sick', label: 'Sick', show: true },
		{ key: 'parade', label: 'Parade', show: true },
		{ key: 'admin', label: 'Admin', show: me.user_role === 'admin' },
	];

	return (
		<div className="app">
			<header className="appbar">
				<span className="brand">Depot</span>
				<span className="username">{me.full_name}</span>
			</header>

			<main className="content">
				{tab === 'off' && <OffTab me={me} />}
				{tab === 'sick' && <SickTab me={me} />}
				{tab === 'parade' && <ParadeTab me={me} />}
				{tab === 'admin' && me.user_role === 'admin' && <AdminTab />}
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

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="centered">{children}</div>;
}
