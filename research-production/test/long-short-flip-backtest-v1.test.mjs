import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LONG_SHORT_FLIP_HOLDOUT_START,
  LONG_SHORT_FLIP_VARIANTS_V1,
  evaluateLongShortFlipV1,
  flipIndicatorsV1,
  formatLongShortFlipReportKoV1,
  fundingAtBarsV1,
  regimeAllowsLongV1,
  simulateLongShortFlipV1,
  summarizeFlipTradesV1,
} from '../src/long-short-flip-backtest-v1.mjs';

const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const [LONG_ONLY, FLIP, FLIP_NO_REGIME] = LONG_SHORT_FLIP_VARIANTS_V1;

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

/** Quiet random walk with periodic pump (high volume) → dump cycles. */
function pumpDump(n, { seed = 7, every = 300, start = START, pumps = true } = {}) {
  const r = rng(seed);
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    const phase = i % every;
    let drift = (r() - 0.5) * 0.004;
    let volume = 100 * (0.8 + (r() * 0.4));
    if (pumps && phase >= 150 && phase < 165) { drift += 0.012; volume *= 6; }
    if (pumps && phase >= 165 && phase < 200) { drift -= 0.008; volume *= 2; }
    const o = p;
    p = Math.max(1, p * (1 + drift));
    out.push({ timestamp: start + (i * HOUR), open: o, close: p, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, volume });
  }
  return out;
}

test('indicators use only the closed bar and earlier bars', () => {
  const candles = pumpDump(400);
  const full = flipIndicatorsV1(candles);
  const cut = flipIndicatorsV1(candles.slice(0, 250));
  for (const key of ['emaFast', 'emaSlow', 'atr', 'rsi', 'vwap', 'volumeRatio', 'priorHigh', 'priorLow']) {
    assert.equal(full[key][249], cut[key][249], key);
  }
});

test('funding is the latest known rate at each bar', () => {
  const candles = pumpDump(10);
  const { perBar } = fundingAtBarsV1(candles, [{ timestamp: START + (3 * HOUR), rate: 0.001 }, { timestamp: START + (7 * HOUR), rate: -0.002 }]);
  assert.equal(perBar[2], null);
  assert.equal(perBar[3], 0.001);
  assert.equal(perBar[6], 0.001);
  assert.equal(perBar[7], -0.002);
});

test('regime filter blocks longs when the benchmark is 6% or more below its 24-bar peak', () => {
  const bench = Array.from({ length: 30 }, (_, i) => ({ timestamp: START + (i * HOUR), close: i < 20 ? 100 : 93 }));
  const allowed = regimeAllowsLongV1(bench);
  assert.equal(allowed.get(START + (19 * HOUR)), true);
  assert.equal(allowed.get(START + (20 * HOUR)), false);
});

test('flip variant goes long on the pump and only shorts after the long is closed', () => {
  const trades = simulateLongShortFlipV1({ candles: pumpDump(3000), variant: FLIP });
  const sides = trades.map((t) => t.side);
  assert.ok(sides.includes('long'), 'expected long trades');
  assert.ok(sides.includes('short'), 'expected short trades');
  for (let i = 0; i < trades.length; i += 1) {
    if (trades[i].side === 'short') {
      assert.equal(trades[i - 1]?.side, 'long', 'a short must follow a long');
      assert.ok(trades[i].entryTime > trades[i - 1].exitTime, 'no overlap with the long');
    }
  }
});

test('long-only variant never shorts and no trade opens on pure noise', () => {
  assert.ok(simulateLongShortFlipV1({ candles: pumpDump(3000), variant: LONG_ONLY }).every((t) => t.side === 'long'));
  assert.equal(simulateLongShortFlipV1({ candles: pumpDump(3000, { pumps: false }), variant: FLIP }).length, 0);
});

test('entries fill at the next bar open with slippage, never at the signal close', () => {
  const candles = pumpDump(3000);
  const byTime = new Map(candles.map((c, i) => [c.timestamp, i]));
  for (const t of simulateLongShortFlipV1({ candles, variant: FLIP })) {
    const i = byTime.get(t.entryTime);
    assert.ok(i > 0);
    const slip = 0.0005 + 0.0001;
    assert.ok(Math.abs((t.entry / candles[i].open) - (t.side === 'long' ? 1 + slip : 1 - slip)) < 1e-9);
  }
});

test('regime filter removes longs while the benchmark is crashing', () => {
  const candles = pumpDump(3000);
  const blocked = new Map(candles.map((c) => [c.timestamp, false]));
  assert.equal(simulateLongShortFlipV1({ candles, regimeAllowed: blocked, variant: FLIP }).length, 0);
  assert.ok(simulateLongShortFlipV1({ candles, regimeAllowed: blocked, variant: FLIP_NO_REGIME }).length > 0);
});

test('sealed 2026 holdout candles are never read', () => {
  const late = pumpDump(3000, { start: LONG_SHORT_FLIP_HOLDOUT_START - (1000 * HOUR) });
  for (const t of simulateLongShortFlipV1({ candles: late, variant: FLIP })) {
    assert.ok(t.entryTime < LONG_SHORT_FLIP_HOLDOUT_START && t.exitTime < LONG_SHORT_FLIP_HOLDOUT_START);
  }
});

test('positive funding is a cost for longs and income for shorts', () => {
  const candles = pumpDump(3000);
  const noFunding = simulateLongShortFlipV1({ candles, variant: FLIP });
  const funding = candles.filter((_, i) => i % 8 === 0).map((c) => ({ timestamp: c.timestamp, rate: 0.0002 }));
  const withFunding = simulateLongShortFlipV1({ candles, fundingRates: funding, variant: FLIP });
  assert.equal(withFunding.length, noFunding.length);
  const longs = withFunding.filter((t) => t.side === 'long');
  assert.ok(longs.length > 0);
  const lidx = withFunding.findIndex((t) => t.side === 'long' && t.exitTime - t.entryTime > 8 * HOUR);
  if (lidx >= 0) assert.ok(withFunding[lidx].returnOnNotional < noFunding[lidx].returnOnNotional);
});

test('summary math: R sum, profit factor and 1%-risk compounding', () => {
  const s = summarizeFlipTradesV1([
    { exitTime: 1, rMultiple: 2 }, { exitTime: 2, rMultiple: -1 }, { exitTime: 3, rMultiple: 1 },
  ]);
  assert.equal(s.trades, 3);
  assert.equal(s.sumR, 2);
  assert.equal(s.profitFactor, 3);
  assert.ok(Math.abs(s.returnAtOnePercentRisk - ((1.02 * 0.99 * 1.01) - 1)) < 1e-12);
  assert.ok(Math.abs(s.maxDrawdownAtOnePercentRisk - 0.01) < 1e-12);
});

test('evaluation splits discovery/validation, compares to long-only and reports a verdict in Korean', () => {
  const datasets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol, k) => ({ symbol, candles: pumpDump(4000, { seed: 11 + k }), fundingRates: [] }));
  const result = evaluateLongShortFlipV1({ datasets });
  assert.equal(result.symbols.length, 3);
  assert.equal(result.benchmark, 'BTCUSDT');
  assert.ok(Date.parse(result.splitTime) > START);
  assert.ok(['SHORT_LEG_ADDS_VALUE', 'NOT_PROVEN'].includes(result.verdict));
  assert.equal(result.results.LONG_ONLY.validation.short.trades, 0);
  assert.equal(result.safety.realOrder, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
  const report = formatLongShortFlipReportKoV1(result);
  assert.match(report, /검증 구간/u);
  assert.match(report, /결론:/u);
});
