import { Router, type IRouter } from 'express';
import webPush, { type PushSubscription } from 'web-push';

const router: IRouter = Router();

const subscriptions = new Map<string, PushSubscription>();

function vapidReady(): boolean {
	return Boolean(
		process.env.VAPID_PUBLIC_KEY &&
			process.env.VAPID_PRIVATE_KEY &&
			process.env.VAPID_SUBJECT,
	);
}

function setupVapid(): void {
	if (!vapidReady()) return;

	webPush.setVapidDetails(
		process.env.VAPID_SUBJECT as string,
		process.env.VAPID_PUBLIC_KEY as string,
		process.env.VAPID_PRIVATE_KEY as string,
	);
}

setupVapid();

function getEndpoint(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;

	const endpoint = (body as { endpoint?: unknown }).endpoint;

	return typeof endpoint === 'string' && endpoint.length > 0
		? endpoint
		: null;
}

router.post('/push/subscribe', (req, res) => {
	const endpoint = getEndpoint(req.body);

	if (!endpoint) {
		res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
		return;
	}

	subscriptions.set(endpoint, req.body as PushSubscription);

	res.json({
		ok: true,
		count: subscriptions.size,
		vapidReady: vapidReady(),
	});
});

router.post('/push/unsubscribe', (req, res) => {
	const endpoint = getEndpoint(req.body);

	if (!endpoint) {
		res.status(400).json({ error: 'INVALID_ENDPOINT' });
		return;
	}

	subscriptions.delete(endpoint);

	res.json({
		ok: true,
		count: subscriptions.size,
	});
});

router.post('/push/test', async (req, res) => {
	if (!vapidReady()) {
		res.json({
			ok: false,
			reason: 'VAPID 키 미설정',
		});
		return;
	}

	const payload = JSON.stringify({
		title: '승재주식 테스트 알림',
		body: '관심종목 뉴스·공시·등락률 알림 연결 테스트입니다.',
		url: '/',
		...(typeof req.body === 'object' && req.body ? req.body : {}),
	});

	const failed: string[] = [];

	await Promise.all(
		Array.from(subscriptions.entries()).map(async ([endpoint, sub]) => {
			try {
				await webPush.sendNotification(sub, payload);
			} catch {
				failed.push(endpoint);
			}
		}),
	);

	failed.forEach((endpoint) => subscriptions.delete(endpoint));

	res.json({
		ok: true,
		sent: subscriptions.size,
		removed: failed.length,
	});
});

export default router;