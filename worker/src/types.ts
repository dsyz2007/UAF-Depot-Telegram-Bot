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
	| 'Leave (Others)';

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
	'Leave (Others)': 'Leave (Others)',
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
];

// A user whose superior is themselves is "self-managed" — they bypass every
// approval step (off requests, off credits, sick reports, late parade changes).
export function isSelfManaged(u: { telegram_id: string; superior_telegram_id: string | null }): boolean {
	return !!u.superior_telegram_id && u.superior_telegram_id === u.telegram_id;
}

export function dayCountInclusive(startdate: string, enddate: string): number {
	const a = new Date(`${startdate}T00:00:00Z`).getTime();
	const b = new Date(`${enddate}T00:00:00Z`).getTime();
	return Math.floor((b - a) / 86_400_000) + 1;
}
