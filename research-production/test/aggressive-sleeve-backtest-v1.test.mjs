import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAggressiveSleeveV1, formatAggressiveSleeveKoV1, simulateSleeveV1 } from '../src/aggressive-sleeve-backtest-v1.mjs';

const H = 3_600_000;
const policy = { startSleeveKrw: 200_000, riskFractionOfSleeve: 0.05, maxLeverage: 5, maxConcurrent: 3 };

test('sleeve risks 5% per trade and never goes below zero', () => {
  const loss = (k) => ({ entryTime: k * H, exitTime: k * H + 1, returnOnNotional: -0.04, stopFraction: 0.04 });
  const r = simulateSleeveV1(Array.from({ length: 200 }, (_, k) => loss(k)), policy);
  assert.ok(r.endSleeveKrw >= 0);
  assert.ok(r.endSleeveKrw < 200_000 * 0.01);
  const one = simulateSleeveV1([loss(0)], policy);
  assert.equal(one.endSleeveKrw, 190_000);
});

test('leverage cap limits notional when the stop is tight', () => {
  const r = simulateSleeveV1([{ entryTime: 0, exitTime: 1, returnOnNotional: 0.01, stopFraction: 0.001 }], policy);
  assert.equal(r.endSleeveKrw, 200_000 + (5 * 200_000 * 0.01));
});

test('at most three positions at once; extra signals are skipped', () => {
  const t = (k) => ({ entryTime: k, exitTime: 100 * H, returnOnNotional: 0.02, stopFraction: 0.05 });
  const r = simulateSleeveV1([t(1), t(2), t(3), t(4), t(5)], policy);
  assert.equal(r.trades, 3);
  assert.equal(r.skippedWhileFull, 2);
});

test('end-to-end on synthetic candles returns three variants and a Korean report', () => {
  let s = 3; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const mk = (symbol) => {
    let p = 100; const candles = [];
    for (let i = 0; i < 3000; i += 1) {
      const spike = i % 500 === 300 ? 0.08 : 0;
      const o = p; p = Math.max(1, p * (1 + spike + ((rnd() - 0.5) * 0.01)));
      candles.push({ timestamp: Date.UTC(2024, 0, 1) + (i * H), open: o, close: p, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, volume: spike ? 5000 : 100 + (rnd() * 50) });
    }
    return { symbol, candles, fundingRates: [] };
  };
  const rows = evaluateAggressiveSleeveV1({ datasets: [mk('BTCUSDT'), mk('SOLUSDT')] });
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(r.endSleeveKrw >= 0 && Math.abs(r.accountEffectFraction) <= 10);
  assert.match(formatAggressiveSleeveKoV1(rows), /공격형 칸/);
});
