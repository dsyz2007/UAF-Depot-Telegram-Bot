import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api, confirmDialog, type Me } from '../lib/api';

// ── Approvals inbox ────────────────────────────────────────────────────────
interface ApprovalsPayload {
	offs: { id: number; full_name: string; startdate: string; enddate: string; reason: string; days: number }[];
	sick: { id: number; full_name: string; case_type: string; created_at: string }[];
	grants: { id: number; full_name: string; num_days: number; reason: string }[];
	parade: { id: number; full_name: string; parade_state_date: string; period: string; new_status: string; new_reason: string | null }[];
}
type ApprovalType = 'off' | 'sick' | 'grant' | 'parade';
interface ActionItem {
	type: ApprovalType;
	id: number;
	action: 'approve' | 'reject';
}

function ApprovalsInbox() {
	const [data, setData] = useState<ApprovalsPayload | null>(null);
	const [busy, setBusy] = useState(false);

	function refresh() {
		return api.get<ApprovalsPayload>('/api/approvals').then(setData).catch(console.error);
	}
	useEffect(() => {
		refresh();
	}, []);

	async function act(actions: ActionItem[], label: string) {
		if (actions.length === 0) return;
		if (actions.length > 1) {
			const ok = await confirmDialog(`${label} ${actions.length} item(s)?`);
			if (!ok) return;
		}
		setBusy(true);
		try {
			const res = await api.post<{ done: number }>('/api/approvals/act', { actions });
			await refresh();
			WebApp.showAlert(`${label}: ${res.done} done.`);
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (!data) return <div className="muted">Loading approvals…</div>;
	const total = data.offs.length + data.sick.length + data.grants.length + data.parade.length;

	return (
		<div style={{ marginBottom: 18 }}>
			<h3>✅ Pending approvals ({total})</h3>
			{total === 0 ? (
				<p className="muted">Nothing waiting on you. 🎉</p>
			) : (
				<>
					{data.offs.length > 0 && (
						<ApprovalGroup
							title={`Offs (${data.offs.length})`}
							busy={busy}
							onApproveAll={() => act(data.offs.map((o) => ({ type: 'off', id: o.id, action: 'approve' })), 'Approve all offs')}
							rows={data.offs.map((o) => ({
								id: o.id,
								main: `${o.full_name} · ${o.startdate === o.enddate ? o.startdate : `${o.startdate}→${o.enddate}`} (${o.days}d)`,
								sub: o.reason,
								onApprove: () => act([{ type: 'off', id: o.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'off', id: o.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.sick.length > 0 && (
						<ApprovalGroup
							title={`Sick (${data.sick.length})`}
							busy={busy}
							onApproveAll={() => act(data.sick.map((s) => ({ type: 'sick', id: s.id, action: 'approve' })), 'Approve all sick')}
							rows={data.sick.map((s) => ({
								id: s.id,
								main: `${s.full_name} · ${s.case_type}`,
								sub: s.created_at,
								onApprove: () => act([{ type: 'sick', id: s.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'sick', id: s.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.grants.length > 0 && (
						<ApprovalGroup
							title={`Off credits (${data.grants.length})`}
							busy={busy}
							onApproveAll={() => act(data.grants.map((g) => ({ type: 'grant', id: g.id, action: 'approve' })), 'Approve all credits')}
							rows={data.grants.map((g) => ({
								id: g.id,
								main: `${g.full_name} · +${g.num_days}d`,
								sub: g.reason,
								onApprove: () => act([{ type: 'grant', id: g.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'grant', id: g.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.parade.length > 0 && (
						<ApprovalGroup
							title={`Parade changes (${data.parade.length})`}
							busy={busy}
							onApproveAll={() => act(data.parade.map((p) => ({ type: 'parade', id: p.id, action: 'approve' })), 'Approve all parade changes')}
							rows={data.parade.map((p) => ({
								id: p.id,
								main: `${p.full_name} · ${p.parade_state_date} ${p.period} → ${p.new_status}`,
								sub: p.new_reason ?? '',
								onApprove: () => act([{ type: 'parade', id: p.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'parade', id: p.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
				</>
			)}
		</div>
	);
}

function ApprovalGroup({
	title,
	rows,
	busy,
	onApproveAll,
}: {
	title: string;
	busy: boolean;
	onApproveAll: () => void;
	rows: { id: number; main: string; sub: string; onApprove: () => void; onReject: () => void }[];
}) {
	return (
		<div style={{ marginTop: 12 }}>
			<div className="card-row">
				<h4 className="section-title" style={{ margin: 0 }}>{title}</h4>
				{rows.length > 1 && (
					<button className="btn-link" disabled={busy} onClick={onApproveAll}>✅ Approve all</button>
				)}
			</div>
			{rows.map((r) => (
				<div key={r.id} className="card">
					<div className="card-row">
						<div style={{ minWidth: 0 }}>
							<div>{r.main}</div>
							{r.sub && <div className="muted">{r.sub}</div>}
						</div>
						<div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
							<button className="btn-link" disabled={busy} onClick={r.onApprove}>✅</button>
							<button className="btn-link danger" disabled={busy} onClick={r.onReject}>❌</button>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
// ───────────────────────────────────────────────────────────────────────────

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
			<ApprovalsInbox />

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
							{s.approved_at && <div className="muted">Approved {s.approved_at}</div>}
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
