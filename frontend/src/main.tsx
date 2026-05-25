import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import WebApp from '@twa-dev/sdk';
import './index.css';
import App from './App.tsx';

// Tell Telegram we're ready to be shown, expand to full height.
WebApp.ready();
WebApp.expand();

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
