import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LONG_SHORT_FLIP_VARIANTS_V2,
  evaluateLongShortFlipV2,
  formatLongShortFlipReportKoV2,
  resampleFlipCandlesV2,
} from '../src/long-short-flip-backtest-v2.mjs';
import { LONG_SHORT_FLIP_RULES_V1, simulateLongShortFlipV1 } from '../src/long-short-flip-backtest-v1.mjs';

const HOUR = 3_600_000;
const START = Date.UTC(2023, 0, 1);

function hourly(n, seed = 9) {
  let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100; const out = [];
  for (let i = 0; i < n; i += 1) {
    const phase = i % 1200;
    let drift = (r() - 0.5) * 0.004; let volume = 100 * (0.8 + (r() * 0.4));
    if (phase >= 600 && phase < 660) { drift += 0.004; volume *= 6; }
    if (phase >= 660 && phase < 800) { drift -= 0.003; volume *= 2; }
    const o = p; p = Math.max(1, p * (1 + drift));
    out.push({ timestamp: START + (i * HOUR), open: o, close: p, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, volume });
  }
  return out;
}

test('resampling builds complete UTC-aligned bars and keeps OHLCV meaning', () => {
  const bars = resampleFlipCandlesV2(hourly(30), 4);
  assert.equal(bars.length, 7);
  assert.equal(bars[0].timestamp, START);
  const src = hourly(30).slice(0, 4);
  assert.equal(bars[0].open, src[0].open);
  assert.equal(bars[0].close, src[3].close);
  assert.equal(bars[0].high, Math.max(...src.map((c) => c.high)));
  assert.equal(bars[0].volume, src.reduce((s, c) => s + c.volume, 0));
  assert.equal(resampleFlipCandlesV2(src, 1), src);
});

test('v1 behaviour is unchanged unless the strict short is requested', () => {
  const candles = resampleFlipCandlesV2(hourly(20_000), 4);
  const loose = simulateLongShortFlipV1({ candles, variant: { flip: true, regime: false } });
  const sameAsV1 = simulateLongShortFlipV1({ candles, variant: { flip: true, regime: false }, rules: { ...LONG_SHORT_FLIP_RULES_V1 } });
  assert.deepEqual(loose, sameAsV1);
  const strict = simulateLongShortFlipV1({ candles, variant: { flip: true, regime: false },
    rules: { ...LONG_SHORT_FLIP_RULES_V1, confirmBars: 3, recentLowBars: 20, strictShort: true } });
  assert.ok(strict.filter((t) => t.side === 'short').length <= loose.filter((t) => t.side === 'short').length);
});

test('v2 evaluates the pre-registered variants, judges each flip against its own long-only twin', () => {
  const datasets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'].map((symbol, k) => ({ symbol, candles: hourly(20_000, 9 + k), fundingRates: [] }));
  const result = evaluateLongShortFlipV2({ datasets });
  assert.deepEqual(Object.keys(result.results), LONG_SHORT_FLIP_VARIANTS_V2.map((v) => v.id));
  assert.deepEqual(Object.keys(result.verdicts), ['H4_MAJORS_FLIP', 'D1_ALL_FLIP']);
  assert.equal(result.results.H4_MAJORS_LONG.validation.short.trades, 0);
  for (const v of Object.values(result.verdicts)) assert.ok(['SHORT_LEG_ADDS_VALUE', 'NOT_PROVEN'].includes(v.verdict));
  assert.equal(result.fundingCoverage, 0);
  assert.equal(result.safety.realOrder, false);
  assert.match(formatLongShortFlipReportKoV2(result), /검증 구간/u);
});
