self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const metadata = payload.metadata || {};
  const repeatIndex = Number(metadata.repeatIndex || 1);
  const repeatCount = Number(metadata.repeatCount || 1);
  const signalId = String(metadata.signalId || Date.now());

  event.waitUntil(
    self.registration.showNotification(
      String(payload.title || '주식앱 알림'),
      {
        body: String(payload.body || ''),
        data: {
          url: String(payload.url || '/alerts'),
          metadata,
        },
        tag: `${signalId}:${repeatIndex}`,
        renotify: true,
        requireInteraction: true,
        silent: false,
        vibrate: [350, 150, 350, 150, 550],
        badge: '/favicon.ico',
        icon: '/favicon.ico',
        actions:
          repeatIndex === repeatCount
            ? [{ action: 'open', title: '신호 확인' }]
            : [],
      },
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data?.url || '/alerts',
    self.location.origin,
  ).href;

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ('focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        return clients.openWindow(targetUrl);
      }),
  );
});
