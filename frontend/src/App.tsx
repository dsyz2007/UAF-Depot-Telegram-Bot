import { useEffect, useState } from 'react';
import { api, type Me, type RouteAction } from './lib/api';
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
	const [tab, setTab] = useState<TabKey>(() => {
		// Bot reminder buttons deep-link with ?tab=parade|sick|off so the user
		// lands on the right page immediately.
		const requested = new URLSearchParams(window.location.search).get('tab');
		if (requested === 'parade' || requested === 'sick' || requested === 'off' || requested === 'today' || requested === 'admin') {
			return requested;
		}
		return 'parade';
	});
	// Set by the Parade tab when a user marks OFF/RSI/RSO without applying; the
	// destination tab consumes it (opens the apply form) then clears it.
	const [routeAction, setRouteAction] = useState<RouteAction | null>(null);

	function handleRoute(action: RouteAction) {
		setRouteAction(action);
		setTab(action.kind === 'off' ? 'off' : 'sick');
	}

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
	// Pending tab is shown to everyone: approvers manage their inbox, and normal
	// users use it to track their OWN pending + approved/rejected requests.
	const showToday = true;
	const tabs: { key: TabKey; label: string; show: boolean }[] = [
		{ key: 'parade', label: '🪖 Parade', show: true },
		{ key: 'off', label: '📅 Off', show: true },
		{ key: 'sick', label: '🤒 Sick', show: true },
		{ key: 'today', label: '🗂 Pending', show: showToday },
		{ key: 'admin', label: '⚙ Admin', show: isAdminish },
	];

	return (
		<div className="app">
			<header className="appbar">
				<span className="brand">UAF App</span>
				<span className="username">{me.full_name} · {roleLabel(me.user_role)}</span>
			</header>

			<main className="content">
				{tab === 'today' && showToday && <TodayTab me={me} />}
				{tab === 'off' && (
					<OffTab
						me={me}
						initialOff={
							routeAction?.kind === 'off'
								? { start: routeAction.start, end: routeAction.end, period: routeAction.period, reason: routeAction.reason }
								: null
						}
						onConsumed={() => setRouteAction(null)}
					/>
				)}
				{tab === 'sick' && (
					<SickTab
						me={me}
						initialSick={routeAction?.kind === 'sick' ? routeAction.sickType : null}
						initialReason={routeAction?.kind === 'sick' ? routeAction.reason : undefined}
						onConsumed={() => setRouteAction(null)}
					/>
				)}
				{tab === 'parade' && <ParadeTab me={me} onRoute={handleRoute} />}
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
