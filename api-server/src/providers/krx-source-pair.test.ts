import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKrFinderSourcesReady, KRX_FINDER_ENDPOINT, getKrUniverse } from './krx';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ short_code: String(i).padStart(6, '0'), codeName: `종목 ${i}` }));
test('both KRX source pages must pass anomaly guards; one success cannot mask a missing/malformed source', () => {
  assert.equal(KRX_FINDER_ENDPOINT.startsWith('https://'), true);
  assert.doesNotThrow(() => assertKrFinderSourcesReady(rows(1000), rows(100)));
  for (const [stocks, products] of [[rows(1000), []], [[], rows(100)], [rows(10), rows(100)],
    [rows(1000), Array.from({ length: 100 }, () => ({ short_code: 'invalid', codeName: '' }))]]) {
    assert.throws(() => assertKrFinderSourcesReady(stocks, products), /KRX_FINDER_SOURCE_PAIR_INCOMPLETE/);
  }
});
test('a partial HTTP 200 source pair is not cached as a successful roster', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++; assert.equal(init?.redirect, 'error');
    const stock = String(init?.body).includes('finder_stkisu');
    return new Response(JSON.stringify({ block1: stock ? rows(1000) : [] }));
  };
  try {
    await assert.rejects(getKrUniverse(), /KRX_FINDER_SOURCE_PAIR_INCOMPLETE/);
    await assert.rejects(getKrUniverse(), /KRX_FINDER_SOURCE_PAIR_INCOMPLETE/);
    assert.equal(calls, 4);
  } finally { globalThis.fetch = original; }
});
