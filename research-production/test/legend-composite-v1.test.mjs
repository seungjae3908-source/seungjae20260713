import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGEND_VARIANTS_V1, curveStats, evaluateLegendCompositeV1, formatLegendCompositeReportKoV1, simulateLegendCompositeV1, yearlyReturns,
} from '../src/legend-composite-v1.mjs';

const H = 3_600_000;
const T0 = Date.UTC(2021, 0, 1);
function series(n, seed, { drift = 0, vol = 0.004 } = {}) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let p = 100;
  for (let i = 0; i < n; i += 1) {
    const o = p; const c = o * (1 + drift + ((rnd() - 0.5) * vol));
    out.push({ timestamp: T0 + (i * H), open: o, close: c, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, volume: 100 });
    p = c;
  }
  return out;
}
/** A pump at bar k (+6%, 10× volume) followed by a steady rally of `bars` hours. */
function withPump(base, k, { bars = 60, step = 0.01, crashAt = null } = {}) {
  const out = base.map((b) => ({ ...b }));
  let p = out[k - 1].close;
  out[k] = { ...out[k], open: p, close: p * 1.06, high: p * 1.065, low: p * 0.998, volume: 1000 }; p *= 1.06;
  for (let i = k + 1; i < Math.min(out.length, k + 1 + bars); i += 1) {
    const o = p; const c = crashAt !== null && i === crashAt ? o * 0.7 : o * (1 + step);
    out[i] = { ...out[i], open: crashAt !== null && i === crashAt ? o * 0.7 : o, close: c, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, volume: 100 };
    p = c;
  }
  for (let i = k + 1 + bars; i < out.length; i += 1) { const r = out[i].close / out[i].open; out[i] = { ...out[i], open: p, close: p * r, high: p * Math.max(1, r) * 1.001, low: p * Math.min(1, r) * 0.999 }; p *= r; }
  return out;
}
const variant = (id) => LEGEND_VARIANTS_V1.find((v) => v.id === id);

test('pump entry fills at the next open, trails without a fixed target and pyramids into strength', () => {
  const bars = withPump(series(1600, 3), 1300, { bars: 80, step: 0.01 });
  const ds = [{ symbol: 'XUSDT', candles: bars }];
  const trail = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets: ds, variant: variant('V2_PYRAMID'), maxPositions: 3, fill: 'TAKER' });
  const t = trail.trades.find((x) => x.entryT === bars[1301].timestamp);
  assert.ok(t, 'entered at the bar after the signal');
  assert.equal(t.entry, bars[1301].open);
  assert.ok(t.adds === 2, 'added at +1R and +2R');
  assert.ok(t.ret > 0.5, `rode the rally (${t.ret})`);
  const fixed = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets: ds, variant: variant('V0_FIXED_TP'), maxPositions: 3, fill: 'TAKER' });
  const f = fixed.trades.find((x) => x.entryT === bars[1301].timestamp);
  assert.ok(Math.abs(f.ret - 0.12) < 1e-9 && f.reason === 'TARGET');
  assert.ok(trail.curve.at(-1).equity > fixed.curve.at(-1).equity);
});

test('a gap below the stop exits at the open; worst case books the add before the stop', () => {
  const bars = withPump(series(1600, 5), 1300, { bars: 30, step: 0.01, crashAt: 1310 });
  const sim = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets: [{ symbol: 'XUSDT', candles: bars }], variant: variant('V1_TRAIL'), maxPositions: 3, fill: 'TAKER' });
  const t = sim.trades.find((x) => x.entryT === bars[1301].timestamp);
  assert.equal(t.reason, 'STOP'); assert.equal(t.exit, bars[1310].open);
});

test('maker entries only fill when the next bar trades through the limit', () => {
  const bars = withPump(series(1600, 7), 1300, { bars: 40, step: 0.01 });
  bars[1301] = { ...bars[1301], low: bars[1300].close * 1.001, open: bars[1300].close * 1.002 };
  const sim = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets: [{ symbol: 'XUSDT', candles: bars }], variant: variant('V1_TRAIL'), maxPositions: 3, fill: 'MAKER' });
  assert.ok(!sim.trades.some((x) => x.entryT === bars[1301].timestamp));
});

test('no lookahead: future bars cannot change the past equity curve; max positions respected', () => {
  const sets = Array.from({ length: 6 }, (_, k) => ({ symbol: k ? `C${k}USDT` : 'BTCUSDT', candles: withPump(series(2600, k + 11, { vol: 0.02, drift: 0.0002 }), 1400 + (k * 7), { bars: 50 }) }));
  const changed = sets.map((d) => ({ ...d, candles: d.candles.map((b, i) => (i > 2200 ? { ...b, close: b.close * 2, high: b.high * 2 } : b)) }));
  for (const v of LEGEND_VARIANTS_V1) {
    const a = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets: sets, variant: v, maxPositions: 2, fill: 'TAKER' });
    const b = simulateLegendCompositeV1({ venue: 'PERP_1H', datasets: changed, variant: v, maxPositions: 2, fill: 'TAKER' });
    const cut = sets[0].candles[2100].timestamp;
    assert.deepEqual(a.curve.filter((c) => c.t < cut), b.curve.filter((c) => c.t < cut), v.id);
    const events = a.trades.flatMap((x) => [[x.entryT, 1], [x.exitT + 1, -1]]).sort((x, y) => x[0] - y[0]);
    let live = 0; for (const [, d] of events) { live += d; assert.ok(live <= 2, `${v.id} concurrent ${live}`); }
  }
});

test('evaluation, statistics and Korean report', () => {
  const sets = Array.from({ length: 4 }, (_, k) => ({ symbol: k ? `C${k}USDT` : 'BTCUSDT', candles: withPump(series(3000, k + 3, { vol: 0.02, drift: 0.0001 }), 1500 + (k * 50)) }));
  const from = sets[0].candles[0].timestamp; const to = sets[0].candles.at(-1).timestamp + H;
  const res = evaluateLegendCompositeV1({ venue: 'PERP_1H', datasets: sets, span: { from, to }, splitTime: from + ((to - from) * 0.6) });
  assert.equal(res.rows.length, LEGEND_VARIANTS_V1.length * 4);
  assert.ok(res.btc && res.rows.every((r) => r.verdict));
  assert.match(formatLegendCompositeReportKoV1([res]), /종합판/u);
  const curve = [{ t: Date.UTC(2021, 0, 1), equity: 1 }, { t: Date.UTC(2021, 11, 31), equity: 1.5 }, { t: Date.UTC(2022, 11, 31), equity: 0.75 }];
  const y = yearlyReturns(curve); assert.ok(Math.abs(y[2021] - 0.5) < 1e-12 && Math.abs(y[2022] + 0.5) < 1e-12);
  assert.ok(Math.abs(curveStats(curve, 0, Date.UTC(2030, 0, 1)).maxDrawdown - 0.5) < 1e-12);
});

test('robustness grid, trend-pilot replica and monthly combination', async () => {
  const { robustnessGridV1, trendPilotReplicaTradesV1, monthlyFromCurve, monthlyFromTrades, combineMonthlyV1, formatRobustnessReportKoV1 } = await import('../src/legend-composite-v1.mjs');
  const sets = Array.from({ length: 3 }, (_, k) => ({ symbol: k ? `C${k}USDT` : 'BTCUSDT', candles: withPump(series(3000, k + 3, { vol: 0.02, drift: 0.0001 }), 1500 + (k * 50)) }));
  const from = sets[0].candles[0].timestamp; const to = sets[0].candles.at(-1).timestamp + H;
  const robust = robustnessGridV1({ datasets: sets, span: { from, to }, splitTime: from + ((to - from) * 0.6) });
  assert.equal(robust.grid.length, 27); assert.equal(robust.risk.length, 3); assert.equal(robust.oneAtATime.length, 4);
  const trending = series(4000, 9, { drift: 0.002, vol: 0.01 });
  const tp = trendPilotReplicaTradesV1(trending);
  assert.ok(tp.length > 0 && tp.every((t) => t.exitT >= t.entryT && Number.isFinite(t.rMultiple)));
  assert.ok(tp.some((t) => t.side === 'LONG'));
  const a = monthlyFromCurve(robust.risk[0].curve); const b = monthlyFromTrades(tp, 0.02);
  const c = combineMonthlyV1(a, b, Date.UTC(2021, 0, 1), Date.UTC(2021, 5, 1));
  assert.equal(c.months, 5);
  assert.match(formatRobustnessReportKoV1({ robust, correlation: c, span: { from: '2021-01-01', to: '2021-06-01' }, splitDate: '2021-04-01' }), /견고성/u);
});
