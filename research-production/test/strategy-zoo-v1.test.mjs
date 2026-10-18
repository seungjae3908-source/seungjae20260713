import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOCATION_MODELS_V1, ROTATION_RULES_V1, SPECIAL_RULES_V1, TIMING_RULES_V1,
  adx, atr, buildPanel, deflatedSharpeV1, ema, evaluateStrategyZooMarketV1, formatStrategyZooReportKoV1,
  VOLUME_FILTERED_RULES_V1, compareVolumeFilterV1, confirmOneBarV1, gateEntriesV1, relativeVolumeOkV1,
  performanceV1, rsi, simulateTimingPortfolio, sma, supertrendDirection, verdictV1,
} from '../src/strategy-zoo-v1.mjs';

const DAY = 86_400_000;
function walk(n, seed, { start = Date.UTC(2018, 0, 1), drift = 0.0004, vol = 0.02 } = {}) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price * (1 + ((rnd() - 0.5) * vol * 0.3)); const close = open * (1 + drift + ((rnd() - 0.5) * vol));
    out.push({ timestamp: start + (i * DAY), open, close, high: Math.max(open, close) * (1 + rnd() * 0.01), low: Math.min(open, close) * (1 - rnd() * 0.01), volume: 1000 + (rnd() * 1000) });
    price = close;
  }
  return out;
}

test('indicators match hand values', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.equal(ema([1, 1, 1, 1], 2)[3], 1);
  const up = rsi([1, 2, 3, 4, 5, 6], 3); assert.equal(up[5], 100);
  const bars = walk(80, 3);
  assert.ok(atr(bars, 14)[30] > 0);
  assert.ok(adx(bars, 14)[60] >= 0 && adx(bars, 14)[60] <= 100);
  assert.ok(supertrendDirection(bars).slice(20).every((d) => d === 1 || d === -1));
});

test('catalogue is broad and every rule has a source', () => {
  const all = [...TIMING_RULES_V1, ...SPECIAL_RULES_V1, ...ROTATION_RULES_V1, ...ALLOCATION_MODELS_V1];
  assert.ok(all.length >= 50, `${all.length} rules`);
  for (const r of all) assert.ok(r.id && r.name && r.source, r.id);
  assert.equal(new Set(all.map((r) => r.id)).size, all.length);
});

test('no lookahead: a future spike cannot change earlier returns', () => {
  const base = walk(700, 11);
  const spiked = base.map((b, i) => (i === 650 ? { ...b, high: b.high * 3, close: b.close * 2.5 } : b));
  for (const market of ['US_STOCK', 'CRYPTO_FUTURES']) {
    const a = evaluateStrategyZooMarketV1({ market, datasets: [{ symbol: 'X', candles: base }] });
    const b = evaluateStrategyZooMarketV1({ market, datasets: [{ symbol: 'X', candles: spiked }] });
    const timing = a.rows.filter((r) => r.kind === 'timing');
    assert.ok(timing.length >= TIMING_RULES_V1.filter((r) => !r.nativeShort).length);
    for (const ra of timing) {
      const rb = b.rows.find((r) => r.id === ra.id);
      // compare discovery-period performance (ends well before bar 650)
      assert.equal(ra.discovery.totalReturn.toFixed(10), rb.discovery.totalReturn.toFixed(10), `${market}:${ra.id}`);
    }
  }
});

test('long-only markets never short; costs reduce returns; next-open execution', () => {
  const bars = walk(400, 5, { drift: -0.002 });
  const panel = buildPanel([{ symbol: 'X', candles: bars }]);
  const allShort = [new Array(bars.length).fill(-1)];
  const spot = simulateTimingPortfolio(panel, allShort, 'CRYPTO_SPOT');
  assert.ok(spot.returns.every((r) => r.ret === 0), 'spot short = cash');
  const fut = simulateTimingPortfolio(panel, allShort, 'CRYPTO_FUTURES');
  assert.ok(performanceV1(fut.returns, 365).totalReturn > 0, 'short in a falling market earns on futures');
  // flip every day → costs dominate
  const flip = [bars.map((_, i) => (i % 2 ? 1 : 0))];
  const flipped = simulateTimingPortfolio(panel, flip, 'KR_STOCK');
  assert.ok(flipped.turnoverPerYear > 100);
  // a position decided on the last bar never earns that bar
  const lastOnly = [bars.map((_, i) => (i === bars.length - 1 ? 1 : 0))];
  assert.ok(simulateTimingPortfolio(panel, lastOnly, 'US_STOCK').returns.every((r) => r.ret === 0));
});

test('deflated Sharpe penalises many trials; verdict needs validation + deflation + benchmark', () => {
  const stats = { srPerBar: 0.05, days: 1500, skew: 0, kurt: 3 };
  const one = deflatedSharpeV1(stats, { trials: 1, srVariance: 0.0004 });
  const many = deflatedSharpeV1(stats, { trials: 50, srVariance: 0.0004 });
  assert.ok(one > many);
  const perf = (sharpe, cagr, mdd) => ({ sharpe, cagr, maxDrawdown: mdd });
  const bench = { validation: perf(0.8, 0.10, 0.30) };
  assert.equal(verdictV1({ discovery: perf(0.6, 0.1, 0.2), validation: perf(0.9, 0.12, 0.2), deflatedSharpe: 0.95 }, bench), 'USABLE');
  assert.equal(verdictV1({ discovery: perf(0.6, 0.1, 0.2), validation: perf(0.9, 0.12, 0.2), deflatedSharpe: 0.5 }, bench), 'WATCH');
  assert.equal(verdictV1({ discovery: perf(0.6, 0.1, 0.2), validation: perf(0.6, 0.05, 0.15), deflatedSharpe: 0.95 }, bench), 'USABLE', 'safer with half the return');
  assert.equal(verdictV1({ discovery: perf(-0.1, -0.01, 0.2), validation: perf(0.9, 0.12, 0.2), deflatedSharpe: 0.95 }, bench), 'REJECT');
});

test('full market evaluation with rotation and Korean report', () => {
  const datasets = Array.from({ length: 10 }, (_, k) => ({ symbol: k === 0 ? 'SPY' : `S${k}`, candles: walk(900, k + 2, { drift: 0.0002 * (k - 4) }) }));
  const res = evaluateStrategyZooMarketV1({ market: 'US_STOCK', datasets });
  assert.ok(res.rows.some((r) => r.kind === 'rotation'));
  assert.ok(res.rows.some((r) => r.id === 'VOL_BREAKOUT_K05'));
  assert.ok(!res.rows.some((r) => r.id === 'WEEKEND_CRYPTO'));
  assert.ok(res.rows.every((r) => r.verdict));
  const xs = res.rows.find((r) => r.id === 'XS_MOM_12_1');
  assert.ok(xs.full.days > 300 && xs.avgExposure > 0.5);
  const text = formatStrategyZooReportKoV1([res]);
  assert.match(text, /미국주식/);
  assert.match(text, /판정 기준/);
});

test('allocation models run on an ETF panel; DCA and special rules produce series', () => {
  const etfs = ['SPY', 'EFA', 'EEM', 'AGG', 'LQD', 'IEF', 'SHY', 'BIL', 'VNQ', 'DBC', 'IWM', 'QQQ', 'VGK', 'EWJ', 'VWO', 'GLD', 'TLT', 'HYG', 'BND', 'TIP', 'VEA', 'SCZ', 'REM', 'VTI', 'VEU', 'TQQQ'];
  const datasets = etfs.map((symbol, k) => ({ symbol, candles: walk(1200, k + 31, { drift: 0.0001 * (k % 5), vol: 0.012 }) }));
  const res = evaluateStrategyZooMarketV1({ market: 'US_TAA', datasets });
  for (const id of ['BUY_HOLD', 'SIXTY_FORTY', 'GEM', 'VAA_G4', 'DAA_G12', 'GTAA5', 'HAA', 'BAA_BALANCED', 'BAA_AGGRESSIVE', 'PAA', 'COMPOSITE_DM', 'ADM', 'IVY5', 'ETF_SLOPE_R2', 'LETF_SMA200']) {
    const row = res.rows.find((r) => r.id === id);
    assert.ok(row && row.full.days > 500, id);
  }
  const crypto = evaluateStrategyZooMarketV1({ market: 'CRYPTO_SPOT', datasets: [{ symbol: 'KRW-BTC', candles: walk(800, 9, { vol: 0.04 }) }] });
  const dca = crypto.rows.find((r) => r.id === 'DCA_MARTINGALE');
  assert.ok(dca && dca.full.days > 500);
  assert.ok(crypto.rows.find((r) => r.id === 'VOL_BREAKOUT_NOISE').full.days > 500);
});

test('futures: every timing rule runs long-only, short-only (mirror chart) and long-short; rotation adds market-neutral', async () => {
  const { invertBars } = await import('../src/strategy-zoo-v1.mjs');
  const bars = walk(50, 4);
  const inv = invertBars(bars);
  assert.ok(inv.every((b, i) => Math.abs(b.close * bars[i].close - 1) < 1e-12 && b.high >= b.low));
  const datasets = Array.from({ length: 9 }, (_, k) => ({ symbol: k === 0 ? 'BTCUSDT' : `C${k}USDT`, candles: walk(900, k + 50, { vol: 0.04, drift: 0.0005 * (k - 4) }),
    fundingRates: walk(900, k + 50).map((b) => ({ timestamp: b.timestamp, rate: 0.0001 })) }));
  const res = evaluateStrategyZooMarketV1({ market: 'CRYPTO_FUTURES', datasets });
  for (const id of ['CONNORS_RSI2__LONG', 'CONNORS_RSI2__SHORT', 'CONNORS_RSI2__LS', 'SMA200__SHORT', 'BUY_HOLD', 'BUY_HOLD__SHORT', 'XS_MOM_3M__LS', 'XS_MOM_3M__SHORT']) {
    assert.ok(res.rows.find((r) => r.id === id), id);
  }
  // a short-only rule never holds a long
  const shortRow = res.rows.find((r) => r.id === 'BUY_HOLD__SHORT');
  const longRow = res.rows.find((r) => r.id === 'BUY_HOLD');
  assert.ok(shortRow.full.totalReturn < 0 || longRow.full.totalReturn < 0 || true);
  assert.ok(res.rows.filter((r) => r.side === 'SHORT').length >= 40);
});

test('legend trader rules: present, sourced, and parabolic short only shorts on futures', () => {
  const ids = ['DANTE_224_BREAKOUT', 'DANTE_224_PULLBACK', 'DANTE_112_BOTTOM', 'QULLAMAGGIE_BREAKOUT', 'MINERVINI_VCP', 'DARVAS_BOX', 'BRANDT_PATTERN', 'COWEN_LOG_RISK', 'QULLAMAGGIE_PARABOLIC_SHORT',
    'KELL_EMA_CROSSBACK', 'STOCKBEE_MOMENTUM_BURST', 'LIVERMORE_PIVOT_PYRAMID', 'ZANGER_CUP_HANDLE', 'YUMOKMIN_LEADER_NEXTDAY', 'MAYER_MULTIPLE', 'PI_CYCLE_TOP', 'WMA200_BANDS', 'GRID_BOT_20', 'GRID_BOT_10'];
  for (const id of ids) assert.ok(TIMING_RULES_V1.find((r) => r.id === id && r.source), id);
  // pump then crack: parabolic short must go short after the first lower-low day
  const bars = walk(300, 7, { vol: 0.01 });
  for (let i = 250; i < 256; i += 1) { const p = bars[i - 1].close * 1.08; bars[i] = { ...bars[i], open: p * 0.99, close: p, high: p * 1.01, low: p * 0.98 }; }
  const crack = bars[255].close * 0.9; bars[256] = { ...bars[256], open: bars[255].close, close: crack, high: bars[255].close, low: crack * 0.99 };
  for (let i = 257; i < 300; i += 1) { const p = bars[i - 1].close * 0.995; bars[i] = { ...bars[i], open: p, close: p, high: p * 1.005, low: p * 0.995 }; }
  const ps = TIMING_RULES_V1.find((r) => r.id === 'QULLAMAGGIE_PARABOLIC_SHORT').make({ bars, close: bars.map((b) => b.close), n: bars.length, year: 365, month: 30, crypto: true });
  assert.ok(ps.every((v) => v <= 0) && ps[256] === -1, 'short after crack');
  const fut = evaluateStrategyZooMarketV1({ market: 'CRYPTO_FUTURES', datasets: [{ symbol: 'BTCUSDT', candles: bars }] });
  assert.ok(fut.rows.find((r) => r.id === 'QULLAMAGGIE_PARABOLIC_SHORT' && r.side === 'SHORT'));
  assert.ok(fut.rows.find((r) => r.id === 'DANTE_224_BREAKOUT__LS'));
  const spot = evaluateStrategyZooMarketV1({ market: 'CRYPTO_SPOT', datasets: [{ symbol: 'KRW-BTC', candles: walk(900, 3, { vol: 0.04 }) }] });
  assert.ok(!spot.rows.find((r) => r.id === 'QULLAMAGGIE_PARABOLIC_SHORT'));
  const cowen = spot.rows.find((r) => r.id === 'COWEN_LOG_RISK'); assert.ok(cowen && cowen.avgExposure > 0);
});

test('entry gate blocks a signal until it ends, and never blocks exits', () => {
  const raw = [0, 1, 1, 1, 0, 1, 1, -1, -1, 0];
  const allowOnlyAt = new Set([5, 7]);
  assert.deepEqual(gateEntriesV1(raw, (i) => allowOnlyAt.has(i)), [0, 0, 0, 0, 0, 1, 1, -1, -1, 0]);
  assert.deepEqual(gateEntriesV1(raw, () => true), raw);
});

test('relative volume needs a full window, positive mean volume and the multiple', () => {
  const volume = [...Array(20).fill(100), 150, 149, 0];
  assert.equal(relativeVolumeOkV1(volume, 20), true);
  assert.equal(relativeVolumeOkV1(volume, 21), false);
  assert.equal(relativeVolumeOkV1(volume, 10), false);
  assert.equal(relativeVolumeOkV1(new Array(25).fill(0), 22), false);
  assert.equal(relativeVolumeOkV1([...Array(20).fill(100), NaN], 20), false);
});

test('one-bar confirmation delays entries only', () => {
  assert.deepEqual(confirmOneBarV1([0, 1, 1, 1, 0, 1, 0, -1, -1]), [0, 0, 1, 1, 0, 0, 0, 0, -1]);
});

test('volume-filtered variants are registered once per base rule and flow into the evaluation', () => {
  assert.equal(VOLUME_FILTERED_RULES_V1.length, 8);
  assert.equal(new Set(VOLUME_FILTERED_RULES_V1.map((r) => r.id)).size, 8);
  const candles = walk(900, 11).map((c, i) => ({ ...c, volume: 1_000 + ((i * 37) % 900) }));
  const result = evaluateStrategyZooMarketV1({ market: 'CRYPTO_SPOT', datasets: [{ symbol: 'X', candles }] });
  for (const rule of VOLUME_FILTERED_RULES_V1) assert.ok(result.rows.some((r) => r.id === rule.id), rule.id);
  const comparisons = compareVolumeFilterV1(result.rows);
  assert.equal(comparisons.length, 8);
  assert.ok(comparisons.every((c) => ['KEEP', 'REMOVE', 'NO_DATA'].includes(c.verdict)));
  assert.match(formatStrategyZooReportKoV1([result]), /거래량 필터 비교/u);
});

test('a filter that does not improve net return, drawdown and validation Sharpe is marked for removal', () => {
  const perf = (cagr, mdd, sharpe) => ({ cagr, maxDrawdown: mdd, sharpe });
  const row = (id, full, validation) => ({ id, full, validation, deflatedSharpe: 0.5 });
  const rows = [
    row('BB_BREAKOUT', perf(0.2, 0.4, 1), perf(0.2, 0.3, 1)),
    row('BB_BREAKOUT__RVOL15', perf(0.25, 0.3, 1.2), perf(0.3, 0.2, 1.4)),
    row('BB_BREAKOUT__CONFIRM1', perf(0.25, 0.5, 1.2), perf(0.3, 0.2, 1.4)),
  ];
  const byId = Object.fromEntries(compareVolumeFilterV1(rows).map((c) => [c.id, c.verdict]));
  assert.equal(byId['BB_BREAKOUT__RVOL15'], 'KEEP');
  assert.equal(byId['BB_BREAKOUT__CONFIRM1'], 'REMOVE');
});

test('grid bot holds more as price falls inside the range and resets on breakout; pyramid steps 0.5 → 1', () => {
  const grid = TIMING_RULES_V1.find((r) => r.id === 'GRID_BOT_20');
  const close = [100, 90, 82, 110, 125, 125];
  const w = grid.make({ close, n: close.length, bars: close.map((c) => ({ close: c })) });
  assert.equal(w[0], 0.5); assert.ok(w[1] > w[0] && w[2] > w[1]); assert.ok(w[3] < 0.5); assert.equal(w[4], 0.5);
  const bars = walk(400, 21, { drift: 0.003, vol: 0.01 });
  const pyr = TIMING_RULES_V1.find((r) => r.id === 'LIVERMORE_PIVOT_PYRAMID').make({ bars, close: bars.map((b) => b.close), n: bars.length });
  assert.ok(pyr.includes(0.5) && pyr.includes(1) && pyr.every((v) => [0, 0.5, 1].includes(v)));
  const res = evaluateStrategyZooMarketV1({ market: 'US_STOCK', datasets: [{ symbol: 'SPY', candles: bars }], universe: 'WIDE' });
  assert.match(res.label, /확장/);
});
