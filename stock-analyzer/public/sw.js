self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
	let payload = {
		title: '승재주식 알림',
		body: '관심종목 변동이 감지되었습니다.',
		url: '/',
	};

	try {
		if (event.data) {
			payload = {
				...payload,
				...event.data.json(),
			};
		}
	} catch {
		if (event.data) {
			payload.body = event.data.text();
		}
	}

	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			data: {
				url: payload.url || '/',
			},
		}),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	const url = event.notification.data?.url || '/';

	event.waitUntil(
		self.clients
			.matchAll({
				type: 'window',
				includeUncontrolled: true,
			})
			.then((clients) => {
				for (const client of clients) {
					if ('focus' in client) {
						client.navigate(url);
						return client.focus();
					}
				}

				return self.clients.openWindow(url);
			}),
	);
});