import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('legacy stock auto-trade cannot own any real provider mutation path', async () => {
  const source = await readFile(new URL('./stocks.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('placeKiwoomDomesticOrder'), false);
  assert.equal(source.includes('placeKiwoomUsOrder'), false);
  assert.equal(source.includes('KIWOOM_AUTO_TRADE_ENABLED'), false);
  assert.ok(source.includes('LEGACY_REAL_ORDER_PATH_DISABLED_USE_TRADE_AUTOMATION'));
  assert.ok(source.includes('canonicalPath: "/api/trade-automation"'));

  for (const route of [
    '/auto-trade/plan',
    '/auto-trade/execute',
    '/auto-trade/close-plan',
    '/auto-trade/close-execute',
  ]) {
    assert.ok(source.includes(`router.post("${route}", rejectLegacyRealOrder);`), route);
  }

  assert.ok(source.includes('providerMutationRequests: 0'));
  assert.ok(source.includes('orderSubmitted: false'));
  assert.ok(source.includes('orderCanceled: false'));
});
