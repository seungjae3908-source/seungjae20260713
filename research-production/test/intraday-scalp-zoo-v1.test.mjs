import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTRADAY_RULES_V1, buildIntradayContext, equityCurve, evaluateIntradayVenueV1, formatIntradayReportKoV1,
  intradayVerdictV1, simulateIntradayRule, tradeStats,
} from '../src/intraday-scalp-zoo-v1.mjs';

const M5 = 5 * 60_000;
function walk(n, seed, { start = Date.UTC(2023, 0, 1), step = M5, vol = 0.003 } = {}) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let p = 100;
  for (let i = 0; i < n; i += 1) {
    const o = p; const c = o * (1 + ((rnd() - 0.5) * vol * 2));
    out.push({ timestamp: start + (i * step), open: o, close: c, high: Math.max(o, c) * (1 + (rnd() * vol)), low: Math.min(o, c) * (1 - (rnd() * vol)), volume: 100 + (rnd() * 100) });
    p = c;
  }
  return out;
}

const flat = (n, price = 100) => Array.from({ length: n }, (_, i) => ({ timestamp: Date.UTC(2023, 0, 1) + (i * M5), open: price, high: price, low: price, close: price, volume: 100 }));

test('stop is assumed first when stop and target are touched in the same bar; costs are charged', () => {
  const bars = flat(10); bars[2] = { ...bars[2], high: 110, low: 90 };
  const rule = { id: 'X', side: 'LONG', signal: (c, i) => (i === 1 ? { stopPct: 0.02, targetPct: 0.05, maxBars: 5 } : null) };
  const [t] = simulateIntradayRule(buildIntradayContext(bars), rule, 0.001);
  assert.equal(t.reason, 'STOP');
  assert.ok(Math.abs(t.ret - (-0.02 - (0.001 * (1 + 0.98)))) < 1e-12);
  const short = { ...rule, side: 'SHORT' };
  assert.equal(simulateIntradayRule(buildIntradayContext(bars), short, 0)[0].reason, 'STOP');
});

test('entry is the next bar open and a gap through the stop fills at the open', () => {
  const bars = flat(10); bars[2] = { ...bars[2], open: 100 }; bars[3] = { ...bars[3], open: 90, high: 91, low: 89, close: 90 };
  const rule = { id: 'X', side: 'LONG', signal: (c, i) => (i === 1 ? { stopPct: 0.02, targetPct: 0.05, maxBars: 5 } : null) };
  const [t] = simulateIntradayRule(buildIntradayContext(bars), rule, 0);
  assert.equal(t.entryT, bars[2].timestamp);
  assert.ok(Math.abs(t.ret - (-0.10)) < 1e-12, 'gap fill at 90, worse than the 98 stop');
});

test('trailing stop tightens from the previous bar extreme only', () => {
  const bars = flat(10);
  bars[2] = { ...bars[2], open: 100, high: 100, low: 100, close: 100 };
  bars[3] = { ...bars[3], open: 100, high: 120, low: 100, close: 119 };
  bars[4] = { ...bars[4], open: 119, high: 119, low: 113, close: 113 };
  const rule = { id: 'X', side: 'LONG', signal: (c, i) => (i === 1 ? { stopPct: 0.05, trailPct: 0.05, maxBars: 8 } : null) };
  const [t] = simulateIntradayRule(buildIntradayContext(bars), rule, 0);
  assert.equal(t.reason, 'STOP'); assert.ok(Math.abs(t.ret - 0.14) < 1e-9, '120 × 0.95 = 114');
});

test('no lookahead: changing bars after a trade cannot change it', () => {
  const base = walk(6000, 3, { vol: 0.01 });
  const changed = base.map((b, i) => (i > 5000 ? { ...b, close: b.close * 3, high: b.high * 3 } : b));
  for (const rule of INTRADAY_RULES_V1.filter((r) => r.venue === 'BITGET_5M')) {
    const a = simulateIntradayRule(buildIntradayContext(base), rule, 0.0008).filter((t) => t.exitT < base[4000].timestamp);
    const b = simulateIntradayRule(buildIntradayContext(changed), rule, 0.0008).filter((t) => t.exitT < base[4000].timestamp);
    assert.deepEqual(a, b, rule.id);
  }
});

test('opening-range breakout trades at most once per session', () => {
  const bars = walk(288 * 20, 9, { vol: 0.004 });
  const rule = INTRADAY_RULES_V1.find((r) => r.id === 'F5_ORB_KST9_LONG');
  const trades = simulateIntradayRule(buildIntradayContext(bars), rule, 0);
  const days = trades.map((t) => Math.floor(t.entryT / 86_400_000));
  assert.equal(new Set(days).size, days.length);
  assert.ok(trades.every((t) => (t.entryT % 86_400_000) >= 30 * 60_000), 'never enters inside the range window');
});

test('every rule is sourced; venue evaluation, baselines, verdicts and report', () => {
  for (const r of INTRADAY_RULES_V1) assert.ok(r.id && r.name && r.source && r.venue && r.side, r.id);
  assert.equal(new Set(INTRADAY_RULES_V1.map((r) => r.id)).size, INTRADAY_RULES_V1.length);
  const datasets = [1, 2].map((k) => ({ symbol: `S${k}USDT`, candles: walk(288 * 30, k + 20, { vol: 0.006 }) }));
  const from = datasets[0].candles[0].timestamp; const to = datasets[0].candles.at(-1).timestamp;
  const res = evaluateIntradayVenueV1({ venue: 'BITGET_5M', datasets, splitTime: from + ((to - from) * 0.6), span: { from, to } });
  assert.ok(res.rows.length >= 14);
  assert.ok(res.rows.find((r) => r.id === 'F5_VOL_SPIKE_BREAKOUT').baseline);
  assert.ok(res.rows.every((r) => r.verdict));
  const up = evaluateIntradayVenueV1({ venue: 'UPBIT_1H', datasets: [{ symbol: 'KRW-X', candles: walk(24 * 200, 5, { step: 3_600_000, vol: 0.03 }), listedInWindow: true }],
    splitTime: Date.UTC(2023, 3, 1), span: { from: Date.UTC(2023, 0, 1), to: Date.UTC(2023, 6, 1) } });
  assert.ok(up.rows.every((r) => r.side === 'LONG'));
  assert.equal(up.rows.find((r) => r.id === 'U1H_LISTING_RIDE').full.n, 1);
  assert.match(formatIntradayReportKoV1([res, up]), /무작위 진입/u);
  const stat = (mean, n, pf, t) => ({ mean, n, profitFactor: pf, tStat: t });
  assert.equal(intradayVerdictV1({ discovery: stat(0.002, 200), validation: stat(0.003, 100, 1.3, 3), full: stat(0.002, 300) }, { validation: stat(-0.001, 100) }), 'USABLE');
  assert.equal(intradayVerdictV1({ discovery: stat(0.002, 200), validation: stat(0.003, 100, 1.3, 3), full: stat(0.002, 300) }, { validation: stat(0.004, 100) }), 'WATCH', 'must beat random entries');
  assert.equal(intradayVerdictV1({ discovery: stat(0.002, 20), validation: stat(0.003, 10, 1.3, 3), full: stat(0.002, 30) }, null), 'TOO_FEW_TRADES');
  const st = tradeStats([{ ret: 0.1, bars: 1 }, { ret: -0.05, bars: 1 }]); assert.equal(st.share10, 0.5); assert.equal(st.profitFactor, 2);
  const eq = equityCurve([{ exitT: 1, ret: 0.1 }, { exitT: 2, ret: -0.1 }], { fraction: 0.5, from: 0, to: 365 * 86_400_000 });
  assert.ok(Math.abs(eq.finalMultiple - (1.05 * 0.95)) < 1e-12);
});
