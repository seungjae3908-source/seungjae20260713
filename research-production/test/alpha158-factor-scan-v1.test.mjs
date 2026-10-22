import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ALPHA158_FACTOR_IDS_V1,
  benjaminiHochbergV1,
  computeAlpha158FactorsV1,
  evaluateAlpha158MarketV1,
  formatAlpha158ReportKoV1,
  forwardReturnsV1,
  rankV1,
  runAlpha158FactorScanV1,
  spearmanV1,
} from '../src/alpha158-factor-scan-v1.mjs';

const DAY = 86_400_000;
const START = Date.UTC(2021, 0, 4);

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

// Planted signal: a stock's next-week drift is the opposite of its last 5-day
// return (short-term reversal), so ROC5 (= close[t-5]/close[t]) is a real factor.
function plantedMarket(symbols, days, { strength = 0.6, seed = 3 } = {}) {
  const r = rng(seed);
  const series = symbols.map(() => [100]);
  for (let t = 1; t < days; t += 1) {
    for (const s of series) {
      const past = t >= 6 ? s[t - 1] / s[t - 6] - 1 : 0;
      s.push(Math.max(1, s[t - 1] * (1 + ((r() - 0.5) * 0.03) - (strength * past / 5))));
    }
  }
  return symbols.map((symbol, k) => ({ symbol, candles: series[k].map((close, t) => {
    const open = t ? series[k][t - 1] : close;
    return { timestamp: START + (t * DAY), open, close, high: Math.max(open, close) * 1.005, low: Math.min(open, close) * 0.995, volume: 1000 + (r() * 500) };
  }) }));
}

test('rank and spearman handle ties and perfect order', () => {
  assert.deepEqual(rankV1([3, 1, 1, 2]), [4, 1.5, 1.5, 3]);
  assert.equal(spearmanV1([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearmanV1([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearmanV1([1, null, 3], [1, 2, 3]), null);
});

test('factors use only past candles (no lookahead)', () => {
  const [d] = plantedMarket(['AAA'], 120);
  const full = computeAlpha158FactorsV1(d.candles);
  const cut = computeAlpha158FactorsV1(d.candles.slice(0, 80));
  for (const id of ALPHA158_FACTOR_IDS_V1) assert.equal(cut[id][79], full[id][79], id);
  assert.equal(ALPHA158_FACTOR_IDS_V1.length, 69);
  const fwd = forwardReturnsV1(d.candles, 5);
  assert.equal(fwd.at(-1), null);
  assert.ok(Math.abs(fwd[0] - (d.candles[5].close / d.candles[0].close - 1)) < 1e-12);
});

test('benjamini-hochberg is monotone and bounded', () => {
  const q = benjaminiHochbergV1([0.001, 0.04, 0.03, 0.9]);
  assert.ok(q.every((v) => v >= 0 && v <= 1));
  assert.ok(q[0] <= q[2] && q[2] <= q[1]);
});

test('a planted reversal factor is found; noise factors are not', () => {
  const symbols = Array.from({ length: 20 }, (_, k) => `S${String(k).padStart(2, '0')}`);
  const result = evaluateAlpha158MarketV1({ datasets: plantedMarket(symbols, 700) });
  const roc5 = result.factors.find((f) => f.factorId === 'ROC5');
  assert.equal(roc5.verdict, 'CANDIDATE');
  assert.equal(roc5.direction, 'HIGH_IS_BETTER'); // high ROC5 = fell over 5 days = rebounds
  assert.ok(roc5.unseen.symbols >= 3);
  const noise = plantedMarket(symbols, 700, { strength: 0, seed: 9 });
  const quiet = evaluateAlpha158MarketV1({ datasets: noise });
  assert.ok(quiet.candidates <= 2, `noise candidates ${quiet.candidates}`);
});

test('runner reads the cache, drops 2026 candles, caches results and reports in Korean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha158-'));
  try {
    const symbols = Array.from({ length: 14 }, (_, k) => `T${k}`);
    for (const d of plantedMarket(symbols, 400)) {
      d.candles.push({ timestamp: Date.UTC(2026, 0, 5), open: 1, high: 1e9, low: 1, close: 1e9, volume: 1 });
      const path = join(root, 'combination-research', 'datasets', 'YAHOO_US_1D', `${d.symbol}.json`);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, JSON.stringify({ symbol: d.symbol, candles: d.candles }));
    }
    const first = await runAlpha158FactorScanV1({ stateRoot: root, researchCodeSha: 'x', now: () => '2026-10-18T00:00:00.000Z' });
    assert.equal(first.markets.US_STOCK.status, 'COMPLETE');
    assert.equal(first.markets.KR_STOCK.status, 'WAITING_FOR_DATA');
    assert.equal(first.holdoutRead, false);
    for (const f of first.markets.US_STOCK.factors) assert.ok(!Number.isFinite(f.validationTopMinusBottom) || Math.abs(f.validationTopMinusBottom) < 1, f.factorId);
    const second = await runAlpha158FactorScanV1({ stateRoot: root, researchCodeSha: 'x', now: () => '2026-10-19T00:00:00.000Z' });
    assert.equal(second.markets.US_STOCK.computedAt, '2026-10-18T00:00:00.000Z');
    const saved = JSON.parse(await readFile(join(root, 'latest', 'alpha158-factor-scan-v1.json'), 'utf8'));
    const report = formatAlpha158ReportKoV1(saved);
    assert.match(report, /미국주식/);
    assert.match(report, /주문 권한은 없습니다/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
