import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_EXTERNAL_REVIEW_STATUS,
  JOURNAL_COST_SAFETY,
  JOURNAL_INTEGRATION_BASE_SHA,
  TOSS_LIVE_READ_INTEGRATION,
  buildUnifiedTradeJournal,
  maskBrokerAccountReference,
  normalizeTossOrderContract,
  tossJournalIntegrationStatus,
  type TossOrderContract,
  type UnifiedTradeOrder,
} from './unified-trade-journal.service';

const NOW = new Date('2026-08-12T03:00:00.000Z');

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

function tossOrder(overrides: Partial<TossOrderContract> = {}): TossOrderContract {
  return {
    orderId: 'toss-order-1',
    symbol: '005930',
    side: 'BUY',
    orderType: 'LIMIT',
    timeInForce: 'DAY',
    status: 'FILLED',
    price: '70000',
    quantity: '10',
    orderAmount: null,
    currency: 'KRW',
    orderedAt: '2026-03-28T09:30:00+09:00',
    canceledAt: null,
    execution: {
      filledQuantity: '10',
      averageFilledPrice: '70000',
      filledAmount: '700000',
      commission: '1400',
      tax: '0',
      filledAt: '2026-03-28T09:31:15+09:00',
      settlementDate: '2026-03-30',
    },
    ...overrides,
  };
}

test('Toss official aggregate order contract normalizes without retaining the account reference', () => {
  const rawAccount = 'brokerage-account-seq-1234';
  const normalized = normalizeTossOrderContract(tossOrder(), rawAccount, '2026-08-12T01:00:00.000Z');
  assert.equal(normalized.source, 'TOSS_API');
  assert.equal(normalized.market, 'KR_STOCK');
  assert.equal(normalized.filledQuantity, 10);
  assert.equal(normalized.remainingQuantity, 0);
  assert.equal(normalized.averageFillPrice, 70_000);
  assert.equal(normalized.idempotencyBasis, 'aggregate-cumulative');
  assert.match(normalized.executionKey, /^TOSS_AGGREGATE:toss-order-1:10:/);
  assert.match(normalized.accountIdMasked, /^TOSS-\*\*\*\*-/);
  assert.doesNotMatch(JSON.stringify(normalized), new RegExp(rawAccount));
  assert.equal(normalized.fillId, null);
  assert.ok(normalized.warnings.includes('TOSS_ORDER_EXECUTION_IS_CUMULATIVE_AGGREGATE_WITHOUT_FILL_ID'));
});

test('Toss partial fill remains an aggregate snapshot and validates price/time requirements', () => {
  const partial = normalizeTossOrderContract(tossOrder({
    status: 'PARTIAL_FILLED',
    quantity: '10',
    execution: {
      filledQuantity: '3', averageFilledPrice: '185.25', filledAmount: '555.75', commission: '0.99', tax: '0',
      filledAt: '2026-03-28T23:31:15+09:00', settlementDate: null,
    },
    currency: 'USD', symbol: 'AAPL', side: 'BUY', price: null,
  }), 'us-account');
  assert.equal(partial.status, 'PARTIALLY_FILLED');
  assert.equal(partial.market, 'US_STOCK');
  assert.equal(partial.remainingQuantity, 7);
  assert.equal(partial.currency, 'USD');
  assert.throws(() => normalizeTossOrderContract(tossOrder({
    execution: { ...tossOrder().execution, averageFilledPrice: null },
  }), 'account'), /평균가와 체결시각/);
});

test('multiple entries and partial exits form one cycle, while a flat re-entry starts a new cycle', () => {
  const payloads = [
    order({ brokerOrderId: 'buy-1', filledAt: '2026-08-10T01:00:00.000Z', observedAt: '2026-08-10T01:00:01.000Z', averageFillPrice: 100, filledQuantity: 10, quantity: 10, remainingQuantity: 0 }),
    order({ brokerOrderId: 'buy-2', filledAt: '2026-08-10T01:10:00.000Z', observedAt: '2026-08-10T01:10:01.000Z', averageFillPrice: 110, filledQuantity: 10, quantity: 10, remainingQuantity: 0 }),
    order({ brokerOrderId: 'sell-1', side: 'SELL', positionEffect: 'CLOSE', filledAt: '2026-08-10T02:00:00.000Z', observedAt: '2026-08-10T02:00:01.000Z', averageFillPrice: 120, filledQuantity: 8, quantity: 8, remainingQuantity: 0 }),
    order({ brokerOrderId: 'sell-2', side: 'SELL', positionEffect: 'CLOSE', filledAt: '2026-08-10T03:00:00.000Z', observedAt: '2026-08-10T03:00:01.000Z', averageFillPrice: 90, filledQuantity: 12, quantity: 12, remainingQuantity: 0 }),
    order({ brokerOrderId: 'buy-3', filledAt: '2026-08-10T04:00:00.000Z', observedAt: '2026-08-10T04:00:01.000Z', averageFillPrice: 80, filledQuantity: 5, quantity: 5, remainingQuantity: 0 }),
    order({ brokerOrderId: 'sell-3', side: 'SELL', positionEffect: 'CLOSE', filledAt: '2026-08-10T05:00:00.000Z', observedAt: '2026-08-10T05:00:01.000Z', averageFillPrice: 100, filledQuantity: 5, quantity: 5, remainingQuantity: 0 }),
  ];
  const result = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, NOW);
  assert.equal(result.trades.length, 2);
  const first = result.trades.find((trade) => trade.initialEntry.orderId === 'buy-1')!;
  const second = result.trades.find((trade) => trade.initialEntry.orderId === 'buy-3')!;
  assert.equal(first.entryPrice, 105);
  assert.equal(first.additions.length, 1);
  assert.equal(first.partialExits.length, 1);
  assert.equal(first.finalExit?.orderId, 'sell-2');
  assert.equal(first.closedQuantity, 20);
  assert.equal(first.remainingQuantity, 0);
  assert.equal(first.grossPnl, -60);
  assert.equal(first.netPnl, -64);
  assert.equal(first.status, 'CLOSED');
  assert.notEqual(first.id, second.id);
  assert.equal(second.grossPnl, 100);
});

test('cumulative order reconciliation rejects fill regression and terminal status regression', () => {
  const payloads = [
    order({ brokerOrderId: 'cumulative', quantity: 10, filledQuantity: 5, remainingQuantity: 5, status: 'PARTIALLY_FILLED', observedAt: '2026-08-10T01:00:01.000Z' }),
    order({ brokerOrderId: 'cumulative', quantity: 10, filledQuantity: 3, remainingQuantity: 7, status: 'PARTIALLY_FILLED', observedAt: '2026-08-10T01:00:02.000Z' }),
    order({ brokerOrderId: 'terminal', quantity: 10, filledQuantity: 10, remainingQuantity: 0, status: 'FILLED', observedAt: '2026-08-10T01:00:01.000Z' }),
    order({ brokerOrderId: 'terminal', quantity: 10, filledQuantity: 10, remainingQuantity: 0, status: 'OPEN', observedAt: '2026-08-10T01:00:02.000Z' }),
  ];
  const result = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, NOW);
  assert.ok(result.integrityIssues.some((issue) => issue.code === 'FILLED_QUANTITY_REGRESSION'));
  assert.ok(result.integrityIssues.some((issue) => issue.code === 'TERMINAL_STATUS_REGRESSION'));
  assert.equal(result.trades.reduce((sum, trade) => sum + trade.totalQuantity, 0), 15);
});

test('duplicate execution keys are idempotent and conflicting duplicates fail closed', () => {
  const first = order({ brokerOrderId: 'duplicate' });
  const exact = structuredClone(first);
  const conflict = { ...structuredClone(first), averageFillPrice: 101 };
  const result = buildUnifiedTradeJournal([first, exact, conflict], { range: 'ALL' }, NOW);
  assert.equal(result.trades.length, 1);
  assert.ok(result.integrityIssues.some((issue) => issue.code === 'IDEMPOTENCY_KEY_CONFLICT'));
  assert.equal(result.trades[0].entryPrice, 100);
});

test('full account identifiers and quantity mismatches are rejected without dropping other valid records', () => {
  const result = buildUnifiedTradeJournal([
    order({ brokerOrderId: 'valid' }),
    order({ brokerOrderId: 'full-account', accountIdMasked: '1234567890123456' }),
    order({ brokerOrderId: 'bad-quantity', quantity: 10, filledQuantity: 4, remainingQuantity: 9 }),
  ], { range: 'ALL' }, NOW);
  assert.equal(result.trades.length, 1);
  assert.ok(result.integrityIssues.some((issue) => issue.code === 'FULL_ACCOUNT_IDENTIFIER_FORBIDDEN'));
  assert.ok(result.integrityIssues.some((issue) => issue.code === 'TRADE_QUANTITY_MISMATCH'));
});

test('missing pre-trade context remains explicit and is never reconstructed from later fields', () => {
  const result = buildUnifiedTradeJournal([{
    id: 'paper-1', tradeId: 'paper-1', status: 'closed', source: 'APP_PAPER', symbol: 'BTCUSDT', side: 'long',
    currency: 'USDT', filledAt: '2026-08-10T01:00:00.000Z', closedAt: '2026-08-10T02:00:00.000Z',
    entryPrice: 100, exitPrice: 110, initialQuantity: 2, closedQuantity: 2, remainingQuantity: 0,
    grossPnl: 20, netPnl: 18, entryFee: 1, exitFee: 1, marketRegimeAtEntry: 'trend',
  }], { range: 'ALL' }, NOW);
  const snapshot = result.trades[0].technicalSnapshot;
  assert.equal(snapshot.contextSource, 'NO_PRE_TRADE_CONTEXT');
  assert.equal(snapshot.marketRegime, null);
  assert.equal(snapshot.rsi, null);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.signalReasons));
  assert.ok(result.trades[0].review.mistakes.includes('MISSING_PRE_TRADE_CONTEXT'));
});

test('performance and deterministic quality scores stay separate', () => {
  const profitableRuleBreak = {
    id: 'manual-win', status: 'closed', source: 'TOSS_MANUAL', market: 'US_STOCK', symbol: 'AAPL', side: 'long',
    currency: 'USD', filledAt: '2026-08-10T01:00:00.000Z', closedAt: '2026-08-10T02:00:00.000Z',
    entryPrice: 100, exitPrice: 120, initialQuantity: 1, closedQuantity: 1, remainingQuantity: 0,
    grossPnl: 20, netPnl: 19, fees: 1, ruleViolation: true,
  };
  const result = buildUnifiedTradeJournal([profitableRuleBreak], { range: 'ALL' }, NOW);
  const review = result.trades[0].review;
  assert.ok(review.performanceScore > review.qualityScore);
  assert.equal(review.externalAiCalled, false);
  assert.equal(review.deterministic, true);
  assert.ok(review.bad.some((item) => item.includes('규칙 위반')));
});

test('filters cover range, market, source, broker, account, strategy, timeframe, and grade', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `trade-${index}`, tradeId: `trade-${index}`, status: 'closed', source: index % 2 ? 'APP_SHADOW' : 'APP_PAPER',
    broker: 'APP', accountIdMasked: index % 2 ? 'APP-****-ODD' : 'APP-****-EVEN',
    market: index % 2 ? 'US_STOCK' : 'CRYPTO_FUTURES', symbol: index % 2 ? 'AAPL' : 'BTCUSDT', side: 'long',
    currency: index % 2 ? 'USD' : 'USDT', filledAt: `2026-08-${String(index + 5).padStart(2, '0')}T01:00:00.000Z`,
    closedAt: `2026-08-${String(index + 5).padStart(2, '0')}T02:00:00.000Z`, entryPrice: 100, exitPrice: 110,
    initialQuantity: 1, closedQuantity: 1, remainingQuantity: 0, grossPnl: 10, netPnl: 9,
    strategyName: index % 2 ? 'swing' : 'breakout', timeframe: index % 2 ? '1d' : '15m', stopLossPrice: 90,
  }));
  const result = buildUnifiedTradeJournal(rows, { range: '30D', market: 'US_STOCK', source: 'APP_SHADOW', broker: 'APP', account: 'APP-****-ODD', strategy: 'swing', timeframe: '1d' }, NOW);
  assert.equal(result.trades.length, 3);
  assert.ok(result.trades.every((trade) => trade.market === 'US_STOCK' && trade.source === 'APP_SHADOW' && trade.broker === 'APP' && trade.accountIdMasked === 'APP-****-ODD'));
  const gradeFiltered = buildUnifiedTradeJournal(rows, { range: 'ALL', grade: result.trades[0].review.grade }, NOW);
  assert.ok(gradeFiltered.trades.length >= result.trades.length);
});

test('direct journal records preserve every supported provider provenance', () => {
  const expected = new Map([
    ['TOSS_MANUAL', 'TOSS'],
    ['TOSS_API', 'TOSS'],
    ['KIWOOM_API', 'KIWOOM'],
    ['UPBIT_API', 'UPBIT'],
    ['BITGET_API', 'BITGET'],
    ['APP_PAPER', 'APP'],
    ['APP_SHADOW', 'APP'],
    ['APP_AUTO', 'APP'],
  ]);
  const rows = [...expected.keys()].map((source, index) => ({
    id: `provider-${index}`, status: 'closed', source, market: 'KR_STOCK', symbol: `P${index}`, side: 'long', currency: 'KRW',
    filledAt: '2026-08-10T01:00:00.000Z', closedAt: '2026-08-10T02:00:00.000Z', entryPrice: 100, exitPrice: 101,
    initialQuantity: 1, closedQuantity: 1, remainingQuantity: 0, grossPnl: 1, netPnl: 1,
  }));
  const result = buildUnifiedTradeJournal(rows, { range: 'ALL' }, NOW);
  assert.equal(result.trades.length, expected.size);
  for (const trade of result.trades) assert.equal(trade.broker, expected.get(trade.source));
  assert.equal(buildUnifiedTradeJournal(rows, { range: 'ALL', broker: 'UPBIT' }, NOW).trades[0]?.source, 'UPBIT_API');
});

test('small samples return N/A analytics while five trades produce confirmed aggregates and monthly report', () => {
  const row = (index: number) => ({
    id: `sample-${index}`, status: 'closed', source: 'APP_AUTO', market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', side: 'long', currency: 'KRW',
    filledAt: `2026-08-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`, closedAt: `2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`,
    entryPrice: 100, exitPrice: index % 2 ? 90 : 120, initialQuantity: 1, closedQuantity: 1, remainingQuantity: 0,
    grossPnl: index % 2 ? -10 : 20, netPnl: index % 2 ? -11 : 19, fees: 1, strategy: 'spot', timeframe: '1h', stopLossPrice: 90,
  });
  const small = buildUnifiedTradeJournal([row(0), row(1), row(2)], { range: 'ALL' }, NOW);
  assert.equal(small.analytics.winRate, null);
  assert.equal(small.analytics.profitFactor, null);
  assert.ok(small.analytics.warnings[0].includes('최소 5건'));
  const enough = buildUnifiedTradeJournal(Array.from({ length: 6 }, (_, index) => row(index)), { range: 'ALL' }, NOW);
  assert.notEqual(enough.analytics.winRate, null);
  assert.notEqual(enough.analytics.profitFactor, null);
  assert.equal(enough.analytics.monthlyReport.length, 1);
  assert.equal(enough.analytics.netPnlByCurrency[0].currency, 'KRW');
});

test('free-only integration status exposes zero paid activation and zero trading mutations', () => {
  const status = tossJournalIntegrationStatus();
  assert.equal(status.liveReadIntegration, TOSS_LIVE_READ_INTEGRATION);
  assert.equal(status.paidStatus, 'PAID_STATUS_UNVERIFIED');
  assert.equal(status.livePrivateRequests, 0);
  assert.equal(JOURNAL_COST_SAFETY.finalCostDelta, '0_KRW');
  assert.equal(JOURNAL_COST_SAFETY.actualOrderRequests, 0);
  assert.equal(JOURNAL_COST_SAFETY.cancelRequests, 0);
  assert.equal(JOURNAL_COST_SAFETY.amendRequests, 0);
  assert.equal(JOURNAL_COST_SAFETY.transferRequests, 0);
  assert.equal(JOURNAL_COST_SAFETY.withdrawalRequests, 0);
  const result = buildUnifiedTradeJournal([], {}, NOW);
  assert.equal(result.integrationBaseSha, JOURNAL_INTEGRATION_BASE_SHA);
  assert.equal(result.aiReviewStatus, AI_EXTERNAL_REVIEW_STATUS);
  assert.equal(result.safety.privateBrokerRequests, 0);
});

test('account mask is deterministic per broker and never includes the source reference', () => {
  const first = maskBrokerAccountReference('TOSS', 'account-reference');
  const second = maskBrokerAccountReference('TOSS', 'account-reference');
  assert.equal(first, second);
  assert.doesNotMatch(first, /account-reference/);
  assert.notEqual(first, maskBrokerAccountReference('KIWOOM', 'account-reference'));
});
