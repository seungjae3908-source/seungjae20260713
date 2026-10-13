import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_PROVIDER_ENDPOINTS,
  classifyPublicProviderResult,
  probePublicProvider,
} from '../src/public-provider-diagnostics.mjs';

test('public provider inventory contains the exact production hosts and both stock fallbacks', () => {
  assert.deepEqual([...new Set(PUBLIC_PROVIDER_ENDPOINTS.map((row) => new URL(row.url).hostname))], [
    'query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'www.nasdaqtrader.com', 'api.upbit.com', 'api.bitget.com',
  ]);
});

test('CONNECT 403 is distinguished from a provider HTTP 403 response', () => {
  const tunnel = new TypeError('fetch failed', { cause: new Error('Proxy response (403) during CONNECT tunnel') });
  assert.equal(classifyPublicProviderResult({ error: tunnel }), 'MANAGED_PROXY_CONNECT_403');
  assert.equal(classifyPublicProviderResult({ response: new Response('', { status: 403 }) }), 'PROVIDER_HTTP_403');
});

test('probe does not mislabel a successful public response', async () => {
  const row = await probePublicProvider(PUBLIC_PROVIDER_ENDPOINTS[0], {
    fetchImpl: async () => new Response('{}', { status: 200 }),
    proxyUrl: null,
  });
  assert.equal(row.classification, 'PROVIDER_REACHED');
  assert.equal(row.reachedProviderHttp, true);
});

test('proxy CONNECT denial is reported before any provider fetch is attempted', async () => {
  let fetched = false;
  const row = await probePublicProvider(PUBLIC_PROVIDER_ENDPOINTS[0], {
    proxyUrl: 'http://proxy.invalid',
    proxyConnectProbe: async () => 403,
    fetchImpl: async () => { fetched = true; return new Response('{}', { status: 200 }); },
  });
  assert.equal(fetched, false);
  assert.equal(row.classification, 'MANAGED_PROXY_CONNECT_403');
  assert.equal(row.reachedProviderHttp, false);
});
