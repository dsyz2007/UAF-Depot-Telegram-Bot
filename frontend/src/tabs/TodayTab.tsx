import { useEffect, useState } from 'react';
import { api, type Me } from '../lib/api';

interface OffRow {
	id: number;
	full_name: string;
	startdate: string;
	enddate: string;
	reason: string;
	approved_by_name: string | null;
}

interface SickRow {
	id: number;
	full_name: string;
	case_type: 'RSI' | 'RSO';
	reportsick_status: string;
	created_at: string;
	approved_at: string | null;
	num_of_mc_days: number | null;
	mc_start_date: string | null;
	mc_end_date: string | null;
	medicine_prescribed: string | null;
}

interface TodayPayload {
	today: string;
	offs_today: OffRow[];
	sick_open: SickRow[];
	sick_pending: SickRow[];
	offs_pending: OffRow[];
}

export function TodayTab(_: { me: Me }) {
	const [data, setData] = useState<TodayPayload | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api
			.get<TodayPayload>('/api/today')
			.then(setData)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	if (error) {
		return (
			<div className="card" style={{ borderLeft: '4px solid var(--depot-danger)' }}>
				<h3>⚠ Couldn't load today</h3>
				<p className="muted">{error}</p>
			</div>
		);
	}
	if (!data) return <div className="muted">Loading…</div>;

	return (
		<div>
			<h3>📊 Today — {data.today}</h3>

			<Section title={`On Off (${data.offs_today.length})`} accent="success">
				{data.offs_today.length === 0 ? (
					<p className="muted">Nobody on approved off today.</p>
				) : (
					data.offs_today.map((o) => (
						<div key={o.id} className="card">
							<div className="card-row">
								<b>{o.full_name}</b>
								<span className="muted">{rangeOrSingle(o.startdate, o.enddate)}</span>
							</div>
							<div className="muted">{o.reason}</div>
							{o.approved_by_name && <div className="muted">Approved by {o.approved_by_name}</div>}
						</div>
					))
				)}
			</Section>

			<Section title={`Open Sick Cases (${data.sick_open.length})`} accent="danger">
				{data.sick_open.length === 0 ? (
					<p className="muted">No open RSI/RSO cases.</p>
				) : (
					data.sick_open.map((s) => (
						<div key={s.id} className="card">
							<div className="card-row">
								<b>{s.full_name}</b>
								<span className={`badge status-${s.reportsick_status}`}>
									{s.case_type} · {s.reportsick_status.replace(/_/g, ' ')}
								</span>
							</div>
							{s.num_of_mc_days != null && s.num_of_mc_days >= 1 && (
								<div className="muted">
									{s.num_of_mc_days} day(s) MC — {s.mc_start_date} → {s.mc_end_date}
								</div>
							)}
							{s.medicine_prescribed && <div className="muted">💊 {s.medicine_prescribed}</div>}
							{s.approved_at && <div className="muted">Approved {s.approved_at}</div>}
						</div>
					))
				)}
			</Section>

			<Section title={`Pending Approval — Sick (${data.sick_pending.length})`} accent="warning">
				{data.sick_pending.length === 0 ? (
					<p className="muted">No pending sick requests.</p>
				) : (
					data.sick_pending.map((s) => (
						<div key={s.id} className="card">
							<div className="card-row">
								<b>{s.full_name}</b>
								<span className="badge status-pending_superior">{s.case_type}</span>
							</div>
							<div className="muted">Submitted {s.created_at}</div>
						</div>
					))
				)}
			</Section>

			<Section title={`Pending Approval — Off (${data.offs_pending.length})`} accent="warning">
				{data.offs_pending.length === 0 ? (
					<p className="muted">No pending off requests.</p>
				) : (
					data.offs_pending.map((o) => (
						<div key={o.id} className="card">
							<div className="card-row">
								<b>{o.full_name}</b>
								<span className="muted">{rangeOrSingle(o.startdate, o.enddate)}</span>
							</div>
							<div className="muted">{o.reason}</div>
						</div>
					))
				)}
			</Section>
		</div>
	);
}

function Section({ title, accent, children }: { title: string; accent: 'success' | 'warning' | 'danger'; children: React.ReactNode }) {
	const color = accent === 'success' ? 'var(--depot-success)' : accent === 'warning' ? 'var(--depot-warning)' : 'var(--depot-danger)';
	return (
		<div style={{ marginTop: 18 }}>
			<h4 style={{ margin: '0 0 8px', borderLeft: `4px solid ${color}`, paddingLeft: 8 }}>{title}</h4>
			{children}
		</div>
	);
}

function rangeOrSingle(start: string, end: string): string {
	return start === end ? start : `${start} → ${end}`;
}
