import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePaperJournalAnalytics, createTradingReviewDataset } from './paper-journal-analytics.service';

const BASE = Date.parse('2026-08-01T00:00:00.000Z');

function trade(index: number, overrides: Record<string, unknown> = {}) {
  const filledAt = new Date(BASE + index * 60 * 60 * 1000).toISOString();
  const closedAt = new Date(BASE + index * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
  return {
    id: `internal-uuid-${index}`,
    tradeId: `trade-${index}`,
    status: 'closed',
    side: index % 2 === 0 ? 'long' : 'short',
    symbol: index % 2 === 0 ? 'BTCUSDT' : 'ETHUSDT',
    strategyName: index % 2 === 0 ? 'breakout' : 'pullback',
    filledAt,
    closedAt,
    netPnl: index % 3 === 0 ? -10 : 20,
    grossPnl: index % 3 === 0 ? -8 : 22,
    rMultiple: index % 3 === 0 ? -1 : 2,
    notionalValue: 1_000,
    leverage: index % 2 === 0 ? 2 : 5,
    riskPercent: index % 2 === 0 ? 0.5 : 0.75,
    stopLossPrice: 90,
    takeProfitPrice1: 110,
    takeProfitPrice2: 120,
    exitReason: index % 3 === 0 ? 'stop_loss' : 'take_profit',
    dataStatusAtEntry: 'live',
    marketRegimeAtEntry: index % 2 === 0 ? 'trend' : 'range',
    entryFee: 0.5,
    exitFee: 0.5,
    slippageCost: 0.5,
    fundingCost: 0.5,
    warnings: [],
    ruleViolation: false,
    note: `private note ${index}`,
    email: `user${index}@example.com`,
    ...overrides,
  };
}

const sample = (count = 12) => Array.from({ length: count }, (_, index) => trade(index));

test('counts only closed valid trades', () => {
  const result = calculatePaperJournalAnalytics([trade(0), { ...trade(1), status: 'open' }, { broken: true }]);
  assert.equal(result.totalTrades, 1);
});

test('calculates total net pnl', () => {
  const result = calculatePaperJournalAnalytics(sample(6));
  assert.equal(result.netPnl, 60);
});

test('calculates wins and losses', () => {
  const result = calculatePaperJournalAnalytics(sample(6));
  assert.equal(result.wins, 4);
  assert.equal(result.losses, 2);
});

test('calculates win rate with enough sample', () => {
  const result = calculatePaperJournalAnalytics(sample(6));
  assert.equal(result.winRate, 4 / 6 * 100);
});

test('calculates expectancy', () => {
  const result = calculatePaperJournalAnalytics(sample(6));
  assert.equal(result.expectancy, 10);
});

test('calculates average R', () => {
  const result = calculatePaperJournalAnalytics(sample(6));
  assert.equal(result.averageR, 1);
});

test('calculates profit factor', () => {
  const result = calculatePaperJournalAnalytics(sample(6));
  assert.equal(result.profitFactor, 4);
});

test('calculates maximum consecutive losses', () => {
  const rows = [trade(0, { netPnl: -1 }), trade(1, { netPnl: -1 }), trade(2, { netPnl: 2 }), trade(3, { netPnl: -1 }), trade(4, { netPnl: -1 }), trade(5, { netPnl: -1 })];
  assert.equal(calculatePaperJournalAnalytics(rows).maximumConsecutiveLosses, 3);
});

test('calculates total costs', () => {
  assert.equal(calculatePaperJournalAnalytics(sample(5)).totalCosts, 10);
});

test('calculates finite cost ratio', () => {
  const value = calculatePaperJournalAnalytics(sample(5)).costRatioPercent;
  assert.equal(typeof value, 'number');
  assert.equal(Number.isFinite(value), true);
});

test('groups long and short performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(20)).bySide;
  assert.deepEqual(groups.map((group) => group.key), ['long', 'short']);
  assert.equal(groups.every((group) => group.sampleSize === 10), true);
});

test('groups symbol performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(20)).bySymbol;
  assert.equal(groups.find((group) => group.key === 'BTCUSDT')?.sampleSize, 10);
});

test('groups strategy performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(20)).byStrategy;
  assert.equal(groups.find((group) => group.key === 'breakout')?.certainty, 'confirmed');
});

test('groups hour performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(12)).byHour;
  assert.equal(groups.some((group) => group.key === '00'), true);
});

test('groups weekday performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(12)).byWeekday;
  assert.equal(groups.length > 0, true);
});

test('groups exit reason performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(12)).byExitReason;
  assert.equal(groups.some((group) => group.key === 'stop_loss'), true);
});

test('groups data status performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(12)).byDataStatus;
  assert.equal(groups[0]?.key, 'live');
});

test('groups market regime performance', () => {
  const groups = calculatePaperJournalAnalytics(sample(20)).byMarketRegime;
  assert.deepEqual(groups.map((group) => group.key), ['range', 'trend']);
});

test('groups leverage buckets', () => {
  const groups = calculatePaperJournalAnalytics(sample(20)).byLeverageBucket;
  assert.deepEqual(groups.map((group) => group.key), ['1-2x', '3-5x']);
});

test('groups risk percent buckets', () => {
  const groups = calculatePaperJournalAnalytics(sample(20)).byRiskBucket;
  assert.deepEqual(groups.map((group) => group.key), ['0.26-0.50%', '0.51-1.00%']);
});

test('calculates stop adherence rate', () => {
  const rows = sample(5);
  rows[0] = trade(0, { ruleViolation: true, warnings: ['손절 없음'] });
  assert.equal(calculatePaperJournalAnalytics(rows).stopAdherenceRate, 80);
});

test('calculates target adherence rate', () => {
  const rows = sample(5).map((row, index) => ({ ...row, exitReason: index < 4 ? 'take_profit' : 'manual_close' }));
  assert.equal(calculatePaperJournalAnalytics(rows).targetAdherenceRate, 80);
});

test('calculates rule violation rate', () => {
  const rows = sample(5);
  rows[0] = trade(0, { ruleViolation: true });
  assert.equal(calculatePaperJournalAnalytics(rows).ruleViolationRate, 20);
});

test('reports confirmed missing stop fact', () => {
  const rows = sample(5);
  rows[0] = trade(0, { stopLossPrice: null });
  assert.match(calculatePaperJournalAnalytics(rows).facts.join(' '), /손절가 없이 기록된 거래 1건/);
});

test('basic metrics are insufficient below five trades', () => {
  const result = calculatePaperJournalAnalytics(sample(4));
  assert.equal(result.certainty, 'insufficient');
  assert.equal(result.winRate, null);
  assert.equal(result.expectancy, null);
});

test('behavior patterns are insufficient below ten trades', () => {
  const result = calculatePaperJournalAnalytics(sample(9));
  assert.equal(result.behaviorSignals[0]?.code, 'BEHAVIOR_SAMPLE_INSUFFICIENT');
  assert.equal(result.behaviorSignals[0]?.certainty, 'insufficient');
});

test('detects loss reentry within ten minutes as candidate', () => {
  const rows = sample(10);
  rows[0] = trade(0, { netPnl: -10, symbol: 'BTCUSDT', closedAt: new Date(BASE + 5 * 60_000).toISOString() });
  rows[1] = trade(1, { symbol: 'BTCUSDT', filledAt: new Date(BASE + 10 * 60_000).toISOString() });
  const signal = calculatePaperJournalAnalytics(rows).behaviorSignals.find((item) => item.code === 'LOSS_REENTRY_WITHIN_10_MINUTES');
  assert.equal(signal?.count, 1);
  assert.equal(signal?.certainty, 'candidate');
});

test('detects six trades in one hour as overtrading candidate', () => {
  const rows = sample(10).map((row, index) => index < 6 ? { ...row, filledAt: new Date(BASE + index * 5 * 60_000).toISOString() } : row);
  const signal = calculatePaperJournalAnalytics(rows).behaviorSignals.find((item) => item.code === 'OVERTRADING_HOURLY_CLUSTER');
  assert.equal((signal?.count ?? 0) >= 1, true);
});

test('explicit chase warning is confirmed', () => {
  const rows = sample(10);
  rows[0] = trade(0, { warnings: ['추격 진입'] });
  const signal = calculatePaperJournalAnalytics(rows).behaviorSignals.find((item) => item.code === 'CHASE_ENTRY_WARNING');
  assert.equal(signal?.certainty, 'confirmed');
  assert.equal(signal?.count, 1);
});

test('stop widening without history stays insufficient', () => {
  const signal = calculatePaperJournalAnalytics(sample(10)).behaviorSignals.find((item) => item.code === 'STOP_WIDENING_WARNING');
  assert.equal(signal?.certainty, 'insufficient');
});

test('explicit stop widening warning is confirmed', () => {
  const rows = sample(10);
  rows[0] = trade(0, { warnings: ['손절 확대'] });
  const signal = calculatePaperJournalAnalytics(rows).behaviorSignals.find((item) => item.code === 'STOP_WIDENING_WARNING');
  assert.equal(signal?.certainty, 'confirmed');
});

test('detects positive gross but non-positive net after costs', () => {
  const rows = sample(10);
  rows[0] = trade(0, { grossPnl: 1, netPnl: -1 });
  const signal = calculatePaperJournalAnalytics(rows).behaviorSignals.find((item) => item.code === 'LOW_EXPECTANCY_AFTER_COST');
  assert.equal((signal?.count ?? 0) >= 1, true);
});

test('invalid NaN trade is excluded', () => {
  const result = calculatePaperJournalAnalytics([...sample(5), trade(9, { netPnl: Number.NaN })]);
  assert.equal(result.totalTrades, 5);
});

test('invalid Infinity trade is excluded', () => {
  const result = calculatePaperJournalAnalytics([...sample(5), trade(9, { netPnl: Number.POSITIVE_INFINITY })]);
  assert.equal(result.totalTrades, 5);
});

test('review dataset never includes email', () => {
  assert.doesNotMatch(JSON.stringify(createTradingReviewDataset(sample(10))), /@example\.com/);
});

test('review dataset never includes original notes', () => {
  assert.doesNotMatch(JSON.stringify(createTradingReviewDataset(sample(10))), /private note/);
});

test('review dataset never includes internal ids', () => {
  assert.doesNotMatch(JSON.stringify(createTradingReviewDataset(sample(10))), /internal-uuid/);
});

test('review dataset declares excluded sensitive fields', () => {
  const fields = createTradingReviewDataset(sample(10)).excludedFields;
  assert.equal(fields.includes('apiKey'), true);
  assert.equal(fields.includes('secret'), true);
  assert.equal(fields.includes('originalUserNote'), true);
  assert.equal(fields.includes('internalDatabaseUuid'), true);
});

test('representative trades use anonymized ids', () => {
  const representative = createTradingReviewDataset(sample(10)).representativeTrades;
  assert.match(representative[0]?.anonymizedId ?? '', /^[a-f0-9]{16}$/);
});

test('representative trades are capped', () => {
  assert.equal(createTradingReviewDataset(sample(50)).representativeTrades.length, 12);
});

test('representative trades contain only minimized fields', () => {
  const item = createTradingReviewDataset(sample(10)).representativeTrades[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(item).sort(), ['anonymizedId','exitReason','netPnlPercent','rMultiple','riskPercent','ruleViolations','side','strategy'].sort());
});

test('review dataset warns external AI is not called', () => {
  assert.match(createTradingReviewDataset(sample(10)).warnings.join(' '), /외부 AI를 호출하거나 거래기록을 전송하지 않습니다/);
});

test('review dataset contains privacy-safe aggregate groups', () => {
  const result = createTradingReviewDataset(sample(20));
  assert.equal(result.strategyMetrics.length, 2);
  assert.equal(result.symbolMetrics.length, 2);
  assert.equal(result.timeMetrics.length > 0, true);
});
