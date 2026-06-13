// Approver resolution for the department-appointment model.
//
// A user's "unit" is their department. A user's approvers are everyone in the
// SAME unit holding an appointment (WOIC / 2IC / PC). If their unit has no
// appointment-holders, or they have no department, approval falls back to ALL
// superadmins. self_managed users have no approver (they auto-approve).
// (The sub_department column is legacy — STG was merged into one DSP — but the
// IFNULL(...) matching below keeps working since it's null for all DSP users.)

// Same-unit test: matching department (+ legacy sub-section). Used for revert
// authorisation (an appointment-holder may undo a peer's approval in their unit).
export function sameUnit(
	u: { department: string | null; sub_department: string | null },
	dept: string | null,
	sub: string | null,
): boolean {
	return u.department === dept && (u.sub_department ?? '') === (sub ?? '');
}

interface ApproverTarget {
	id: number;
	department: string | null;
	sub_department: string | null;
	self_managed?: number | boolean | null;
}

export async function allSuperadminTids(env: Env): Promise<string[]> {
	const { results } = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin'`)
		.all<{ telegram_id: string }>();
	return [...new Set((results ?? []).map((r) => r.telegram_id))];
}

// Telegram ids that should receive (and may action) an approval request for this
// user. Empty for self-managed users.
export async function approverTidsFor(env: Env, u: ApproverTarget): Promise<string[]> {
	if (u.self_managed) return [];
	if (u.department) {
		const { results } = await env.depot_db
			.prepare(
				`SELECT telegram_id FROM users
				 WHERE department = ? AND IFNULL(sub_department,'') = IFNULL(?, '')
				   AND appointment IN ('WOIC','2IC','PC')
				   AND id != ? AND full_name NOT LIKE 'PENDING:%'`,
			)
			.bind(u.department, u.sub_department ?? null, u.id)
			.all<{ telegram_id: string }>();
		const tids = [...new Set((results ?? []).map((r) => r.telegram_id))];
		if (tids.length) return tids;
	}
	// No department, or no appointment-holders in the unit → all superadmins.
	return allSuperadminTids(env);
}

// True if `approver` may approve a request from a user in unit (reqDepartment,
// reqSub). Mirrors approverTidsFor's routing so the inbox/auth stays consistent.
export async function canApprove(
	env: Env,
	approver: { id: number; user_role: string; appointment: string | null; department: string | null; sub_department: string | null },
	reqDepartment: string | null,
	reqSub: string | null,
	requesterId: number,
): Promise<boolean> {
	const isSuper = approver.user_role === 'superadmin';
	const appointed = !!approver.appointment;
	const sameUnit =
		!!reqDepartment &&
		reqDepartment === approver.department &&
		(approver.sub_department ?? '') === (reqSub ?? '');
	if ((isSuper || appointed) && sameUnit) return true;
	if (isSuper) {
		if (!reqDepartment) return true; // no-department orphan → all superadmins
		// A unit with no OTHER active appointment-holder also falls back to all
		// superadmins — this probe must mirror approverTidsFor exactly (exclude the
		// requester + PENDING) or the DM target and inbox visibility disagree.
		const holder = await env.depot_db
			.prepare(
				`SELECT 1 FROM users WHERE department = ? AND IFNULL(sub_department,'') = IFNULL(?, '')
				   AND appointment IN ('WOIC','2IC','PC') AND id != ? AND full_name NOT LIKE 'PENDING:%' LIMIT 1`,
			)
			.bind(reqDepartment, reqSub ?? null, requesterId)
			.first();
		if (!holder) return true;
	}
	return false;
}
