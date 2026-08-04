import { createRoot } from 'react-dom/client';
import { ACCENT_COLOR_KEY } from '@/lib/stock-display';
import App from './App';
import './index.css';

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
		navigator.serviceWorker.register('/sw.js').catch(() => undefined);
	});
}

applyInitialAccent();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
