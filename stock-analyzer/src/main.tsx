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
		const saved =
			window.localStorage.getItem(ACCENT_COLOR_KEY) || 'blue';

		const color = ACCENTS[saved] ?? ACCENTS.blue;

		document.documentElement.style.setProperty(
			'--primary',
			color,
		);

		document.documentElement.style.setProperty(
			'--ring',
			color,
		);
	} catch {
		document.documentElement.style.setProperty(
			'--primary',
			ACCENTS.blue,
		);

		document.documentElement.style.setProperty(
			'--ring',
			ACCENTS.blue,
		);
	}
}

function isReplitPreview() {
	const hostname = window.location.hostname.toLowerCase();

	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname.endsWith('.replit.dev') ||
		hostname.endsWith('.repl.co') ||
		hostname.includes('replit')
	);
}

async function removePreviewServiceWorker() {
	if (!('serviceWorker' in navigator)) {
		return;
	}

	try {
		const registrations =
			await navigator.serviceWorker.getRegistrations();

		await Promise.all(
			registrations.map((registration) =>
				registration.unregister(),
			),
		);

		/*
		 * Replit Preview에서는 이전 빌드가 남지 않도록
		 * Workbox와 정적 파일 캐시도 함께 제거한다.
		 */
		if ('caches' in window) {
			const cacheNames = await window.caches.keys();

			await Promise.all(
				cacheNames.map((cacheName) =>
					window.caches.delete(cacheName),
				),
			);
		}
	} catch {
		// 캐시 삭제 실패가 앱 실행 자체를 막지는 않게 한다.
	}
}

function configureServiceWorker() {
	if (!('serviceWorker' in navigator)) {
		return;
	}

	/*
	 * Replit Preview에서는 서비스워커를 사용하지 않는다.
	 * 이전 빌드가 계속 보이거나 첫 화면에서 404가 나타나는 문제를 막는다.
	 */
	if (import.meta.env.DEV || isReplitPreview()) {
		window.addEventListener('load', () => {
			void removePreviewServiceWorker();
		});

		return;
	}

	/*
	 * Vultr 실제 운영 도메인에서는 PWA를 유지한다.
	 * updateViaCache:none과 registration.update()로 최신 sw.js를 확인한다.
	 */
	window.addEventListener('load', () => {
		navigator.serviceWorker
			.register('/sw.js', {
				updateViaCache: 'none',
			})
			.then((registration) => registration.update())
			.catch(() => undefined);
	});
}

applyInitialAccent();
configureServiceWorker();

createRoot(
	document.getElementById('root')!,
).render(<App />);