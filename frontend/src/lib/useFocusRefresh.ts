import { useEffect, useRef } from 'react';

// Refetch when the app returns to the foreground (the Telegram WebApp becomes
// visible / the window regains focus). Event-based, NO polling — zero steady
// free-tier cost. Pairs with the bot's Telegram DMs: the DM is the instant
// alert, and this syncs the on-screen data the moment the user taps back in.
//
// `refresh` may be recreated each render — we read it via a ref so the listener
// is attached only once and always calls the latest version.
export function useFocusRefresh(refresh: () => void | Promise<void>): void {
	const ref = useRef(refresh);
	ref.current = refresh;
	useEffect(() => {
		const run = () => {
			if (document.visibilityState === 'visible') void ref.current();
		};
		document.addEventListener('visibilitychange', run);
		window.addEventListener('focus', run);
		return () => {
			document.removeEventListener('visibilitychange', run);
			window.removeEventListener('focus', run);
		};
	}, []);
}
