import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hasCanonicalMemberAccessState, hasCapability, type MemberTier } from '../../../../packages/member-access/src/index.js';
import type { TelegramAlertInput, TelegramAlertResult } from '../../services/telegram-notification.service';
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
type PersonalAlertSender = (input: TelegramAlertInput) => Promise<TelegramAlertResult>;

export function hashTelegramLinkToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function maskBrokerAccount(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').replace(/\s+/g, '').trim();
  return normalized ? `****${normalized.slice(-4)}` : null;
}
function safeNumber(value: number | null | undefined): number | null { return value != null && Number.isFinite(value) ? value : null; }
function metadataNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function metadataText(value: unknown, maxLength = 160): string | null {
  return typeof value === 'string' && value.trim() ? value.normalize('NFKC').trim().slice(0, maxLength) : null;
}
function metadataTextList(value: unknown, maxItems = 6): string[] {
  return Array.isArray(value)
    ? value.map((item) => metadataText(item)).filter((item): item is string => Boolean(item)).slice(0, maxItems)
    : [];
}
function actualSlippagePercent(plan: TradingPlan, order: TradingOrder): number | null {
  const reference = safeNumber(plan.entryPrice ?? plan.limitPrice);
  const fill = safeNumber(order.averageFillPrice);
  if (reference == null || reference <= 0 || fill == null || fill <= 0) return null;
  const adverseMove = plan.side === 'sell' || plan.side === 'short'
    ? reference - fill
    : fill - reference;
  return Number(((adverseMove / reference) * 100).toFixed(4));
}

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
      orderState: transition.toState,
      reason: transition.reason,
      providerStatusCode: order.providerStatusCode ?? null,
      orderPlanVersion: order.approvedPlanVersion ?? plan.version ?? null,
      approvedBy: order.userId,
      approvedAt: plan.approvedAt,
      approvalSource: executionMethod === 'AUTO_POLICY' ? 'AUTO_POLICY' : 'USER_UI',
      accountMode: plan.accountMode,
      orderType: plan.orderType,
      reduceOnly: plan.reduceOnly === true,
      signalId: plan.signalId,
      signalReasons: plan.signalReasons.slice(0, 8),
      entryPrice: plan.entryPrice ?? plan.limitPrice ?? null,
      entryZoneLow: plan.entryZoneLow ?? null,
      entryZoneHigh: plan.entryZoneHigh ?? null,
      stopPrice: plan.stopPrice,
      targetPrices: plan.targetPrices.slice(0, 3),
      leverage: plan.leverage ?? null,
      marginMode: plan.marginMode ?? null,
      estimatedSlippagePercent: plan.estimatedSlippagePercent ?? null,
      actualSlippagePercent: actualSlippagePercent(plan, order),
      feeAmount: order.feeAmount ?? null,
      feeCurrency: order.feeCurrency ?? null,
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
function signedPlanPercent(
  entry: number | null,
  price: number | null,
  side: UserExecutionEvent['side'],
): number | null {
  if (entry == null || entry <= 0 || price == null || price <= 0) return null;
  const descendingProfit = side === 'sell' || side === 'short';
  const raw = descendingProfit ? ((entry - price) / entry) * 100 : ((price - entry) / entry) * 100;
  return Number(raw.toFixed(2));
}
function formatSignedPercent(value: number | null): string {
  if (value == null) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}
function title(event: UserExecutionEvent): string {
  switch (event.type) {
    case 'ORDER_SUBMITTED': return '🟦 주문 제출';
    case 'ORDER_PARTIALLY_FILLED': return '🔵 부분 체결';
    case 'ORDER_FILLED':
      if (event.side === 'long') return '✅ LONG 체결';
      if (event.side === 'short') return '✅ SHORT 체결';
      return event.side === 'sell' ? '✅ 매도 체결' : '✅ 매수 체결';
    case 'ORDER_CANCELLED': return '⛔ 주문 취소';
    case 'ORDER_REJECTED': return '⚠️ 주문 거절';
    case 'POSITION_OPENED': return '📈 포지션 시작';
    case 'POSITION_INCREASED': return '📈 포지션 추가';
    case 'POSITION_REDUCED': return '💰 포지션 일부 청산';
    case 'POSITION_CLOSED': return '🏁 포지션 종료';
    case 'TAKE_PROFIT_FILLED': return '💰 익절 체결';
    case 'STOP_FILLED': return '🛑 손절 체결';
    case 'MANUAL_PORTFOLIO_ENTRY': return '📌 보유종목 등록';
  }
}
function executionStateLabel(event: UserExecutionEvent): string {
  switch (event.type) {
    case 'ORDER_SUBMITTED': return '주문 제출';
    case 'ORDER_PARTIALLY_FILLED': return '부분 체결';
    case 'ORDER_FILLED': return '체결 완료';
    case 'ORDER_CANCELLED': return '주문 취소';
    case 'ORDER_REJECTED': return '주문 거절';
    case 'POSITION_OPENED': return '포지션 시작';
    case 'POSITION_INCREASED': return '포지션 추가';
    case 'POSITION_REDUCED': return '일부 청산';
    case 'POSITION_CLOSED': return '포지션 종료';
    case 'TAKE_PROFIT_FILLED': return '익절 체결';
    case 'STOP_FILLED': return '손절 체결';
    case 'MANUAL_PORTFOLIO_ENTRY': return '보유종목 등록';
  }
}

function strategyLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'scalping') return '단타';
  if (normalized === 'swing') return '스윙';
  if (normalized === 'position') return '중장기';
  return value;
}

function marginModeLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'isolated') return '격리';
  if (normalized === 'cross') return '교차';
  return value;
}

function kstTimestamp(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const formatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return formatter.format(new Date(time));
}

function autoTradingSignalLabel(event: UserExecutionEvent): string {
  if (event.side === 'long') return 'LONG 신호';
  if (event.side === 'short') return 'SHORT 신호';
  if (event.side === 'sell') return '매도 신호';
  if (event.side === 'buy') return '매수 신호';
  return '상태 알림';
}

export function renderUserExecutionTelegramMessage(event: UserExecutionEvent): string {
  const lane = event.executionMethod === 'AUTO_POLICY'
    ? `🤖 자동매매 · ${autoTradingSignalLabel(event)}`
    : event.type === 'MANUAL_PORTFOLIO_ENTRY'
      ? '👤 보유종목'
      : '👤 개인 주문/체결';
  const lines = [lane, title(event), '', event.symbol];
  if (event.quantity != null) lines.push(`수량: ${formatNumber(event.quantity)}`);
  if (event.price != null) lines.push(`가격: ${formatNumber(event.price)}`);
  if (event.maskedAccount) lines.push('', `계좌: ${event.maskedAccount}`);
  const strategy = strategyLabel(event.strategy);
  if (strategy) lines.push(`전략: ${strategy}`);
  if (event.remainingQuantity != null) lines.push(`잔여수량 ${formatNumber(event.remainingQuantity)}`);

  const transitionReason = metadataText(event.metadata.reason);
  const signalReasons = metadataTextList(event.metadata.signalReasons, 8);
  const entryPrice = metadataNumber(event.metadata.entryPrice);
  const entryZoneLow = metadataNumber(event.metadata.entryZoneLow);
  const entryZoneHigh = metadataNumber(event.metadata.entryZoneHigh);
  const stopPrice = metadataNumber(event.metadata.stopPrice);
  const targets = Array.isArray(event.metadata.targetPrices)
    ? event.metadata.targetPrices.map(metadataNumber).filter((value): value is number => value != null).slice(0, 3)
    : [];
  const feeAmount = metadataNumber(event.metadata.feeAmount);
  const feeCurrency = metadataText(event.metadata.feeCurrency, 24);
  const estimatedSlippage = metadataNumber(event.metadata.estimatedSlippagePercent);
  const actualSlippage = metadataNumber(event.metadata.actualSlippagePercent);
  const leverage = metadataNumber(event.metadata.leverage);
  const marginMode = metadataText(event.metadata.marginMode, 24);

  if (event.executionMethod === 'AUTO_POLICY') {
    const planEntry = entryPrice ?? (
      entryZoneLow != null && entryZoneHigh != null
        ? (entryZoneLow + entryZoneHigh) / 2
        : null
    );
    lines.push('', '[자동매매 판단 근거]');
    lines.push(`판단: ${autoTradingSignalLabel(event).replace(' 신호', '')}`);
    lines.push(`상태: ${executionStateLabel(event)}`);
    if (signalReasons.length) signalReasons.forEach((reason) => lines.push(`• ${reason}`));
    else lines.push('• 검증된 진입 근거 N/A');
    if (transitionReason && !['FILLED', 'SUBMITTED', 'ACCEPTED'].includes(transitionReason.toUpperCase())) {
      lines.push('상태 이유: 정책/브로커 상태가 변경되었습니다.');
    }
    if (entryPrice != null) lines.push(`기준 진입가: ${formatNumber(entryPrice)}`);
    if (entryZoneLow != null && entryZoneHigh != null) lines.push(`진입구간: ${formatNumber(entryZoneLow)}~${formatNumber(entryZoneHigh)}`);
    if (targets.length) lines.push(`익절 계획: ${targets.map((value, index) =>
      `TP${index + 1} ${formatNumber(value)} (${formatSignedPercent(signedPlanPercent(planEntry, value, event.side))})`).join(' · ')}`);
    if (stopPrice != null) lines.push(`손절/무효: ${formatNumber(stopPrice)} (${formatSignedPercent(signedPlanPercent(planEntry, stopPrice, event.side))})`);
    if (leverage != null) {
      const mode = marginModeLabel(marginMode);
      lines.push(`레버리지: ${formatNumber(leverage)}x${mode ? ` · ${mode}` : ''}`);
    }
  } else if (transitionReason) {
    lines.push('', `체결/상태 이유: ${transitionReason}`);
  }

  if (feeAmount != null || estimatedSlippage != null || actualSlippage != null) {
    lines.push('', '[체결 비용/품질]');
    if (feeAmount != null) lines.push(`수수료: ${formatNumber(feeAmount)}${feeCurrency ? ` ${feeCurrency}` : ''}`);
    if (estimatedSlippage != null) lines.push(`예상 슬리피지: ${estimatedSlippage.toFixed(4)}%`);
    if (actualSlippage != null) lines.push(`실제 슬리피지: ${actualSlippage.toFixed(4)}%`);
  }

  if (event.type === 'POSITION_CLOSED') {
    if (event.averageEntryPrice != null) lines.push(`평균매수가 ${formatNumber(event.averageEntryPrice)}`);
    if (event.averageExitPrice != null) lines.push(`평균매도가 ${formatNumber(event.averageExitPrice)}`);
    if (event.realizedPnl != null) lines.push(`실현손익 ${formatNumber(event.realizedPnl)}`);
  }
  if (event.type === 'MANUAL_PORTFOLIO_ENTRY') lines.push('', '등록방식: 수동등록');
  if (event.executionMethod) lines.push('', `실행방식: ${event.executionMethod === 'AUTO_POLICY' ? '자동매매 정책' : '사용자 승인'}`);
  const occurredAt = kstTimestamp(event.occurredAt);
  if (occurredAt) lines.push(`시각: ${occurredAt}`);
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
    private readonly personalAlertSender?: PersonalAlertSender,
    private readonly ownerMemberId: string | null = process.env.TELEGRAM_OWNER_MEMBER_ID?.trim() || null,
    private readonly ownerAutoTradingChatId: string | null = process.env.TELEGRAM_AUTO_TRADING_CHAT_ID?.trim() || null,
  ) {}

  private async personalTelegramEligible(userId: string) {
    const profile = await this.repository.getPersonalTelegramMemberProfile(userId);
    return hasCanonicalMemberAccessState(profile) && hasCapability(profile, 'canConnectPersonalTelegram');
  }

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
    if (!await this.personalTelegramEligible(userId)) throw new Error('TELEGRAM_MEMBER_INELIGIBLE');
    await this.repository.bindTelegramConnection({ userId, telegramChatId: chatId, telegramUserId, status: 'ACTIVE', connectedAt: timestamp, revokedAt: null, updatedAt: timestamp });
    return { userId, connected: true };
  }
  async revokeTelegram(userId: string, now = new Date()) { await this.repository.revokeTelegramConnection(userId, now.toISOString()); }
  async getState(userId: string) {
    const connection = await this.repository.getTelegramConnection(userId);
    const preferences = await this.repository.getPreferences(userId);
    const deliveries = await this.repository.listDeliveries(userId);
    return { telegram: { connected: connection?.status === 'ACTIVE', status: connection?.status ?? 'DISCONNECTED', connectedAt: connection?.connectedAt ?? null }, preferences,
      deliveries: deliveries.map(({ userId: _userId, dedupeKey: _dedupeKey, payload: _payload, ...delivery }) => delivery) };
  }
  async savePreferences(userId: string, patch: Partial<NotificationPreferences>, now = new Date()) {
    const current = await this.repository.getPreferences(userId); const allowed = new Set<string>(NOTIFICATION_PREFERENCE_KEYS); const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key) || typeof value !== 'boolean') throw new Error('NOTIFICATION_PREFERENCE_INVALID');
      next[key as keyof NotificationPreferences] = value;
    }
    await this.repository.savePreferences(userId, next, now.toISOString()); return next;
  }
  async recordEvent(event: UserExecutionEvent, now = new Date(), membership: MemberTier = 'pending') {
    // Capture whether delivery was authorized AT FIRST PERSISTENCE. A crash
    // may be replayed, but a user connecting Telegram or enabling preferences
    // later must not receive a flood of historical orders retroactively.
    const preferences = await this.repository.getPreferences(event.userId);
    const connection = await this.repository.getTelegramConnection(event.userId);
    const eligible = personalTelegramEventAllowed(membership, event);
    const eventAtMs = Date.parse(event.occurredAt);
    const connectionAtMs = Date.parse(connection?.connectedAt ?? '');
    const deliveryIntended = Boolean(preferences[event.type] && eligible
      && connection?.status === 'ACTIVE'
      && Number.isFinite(eventAtMs) && Number.isFinite(connectionAtMs)
      && eventAtMs >= connectionAtMs);
    const proposed: UserExecutionEvent = {
      ...event,
      metadata: { ...event.metadata, telegramDeliveryIntendedAtInsert: deliveryIntended },
    };
    const inserted = await this.repository.insertExecutionEvent(proposed);
    // Replay the persisted source identity after a crash; never turn an
    // earlier USER_APPROVED event into AUTO_POLICY under the same source ID.
    const canonical = inserted
      ? proposed
      : await this.repository.getExecutionEventBySource(event.userId, event.sourceEventId);
    if (!canonical || canonical.userId !== event.userId || canonical.sourceEventId !== event.sourceEventId) {
      throw new Error('EXECUTION_SOURCE_EVENT_RECOVERY_REQUIRED');
    }
    if (canonical.type !== event.type || canonical.source !== event.source
      || canonical.executionMethod !== event.executionMethod
      || canonical.orderPlanId !== event.orderPlanId
      || canonical.executionId !== event.executionId
      || canonical.symbol !== event.symbol || canonical.market !== event.market
      || canonical.side !== event.side) {
      throw new Error('EXECUTION_SOURCE_EVENT_LINEAGE_CONFLICT');
    }
    if (canonical.type !== 'MANUAL_PORTFOLIO_ENTRY') await this.portfolioSink.accept(canonical);
    if (!preferences[canonical.type]) return { inserted, deliveryQueued: false };
    if (!eligible) return { inserted, deliveryQueued: false, skipped: 'MEMBERSHIP_SCOPE' as const };
    if (!connection || connection.status !== 'ACTIVE') return { inserted, deliveryQueued: false };
    if (canonical.metadata.telegramDeliveryIntendedAtInsert !== true) {
      return { inserted, deliveryQueued: false };
    }
    const timestamp = now.toISOString();
    const delivery: NotificationDelivery = {
      id: randomUUID(), userId: canonical.userId, eventId: canonical.id, dedupeKey: `${canonical.id}:${canonical.type}`,
      state: 'PENDING', attempts: 0, nextRetryAt: null, lastErrorCode: null, createdAt: timestamp, updatedAt: timestamp,
      kind: 'EXECUTION_EVENT', payload: null,
    };
    const deliveryQueued = await this.repository.enqueueDelivery(delivery);
    return { inserted, deliveryQueued, deliveryId: deliveryQueued ? delivery.id : null };
  }
  async processDelivery(userId: string, deliveryId: string, now = new Date()) {
    const timestamp = now.toISOString(); const claimed = await this.repository.claimDelivery(userId, deliveryId, timestamp);
    if (!claimed) return { processed: false, state: null as null };
    const connection = await this.repository.getTelegramConnection(userId);
    if (!connection || connection.status !== 'ACTIVE') {
      const result = await this.repository.finishDelivery(userId, deliveryId, 'DEAD_LETTER', claimed.attempts, null,
        'TELEGRAM_DISCONNECTED', timestamp);
      return { processed: true, state: result?.state ?? 'DEAD_LETTER' };
    }

    let eligible: boolean;
    try {
      eligible = await this.personalTelegramEligible(userId);
    } catch {
      const attempt = claimed.attempts + 1;
      const dead = attempt >= MAX_DELIVERY_ATTEMPTS;
      const state = dead ? 'DEAD_LETTER' as const : 'RETRY_SCHEDULED' as const;
      const result = await this.repository.finishDelivery(
        userId,
        deliveryId,
        state,
        attempt,
        dead ? null : nextRetryAt(now, attempt),
        'TELEGRAM_MEMBER_ELIGIBILITY_UNAVAILABLE',
        timestamp,
      );
      return { processed: true, state: result?.state ?? state };
    }
    if (!eligible) {
      const result = await this.repository.finishDelivery(
        userId,
        deliveryId,
        'DEAD_LETTER',
        claimed.attempts,
        null,
        'TELEGRAM_MEMBER_INELIGIBLE',
        timestamp,
      );
      return { processed: true, state: result?.state ?? 'DEAD_LETTER' };
    }

    const kind = claimed.kind ?? 'EXECUTION_EVENT';
    if (kind === 'PERSONAL_ALERT') {
      const payload = claimed.payload;
      if (!payload || payload.event.userId !== userId || !this.personalAlertSender) {
        const result = await this.repository.finishDelivery(userId, deliveryId, 'DEAD_LETTER', claimed.attempts, null,
          !payload || payload.event.userId !== userId ? 'PERSONAL_ALERT_PAYLOAD_INVALID' : 'PERSONAL_ALERT_SENDER_UNAVAILABLE', timestamp);
        return { processed: true, state: result?.state ?? 'DEAD_LETTER' };
      }
      const attempt = claimed.attempts + 1;
      let alertResult: TelegramAlertResult;
      try {
        alertResult = await this.personalAlertSender({
          ...payload.alert,
          destinationChatId: connection.telegramChatId,
          duplicateWindowMs: 0,
          cooldownMs: 0,
        });
      } catch {
        alertResult = { ok: false, attempts: 0, skipped: 'DELIVERY_FAILED' };
      }
      if (alertResult.ok) {
        await this.repository.finishDelivery(userId, deliveryId, 'SENT', attempt, null, null, timestamp);
        return { processed: true, state: 'SENT' as const };
      }
      const dead = attempt >= MAX_DELIVERY_ATTEMPTS;
      const state = dead ? 'DEAD_LETTER' as const : 'RETRY_SCHEDULED' as const;
      await this.repository.finishDelivery(userId, deliveryId, state, attempt, dead ? null : nextRetryAt(now, attempt),
        `TELEGRAM_${alertResult.skipped}`.slice(0, 120), timestamp);
      return { processed: true, state };
    }

    if (!claimed.eventId) {
      const result = await this.repository.finishDelivery(userId, deliveryId, 'DEAD_LETTER', claimed.attempts, null,
        'EVENT_NOT_FOUND', timestamp);
      return { processed: true, state: result?.state ?? 'DEAD_LETTER' };
    }
    const event = await this.repository.getExecutionEvent(userId, claimed.eventId);
    if (!event) {
      const result = await this.repository.finishDelivery(userId, deliveryId, 'DEAD_LETTER', claimed.attempts, null,
        'EVENT_NOT_FOUND', timestamp);
      return { processed: true, state: result?.state ?? 'DEAD_LETTER' };
    }
    const attempt = claimed.attempts + 1;
    const rendered = renderUserExecutionTelegramMessage(event);
    let transportResult: Awaited<ReturnType<TelegramTransport['send']>>;
    try { transportResult = await this.transport.send(connection.telegramChatId, rendered); }
    catch { transportResult = { ok: false, errorCode: 'TELEGRAM_TRANSPORT_ERROR' }; }
    if (transportResult.ok) {
      if (
        event.executionMethod === 'AUTO_POLICY'
        && this.ownerMemberId
        && this.ownerMemberId === event.userId
        && this.ownerAutoTradingChatId
        && this.ownerAutoTradingChatId !== connection.telegramChatId
      ) {
        try {
          await this.transport.send(this.ownerAutoTradingChatId, rendered);
        } catch {
          // Owner mirror is advisory and never changes the canonical member delivery state.
        }
      }
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
