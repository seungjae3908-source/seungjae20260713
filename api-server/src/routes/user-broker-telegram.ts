import { timingSafeEqual } from 'node:crypto';
import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  createSupabaseUserBrokerTelegramRepository,
} from '../features/user-broker-telegram/user-broker-telegram.repository';
import { UserBrokerTelegramService } from '../features/user-broker-telegram/user-broker-telegram.service';
import type {
  NotificationPreferences,
  PortfolioSyncSink,
  TelegramTransport,
} from '../features/user-broker-telegram/user-broker-telegram.types';
import {
  createSupabaseTradingRepository,
  safeConnections,
} from '../services/trade-automation.repository';

const disabledTransport: TelegramTransport = {
  async send() {
    return { ok: false, errorCode: 'TELEGRAM_DELIVERY_WORKER_REQUIRED' };
  },
};

const bridgeOnlyPortfolioSink: PortfolioSyncSink = {
  async accept() {
    // Portfolio core is owned elsewhere. This route never mutates portfolio state.
  },
};

function service(): UserBrokerTelegramService {
  return new UserBrokerTelegramService(
    createSupabaseUserBrokerTelegramRepository(),
    disabledTransport,
    bridgeOnlyPortfolioSink,
  );
}

function member(req: AuthenticatedRequest) {
  if (!req.member?.id || !req.accessToken) throw new Error('LOGIN_REQUIRED');
  return { userId: req.member.id, accessToken: req.accessToken };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'USER_INTEGRATION_FAILED';
  return error.message.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 120);
}

function webhookSecretMatches(provided: string | undefined): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function telegramStartPayload(body: unknown): { token: string; chatId: string; telegramUserId: string } | null {
  const update = record(body);
  const message = record(update?.message);
  const chat = record(message?.chat);
  const from = record(message?.from);
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const match = /^\/start\s+([A-Za-z0-9_-]{20,200})$/.exec(text);
  const chatId = chat?.id == null ? '' : String(chat.id);
  const telegramUserId = from?.id == null ? '' : String(from.id);
  if (!match || !chatId || !telegramUserId) return null;
  return { token: match[1], chatId, telegramUserId };
}

export const telegramWebhookRouter: IRouter = Router();

telegramWebhookRouter.post('/', async (req, res) => {
  const configured = Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim());
  if (!configured) {
    res.status(503).json({ ok: false, error: 'TELEGRAM_WEBHOOK_NOT_CONFIGURED' });
    return;
  }
  const provided = typeof req.get('x-telegram-bot-api-secret-token') === 'string'
    ? req.get('x-telegram-bot-api-secret-token')
    : undefined;
  if (!webhookSecretMatches(provided)) {
    res.status(403).json({ ok: false, error: 'TELEGRAM_WEBHOOK_FORBIDDEN' });
    return;
  }
  const payload = telegramStartPayload(req.body);
  if (!payload) {
    res.status(204).end();
    return;
  }
  try {
    await service().bindTelegramStart({
      token: payload.token,
      telegramChatId: payload.chatId,
      telegramUserId: payload.telegramUserId,
    });
  } catch {
    // Expired/reused/invalid tokens are deliberately not echoed to Telegram or logs.
  }
  res.status(204).end();
});

export const userBrokerTelegramRouter: IRouter = Router();

userBrokerTelegramRouter.get('/', async (req, res) => {
  try {
    const { userId, accessToken } = member(req as AuthenticatedRequest);
    const [state, brokerConnections] = await Promise.all([
      service().getState(userId),
      createSupabaseTradingRepository(accessToken, userId).getConnections(userId),
    ]);
    res.json({
      ok: true,
      brokerConnections: safeConnections(brokerConnections),
      ...state,
      privateApiRequests: 0,
      ordersSubmitted: 0,
      ordersCancelled: 0,
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: errorCode(error) });
  }
});

userBrokerTelegramRouter.post('/telegram/link', async (req, res) => {
  try {
    const { userId } = member(req as AuthenticatedRequest);
    const link = await service().createTelegramLink(userId);
    res.status(201).json({ ok: true, ...link });
  } catch (error) {
    res.status(503).json({ ok: false, error: errorCode(error) });
  }
});

userBrokerTelegramRouter.delete('/telegram', async (req, res) => {
  try {
    const { userId } = member(req as AuthenticatedRequest);
    await service().revokeTelegram(userId);
    res.json({ ok: true, status: 'REVOKED' });
  } catch (error) {
    res.status(503).json({ ok: false, error: errorCode(error) });
  }
});

userBrokerTelegramRouter.patch('/notifications', async (req, res) => {
  try {
    const { userId } = member(req as AuthenticatedRequest);
    const body = record(req.body) ?? {};
    const preferences = await service().savePreferences(userId, body as Partial<NotificationPreferences>);
    res.json({ ok: true, preferences });
  } catch (error) {
    const code = errorCode(error);
    res.status(code === 'NOTIFICATION_PREFERENCE_INVALID' ? 400 : 503).json({ ok: false, error: code });
  }
});

export default userBrokerTelegramRouter;
