import { createRoot } from 'react-dom/client';
import { authorizedFetch } from '@/lib/auth-fetch';
import { ACCENT_COLOR_KEY } from '@/lib/stock-display';
import { configureUnifiedChartFetch } from '@/lib/unified-chart-data';
import App from './App';
import './index.css';
import './unified-analysis-chart-touch.css';

const ACCENTS: Record<string, string> = {
	blue: '221 83% 53%',
	green: '142 71% 45%',
	purple: '262 83% 58%',
	red: '0 84% 60%',
	orange: '24 95% 53%',
	pink: '330 81% 60%',
};

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
	if (import.meta.env.VITE_PHASE4_E2E === 'true' || import.meta.env.VITE_PHASE11_E2E === 'false') return;
	if (!('serviceWorker' in navigator)) return;

	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
			const checkForUpdate = () => registration.update().catch(() => undefined);

			void checkForUpdate();
			document.addEventListener('visibilitychange', checkForUpdate);
			window.addEventListener('pageshow', checkForUpdate);
			window.setInterval(checkForUpdate, 5 * 60 * 1000);
		}).catch(() => undefined);
	});
}

configureUnifiedChartFetch(authorizedFetch);
applyInitialAccent();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);