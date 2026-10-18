import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendExperimentRecordV1,
  experimentRecordV1,
  monteCarloTradeSequenceV1,
  performanceByRegimeV1,
  portfolioRiskV1,
  regimeDependenceV1,
  regimeSeriesV1,
  rollingSelectionWalkForwardV1,
  simulateDcaV1,
  simulateGridV1,
} from '../src/research-analytics-v1.mjs';

const DAY = 86_400_000;
function path(prices, start = Date.UTC(2025, 0, 1), step = DAY) {
  return prices.map((close, i) => {
    const open = i === 0 ? close : prices[i - 1];
    return { timestamp: start + (i * step), open, close, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, volume: 1 };
  });
}

test('Monte Carlo: deterministic per seed, riskier sequences have worse drawdown and higher ruin', () => {
  const calm = Array.from({ length: 80 }, (_, i) => (i % 2 ? 0.01 : -0.005));
  const wild = Array.from({ length: 80 }, (_, i) => (i % 2 ? 0.08 : -0.07));
  const a = monteCarloTradeSequenceV1(calm, { seed: 3 });
  assert.deepEqual(monteCarloTradeSequenceV1(calm, { seed: 3 }), a);
  const b = monteCarloTradeSequenceV1(wild, { seed: 3 });
  assert.ok(b.maxDrawdown.p95 > a.maxDrawdown.p95);
  assert.ok(b.probabilityOfRuin >= a.probabilityOfRuin);
  assert.equal(monteCarloTradeSequenceV1([0.01], {}).reason, 'TOO_FEW_TRADES');
});

test('regimes use closed data only and classify trend correctly', () => {
  const up = path(Array.from({ length: 300 }, (_, i) => 100 * (1.005 ** i)));
  const down = path(Array.from({ length: 300 }, (_, i) => 100 * (0.995 ** i)));
  assert.equal(regimeSeriesV1(up).at(-1), 'BULL');
  assert.equal(regimeSeriesV1(down).at(-1), 'BEAR');
  assert.equal(regimeSeriesV1(up)[100], null, 'warm-up has no regime');
  const prefix = regimeSeriesV1(up.slice(0, 250));
  assert.deepEqual(prefix, regimeSeriesV1(up).slice(0, 250), 'no look-ahead');
  const series = regimeSeriesV1(up);
  const perf = performanceByRegimeV1([{ signalTime: up[260].timestamp, return: 0.01 }, { signalTime: up[10].timestamp, return: -0.01 }], up, series);
  assert.equal(perf.BULL.trades, 1);
  assert.equal(perf.UNKNOWN.trades, 1);
  assert.equal(regimeDependenceV1({ BULL: { trades: 20, meanReturn: 0.01 }, BEAR: { trades: 20, meanReturn: -0.01 }, SIDEWAYS: { trades: 3, meanReturn: 0.1 } }), 'ONLY_BULL');
});

test('rolling selection walk-forward scores the selection process out of sample', () => {
  const trial = (id, means) => ({ trialId: id, status: 'WATCH', walkForward: { windows: means.map((meanReturn) => ({ trades: 30, meanReturn })) } });
  const lucky = { a: trial('a', [0.02, 0.02, -0.01, -0.01]), b: trial('b', [0.001, -0.02, 0.01, 0.01]) };
  const result = rollingSelectionWalkForwardV1(lucky, { minimumTrades: 20 });
  assert.equal(result.folds[0].trialId, 'a');
  assert.ok(result.outOfSampleMean != null);
  const robust = { a: trial('a', [0.01, 0.01, 0.01, 0.01]) };
  assert.equal(rollingSelectionWalkForwardV1(robust).verdict, 'SELECTION_HOLDS_OUT_OF_SAMPLE');
});

test('portfolio risk: correlation, concurrency and combined drawdown', () => {
  const trades = [];
  for (let d = 0; d < 30; d += 1) {
    const r = d % 3 === 0 ? -1 : 1;
    trades.push({ ruleId: 'x', status: 'CLOSED', rMultiple: r, entryTime: d * DAY, exitTime: (d * DAY) + 3_600_000 });
    trades.push({ ruleId: 'y', status: 'CLOSED', rMultiple: r * 0.9, entryTime: d * DAY, exitTime: (d * DAY) + 7_200_000 });
  }
  const result = portfolioRiskV1(trades);
  assert.equal(result.rules, 2);
  assert.ok(result.mostCorrelated[0].correlation > 0.95);
  assert.equal(result.concentrationWarning, true);
  assert.equal(result.maxConcurrentPositions, 2);
  assert.ok(result.maxDrawdownR > 0);
});

test('grid and DCA simulators always surface the tail loss', () => {
  const crash = path([100, 98, 96, 99, 97, 95, 90, 80, 70, 60, 55, 50]);
  const grid = simulateGridV1(crash, { lower: 80, upper: 100, levels: 5, capital: 1_000 });
  assert.ok(grid.worstEquityReturn < -0.1);
  assert.ok(grid.stuckInventoryValue > 0);
  const dca = simulateDcaV1(crash, { baseOrder: 100, safetyOrder: 100, maxSafetyOrders: 3, deviation: 0.03, takeProfit: 0.02 });
  assert.ok(dca.worstUnrealizedLoss < 0);
  assert.ok(dca.maxCapitalCommitted <= 400);
  assert.ok(dca.longestUnderwaterBars > 3);
  const range = path(Array.from({ length: 200 }, (_, i) => 90 + (8 * Math.sin(i / 3))));
  assert.ok(simulateGridV1(range, { lower: 80, upper: 100, levels: 10, capital: 1_000 }).completedRounds > 5);
  assert.throws(() => simulateGridV1(range, { lower: 100, upper: 90 }), /GRID_PARAMETERS_INVALID/u);
});

test('experiment records are appended once per experiment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'analytics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = experimentRecordV1({ laneId: 'L', experimentKey: 'k1', researchCodeSha: 'a'.repeat(40), atomLibraryVersion: 'v', symbolKey: 's', policy: { x: 1 },
    datasetDigests: { A: 'h1' }, observedAt: 't' });
  assert.equal(await appendExperimentRecordV1(root, record), true);
  assert.equal(await appendExperimentRecordV1(root, record), false);
  const lines = (await readFile(join(root, 'combination-research', 'experiments.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).datasetDigests.A, 'h1');
});

test('walk-forward selection does not use hindsight: a trial rejected on the full sample still competes at each window', () => {
  const trial = (id, status, means) => ({ trialId: id, status, walkForward: { windows: means.map((meanReturn) => ({ trades: 30, meanReturn })) } });
  // "late" looks best early but collapses later, so the full-sample verdict rejects it. At window 1..2
  // a real process would still have picked it; excluding it would hide that failure.
  const trials = { late: trial('late', 'REJECT', [0.05, 0.05, -0.08, -0.08]), steady: trial('steady', 'WATCH', [0.004, 0.004, 0.004, 0.004]) };
  const result = rollingSelectionWalkForwardV1(trials, { minimumTrades: 20 });
  assert.equal(result.folds[0].trialId, 'late');
  assert.equal(result.folds[1].trialId, 'late');
  assert.equal(result.folds[2].trialId, 'late');
  assert.equal(result.verdict, 'SELECTION_FAILS_OUT_OF_SAMPLE');
  // unequal window counts are truncated to the common length, never read past the end
  const ragged = { a: trial('a', 'WATCH', [0.01, 0.01, 0.01]), b: trial('b', 'WATCH', [0.02, 0.02]) };
  assert.equal(rollingSelectionWalkForwardV1(ragged).folds.length, 1);
});

test('block bootstrap sees deeper drawdowns than iid when losses cluster', () => {
  const clustered = [...Array(10).fill(0.02), ...Array(10).fill(-0.04), ...Array(10).fill(0.02), ...Array(10).fill(-0.04)];
  const iid = monteCarloTradeSequenceV1(clustered, { seed: 5, paths: 3_000, meanBlockLength: 1 });
  const block = monteCarloTradeSequenceV1(clustered, { seed: 5, paths: 3_000, meanBlockLength: 10 });
  assert.equal(iid.method, 'IID_BOOTSTRAP');
  assert.equal(block.method, 'STATIONARY_BLOCK_BOOTSTRAP');
  assert.ok(block.maxDrawdown.p95 > iid.maxDrawdown.p95);
  assert.equal(monteCarloTradeSequenceV1(clustered, { seed: 5 }).meanBlockLength, Math.round(40 ** (1 / 3)));
});

test('grid does not complete a round trip inside the bar that bought the level', () => {
  const bar = (low, high, close) => ({ timestamp: 0, open: close, high, low, close });
  const sameBar = simulateGridV1([bar(95, 125, 110)], { lower: 100, upper: 120, levels: 2, capital: 1_000, feeRate: 0 });
  assert.equal(sameBar.completedRounds, 0);
  const nextBar = simulateGridV1([bar(95, 105, 100), bar(100, 125, 120)], { lower: 100, upper: 120, levels: 2, capital: 1_000, feeRate: 0 });
  assert.ok(nextBar.completedRounds >= 1);
});
