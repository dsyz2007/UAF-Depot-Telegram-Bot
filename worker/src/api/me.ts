import { json, type AuthedContext } from './router';

export async function handleMe({ env, user }: AuthedContext): Promise<Response> {
	const isPending = user.full_name.startsWith('PENDING:');

	// is_approver: admins/superadmins, or anyone holding a department appointment
	// (WOIC/2IC/PC). Drives visibility of the Approvals inbox (Today tab).
	const isApprover = user.user_role === 'admin' || user.user_role === 'superadmin' || !!user.appointment;

	return json({
		id: user.id,
		telegram_id: user.telegram_id,
		full_name: isPending ? user.full_name.slice('PENDING:'.length) : user.full_name,
		user_role: user.user_role,
		ord_date: user.ord_date,
		department: user.department,
		sub_department: user.sub_department,
		personnel_type: user.personnel_type,
		appointment: user.appointment,
		self_managed: user.self_managed,
		off_credits: user.off_credits,
		is_approver: isApprover,
		pending: isPending,
	});
}
