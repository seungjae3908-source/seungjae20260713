import assert from 'node:assert/strict';
import test from 'node:test';

import { runManagedExitBacktestV1 } from '../src/managed-exit-backtest-v1.mjs';
import {
  TREND_PILOT_VARIANTS_V1,
  evaluateTrendPilotSymbolV1,
  formatTrendPilotReportKoV1,
  resampleCandlesV1,
  summarizeTradesKrwV1,
  trendSignalsV1,
} from '../src/trend-pilot-backtest-v1.mjs';

const HOUR = 3_600_000;
const START = Date.UTC(2023, 0, 1);

function hourly(n, drift, seed = 5) {
  let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100; const out = [];
  for (let i = 0; i < n; i += 1) {
    const o = p; p = Math.max(1, p * (1 + drift(i) + ((r() - 0.5) * 0.006)));
    out.push({ timestamp: START + (i * HOUR), open: o, close: p, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, volume: 10 });
  }
  return out;
}

test('resampling builds complete aligned bars only', () => {
  const bars = resampleCandlesV1(hourly(30, () => 0), 4);
  assert.equal(bars.length, 7);
  assert.equal(bars[0].timestamp, START);
  assert.equal(bars[1].open, hourly(30, () => 0)[4].open);
});

test('signals use prior bars only and require the EMA side', () => {
  const bars = resampleCandlesV1(hourly(4 * 400, (i) => (i > 4 * 300 ? 0.002 : 0)), 4);
  const s = trendSignalsV1(bars);
  const cut = trendSignalsV1(bars.slice(0, 330));
  assert.deepEqual(cut.long.slice(0, 330), s.long.slice(0, 330));
  assert.ok(s.long.some(Boolean));
  assert.equal(s.long.some((v, i) => v && s.short[i]), false);
});

test('stop cap limits the initial loss to 2.5% of entry', () => {
  const candles = hourly(4 * 300, () => 0);
  const r = runManagedExitBacktestV1({ backtestInput: { market: 'CRYPTO_FUTURES', side: 'long', symbol: 'BTCUSDT', candles, riskModel: { riskPerTrade: 0.5, leverage: 2 } },
    plan: { exit: { stopAtrMultiple: 50, maxStopFraction: 0.025, targetR: null, trailing: { atrMultiple: 50 }, maxHoldBars: 5 } },
    signalEvaluator: ({ index }) => (index === 100 ? {} : null) });
  const t = r.trades[0];
  assert.ok(Math.abs((t.entryPrice - t.stopPrice) / t.entryPrice - 0.025) < 1e-9);
});

test('a strong uptrend makes money on the long side; a strong downtrend on the short side', () => {
  const variant = TREND_PILOT_VARIANTS_V1.find((v) => v.id === 'H4_CAP25');
  const up = evaluateTrendPilotSymbolV1({ symbol: 'BTCUSDT', candles: hourly(4 * 600, (i) => (i > 4 * 250 ? 0.0012 : 0)), variant });
  const upSummary = summarizeTradesKrwV1(up.trades);
  assert.ok(upSummary.longs > 0 && upSummary.totalKrw > 0, JSON.stringify(upSummary));
  const down = evaluateTrendPilotSymbolV1({ symbol: 'ETHUSDT', candles: hourly(4 * 600, (i) => (i > 4 * 250 ? -0.0012 : 0)), variant });
  const downSummary = summarizeTradesKrwV1(down.trades);
  assert.ok(downSummary.shorts > 0 && downSummary.totalKrw > 0, JSON.stringify(downSummary));
  for (let i = 1; i < up.trades.length; i += 1) assert.ok(up.trades[i].entryTime >= up.trades[i - 1].exitTime, 'one position at a time');
});

test('KRW summary counts days over the daily loss limit and streaks', () => {
  const day = 86_400_000;
  const s = summarizeTradesKrwV1([
    { entryTime: 0, exitTime: day, returnOnNotional: -0.02, side: 'long' },
    { entryTime: day, exitTime: day + 1, returnOnNotional: -0.015, side: 'short' },
    { entryTime: 2 * day, exitTime: 3 * day, returnOnNotional: 0.08, side: 'long' },
  ]);
  assert.equal(s.trades, 3);
  assert.equal(s.totalKrw, 45_000);
  assert.equal(s.daysOverDailyLimit, 1);
  assert.equal(s.longestLosingStreak, 2);
  assert.equal(s.maxDrawdownKrw, 35_000);
  assert.match(formatTrendPilotReportKoV1({ status: 'WAITING_FOR_DATA', notionalKrw: 1_000_000 }), /데이터 대기/);
});

test('full-size data (two years of hourly candles for several symbols) does not overflow the stack', async () => {
  const { evaluateTrendPilotV1 } = await import('../src/trend-pilot-backtest-v1.mjs');
  const datasets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol, k) => ({ symbol, candles: hourly(19_680, () => 0, k + 2), fundingRates: [] }));
  const result = evaluateTrendPilotV1({ datasets });
  assert.equal(result.length, 5);
});

test('equity-based sizing grows the notional after gains and shrinks it after losses', async () => {
  const { simulateCompoundingV1 } = await import('../src/trend-pilot-backtest-v1.mjs');
  const day = 86_400_000;
  const win = (k) => ({ entryTime: k * day, exitTime: k * day + 1, returnOnNotional: 0.05, stopFraction: 0.025, rMultiple: 2 });
  const up = simulateCompoundingV1([win(0), win(1), win(2)], { startEquityKrw: 2_000_000, riskFraction: 0.01, maxNotionalKrw: 5_000_000 });
  assert.equal(up.firstNotionalKrw, 800_000);
  assert.ok(up.lastNotionalKrw > up.firstNotionalKrw);
  assert.ok(up.endEquityKrw > 2_000_000);
  const loss = (k) => ({ entryTime: k * day, exitTime: k * day + 1, returnOnNotional: -0.025, stopFraction: 0.025, rMultiple: -1 });
  const down = simulateCompoundingV1([loss(0), loss(1)], { startEquityKrw: 2_000_000, riskFraction: 0.01, maxNotionalKrw: 5_000_000 });
  assert.ok(down.lastNotionalKrw < down.firstNotionalKrw);
  assert.equal(Math.round(down.endEquityKrw), Math.round(2_000_000 * 0.99 * 0.99));
  const capped = simulateCompoundingV1([win(0)], { startEquityKrw: 100_000_000, riskFraction: 0.01, maxNotionalKrw: 5_000_000 });
  assert.equal(capped.firstNotionalKrw, 5_000_000);
});

test('regime sizing takes more risk in strong trends and less otherwise; pyramid variant adds to winners', async () => {
  const { simulateCompoundingV1, TREND_PILOT_VARIANTS_V1: V, evaluateTrendPilotSymbolV1: run } = await import('../src/trend-pilot-backtest-v1.mjs');
  const day = 86_400_000;
  const strong = simulateCompoundingV1([{ entryTime: 0, exitTime: 1, rMultiple: 1, stopFraction: 0.02, strongRegime: true }],
    { startEquityKrw: 1_000_000, riskFraction: 0.01, maxNotionalKrw: 1e9, regimeSizing: true });
  assert.equal(strong.endEquityKrw, 1_015_000);
  const weak = simulateCompoundingV1([{ entryTime: 0, exitTime: day, rMultiple: 1, stopFraction: 0.02, strongRegime: false }],
    { startEquityKrw: 1_000_000, riskFraction: 0.01, maxNotionalKrw: 1e9, regimeSizing: true });
  assert.equal(weak.endEquityKrw, 1_007_500);
  const pyramid = V.find((v) => v.id === 'H4_PYRAMID');
  const up = run({ symbol: 'BTCUSDT', candles: hourly(4 * 600, (i) => (i > 4 * 250 ? 0.0012 : 0)), variant: pyramid });
  assert.ok(up.trades.some((t) => t.adds > 0), 'adds while winning');
  assert.ok(up.trades.every((t) => typeof t.strongRegime === 'boolean'));
});
