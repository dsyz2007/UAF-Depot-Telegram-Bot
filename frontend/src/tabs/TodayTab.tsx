import { useEffect, useState } from 'react';
import WebApp from '@twa-dev/sdk';
import { api, confirmDialog, type Me } from '../lib/api';
import { useFocusRefresh } from '../lib/useFocusRefresh';

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
	// New requests arrive as Telegram DMs; sync the inbox when the superior
	// returns to the app.
	useFocusRefresh(refresh);

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
							title={`Off requests (${data.offs.length})`}
							type="off"
							chip="Off"
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
							title={`Sick — RSI/RSO (${data.sick.length})`}
							type="sick"
							chip="Sick"
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
							title={`Off-credit grants (${data.grants.length})`}
							type="grant"
							chip="Credit"
							busy={busy}
							onApproveAll={() => act(data.grants.map((g) => ({ type: 'grant', id: g.id, action: 'approve' })), 'Approve all credits')}
							rows={data.grants.map((g) => ({
								id: g.id,
								main: `${g.full_name} · +${g.num_days} credit${g.num_days === 1 ? '' : 's'}`,
								sub: g.reason,
								onApprove: () => act([{ type: 'grant', id: g.id, action: 'approve' }], 'Approve'),
								onReject: () => act([{ type: 'grant', id: g.id, action: 'reject' }], 'Reject'),
							}))}
						/>
					)}
					{data.parade.length > 0 && (
						<ApprovalGroup
							title={`Late parade changes (${data.parade.length})`}
							type="parade"
							chip="Parade"
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
	type,
	chip,
	rows,
	busy,
	onApproveAll,
}: {
	title: string;
	type: ApprovalType;
	chip: string;
	busy: boolean;
	onApproveAll: () => void;
	rows: { id: number; main: string; sub: string; onApprove: () => void; onReject: () => void }[];
}) {
	const accent = type === 'grant' ? 'acc-grant' : `acc-${type}`;
	return (
		<div style={{ marginTop: 14 }}>
			<div className="card-row">
				<h4 className="section-title" style={{ margin: 0 }}>{title}</h4>
				{rows.length > 1 && (
					<button className="btn-link" disabled={busy} onClick={onApproveAll}>✅ Approve all</button>
				)}
			</div>
			{rows.map((r) => (
				<div key={r.id} className={`entry-card ${accent}`}>
					<div className="entry-head">
						<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
							<span className={`type-chip ${type}`}>{chip}</span>
							<span className="entry-title" style={{ fontSize: 14 }}>{r.main}</span>
						</span>
						<div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
							<button className="pill-btn approve" disabled={busy} onClick={r.onApprove}>✅</button>
							<button className="pill-btn reject" disabled={busy} onClick={r.onReject}>❌</button>
						</div>
					</div>
					{r.sub && <div className="entry-meta"><span>{r.sub}</span></div>}
				</div>
			))}
		</div>
	);
}
// ───────────────────────────────────────────────────────────────────────────

// ── Undo recently-approved sick cases + credit grants ──────────────────────
interface RecentPayload {
	offs: { id: number; full_name: string; startdate: string; enddate: string; days: number; approved_date: string | null }[];
	sick: { id: number; full_name: string; case_type: string; reportsick_status: string; approved_at: string | null; updated_status: string | null }[];
	grants: { id: number; full_name: string; num_days: number; reason: string; approved_at: string | null }[];
}

function RecentApprovals() {
	const [data, setData] = useState<RecentPayload | null>(null);
	const [busy, setBusy] = useState(false);

	function refresh() {
		return api.get<RecentPayload>('/api/approvals/recent').then(setData).catch(console.error);
	}
	useEffect(() => {
		refresh();
	}, []);
	useFocusRefresh(refresh);

	async function undo(kind: 'off' | 'sick' | 'grant', id: number, label: string) {
		const ok = await confirmDialog(`Undo this ${label}? This reverses the approval.`);
		if (!ok) return;
		setBusy(true);
		try {
			const path = kind === 'sick' ? '/api/sick/revert' : kind === 'grant' ? '/api/off/grant/revert' : '/api/off/revert';
			await api.post(path, { id });
			await refresh();
			WebApp.showAlert('Reverted.');
		} catch (e) {
			WebApp.showAlert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	if (!data) return null;
	if (data.offs.length + data.sick.length + data.grants.length === 0) return null;

	return (
		<div style={{ marginBottom: 18 }}>
			<h3>↩ Undo recent approvals</h3>
			<p className="muted" style={{ marginTop: -4 }}>Approvals you made in the last 14 days. Undoing sends the request back to Pending approvals (credits are returned until it's approved again).</p>
			{data.offs.map((o) => (
				<div key={`o${o.id}`} className="entry-card acc-off">
					<div className="entry-head">
						<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
							<span className="type-chip off">Off</span>
							<span className="entry-title" style={{ fontSize: 14 }}>{o.full_name}</span>
						</span>
						<button className="btn-link danger" disabled={busy} onClick={() => undo('off', o.id, 'off approval')}>↩ Undo</button>
					</div>
					<div className="entry-meta"><span>{o.startdate === o.enddate ? o.startdate : `${o.startdate} → ${o.enddate}`}</span><span>🗓 {o.days} day{o.days === 1 ? '' : 's'}</span></div>
				</div>
			))}
			{data.sick.map((s) => (
				<div key={`s${s.id}`} className="entry-card acc-sick">
					<div className="entry-head">
						<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
							<span className="type-chip sick">Sick</span>
							<span className="entry-title" style={{ fontSize: 14 }}>{s.full_name} · {s.case_type}</span>
						</span>
						<button className="btn-link danger" disabled={busy} onClick={() => undo('sick', s.id, `${s.case_type} approval`)}>↩ Undo</button>
					</div>
					<div className="entry-meta"><span>{s.reportsick_status.replace(/_/g, ' ')}</span>{s.updated_status && <span>{s.updated_status}</span>}</div>
				</div>
			))}
			{data.grants.map((g) => (
				<div key={`g${g.id}`} className="entry-card acc-grant">
					<div className="entry-head">
						<span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
							<span className="type-chip grant">Credit</span>
							<span className="entry-title" style={{ fontSize: 14 }}>{g.full_name} · +{g.num_days} credit{g.num_days === 1 ? '' : 's'}</span>
						</span>
						<button className="btn-link danger" disabled={busy} onClick={() => undo('grant', g.id, 'credit grant')}>↩ Undo</button>
					</div>
					{g.reason && <div className="entry-meta"><span>{g.reason}</span></div>}
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

	function loadToday() {
		return api
			.get<TodayPayload>('/api/today')
			.then(setData)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}
	useEffect(() => {
		loadToday();
	}, []);
	useFocusRefresh(loadToday);

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
			<RecentApprovals />

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
