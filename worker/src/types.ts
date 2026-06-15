// Single source of truth for cross-module types.

export {};

declare global {
	interface Env {
		BOT_TOKEN: string;
		WEBHOOK_SECRET: string;
	}
}

export type UserRole = 'user' | 'admin' | 'superadmin';

export type Department = 'DHQ' | 'DMSP' | 'DCS' | 'DSP' | 'Others';
export const DEPARTMENTS: readonly Department[] = ['DHQ', 'DMSP', 'DCS', 'DSP', 'Others'];

export type PersonnelType = 'NSF' | 'Regular';
export const PERSONNEL_TYPES: readonly PersonnelType[] = ['NSF', 'Regular'];

// Department appointments — approvers for a user are the appointment-holders in
// their own unit (= their department). Any number of each per unit.
export type Appointment = 'WOIC' | '2IC' | 'PC';
export const APPOINTMENTS: readonly Appointment[] = ['WOIC', '2IC', 'PC'];

export interface DbUser {
	id: number;
	telegram_id: string;
	full_name: string;
	// Telegram @username (handle), stored without the leading '@'. May be null
	// (the user has no handle, or hasn't been captured yet).
	username: string | null;
	user_role: UserRole;
	// Legacy manual-superior columns (kept for data history; no longer used for
	// routing — replaced by department appointments + self_managed).
	superior_telegram_id: string | null;
	superior_telegram_id_2: string | null;
	ord_date: string | null;
	department: Department | null;
	// Legacy STG sub-section column. STG was merged into a single DSP department,
	// so this is now always null for new data; kept for column compatibility.
	sub_department: string | null;
	personnel_type: PersonnelType | null;
	// Appointment held within their unit (drives who approves whom). NULL = none.
	appointment: Appointment | null;
	// Explicit bypass of all approval (the most senior account(s)).
	self_managed: number;
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
	| 'NTM Swap-Out'
	| 'Operator Off';

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
	'Operator Off',
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
	'Operator Off': 'Operator Off',
};

// Leave parade statuses — these route through the dedicated Leave-request flow
// (superior approval + OneNS reminder) instead of being applied directly.
export const LEAVE_PARADE_STATUSES: readonly ParadeStatus[] = ['LL', 'OL', 'Leave (Others)'];
export function isLeaveStatus(s: string | null | undefined): boolean {
	return s === 'LL' || s === 'OL' || s === 'Leave (Others)';
}

// Statuses that require a reason when submitting parade state.
export const REASON_REQUIRED_STATUSES: readonly ParadeStatus[] = [
	'Course',
	'AO',
	'MA',
	'MC',
	'RSO',
	'RSI',
	'OL',
	'Leave (Others)',
	'Others',
];

// A user is "self-managed" — bypassing every approval step — when the explicit
// self_managed flag is set.
export function isSelfManaged(u: { self_managed?: number | boolean | null }): boolean {
	return !!u.self_managed;
}

// Whose OWN requests need no approval (auto-approve on submit): self-managed
// users, AND appointment-holders (they approve their unit, so they approve
// themselves automatically rather than manually).
export function autoApprovesOwn(u: { self_managed?: number | boolean | null; appointment?: string | null }): boolean {
	return !!u.self_managed || !!u.appointment;
}

// Two period selections (FD / AM / PM) clash if either is full-day, or they're
// the same half. Used to dedup overlapping off / leave requests.
export function periodsOverlap(a: string, b: string): boolean {
	return a === 'FD' || b === 'FD' || a === b;
}

export function dayCountInclusive(startdate: string, enddate: string): number {
	const a = new Date(`${startdate}T00:00:00Z`).getTime();
	const b = new Date(`${enddate}T00:00:00Z`).getTime();
	return Math.floor((b - a) / 86_400_000) + 1;
}
