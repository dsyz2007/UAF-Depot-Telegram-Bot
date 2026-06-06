// Helpers for the "up to two superiors" model. A user may have a primary and a
// secondary superior; EITHER may approve their requests. When neither is set we
// fall back to the first superadmin so a request is never orphaned.

interface HasSuperiors {
	superior_telegram_id: string | null;
	superior_telegram_id_2?: string | null;
}

// Distinct, non-empty superior telegram ids for a user (order: primary, then
// secondary). Does NOT apply the superadmin fallback — use approverTidsFor for
// the routing decision.
export function superiorTidsOf(u: HasSuperiors): string[] {
	const raw = [u.superior_telegram_id, u.superior_telegram_id_2 ?? null].filter((t): t is string => !!t);
	return [...new Set(raw)];
}

export async function firstSuperadminTid(env: Env): Promise<string | null> {
	const a = await env.depot_db
		.prepare(`SELECT telegram_id FROM users WHERE user_role = 'superadmin' ORDER BY id LIMIT 1`)
		.first<{ telegram_id: string }>();
	return a?.telegram_id ?? null;
}

// Chat ids that should receive an approval request for this user: their distinct
// superiors, or the first superadmin if none are set.
export async function approverTidsFor(env: Env, u: HasSuperiors): Promise<string[]> {
	const tids = superiorTidsOf(u);
	if (tids.length) return tids;
	const fb = await firstSuperadminTid(env);
	return fb ? [fb] : [];
}
