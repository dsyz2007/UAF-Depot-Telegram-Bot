// Single source of truth for cross-module types.

export {};

declare global {
	interface Env {
		BOT_TOKEN: string;
		WEBHOOK_SECRET: string;
	}
}

export type UserRole = 'user' | 'admin' | 'superadmin';

export type Department = 'DHQ' | 'DMSP' | 'DCS' | 'STG' | 'Others';
export const DEPARTMENTS: readonly Department[] = ['DHQ', 'DMSP', 'DCS', 'STG', 'Others'];

// Only meaningful when department = 'STG'.
export type StgSubDepartment = 'C1+C2' | 'C3+C4';
export const STG_SUB_DEPARTMENTS: readonly StgSubDepartment[] = ['C1+C2', 'C3+C4'];

export type PersonnelType = 'NSF' | 'NSF Officer' | 'Regular';
export const PERSONNEL_TYPES: readonly PersonnelType[] = ['NSF', 'NSF Officer', 'Regular'];

export interface DbUser {
	id: number;
	telegram_id: string;
	full_name: string;
	user_role: UserRole;
	superior_telegram_id: string | null;
	// Optional second superior — either superior can approve this user's requests.
	superior_telegram_id_2: string | null;
	ord_date: string | null;
	department: Department | null;
	sub_department: StgSubDepartment | null;
	personnel_type: PersonnelType | null;
	off_credits: number;
	created_at: string;
}

export interface TgWebAppUser {
	id: number;
	first_name?: string;
	last_name?: string;
	username?: string;
	language_code?: string;
}

// Parade-state options shown in the UI dropdown. Order matters — drives
// dropdown order, legend order, and copy-state grouping order.
export type ParadeStatus =
	| 'Present'
	| 'Course'
	| 'AO'
	| 'MA'
	| 'MC'
	| 'RSO'
	| 'RSI'
	| 'OFF'
	| 'LL'
	| 'OL'
	| 'Leave (Others)'
	| 'Others'
	| 'Incoming Opr'
	| 'Outgoing Opr'
	| 'Incoming ADS'
	| 'Outgoing ADS'
	| 'Incoming DS'
	| 'Outgoing DS'
	| 'Incoming DO'
	| 'Outgoing DO'
	| 'NTM Swap-In'
	| 'NTM Swap-Out';

// Order: the two "Others" sit just above the Incoming/Outgoing duty block and
// below everything else; the NTM Swap tags sit at the very end.
export const PARADE_STATUSES: readonly ParadeStatus[] = [
	'Present',
	'Course',
	'AO',
	'MA',
	'MC',
	'RSO',
	'RSI',
	'OFF',
	'LL',
	'OL',
	'Leave (Others)',
	'Others',
	'Incoming Opr',
	'Outgoing Opr',
	'Incoming ADS',
	'Outgoing ADS',
	'Incoming DS',
	'Outgoing DS',
	'Incoming DO',
	'Outgoing DO',
	'NTM Swap-In',
	'NTM Swap-Out',
];

// Long-form labels for the legend / dropdown tooltips.
export const PARADE_STATUS_LABELS: Record<ParadeStatus, string> = {
	Present: 'Present',
	Course: 'Course',
	AO: 'AO (Attached-Out)',
	MA: 'MA (Medical Appointment)',
	MC: 'MC',
	RSO: 'RSO',
	RSI: 'RSI',
	OFF: 'OFF',
	LL: 'LL (Local Leave)',
	OL: 'OL (Overseas Leave)',
	'Incoming Opr': 'Incoming Opr (Incoming Operator)',
	'Outgoing Opr': 'Outgoing Opr (Outgoing Operator)',
	'Incoming ADS': 'Incoming ADS',
	'Outgoing ADS': 'Outgoing ADS',
	'Incoming DS': 'Incoming DS',
	'Outgoing DS': 'Outgoing DS',
	'Incoming DO': 'Incoming DO',
	'Outgoing DO': 'Outgoing DO',
	'Leave (Others)': 'Leave (Others)',
	Others: 'Others',
	'NTM Swap-In': 'NTM Swap-In',
	'NTM Swap-Out': 'NTM Swap-Out',
};

// Statuses that require a reason when submitting parade state.
export const REASON_REQUIRED_STATUSES: readonly ParadeStatus[] = [
	'Course',
	'AO',
	'MA',
	'MC',
	'RSO',
	'RSI',
	'Leave (Others)',
	'Others',
];

// A user is "self-managed" — bypassing every approval step — when they have at
// least one superior set and ALL of their superiors are themselves. If a real
// (other) second superior exists, that superior can approve, so NOT self-managed.
export function isSelfManaged(u: {
	telegram_id: string;
	superior_telegram_id: string | null;
	superior_telegram_id_2?: string | null;
}): boolean {
	const sups = [u.superior_telegram_id, u.superior_telegram_id_2 ?? null].filter((t): t is string => !!t);
	return sups.length > 0 && sups.every((t) => t === u.telegram_id);
}

export function dayCountInclusive(startdate: string, enddate: string): number {
	const a = new Date(`${startdate}T00:00:00Z`).getTime();
	const b = new Date(`${enddate}T00:00:00Z`).getTime();
	return Math.floor((b - a) / 86_400_000) + 1;
}
