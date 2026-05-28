import { json, type AuthedContext } from './router';

export async function handleMe({ user }: AuthedContext): Promise<Response> {
	const isPending = user.full_name.startsWith('PENDING:');
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
		pending: isPending,
	});
}
