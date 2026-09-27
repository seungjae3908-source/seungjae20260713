import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKETS,
  buildWalkForwardWindows,
  candlesAtOrBefore,
  discoverCandidates,
  evaluateForward,
  recallAtK,
} from '../src/engine.mjs';
import { runHistoricalReplay } from '../src/replay.mjs';

function makeCandles({ start = 1_700_000_000_000, count = 80, drift = 0.002, volumeBoostAt = null } = {}) {
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = open * (1 + drift);
    out.push({
      ts: start + (i * 60_000),
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1000 * (volumeBoostAt === i ? 5 : 1),
    });
    price = close;
  }
  return out;
}

test('past-only slicing never exposes future candles', () => {
  const data = makeCandles({ count: 40 });
  const asOf = data[20].ts;
  const past = candlesAtOrBefore(data, asOf);
  assert.equal(past.at(-1).ts, asOf);
  assert.equal(past.length, 21);
});

test('candidate discovery ranks stronger impulse first', () => {
  const weak = makeCandles({ drift: 0.0002, volumeBoostAt: 39 });
  const strong = makeCandles({ drift: 0.0025, volumeBoostAt: 39 });
  const asOf = strong[39].ts;
  const ranked = discoverCandidates({
    market: MARKETS.US_STOCK,
    symbols: ['WEAK', 'STRONG'],
    candlesBySymbol: { WEAK: weak, STRONG: strong },
    asOf,
    topK: 2,
    minScore: -100,
  });
  assert.equal(ranked[0].symbol, 'STRONG');
  assert.equal(ranked[0].rank, 1);
});

test('forward evaluation enters only on the next bar and treats active stop conservatively', () => {
  const data = makeCandles({ count: 50, drift: 0.001 });
  const discoveredAt = data[34].ts;
  const entry = data[35].open;
  data[35] = { ...data[35], high: entry * 1.12, low: entry * 0.90, close: entry * 1.01 };
  const result = evaluateForward({ candles: data, discoveredAt, maxBars: 5 });
  assert.equal(result.entryTs, data[35].ts);
  assert.match(result.exitReason, /STOP/);
  assert.equal(result.targetHitTs.pct3, null);
  assert.ok(result.ambiguousBars >= 1);
});

test('runner can hold beyond +10 percent before trailing exit', () => {
  const data = makeCandles({ count: 70, drift: 0.001 });
  const discoveredAt = data[34].ts;
  let p = data[35].open;
  for (let i = 35; i < 45; i += 1) {
    const open = p;
    const close = open * 1.02;
    data[i] = { ...data[i], open, high: close * 1.003, low: open * 0.997, close };
    p = close;
  }
  for (let i = 45; i < data.length; i += 1) {
    const open = p;
    const close = open * 0.985;
    data[i] = { ...data[i], open, high: open * 1.002, low: close * 0.995, close };
    p = close;
  }
  const result = evaluateForward({ candles: data, discoveredAt, maxBars: 30, trailActivateAtR: 2, trailAtrMult: 2 });
  assert.ok(result.mfe > 0.10);
  assert.notEqual(result.targetHitTs.pct10, null);
  assert.ok(result.maxR > 2);
});

test('costs reduce net return', () => {
  const data = makeCandles({ count: 60, drift: 0.0015 });
  const discoveredAt = data[34].ts;
  const gross = evaluateForward({ candles: data, discoveredAt, maxBars: 10, costs: {} });
  const net = evaluateForward({ candles: data, discoveredAt, maxBars: 10, costs: { feeBps: 5, slippageBps: 3, spreadBps: 2 } });
  assert.ok(net.netReturn < gross.netReturn);
});

test('walk-forward windows preserve purge gaps', () => {
  const start = Date.UTC(2023, 8, 27);
  const end = Date.UTC(2026, 8, 27);
  const windows = buildWalkForwardWindows({ startTs: start, endTs: end });
  assert.ok(windows.length > 0);
  for (const w of windows) {
    assert.ok(w.validationStart > w.trainEnd);
    assert.ok(w.testStart > w.validationEnd);
  }
});

test('Recall@K measures captured realized movers', () => {
  assert.deepEqual(
    recallAtK({ discoveredSymbols: ['A', 'B', 'C'], realizedMoverSymbols: ['B', 'C', 'D', 'E'] }),
    { captured: 2, totalMovers: 4, recall: 0.5 },
  );
});

test('historical replay stays market-agnostic and produces settled summary', () => {
  const a = makeCandles({ drift: 0.002, count: 65, volumeBoostAt: 35 });
  const b = makeCandles({ drift: 0.0003, count: 65, volumeBoostAt: 35 });
  const decisionTimes = [a[35].ts, a[40].ts];
  const result = runHistoricalReplay({
    market: MARKETS.CRYPTO_SPOT,
    decisionTimes,
    universeAt: () => ['A', 'B'],
    candlesBySymbol: { A: a, B: b },
    topK: 1,
    minScore: -100,
    forwardConfig: { maxBars: 10, costs: { feeBps: 5, slippageBps: 3, spreadBps: 2 } },
  });
  assert.equal(result.market, MARKETS.CRYPTO_SPOT);
  assert.equal(result.decisionPoints, 2);
  assert.equal(result.discoveries.length, 2);
  assert.equal(result.summary.n, 2);
});
