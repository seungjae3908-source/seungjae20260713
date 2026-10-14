import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runMarketShockReverseLaneV1 } from '../src/market-shock-reverse-lane-v1.mjs';

const SHA = 'c'.repeat(40);
const AT = '2026-10-14T01:00:00.000Z';
const HOUR = 60 * 60 * 1000;

function candles(seed, count = 900) {
  let close = 100 + seed;
  return Array.from({ length: count }, (_, index) => {
    const open = close;
    const cycle = index % 90;
    close = open * (1 + (cycle === 30 ? 0.08 : cycle === 70 ? -0.08 : 0));
    const volume = cycle >= 26 && cycle <= 30 ? 500 : 100;
    return { timestamp: Date.UTC(2025, 0, 1) + index * HOUR, open,
      high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998,
      close, volume, quoteVolume: close * volume };
  });
}

function loader() {
  let calls = 0;
  return {
    count: () => calls,
    load: async () => {
      calls += 1;
      return {
        range: { startTime: Date.UTC(2025, 0, 1), endTime: Date.UTC(2025, 11, 31, 23) },
        datasets: [
          { market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', timeframe: '1h', datasetIdentity: 'upbit:test', candles: candles(0) },
          { market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', timeframe: '1h', datasetIdentity: 'bitget:test', candles: candles(10) },
        ],
        sources: [
          { provider: 'UPBIT', status: 'READY', requests: { attempted: 5, http200: 5, httpNon200: 0, networkFailed: 0 } },
          { provider: 'BITGET', status: 'READY', requests: { attempted: 6, http200: 6, httpNon200: 0, networkFailed: 0 } },
        ],
      };
    },
  };
}

test('actual public datasets create point-in-time shock studies without Formula, Paper, or order authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shock-lane-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = loader();
  const result = await runMarketShockReverseLaneV1({ stateRoot: root, researchCodeSha: SHA,
    now: () => AT, loadDatasets: fixture.load });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.studyCount, 2);
  assert.ok(result.eventCount > 0);
  assert.ok(result.researchHypothesisCount > 0);
  assert.equal(result.formulaCandidateCount, 0);
  assert.equal(result.backtestCount, 0);
  assert.equal(result.actualPublicRequests, 11);
  assert.equal(result.safety.finalHoldoutUsed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(fixture.count(), 1);
});

test('same release and fixed non-holdout period resumes from durable result without refetching', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shock-lane-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = loader();
  await runMarketShockReverseLaneV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT, loadDatasets: fixture.load });
  const resumed = await runMarketShockReverseLaneV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT, loadDatasets: fixture.load });
  assert.equal(resumed.cacheHit, true);
  assert.equal(resumed.actualPublicRequestsThisRun, 0);
  assert.equal(fixture.count(), 1);
});

test('one provider failure preserves the successful market instead of claiming full coverage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shock-lane-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = candles(0);
  const result = await runMarketShockReverseLaneV1({
    stateRoot: root, researchCodeSha: SHA, now: () => AT,
    loadDatasets: async () => ({
      datasets: [{ market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', timeframe: '1h', datasetIdentity: 'upbit:test', candles: source }],
      sources: [
        { provider: 'UPBIT', status: 'READY', requests: { attempted: 5 } },
        { provider: 'BITGET', status: 'BLOCKED_DATA', reason: 'HTTP_503', requests: { attempted: 3 } },
      ],
    }),
  });
  assert.equal(result.status, 'PARTIAL_DATA');
  assert.equal(result.studyCount, 1);
  assert.equal(result.actualPublicRequests, 8);
});
