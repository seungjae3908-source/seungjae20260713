import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPublicProviderResearchLaneV1 } from '../src/public-provider-research-lane-v1.mjs';

const SHA = 'd'.repeat(40);
const AT = '2026-10-14T01:00:00.000Z';

function publicFetch(counter, { failBitget = false } = {}) {
  return async (url, options) => {
    counter.count += 1;
    assert.equal(options.method, 'GET');
    if (String(url).includes('upbit')) return {
      status: 200,
      text: async () => JSON.stringify([{ market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' }]),
    };
    if (failBitget) return { status: 503, text: async () => JSON.stringify({ code: '503', data: [] }) };
    return {
      status: 200,
      text: async () => JSON.stringify({ code: '00000', data: [{ symbol: 'BTCUSDT', symbolStatus: 'normal', minTradeNum: '0.001' }] }),
    };
  };
}

test('fixed public endpoints record only verified data-source capabilities and no execution authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'provider-research-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counter = { count: 0 };
  const result = await runPublicProviderResearchLaneV1({ stateRoot: root, researchCodeSha: SHA,
    now: () => AT, fetchImpl: publicFetch(counter) });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.actualPublicRequestsThisRun, 2);
  assert.equal(result.verifiedProviderCount, 2);
  assert.deepEqual(result.categoryCounts, { STRATEGY_RESEARCH: 0, DATA_SOURCE: 2, EXECUTION_REFERENCE: 0 });
  assert.equal(result.providerResults.every((row) => row.connectedToFormula === false), true);
  assert.equal(result.providerResults.every((row) => row.connectedToExecution === false), true);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(counter.count, 2);
});

test('daily release cache prevents duplicate official API requests after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'provider-research-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counter = { count: 0 };
  const options = { stateRoot: root, researchCodeSha: SHA, now: () => AT, fetchImpl: publicFetch(counter) };
  await runPublicProviderResearchLaneV1(options);
  const resumed = await runPublicProviderResearchLaneV1(options);
  assert.equal(resumed.cacheHit, true);
  assert.equal(resumed.actualPublicRequestsThisRun, 0);
  assert.equal(counter.count, 2);
});

test('one non-200 remains partial and is not recorded as a verified provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'provider-research-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counter = { count: 0 };
  const result = await runPublicProviderResearchLaneV1({ stateRoot: root, researchCodeSha: SHA,
    now: () => AT, fetchImpl: publicFetch(counter, { failBitget: true }) });
  assert.equal(result.status, 'PARTIAL_DATA');
  assert.equal(result.verifiedProviderCount, 1);
  assert.equal(result.providerResults.find((row) => row.provider === 'BITGET').reason, 'OFFICIAL_PUBLIC_HTTP_503');
});
