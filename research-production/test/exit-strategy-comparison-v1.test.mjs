import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RESEARCH_LANES_V2 } from '../src/autonomous-research-discovery-v2.mjs';
import { COMBINATION_UNIVERSE_V1 } from '../src/combination-search-lane-v1.mjs';
import {
  EXIT_COMPARISON_SIGNAL_SETS_V1,
  EXIT_COMPARISON_VARIANTS_V1,
  formatExitComparisonReportKoV1,
  pickExitWinnerV1,
  runExitStrategyComparisonV1,
  summarizeRMultiplesV1,
} from '../src/exit-strategy-comparison-v1.mjs';

const HOUR = 3_600_000;
const UNIVERSE = Object.freeze({ BITGET_1H: Object.freeze({ ...COMBINATION_UNIVERSE_V1.BITGET_1H, symbols: Object.freeze(COMBINATION_UNIVERSE_V1.BITGET_1H.symbols.slice(0, 8)) }) });
const LANES = RESEARCH_LANES_V2.filter((lane) => lane.id === 'CRYPTO_FUTURES_LONG' || lane.id === 'CRYPTO_FUTURES_SHORT');

function walk(n, seed, start = Date.UTC(2025, 3, 1)) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = Math.max(1, open * (1 + ((rnd() - 0.5) * 0.02)));
    out.push({ timestamp: start + (i * HOUR), open, close, high: Math.max(open, close) * (1 + (rnd() * 0.005)), low: Math.min(open, close) * (1 - (rnd() * 0.005)), volume: 100 + (rnd() * 300) });
    price = close;
  }
  return out;
}

async function seedCache(root, { withHoldout = false } = {}) {
  for (const [k, symbol] of UNIVERSE.BITGET_1H.symbols.entries()) {
    const candles = walk(5000, k + 5);
    if (withHoldout) candles.push({ timestamp: Date.UTC(2026, 0, 2), open: 1, high: 1e9, low: 0.5, close: 1e9, volume: 1 });
    const path = join(root, 'combination-research', 'datasets', 'BITGET_1H', `${symbol}.json`);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ candles, timeframe: '1h', fundingRates: candles.filter((_, i) => i % 8 === 0).map((c) => ({ timestamp: c.timestamp, rate: 0.0001 })) }));
  }
}

test('variants are the pre-registered 2 entries x 4 exits', () => {
  assert.equal(EXIT_COMPARISON_VARIANTS_V1.length, 8);
  assert.deepEqual(new Set(EXIT_COMPARISON_VARIANTS_V1.map((v) => v.entryId)), new Set(['SINGLE', 'PYRAMID']));
  for (const sets of Object.values(EXIT_COMPARISON_SIGNAL_SETS_V1)) assert.ok(sets.some((set) => set.id === 'ALWAYS'));
});

test('R summary: mean, streak, drawdown, confidence bound', () => {
  const s = summarizeRMultiplesV1([1, -1, -1, -1, 2, 0.5].map((r) => ({ r, ret: r / 100 })));
  assert.equal(s.trades, 6);
  assert.equal(s.meanR, 0.0833);
  assert.equal(s.maxConsecutiveLosses, 3);
  assert.equal(s.maxDrawdownR, 3);
  assert.ok(s.ciLow95 < s.meanR);
  assert.equal(summarizeRMultiplesV1([]).trades, 0);
});

test('winner rule needs validation and unseen symbols both positive', () => {
  const row = (variantId, v, u, n = 30, tStat = 4) => ({ variantId, validation: { trades: n, meanR: v, ciLow95: v - 0.1, tStat }, unseen: { trades: n, meanR: u } });
  const picked = pickExitWinnerV1([row('SINGLE+FIXED_FULL', 0.05, 0.02), row('SINGLE+TRAIL_FULL', 0.3, -0.1), row('PYRAMID+TRAIL_FULL', 0.2, 0.1)]);
  assert.equal(picked.variantId, 'PYRAMID+TRAIL_FULL');
  assert.equal(picked.upliftVsBaselineR, 0.15);
  assert.equal(pickExitWinnerV1([row('SINGLE+FIXED_FULL', 0.5, 0.5, 5)]).status, 'NO_WINNER');
});

test('winner is rejected when the best variant is not significant after multiple-comparison correction', () => {
  const row = (variantId, tStat) => ({ variantId, validation: { trades: 30, meanR: 0.2, ciLow95: 0.05, tStat }, unseen: { trades: 30, meanR: 0.1 } });
  const variants = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => row(id, 2.2));
  const rejected = pickExitWinnerV1(variants);
  assert.equal(rejected.status, 'NO_WINNER');
  assert.equal(rejected.reason, 'NOT_SIGNIFICANT_AFTER_MULTIPLE_COMPARISON');
  assert.equal(rejected.comparisons, 8);
  assert.ok(rejected.criticalT > 2.4);
  assert.equal(pickExitWinnerV1([...variants.slice(1), row('A', 3)]).status, 'WINNER');
  assert.equal(pickExitWinnerV1([row('A', null)]).status, 'NO_WINNER');
});

test('runner reads the cache, never the holdout, and caches lane results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exit-cmp-'));
  try {
    await seedCache(root, { withHoldout: true });
    const result = await runExitStrategyComparisonV1({ stateRoot: root, researchCodeSha: 'abc', lanes: LANES, universe: UNIVERSE, now: () => '2026-10-17T05:00:00.000Z' });
    assert.equal(result.lanes.length, 2);
    for (const lane of result.lanes) {
      assert.equal(lane.status, 'COMPLETE');
      assert.equal(lane.symbols.unseen.length, 2);
      assert.equal(lane.signalSets.length, 3);
      for (const set of lane.signalSets) assert.equal(set.variants.length, 8);
    }
    const always = result.lanes[0].signalSets.find((set) => set.signalSetId === 'ALWAYS');
    assert.ok(always.variants.every((v) => v.validation.trades > 20));
    // A 2026 candle with a 1e9 close would explode returns if it leaked in.
    assert.ok(always.variants.every((v) => Math.abs(v.validation.meanR) < 5));
    const latest = JSON.parse(await readFile(join(root, 'latest', 'exit-strategy-comparison-v1.json'), 'utf8'));
    assert.equal(latest.holdoutRead, false);
    assert.equal(latest.executionAuthority, 'NONE');

    let calls = 0;
    const second = await runExitStrategyComparisonV1({ stateRoot: root, researchCodeSha: 'abc', lanes: LANES, universe: UNIVERSE,
      now: () => '2026-10-18T05:00:00.000Z', clock: () => { calls += 1; return 1_000; } });
    assert.equal(second.lanes[0].computedAt, '2026-10-17T05:00:00.000Z', 'fresh lane reused');
    assert.ok(calls < 10);

    const report = formatExitComparisonReportKoV1(latest);
    assert.match(report, /코인선물 롱/);
    assert.match(report, /한 번에 진입 \+ 추적 전량/);
    assert.match(report, /주문 권한은 없습니다/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner waits while the symbol set is incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exit-cmp-'));
  try {
    const result = await runExitStrategyComparisonV1({ stateRoot: root, lanes: LANES, universe: UNIVERSE });
    assert.ok(result.lanes.every((lane) => lane.status === 'WAITING_FOR_DATA'));
    assert.match(formatExitComparisonReportKoV1(result), /대기/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
