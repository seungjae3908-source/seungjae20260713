import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PaperJournalRepository, StoredPaperJournalRecord } from '../../services/paper-journal.types';
import type { TradingExchange } from '../../services/trade-automation.types';
import type { UnifiedTradeOrder } from '../../services/unified-trade-journal.service';
import type { MemberTier } from '../../../../packages/member-access/src/index.js';
import { manualPortfolioEvent, UserBrokerTelegramService } from './user-broker-telegram.service';
import type { PortfolioSyncSink, UserExecutionEvent } from './user-broker-telegram.types';

function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function brokerName(exchange: TradingExchange | null): UnifiedTradeOrder['broker'] {
  if (exchange === 'upbit') return 'UPBIT';
  if (exchange === 'bitget') return 'BITGET';
  if (exchange === 'kiwoom') return 'KIWOOM';
  return 'APP';
}

function marketFor(exchange: TradingExchange | null): { market: UnifiedTradeOrder['market']; currency: UnifiedTradeOrder['currency'] } {
  if (exchange === 'upbit') return { market: 'CRYPTO_SPOT', currency: 'KRW' };
  if (exchange === 'bitget') return { market: 'CRYPTO_FUTURES', currency: 'USDT' };
  return { market: 'KR_STOCK', currency: 'KRW' };
}

function maskedAccount(event: UserExecutionEvent) {
  const broker = brokerName(event.brokerConnectionRef);
  return event.maskedAccount
    ? `${broker}-${event.maskedAccount}`
    : `${broker}-****-UNAVAILABLE`;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tradePayload(event: UserExecutionEvent): UnifiedTradeOrder | null {
  if (!['ORDER_PARTIALLY_FILLED', 'ORDER_FILLED', 'TAKE_PROFIT_FILLED', 'STOP_FILLED'].includes(event.type)) return null;
  const filledQuantity = finite(event.quantity);
  const averageFillPrice = finite(event.price);
  if (filledQuantity == null || filledQuantity <= 0 || averageFillPrice == null || averageFillPrice <= 0) return null;
  const remainingQuantity = Math.max(0, finite(event.remainingQuantity) ?? 0);
  const quantity = filledQuantity + remainingQuantity;
  const { market, currency } = marketFor(event.brokerConnectionRef);
  const broker = brokerName(event.brokerConnectionRef);
  const isExit = event.side === 'sell' || event.side === 'short' || event.type === 'TAKE_PROFIT_FILLED' || event.type === 'STOP_FILLED';
  const status: UnifiedTradeOrder['status'] = event.type === 'ORDER_PARTIALLY_FILLED' ? 'PARTIALLY_FILLED' : 'FILLED';
  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: event.source === 'PAPER_EXECUTION' ? 'APP_PAPER' : 'APP_AUTO',
    broker,
    accountIdMasked: maskedAccount(event),
    market,
    symbol: event.symbol,
    side: isExit ? 'SELL' : 'BUY',
    positionSide: event.side === 'short' ? 'SHORT' : 'LONG',
    positionEffect: isExit ? 'CLOSE' : 'OPEN',
    clientOrderId: event.executionId,
    brokerOrderId: event.executionId ?? event.sourceEventId,
    fillId: null,
    executionKey: `APP_EVENT:${event.sourceEventId}`,
    idempotencyBasis: 'aggregate-cumulative',
    orderedAt: event.occurredAt,
    filledAt: event.occurredAt,
    observedAt: event.occurredAt,
    quantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice,
    fees: finite(event.metadata.feeAmount) ?? 0,
    tax: finite(event.metadata.taxAmount) ?? 0,
    currency,
    status,
    strategy: event.strategy,
    timeframe: typeof event.metadata.timeframe === 'string' ? event.metadata.timeframe.slice(0, 20) : null,
    stopLossPrice: finite(event.metadata.stopPrice),
    targetPrice: finite(event.metadata.targetPrice),
    ruleViolation: false,
    warnings: event.source === 'BROKER_EXECUTION' ? [] : ['SOURCE_PAPER_EXECUTION'],
    technicalSnapshot: {
      snapshotId: `execution:${stableId(event.sourceEventId)}`,
      contextSource: 'NO_PRE_TRADE_CONTEXT',
      capturedAt: null,
      timeframe: null,
      price: null,
      rsi: null,
      macd: null,
      macdSignal: null,
      movingAverageFast: null,
      movingAverageSlow: null,
      support: null,
      resistance: null,
      volumeRatio: null,
      volatilityPercent: null,
      signalScore: null,
      marketRegime: null,
      marketStructure: null,
      signalReasons: [],
    },
  };
}

export class CanonicalPortfolioSyncSink implements PortfolioSyncSink {
  constructor(
    private readonly repository: PaperJournalRepository,
    private readonly authenticatedUserId: string,
  ) {}

  async accept(event: UserExecutionEvent) {
    if (event.userId !== this.authenticatedUserId) throw new Error('PORTFOLIO_OWNER_MISMATCH');
    if (event.type === 'MANUAL_PORTFOLIO_ENTRY') return;
    const payload = tradePayload(event);
    if (!payload) return;
    const id = `broker-exec-${stableId(`${event.userId}:${event.sourceEventId}`)}`;
    const existing = await this.repository.getRecord(event.userId, 'journal', id);
    if (existing) {
      if (!isDeepStrictEqual(existing.payload, payload)) throw new Error('PORTFOLIO_EVENT_CONFLICT');
      return;
    }
    await this.repository.upsertRecord(event.userId, {
      kind: 'journal',
      id,
      version: 1,
      updatedAt: event.occurredAt,
      deletedAt: null,
      payload: payload as unknown as Record<string, unknown>,
    }, event.occurredAt);
  }
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function queueManualPortfolioNotifications(
  userId: string,
  uploaded: StoredPaperJournalRecord[],
  service: UserBrokerTelegramService,
  membership: MemberTier = 'admin',
) {
  let queued = 0;
  for (const record of uploaded) {
    if (record.kind !== 'journal' || record.deletedAt) continue;
    const payload = record.payload ?? {};
    const source = String(payload.source ?? payload.registrationMethod ?? '').toUpperCase();
    if (!['TOSS_MANUAL', 'MANUAL', 'MANUAL_PORTFOLIO_ENTRY'].includes(source)) continue;
    const symbol = text(payload.symbol);
    const quantity = positive(payload.quantity ?? payload.initialQuantity ?? payload.filledQuantity);
    const price = positive(payload.price ?? payload.entryPrice ?? payload.averageFillPrice);
    if (!symbol || quantity == null || price == null) continue;
    const event = manualPortfolioEvent({
      id: `manual-journal:${record.id}:${record.version}`,
      userId,
      symbol,
      market: text(payload.market) ?? 'MANUAL',
      side: payload.side === 'sell' || payload.side === 'short' ? payload.side : 'buy',
      quantity,
      price,
      occurredAt: record.updatedAt,
    });
    const result = await service.recordEvent(event, new Date(), membership);
    if (result.deliveryQueued) queued += 1;
  }
  return { queued, brokerSubmitCount: 0 as const, privateApiRequests: 0 as const };
}
