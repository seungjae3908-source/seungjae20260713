import test from 'node:test';
import assert from 'node:assert/strict';
import { withPublicStockProvider } from '../src/public-stock-provider-adapter.mjs';

function dependencies(market = 'KR_STOCK') {
  const forbidden = () => { throw new Error('PRIVATE_OR_LEGACY_PATH_CALLED'); };
  const marketData = { getCandles: forbidden, getCandlesMeta: forbidden, getQuote: forbidden };
  const calls = [];
  const yahoo = {
    getCandles: async (...args) => { calls.push(args); return [{ time: '2026-10-01T00:00:00Z', close: 100 }]; },
    getQuote: async (...args) => { calls.push(args); return { price: 100, updatedAt: '2026-10-01T00:00:00Z' }; },
  };
  return { marketData, yahoo, calls, market, entries: [{ ticker: '247540', exchange: 'KOSDAQ', name: 'fixture' }] };
}

test('health metadata, candles and quote use the same public exchange identity and bounded options', async () => {
  const deps = dependencies(); const originals = { ...deps.marketData }; const signal = new AbortController().signal;
  await withPublicStockProvider(deps, async () => {
    const meta = await deps.marketData.getCandlesMeta('247540', '1D', { signal });
    assert.equal(meta.provider, 'yahoo'); assert.equal(meta.candles.length, 1);
    await deps.marketData.getCandles('247540', '60m', { signal });
    assert.equal((await deps.marketData.getQuote('247540', { signal })).symbol, '247540');
    assert.equal(deps.calls[0][2].purpose, 'scanner'); assert.equal(deps.calls[0][2].signal, signal);
    assert.ok(deps.calls.every(call => call[0] === '247540.KQ'));
  });
  assert.deepEqual(deps.marketData, originals);
});

test('US class shares map once, and provider failure is not multiplied into deadline overruns', async () => {
  const deps = dependencies('US_STOCK'); let calls = 0;
  deps.yahoo.getCandles = async symbol => { calls++; assert.equal(symbol, 'BRK-B'); throw new Error('UPSTREAM_404'); };
  const originals = { ...deps.marketData };
  await assert.rejects(withPublicStockProvider(deps, () => deps.marketData.getCandlesMeta('BRK.B', '1D')), /UPSTREAM_404/);
  assert.equal(calls, 1); assert.deepEqual(deps.marketData, originals);
});

test('unknown Korean exchange fails closed without trying another exchange or private fallback', async () => {
  const deps = dependencies(); deps.entries[0].exchange = 'KONEX';
  await assert.rejects(withPublicStockProvider(deps, () => deps.marketData.getCandlesMeta('247540', '1D')), /EXCHANGE_MAPPING_UNAVAILABLE/);
  assert.equal(deps.calls.length, 0);
});
