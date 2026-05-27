// Today dashboard for admin/superadmin: who's on off / open sick case / pending approval today.

import { json, type AuthedContext } from './router';
import { sgtToday } from '../holidays';

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

export async function handleToday(actx: AuthedContext): Promise<Response> {
	const { request, env, user } = actx;
	if (user.user_role !== 'admin' && user.user_role !== 'superadmin') {
		return json({ error: 'forbidden' }, { status: 403 });
	}
	if (request.method !== 'GET') return json({ error: 'method' }, { status: 405 });

	const today = sgtToday();

	const offs = await env.depot_db
		.prepare(
			`SELECT o.id, u.full_name, o.startdate, o.enddate, o.reason,
			        a.full_name AS approved_by_name
			 FROM off_requests o
			 JOIN users u ON u.id = o.user_id
			 LEFT JOIN users a ON a.id = o.approved_by
			 WHERE o.off_status = 'approved'
			   AND o.startdate <= ? AND o.enddate >= ?
			 ORDER BY u.full_name`,
		)
		.bind(today, today)
		.all<OffRow>();

	const sickOpen = await env.depot_db
		.prepare(
			`SELECT s.id, u.full_name, s.case_type, s.reportsick_status, s.created_at,
			        s.approved_at, s.num_of_mc_days, s.mc_start_date, s.mc_end_date,
			        s.medicine_prescribed
			 FROM sick_cases s
			 JOIN users u ON u.id = s.user_id
			 WHERE s.reportsick_status IN ('approved','updated','flagged')
			   AND (s.mc_end_date IS NULL OR s.mc_end_date >= ?)
			 ORDER BY s.created_at DESC`,
		)
		.bind(today)
		.all<SickRow>();

	const sickPending = await env.depot_db
		.prepare(
			`SELECT s.id, u.full_name, s.case_type, s.reportsick_status, s.created_at,
			        s.approved_at, s.num_of_mc_days, s.mc_start_date, s.mc_end_date,
			        s.medicine_prescribed
			 FROM sick_cases s
			 JOIN users u ON u.id = s.user_id
			 WHERE s.reportsick_status = 'pending_superior'
			 ORDER BY s.created_at DESC`,
		)
		.all<SickRow>();

	const offPending = await env.depot_db
		.prepare(
			`SELECT o.id, u.full_name, o.startdate, o.enddate, o.reason,
			        NULL AS approved_by_name
			 FROM off_requests o
			 JOIN users u ON u.id = o.user_id
			 WHERE o.off_status = 'pending'
			 ORDER BY o.created_at DESC`,
		)
		.all<OffRow>();

	return json({
		today,
		offs_today: offs.results ?? [],
		sick_open: sickOpen.results ?? [],
		sick_pending: sickPending.results ?? [],
		offs_pending: offPending.results ?? [],
	});
}
