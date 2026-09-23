import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { authorizedFetch } from '@/lib/auth-fetch';
import { primeInitialAuthBootstrap } from '@/lib/auth-initial-bootstrap';
import { installDeferredScannerResponseGuard } from '@/lib/scanner-response-guard-bootstrap';
import { ACCENT_COLOR_KEY } from '@/lib/stock-display';
import { configureUnifiedChartFetch } from '@/lib/unified-chart-data';
import './index.css';
import './unified-analysis-chart-touch.css';
import './professional-ui-foundation.css';

const ACCENTS: Record<string, string> = {
	blue: '221 83% 53%',
	green: '142 71% 45%',
	purple: '262 83% 58%',
	red: '0 84% 60%',
	orange: '24 95% 53%',
	pink: '330 81% 60%',
};

const AI_CHART_SERVICE_WORKER_DELAY_MS = 6_000;

function applyInitialAccent() {
	try {
		const saved = window.localStorage.getItem(ACCENT_COLOR_KEY) || 'blue';
		const color = ACCENTS[saved] ?? ACCENTS.blue;

		document.documentElement.style.setProperty('--primary', color);
		document.documentElement.style.setProperty('--ring', color);
	} catch {
		document.documentElement.style.setProperty('--primary', ACCENTS.blue);
	}
}

function registerServiceWorker() {
	if (!import.meta.env.PROD) return;
	if (import.meta.env.VITE_PHASE4_E2E === 'true' || import.meta.env.VITE_PHASE11_E2E === 'false') return;
	if (!('serviceWorker' in navigator)) return;

	window.addEventListener('load', () => {
		const register = () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
			const checkForUpdate = () => registration.update().catch(() => undefined);

			void checkForUpdate();
			document.addEventListener('visibilitychange', checkForUpdate);
			window.addEventListener('pageshow', checkForUpdate);
			window.setInterval(checkForUpdate, 5 * 60 * 1000);
		}).catch(() => undefined);

		// A fresh service worker precaches the complete application graph. On a
		// direct AI Chart cold document, starting that background transfer during
		// the five-second usability window can starve the route chunk itself.
		// Keep PWA registration intact, but start it only after the critical chart
		// window; all other routes retain their existing load-event behavior.
		if (window.location.pathname.endsWith('/ai-chart')) {
			window.setTimeout(register, AI_CHART_SERVICE_WORKER_DELAY_MS);
			return;
		}
		void register();
	});
}

void primeInitialAuthBootstrap()?.catch(() => undefined);
configureUnifiedChartFetch(authorizedFetch);
installDeferredScannerResponseGuard();
applyInitialAccent();
registerServiceWorker();

export function mountApp(App: ComponentType) {
	createRoot(document.getElementById('root')!).render(<App />);
}
