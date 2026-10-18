import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnifiedTradeJournal,
  type JournalCostEvidence,
  type UnifiedTradeOrder,
} from './unified-trade-journal.service';

const NOW = new Date('2026-08-12T03:00:00.000Z');

function readyCostEvidence(): JournalCostEvidence {
  return {
    status: 'READY',
    reasons: [],
    fees: { status: 'READY', source: 'CANONICAL_ORDER_RECORD', reason: null },
    tax: { status: 'READY', source: 'CANONICAL_ORDER_RECORD', reason: null },
  };
}

function order(overrides: Partial<UnifiedTradeOrder> = {}): UnifiedTradeOrder {
  const brokerOrderId = overrides.brokerOrderId ?? 'order-1';
  const filledQuantity = overrides.filledQuantity ?? 10;
  const quantity = overrides.quantity ?? 10;
  const filledAt = overrides.filledAt === undefined ? '2026-08-10T01:00:00.000Z' : overrides.filledAt;
  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'TOSS_MANUAL',
    broker: 'MANUAL',
    accountIdMasked: 'MANUAL-****-1234567890',
    market: 'KR_STOCK',
    symbol: '005930',
    side: 'BUY',
    positionSide: 'LONG',
    positionEffect: 'OPEN',
    clientOrderId: null,
    brokerOrderId,
    fillId: null,
    executionKey: `MANUAL_AGGREGATE:${brokerOrderId}:${filledQuantity}:${filledAt}`,
    idempotencyBasis: 'aggregate-cumulative',
    orderedAt: '2026-08-10T00:59:00.000Z',
    filledAt,
    observedAt: filledAt ?? '2026-08-10T01:00:00.000Z',
    quantity,
    filledQuantity,
    remainingQuantity: quantity - filledQuantity,
    averageFillPrice: filledQuantity > 0 ? 100 : null,
    fees: 1,
    tax: 0,
    costEvidence: readyCostEvidence(),
    currency: 'KRW',
    status: filledQuantity === quantity ? 'FILLED' : 'PARTIALLY_FILLED',
    strategy: 'breakout',
    timeframe: '15m',
    stopLossPrice: 90,
    targetPrice: 120,
    ruleViolation: false,
    warnings: [],
    technicalSnapshot: {
      snapshotId: 'snapshot-1',
      contextSource: 'PRE_TRADE_SNAPSHOT',
      capturedAt: '2026-08-10T00:58:00.000Z',
      timeframe: '15m',
      price: 99,
      rsi: 55,
      macd: 1,
      macdSignal: 0.5,
      movingAverageFast: 98,
      movingAverageSlow: 95,
      support: 90,
      resistance: 120,
      volumeRatio: 1.5,
      volatilityPercent: 2,
      signalScore: 82,
      marketRegime: 'TREND',
      marketStructure: 'HIGHER_HIGH',
      signalReasons: ['volume', 'trend'],
    },
    ...overrides,
  };
}

test('adding after a partial exit averages only the quantity still held', () => {
  const payloads = [
    order({ brokerOrderId: 'avg-buy-1', filledAt: '2026-08-10T01:00:00.000Z', observedAt: '2026-08-10T01:00:01.000Z', averageFillPrice: 100, filledQuantity: 10, quantity: 10, remainingQuantity: 0 }),
    order({ brokerOrderId: 'avg-sell-1', side: 'SELL', positionEffect: 'CLOSE', filledAt: '2026-08-10T02:00:00.000Z', observedAt: '2026-08-10T02:00:01.000Z', averageFillPrice: 110, filledQuantity: 5, quantity: 5, remainingQuantity: 0 }),
    order({ brokerOrderId: 'avg-buy-2', filledAt: '2026-08-10T03:00:00.000Z', observedAt: '2026-08-10T03:00:01.000Z', averageFillPrice: 120, filledQuantity: 5, quantity: 5, remainingQuantity: 0 }),
    order({ brokerOrderId: 'avg-sell-2', side: 'SELL', positionEffect: 'CLOSE', filledAt: '2026-08-10T04:00:00.000Z', observedAt: '2026-08-10T04:00:01.000Z', averageFillPrice: 110, filledQuantity: 10, quantity: 10, remainingQuantity: 0 }),
  ];
  const [trade] = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, NOW).trades;
  // 5 @ +10 realized, then 10 held at an average of 110 sold at 110.
  assert.equal(trade.entryPrice, 110);
  assert.equal(trade.grossPnl, 50);
});
