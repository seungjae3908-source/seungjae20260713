import assert from 'node:assert/strict';
import test from 'node:test';

import { FORWARD_PAPER_START_MS } from '../src/extended-exit-backtest-v1.mjs';
import {
  H4_MAJORS_REGISTERED_AT,
  formatH4MajorsForwardKoV1,
  h4MajorsForwardTradesV1,
  summarizeH4MajorsForwardV1,
} from '../src/h4-majors-long-forward-paper-v1.mjs';

const HOUR = 3_600_000;

function hourly(start, n, seed) {
  let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100; const out = [];
  for (let i = 0; i < n; i += 1) {
    const phase = i % 600;
    let drift = (r() - 0.5) * 0.004; let volume = 100 * (0.8 + (r() * 0.4));
    if (phase >= 300 && phase < 340) { drift += 0.004; volume *= 6; }
    if (phase >= 340 && phase < 420) { drift -= 0.002; volume *= 2; }
    const o = p; p = Math.max(1, p * (1 + drift));
    out.push({ timestamp: start + (i * HOUR), open: o, close: p, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, volume });
  }
  return out;
}

test('only trades entered in the unseen forward window count; strict starts at registration', () => {
  const start = FORWARD_PAPER_START_MS - (60 * 24 * HOUR);
  const nowMs = H4_MAJORS_REGISTERED_AT + (120 * 24 * HOUR);
  const n = Math.floor((nowMs - start) / HOUR);
  const datasets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'].map((symbol, k) => ({ symbol, candles: hourly(start, n, 21 + k) }));
  const trades = h4MajorsForwardTradesV1({ datasets, nowMs });
  assert.ok(trades.length > 0, 'synthetic pumps should produce trades');
  assert.ok(trades.every((t) => t.entryTime >= FORWARD_PAPER_START_MS));
  assert.ok(trades.every((t) => t.side === 'long'));
  assert.ok(trades.every((t) => t.symbol !== 'ADAUSDT'), 'majors only');
  assert.ok(trades.every((t) => t.strict === (t.entryTime >= H4_MAJORS_REGISTERED_AT)));
  const summary = summarizeH4MajorsForwardV1(trades);
  assert.equal(summary.strict.n, trades.filter((t) => t.status === 'CLOSED' && t.strict).length);
  assert.match(formatH4MajorsForwardKoV1({ symbols: datasets.map((d) => d.symbol), trades, summary }), /엄격 표본/u);
});

test('promotion needs 30 strict closed trades, a positive 95% lower bound and 3 symbols', () => {
  const make = (count, r, symbols) => Array.from({ length: count }, (_, i) => ({
    status: 'CLOSED', strict: true, rMultiple: r + ((i % 3) * 0.01), symbol: symbols[i % symbols.length], entryTime: i,
  }));
  assert.equal(summarizeH4MajorsForwardV1(make(29, 1, ['A', 'B', 'C'])).promotionEligible, false);
  assert.equal(summarizeH4MajorsForwardV1(make(30, 1, ['A', 'B'])).promotionEligible, false);
  assert.equal(summarizeH4MajorsForwardV1(make(30, 1, ['A', 'B', 'C'])).promotionEligible, true);
  assert.equal(summarizeH4MajorsForwardV1(make(30, -1, ['A', 'B', 'C'])).promotionEligible, false);
  const notStrict = make(30, 1, ['A', 'B', 'C']).map((t) => ({ ...t, strict: false }));
  assert.equal(summarizeH4MajorsForwardV1(notStrict).promotionEligible, false);
});
