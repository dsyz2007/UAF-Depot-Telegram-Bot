import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// @twa-dev/sdk requires window.Telegram.WebApp to be present (loaded by the
// telegram-web-app.js script tag in index.html). Outside Telegram (e.g. a
// regular browser tab) it isn't, so we no-op rather than crash to a blank screen.
try {
	const tg = (window as unknown as { Telegram?: { WebApp?: { ready?: () => void; expand?: () => void } } }).Telegram?.WebApp;
	tg?.ready?.();
	tg?.expand?.();
} catch (e) {
	console.warn('Telegram WebApp init skipped:', e);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
