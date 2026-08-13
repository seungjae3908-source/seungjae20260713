import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedTradeJournal, type UnifiedTradeOrder } from '../../services/unified-trade-journal.service.ts';
import { buildAutonomousCapitalLab } from './autonomous-capital-lab.ts';
import { buildCanonicalJournalPortfolioAdvisor } from './canonical-journal-adapter.ts';

const NOW = new Date('2026-08-12T03:00:00.000Z');

function order(overrides: Partial<UnifiedTradeOrder> = {}): UnifiedTradeOrder {
  const brokerOrderId = overrides.brokerOrderId ?? 'buy-1';
  const filledAt = overrides.filledAt === undefined ? '2026-08-12T02:58:30.000Z' : overrides.filledAt;
  const quantity = overrides.quantity ?? 10;
  const filledQuantity = overrides.filledQuantity ?? quantity;
  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'APP_PAPER',
    broker: 'APP',
    accountIdMasked: 'APP-****-paper',
    market: 'US_STOCK',
    symbol: 'AAPL',
    side: 'BUY',
    positionSide: 'LONG',
    positionEffect: 'OPEN',
    clientOrderId: null,
    brokerOrderId,
    fillId: null,
    executionKey: `APP_AGGREGATE:${brokerOrderId}:${filledQuantity}:${filledAt}`,
    idempotencyBasis: 'aggregate-cumulative',
    orderedAt: '2026-08-12T02:58:00.000Z',
    filledAt,
    observedAt: filledAt ?? '2026-08-12T02:58:30.000Z',
    quantity,
    filledQuantity,
    remainingQuantity: quantity - filledQuantity,
    averageFillPrice: 100,
    fees: 0,
    tax: 0,
    currency: 'USD',
    status: filledQuantity === quantity ? 'FILLED' : 'PARTIALLY_FILLED',
    strategy: 'paper-test',
    timeframe: '15m',
    stopLossPrice: 90,
    targetPrice: 120,
    ruleViolation: false,
    warnings: [],
    technicalSnapshot: {
      snapshotId: `snapshot-${brokerOrderId}`,
      contextSource: 'PRE_TRADE_SNAPSHOT',
      capturedAt: '2026-08-12T02:59:00.000Z',
      timeframe: '15m',
      price: 110,
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
    ...overrides,
  };
}

function metricValue(metric: { status: string; value?: number }): number {
  assert.equal(metric.status, 'available');
  return metric.value as number;
}

test('canonical adapter reads unified open cycle once after duplicate and partial exit', () => {
  const buy = order();
  const exactDuplicate = structuredClone(buy);
  const partialExit = order({
    brokerOrderId: 'sell-1',
    side: 'SELL',
    positionEffect: 'CLOSE',
    filledAt: '2026-08-12T02:59:20.000Z',
    observedAt: '2026-08-12T02:59:21.000Z',
    quantity: 4,
    filledQuantity: 4,
    remainingQuantity: 0,
    averageFillPrice: 115,
  });
  const journal = buildUnifiedTradeJournal([buy, exactDuplicate, partialExit], { range: 'ALL' }, NOW);
  const result = buildCanonicalJournalPortfolioAdvisor(journal, NOW);

  assert.equal(result.sourceOfTruth, 'PAPER_JOURNAL_UNIFIED_LEDGER');
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].quantity, 6);
  assert.equal(result.positions[0].averageCost, 100);
  assert.equal(result.positions[0].currentPrice, 110);
  assert.equal(metricValue(result.analytics.unrealizedPnl), 60);
  assert.equal(result.analytics.cashValue.status, 'insufficient');
  assert.equal(result.analytics.totalValue.status, 'insufficient');
  assert.equal(result.stateEvidence.openRiskByCurrency.status, 'available');
  assert.equal(result.stateEvidence.openRiskByCurrency.value.USD, 120);
  assert.equal(result.advisor.orderAuthority, 'none');
  assert.equal(result.safety.privateTradingApiRequests, 0);
});

test('stale snapshot price is not promoted to current market evidence', () => {
  const stale = order({
    technicalSnapshot: {
      ...order().technicalSnapshot,
      capturedAt: '2026-08-12T02:50:00.000Z',
      price: 999,
    },
  });
  const result = buildCanonicalJournalPortfolioAdvisor(buildUnifiedTradeJournal([stale], { range: 'ALL' }, NOW), NOW);
  assert.equal(result.positions[0].currentPrice, null);
  assert.equal(result.stateEvidence.priceEvidence[0].status, 'insufficient');
  assert.equal(result.analytics.unrealizedPnl.status, 'insufficient');
  assert.equal(result.stateEvidence.openRiskByCurrency.status, 'insufficient');
});

test('flat close followed by re-entry exposes only the current open cycle', () => {
  const close = order({
    brokerOrderId: 'sell-flat', side: 'SELL', positionEffect: 'CLOSE',
    filledAt: '2026-08-12T02:58:50.000Z', observedAt: '2026-08-12T02:58:51.000Z',
    quantity: 10, filledQuantity: 10, remainingQuantity: 0, averageFillPrice: 112,
  });
  const reentry = order({
    brokerOrderId: 'buy-reentry', filledAt: '2026-08-12T02:59:10.000Z', observedAt: '2026-08-12T02:59:11.000Z',
    quantity: 3, filledQuantity: 3, remainingQuantity: 0, averageFillPrice: 105,
    technicalSnapshot: { ...order().technicalSnapshot, snapshotId: 'snapshot-reentry', capturedAt: '2026-08-12T02:59:30.000Z', price: 108 },
  });
  const journal = buildUnifiedTradeJournal([order(), close, reentry], { range: 'ALL' }, NOW);
  const result = buildCanonicalJournalPortfolioAdvisor(journal, NOW);
  assert.equal(journal.trades.length, 2);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].quantity, 3);
  assert.equal(result.positions[0].averageCost, 105);
});

test('short portfolio pnl uses short direction and never creates leverage evidence', () => {
  const shortOpen = order({
    brokerOrderId: 'short-open', side: 'SELL', positionSide: 'SHORT', positionEffect: 'OPEN', averageFillPrice: 100,
    technicalSnapshot: { ...order().technicalSnapshot, snapshotId: 'short-snapshot', capturedAt: '2026-08-12T02:59:30.000Z', price: 90 },
    stopLossPrice: 110,
  });
  const result = buildCanonicalJournalPortfolioAdvisor(buildUnifiedTradeJournal([shortOpen], { range: 'ALL' }, NOW), NOW);
  assert.equal(result.positions[0].positionSide, 'SHORT');
  assert.equal(metricValue(result.analytics.unrealizedPnl), 100);
  assert.equal(result.stateEvidence.leverageExposure.status, 'insufficient');
});

test('canonical integrity issues remain visible instead of being silently repaired by portfolio AI', () => {
  const first = order({ brokerOrderId: 'conflict' });
  const conflict = { ...structuredClone(first), averageFillPrice: 101 };
  const journal = buildUnifiedTradeJournal([first, conflict], { range: 'ALL' }, NOW);
  const result = buildCanonicalJournalPortfolioAdvisor(journal, NOW);
  assert.ok(result.stateEvidence.journalIntegrityIssues.some((issue) => issue.code === 'IDEMPOTENCY_KEY_CONFLICT'));
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].averageCost, 100);
});

test('autonomous capital lab keeps exactly 1,000,000 KRW and four research lanes with zero execution authority', () => {
  const journal = buildUnifiedTradeJournal([], { range: 'ALL' }, NOW);
  const result = buildAutonomousCapitalLab(journal, NOW);

  assert.equal(result.capital.initialCapitalKrw, 1_000_000);
  assert.equal(result.capital.invariantKrw, 1_000_000);
  assert.equal(result.capital.reserveKrw + result.lanes.reduce((sum, lane) => sum + lane.allocationKrw, 0), 1_000_000);
  assert.deepEqual(result.lanes.map((lane) => lane.market), ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
  assert.ok(result.lanes.every((lane) => lane.evidenceStatus === 'INSUFFICIENT'));
  assert.deepEqual(result.executionReadiness.compatibleExecutionLanes, ['CRYPTO_FUTURES']);
  assert.deepEqual(result.executionReadiness.blockedExecutionLanes, ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
  assert.equal(result.executionReadiness.allMarketsReady, false);
  assert.equal(result.executionReadiness.automaticPaperExecutionAcrossAllMarkets, false);
  assert.equal(result.lanes.find((lane) => lane.market === 'CRYPTO_FUTURES')?.paperExecutionAuthority, 'simulation-only');
  assert.ok(result.lanes.filter((lane) => lane.market !== 'CRYPTO_FUTURES').every((lane) => (
    lane.paperExecutionReadiness === 'BLOCKED_ENGINE_MARKET_CONTRACT'
    && lane.paperExecutionAuthority === 'none'
    && lane.warnings.includes('PAPER_EXECUTION_MARKET_CONTRACT_BLOCKED')
  )));
  assert.equal(result.autonomousPolicy.livePromotionAllowed, false);
  assert.equal(result.autonomousPolicy.strategyMutationAllowed, false);
  assert.equal(result.safety.actualOrderRequests, 0);
  assert.equal(result.safety.privateTradingApiRequests, 0);
  assert.equal(result.safety.orderAuthority, 'none');
});

test('autonomous capital lab learns only from closed APP_PAPER and APP_SHADOW cycles', () => {
  const paperOpen = order({ brokerOrderId: 'paper-open', symbol: 'AAPL', source: 'APP_PAPER', averageFillPrice: 100 });
  const paperClose = order({
    brokerOrderId: 'paper-close', symbol: 'AAPL', source: 'APP_PAPER', side: 'SELL', positionEffect: 'CLOSE',
    orderedAt: '2026-08-12T02:58:35.000Z', filledAt: '2026-08-12T02:58:40.000Z', observedAt: '2026-08-12T02:58:41.000Z',
    averageFillPrice: 110,
  });
  const shadowOpen = order({
    brokerOrderId: 'shadow-open', symbol: 'MSFT', source: 'APP_SHADOW', averageFillPrice: 100,
    orderedAt: '2026-08-12T02:58:45.000Z', filledAt: '2026-08-12T02:58:50.000Z', observedAt: '2026-08-12T02:58:51.000Z',
  });
  const shadowClose = order({
    brokerOrderId: 'shadow-close', symbol: 'MSFT', source: 'APP_SHADOW', side: 'SELL', positionEffect: 'CLOSE',
    orderedAt: '2026-08-12T02:58:55.000Z', filledAt: '2026-08-12T02:59:00.000Z', observedAt: '2026-08-12T02:59:01.000Z',
    averageFillPrice: 105,
  });
  const autoOpen = order({
    brokerOrderId: 'auto-open', symbol: 'NVDA', source: 'APP_AUTO', averageFillPrice: 100,
    orderedAt: '2026-08-12T02:59:05.000Z', filledAt: '2026-08-12T02:59:10.000Z', observedAt: '2026-08-12T02:59:11.000Z',
  });
  const autoClose = order({
    brokerOrderId: 'auto-close', symbol: 'NVDA', source: 'APP_AUTO', side: 'SELL', positionEffect: 'CLOSE',
    orderedAt: '2026-08-12T02:59:15.000Z', filledAt: '2026-08-12T02:59:20.000Z', observedAt: '2026-08-12T02:59:21.000Z',
    averageFillPrice: 200,
  });

  const journal = buildUnifiedTradeJournal(
    [paperOpen, paperClose, shadowOpen, shadowClose, autoOpen, autoClose],
    { range: 'ALL' },
    NOW,
  );
  const result = buildAutonomousCapitalLab(journal, NOW);
  const usLane = result.lanes.find((lane) => lane.market === 'US_STOCK');

  assert.equal(result.journalCoverage.closedResearchTrades, 2);
  assert.equal(result.journalCoverage.ignoredNonResearchTrades, 1);
  assert.equal(usLane?.sampleSize, 2);
  assert.equal(usLane?.paperTrades, 1);
  assert.equal(usLane?.shadowTrades, 1);
  assert.ok((usLane?.averageReturnPercent ?? 0) > 0);
  assert.equal(result.strategyLeaderboard[0].promotionAuthority, 'none');
  assert.equal(result.championCandidates.length, 0);
});

test('no-loss strategy can become champion-eligible without fabricating a numeric profit factor', () => {
  const payloads: UnifiedTradeOrder[] = [];
  const start = Date.parse('2026-08-12T01:00:00.000Z');

  for (let index = 0; index < 30; index += 1) {
    const source = index < 15 ? 'APP_PAPER' as const : 'APP_SHADOW' as const;
    const symbol = `T${String(index).padStart(2, '0')}`;
    const openAt = new Date(start + index * 60_000).toISOString();
    const closeAt = new Date(start + index * 60_000 + 30_000).toISOString();
    payloads.push(order({
      brokerOrderId: `perfect-open-${index}`,
      source,
      market: 'CRYPTO_FUTURES',
      currency: 'USDT',
      symbol,
      strategy: 'perfect-strategy',
      orderedAt: openAt,
      filledAt: openAt,
      observedAt: openAt,
      averageFillPrice: 100,
      technicalSnapshot: {
        ...order().technicalSnapshot,
        snapshotId: `perfect-open-snapshot-${index}`,
        capturedAt: openAt,
        price: 100,
      },
    }));
    payloads.push(order({
      brokerOrderId: `perfect-close-${index}`,
      source,
      market: 'CRYPTO_FUTURES',
      currency: 'USDT',
      symbol,
      strategy: 'perfect-strategy',
      side: 'SELL',
      positionEffect: 'CLOSE',
      orderedAt: closeAt,
      filledAt: closeAt,
      observedAt: closeAt,
      averageFillPrice: 101,
      technicalSnapshot: {
        ...order().technicalSnapshot,
        snapshotId: `perfect-close-snapshot-${index}`,
        capturedAt: closeAt,
        price: 101,
      },
    }));
  }

  const result = buildAutonomousCapitalLab(buildUnifiedTradeJournal(payloads, { range: 'ALL' }, NOW), NOW);
  const row = result.strategyLeaderboard.find((item) => item.strategy === 'perfect-strategy');

  assert.ok(row);
  assert.equal(row.sampleSize, 30);
  assert.equal(row.paperTrades, 15);
  assert.equal(row.shadowTrades, 15);
  assert.equal(row.losses, 0);
  assert.equal(row.profitFactor, null);
  assert.equal(row.status, 'CHAMPION_ELIGIBLE');
  assert.equal(row.promotionAuthority, 'none');
  assert.equal(result.championCandidates.length, 1);
  assert.equal(result.autonomousPolicy.livePromotionAllowed, false);
});