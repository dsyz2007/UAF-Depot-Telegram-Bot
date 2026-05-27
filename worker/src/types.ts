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

export interface DbUser {
	id: number;
	telegram_id: string;
	full_name: string;
	user_role: UserRole;
	superior_telegram_id: string | null;
	ord_date: string | null;
	department: Department | null;
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

export type ParadeStatus =
	| 'Present'
	| 'Off'
	| 'Leave'
	| 'Overseas Leave'
	| 'MC'
	| 'Attached-Out'
	| 'Others';

export const PARADE_STATUSES: readonly ParadeStatus[] = [
	'Present',
	'Off',
	'Leave',
	'Overseas Leave',
	'MC',
	'Attached-Out',
	'Others',
];

export function dayCountInclusive(startdate: string, enddate: string): number {
	const a = new Date(`${startdate}T00:00:00Z`).getTime();
	const b = new Date(`${enddate}T00:00:00Z`).getTime();
	return Math.floor((b - a) / 86_400_000) + 1;
}
