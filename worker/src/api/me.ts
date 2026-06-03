import { json, type AuthedContext } from './router';

export async function handleMe({ env, user }: AuthedContext): Promise<Response> {
	const isPending = user.full_name.startsWith('PENDING:');

	// is_approver: someone reports to this user, OR they're an admin/superadmin.
	// Drives visibility of the Approvals inbox (Today tab).
	let isApprover = user.user_role === 'admin' || user.user_role === 'superadmin';
	if (!isApprover) {
		const r = await env.depot_db
			.prepare(`SELECT 1 AS one FROM users WHERE superior_telegram_id = ? LIMIT 1`)
			.bind(user.telegram_id)
			.first<{ one: number }>();
		isApprover = !!r;
	}

	return json({
		id: user.id,
		telegram_id: user.telegram_id,
		full_name: isPending ? user.full_name.slice('PENDING:'.length) : user.full_name,
		user_role: user.user_role,
		superior_telegram_id: user.superior_telegram_id,
		ord_date: user.ord_date,
		department: user.department,
		sub_department: user.sub_department,
		personnel_type: user.personnel_type,
		off_credits: user.off_credits,
		is_approver: isApprover,
		pending: isPending,
	});
}
