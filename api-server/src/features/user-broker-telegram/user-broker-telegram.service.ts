import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hasCapability, type MemberTier } from '../../../../packages/member-access/src/index.js';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from '../../services/trade-automation.types';
import type { UserBrokerTelegramRepository } from './user-broker-telegram.repository';
import {
  DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_PREFERENCE_KEYS,
  type NotificationDelivery, type NotificationPreferences, type PortfolioSyncSink, type TelegramTransport,
  type UserExecutionEvent, type UserExecutionEventType, type UserExecutionMethod,
} from './user-broker-telegram.types';

const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

export function hashTelegramLinkToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function maskBrokerAccount(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').replace(/\s+/g, '').trim();
  return normalized ? `****${normalized.slice(-4)}` : null;
}
function safeNumber(value: number | null | undefined): number | null { return value != null && Number.isFinite(value) ? value : null; }

function executionType(transition: TradingOrderEvent): UserExecutionEventType | null {
  const reason = transition.reason.toUpperCase();
  const state = transition.toState;
  if (state === 'FILLED' && /(?:TAKE_PROFIT|TARGET)/.test(reason)) return 'TAKE_PROFIT_FILLED';
  if (state === 'FILLED' && /(?:STOP_FILLED|STOP_LOSS|PROTECTIVE_STOP)/.test(reason)) return 'STOP_FILLED';
  if (state === 'SUBMITTED' || state === 'ACCEPTED') return 'ORDER_SUBMITTED';
  if (state === 'PARTIALLY_FILLED') return 'ORDER_PARTIALLY_FILLED';
  if (state === 'FILLED') return 'ORDER_FILLED';
  if (state === 'CANCELED') return 'ORDER_CANCELLED';
  if (state === 'REJECTED') return 'ORDER_REJECTED';
  return null;
}

export function executionEventFromTradingOrder(
  transition: TradingOrderEvent,
  order: TradingOrder,
  plan: TradingPlan,
  options: { accountNumber?: string | null; executionMethod?: UserExecutionMethod } = {},
): UserExecutionEvent | null {
  if (transition.userId !== order.userId || order.userId !== plan.userId || order.planId !== plan.id) throw new Error('EXECUTION_OWNER_MISMATCH');
  const type = executionType(transition);
  if (!type) return null;
  const executionMethod = options.executionMethod ?? 'USER_APPROVED';
  return {
    id: randomUUID(), sourceEventId: transition.id, userId: order.userId, brokerConnectionRef: order.exchange,
    orderPlanId: order.planId, executionId: order.id, type,
    source: plan.accountMode === 'live' ? 'BROKER_EXECUTION' : 'PAPER_EXECUTION', executionMethod,
    symbol: plan.symbol, market: plan.market, side: plan.side,
    quantity: safeNumber(order.filledQuantity || order.requestedQuantity),
    price: safeNumber(order.averageFillPrice ?? plan.limitPrice ?? plan.entryPrice),
    maskedAccount: maskBrokerAccount(options.accountNumber), strategy: plan.strategyId,
    remainingQuantity: safeNumber(order.remainingQuantity), realizedPnl: null, averageEntryPrice: null, averageExitPrice: null,
    occurredAt: transition.createdAt,
    metadata: {
      orderState: transition.toState, reason: transition.reason, providerStatusCode: order.providerStatusCode ?? null,
      orderPlanVersion: order.approvedPlanVersion ?? plan.version ?? null,
      approvedBy: order.userId, approvedAt: plan.approvedAt,
      approvalSource: executionMethod === 'AUTO_POLICY' ? 'AUTO_POLICY' : 'USER_UI',
      accountMode: plan.accountMode, reduceOnly: plan.reduceOnly === true,
      stopPrice: plan.stopPrice, targetPrice: plan.targetPrices?.[0] ?? null,
    },
  };
}

export function manualPortfolioEvent(input: {
  id?: string; userId: string; symbol: string; market: string; side?: 'buy' | 'sell' | 'long' | 'short' | null;
  quantity: number; price: number; occurredAt?: string;
}): UserExecutionEvent {
  const sourceEventId = input.id ?? randomUUID();
  return {
    id: randomUUID(), sourceEventId, userId: input.userId, brokerConnectionRef: null, orderPlanId: null, executionId: null,
    type: 'MANUAL_PORTFOLIO_ENTRY', source: 'MANUAL_PORTFOLIO_ENTRY', executionMethod: null,
    symbol: input.symbol, market: input.market, side: input.side ?? null, quantity: safeNumber(input.quantity), price: safeNumber(input.price),
    maskedAccount: null, strategy: null, remainingQuantity: null, realizedPnl: null,
    averageEntryPrice: safeNumber(input.price), averageExitPrice: null,
    occurredAt: input.occurredAt ?? new Date().toISOString(), metadata: { registrationMethod: 'MANUAL' },
  };
}

function formatNumber(value: number | null): string { return value == null ? '-' : value.toLocaleString('ko-KR', { maximumFractionDigits: 8 }); }
function title(event: UserExecutionEvent): string {
  switch (event.type) {
    case 'ORDER_SUBMITTED': return '🟦 주문 제출';
    case 'ORDER_PARTIALLY_FILLED': return '🔵 부분 체결';
    case 'ORDER_FILLED': return event.side === 'sell' || event.side === 'short' ? '✅ 매도 체결' : '✅ 매수 체결';
    case 'ORDER_CANCELLED': return '⛔ 주문 취소';
    case 'ORDER_REJECTED': return '⚠️ 주문 거절';
    case 'POSITION_OPENED': return '📈 포지션 시작';
    case 'POSITION_INCREASED': return '📈 포지션 추가';
    case 'POSITION_REDUCED': return '💰 포지션 일부 청산';
    case 'POSITION_CLOSED': return '🏁 포지션 종료';
    case 'TAKE_PROFIT_FILLED': return '💰 익절 체결';
    case 'STOP_FILLED': return '🛑 손절 체결';
    case 'MANUAL_PORTFOLIO_ENTRY': return '📌 포트폴리오 등록';
  }
}
export function renderUserExecutionTelegramMessage(event: UserExecutionEvent): string {
  const lines = [title(event), '', event.symbol];
  if (event.quantity != null || event.price != null) lines.push(`${formatNumber(event.quantity)} × ${formatNumber(event.price)}`);
  if (event.maskedAccount) lines.push('', `계좌 ${event.maskedAccount}`);
  if (event.strategy) lines.push(`전략 ${event.strategy}`);
  if (event.remainingQuantity != null) lines.push(`잔여수량 ${formatNumber(event.remainingQuantity)}`);
  if (event.type === 'POSITION_CLOSED') {
    if (event.averageEntryPrice != null) lines.push(`평균매수가 ${formatNumber(event.averageEntryPrice)}`);
    if (event.averageExitPrice != null) lines.push(`평균매도가 ${formatNumber(event.averageExitPrice)}`);
    if (event.realizedPnl != null) lines.push(`실현손익 ${formatNumber(event.realizedPnl)}`);
  }
  if (event.type === 'MANUAL_PORTFOLIO_ENTRY') lines.push('', '등록방식: 수동등록');
  if (event.executionMethod) lines.push('', `실행방식: ${event.executionMethod === 'AUTO_POLICY' ? '자동매매 정책' : '사용자 승인'}`);
  return lines.join('\n');
}
function nextRetryAt(now: Date, attempts: number): string {
  const delay = Math.min(MAX_RETRY_DELAY_MS, 30_000 * (2 ** Math.max(0, attempts - 1)));
  return new Date(now.getTime() + delay).toISOString();
}

export class UserBrokerTelegramService {
  constructor(
    private readonly repository: UserBrokerTelegramRepository,
    private readonly transport: TelegramTransport,
    private readonly portfolioSink: PortfolioSyncSink,
    private readonly botUsername: string | null = process.env.TELEGRAM_BOT_USERNAME?.trim() || null,
  ) {}

  async createTelegramLink(userId: string, now = new Date()) {
    if (!userId) throw new Error('LOGIN_REQUIRED');
    const token = randomBytes(32).toString('base64url');
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS).toISOString();
    await this.repository.createLinkToken({ tokenHash: hashTelegramLinkToken(token), userId, expiresAt, consumedAt: null, createdAt });
    const username = this.botUsername?.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '') || null;
    return { deepLink: username ? `https://t.me/${username}?start=${encodeURIComponent(token)}` : null, tokenForBotStart: username ? null : token, expiresAt };
  }

  async bindTelegramStart(input: { token: string; telegramChatId: string; telegramUserId: string; now?: Date }) {
    const token = input.token.trim(); const chatId = input.telegramChatId.trim(); const telegramUserId = input.telegramUserId.trim();
    if (!token || !chatId || !telegramUserId) throw new Error('TELEGRAM_LINK_INVALID');
    const now = input.now ?? new Date(); const timestamp = now.toISOString();
    const userId = await this.repository.consumeLinkToken(hashTelegramLinkToken(token), timestamp);
    if (!userId) throw new Error('TELEGRAM_LINK_EXPIRED_OR_USED');
    await this.repository.bindTelegramConnection({ userId, telegramChatId: chatId, telegramUserId, status: 'ACTIVE', connectedAt: timestamp, revokedAt: null, updatedAt: timestamp });
    return { userId, connected: true };
  }
  async revokeTelegram(userId: string, now = new Date()) { await this.repository.revokeTelegramConnection(userId, now.toISOString()); }
  async getState(userId: string) {
    const connection = await this.repository.getTelegramConnection(userId);
    const preferences = await this.repository.getPreferences(userId);
    const deliveries = await this.repository.listDeliveries(userId);
    return { telegram: { connected: connection?.status === 'ACTIVE', status: connection?.status ?? 'DISCONNECTED', connectedAt: connection?.connectedAt ?? null }, preferences,
      deliveries: deliveries.map(({ userId: _userId, dedupeKey: _dedupeKey, ...delivery }) => delivery) };
  }
  async savePreferences(userId: string, patch: Partial<NotificationPreferences>, now = new Date()) {
    const current = await this.repository.getPreferences(userId); const allowed = new Set<string>(NOTIFICATION_PREFERENCE_KEYS); const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key) || typeof value !== 'boolean') throw new Error('NOTIFICATION_PREFERENCE_INVALID');
      next[key as keyof NotificationPreferences] = value;
    }
    await this.repository.savePreferences(userId, next, now.toISOString()); return next;
  }
  async recordEvent(event: UserExecutionEvent, now = new Date(), membership: MemberTier = 'admin') {
    const inserted = await this.repository.insertExecutionEvent(event);
    if (!inserted) return { inserted: false, deliveryQueued: false };
    if (event.type !== 'MANUAL_PORTFOLIO_ENTRY') await this.portfolioSink.accept(event);
    const preferences = await this.repository.getPreferences(event.userId);
    if (!preferences[event.type]) return { inserted: true, deliveryQueued: false };
    if (!personalTelegramEventAllowed(membership, event)) {
      return { inserted: true, deliveryQueued: false, skipped: 'MEMBERSHIP_SCOPE' as const };
    }
    const connection = await this.repository.getTelegramConnection(event.userId);
    if (!connection || connection.status !== 'ACTIVE') return { inserted: true, deliveryQueued: false };
    const timestamp = now.toISOString();
    const delivery: NotificationDelivery = { id: randomUUID(), userId: event.userId, eventId: event.id, dedupeKey: `${event.id}:${event.type}`,
      state: 'PENDING', attempts: 0, nextRetryAt: null, lastErrorCode: null, createdAt: timestamp, updatedAt: timestamp };
    const deliveryQueued = await this.repository.enqueueDelivery(delivery);
    return { inserted: true, deliveryQueued, deliveryId: deliveryQueued ? delivery.id : null };
  }
  async processDelivery(userId: string, deliveryId: string, now = new Date()) {
    const timestamp = now.toISOString(); const claimed = await this.repository.claimDelivery(userId, deliveryId, timestamp);
    if (!claimed) return { processed: false, state: null as null };
    const event = await this.repository.getExecutionEvent(userId, claimed.eventId);
    const connection = await this.repository.getTelegramConnection(userId);
    if (!event || !connection || connection.status !== 'ACTIVE') {
      const result = await this.repository.finishDelivery(userId, deliveryId, 'DEAD_LETTER', claimed.attempts, null,
        !event ? 'EVENT_NOT_FOUND' : 'TELEGRAM_DISCONNECTED', timestamp);
      return { processed: true, state: result?.state ?? 'DEAD_LETTER' };
    }
    const attempt = claimed.attempts + 1;
    let transportResult: Awaited<ReturnType<TelegramTransport['send']>>;
    try { transportResult = await this.transport.send(connection.telegramChatId, renderUserExecutionTelegramMessage(event)); }
    catch { transportResult = { ok: false, errorCode: 'TELEGRAM_TRANSPORT_ERROR' }; }
    if (transportResult.ok) {
      await this.repository.finishDelivery(userId, deliveryId, 'SENT', attempt, null, null, timestamp);
      return { processed: true, state: 'SENT' as const };
    }
    const dead = attempt >= MAX_DELIVERY_ATTEMPTS;
    const state = dead ? 'DEAD_LETTER' as const : 'RETRY_SCHEDULED' as const;
    await this.repository.finishDelivery(userId, deliveryId, state, attempt, dead ? null : nextRetryAt(now, attempt),
      transportResult.errorCode?.slice(0, 120) || 'TELEGRAM_DELIVERY_FAILED', timestamp);
    return { processed: true, state };
  }
}
export function personalTelegramEventAllowed(membership: MemberTier, event: Pick<UserExecutionEvent, 'market'>): boolean {
  const market = event.market.trim().toLowerCase();
  const futures = market.includes('future') || market.includes('perp') || market.includes('swap');
  if (futures) return hasCapability(membership, 'canAccessFutures');
  const spot = market.includes('spot') || market.includes('upbit') || market.includes('coin') || market.includes('crypto');
  if (spot) return hasCapability(membership, 'canAccessSpot');
  return hasCapability(membership, 'canAccessBasicInfo');
}
export function defaultNotificationPreferences(): NotificationPreferences { return { ...DEFAULT_NOTIFICATION_PREFERENCES }; }
