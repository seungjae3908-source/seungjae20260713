import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReadonlyCredentialProvider } from '../account-readonly.repository';
import { createVaultBackedAccountReaders } from '../account-readonly.runtime';

const SCOPE = { userId: 'user-runtime-test', accessToken: 'SUPABASE_ACCESS_RUNTIME_TEST_ONLY' };

function record(provider: ReadonlyCredentialProvider, encryptedCredentials: string | null = 'ciphertext-test-only') {
  return {
    userId: SCOPE.userId,
    provider,
    configured: encryptedCredentials !== null,
    encryptedCredentials,
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

function repositoryFor(expectedProvider: ReadonlyCredentialProvider, encryptedCredentials: string | null = 'ciphertext-test-only') {
  return {
    get: async (requestedUserId: string, provider: ReadonlyCredentialProvider) => {
      assert.equal(requestedUserId, SCOPE.userId);
      assert.equal(provider, expectedProvider);
      return record(expectedProvider, encryptedCredentials);
    },
    save: async () => { throw new Error('runtime reader must never mutate credential storage'); },
  };
}

test('vault-backed Upbit reader is user-scoped, GET-only, and never returns credentials', async () => {
  const seen: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined }> = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: (userId) => { assert.equal(userId, SCOPE.userId); return repositoryFor('upbit'); },
    decryptCredentials: (payload) => {
      assert.equal(payload, 'ciphertext-test-only');
      return { accessKey: 'UPBIT_ACCESS_RUNTIME_TEST_ONLY', secretKey: 'UPBIT_SECRET_RUNTIME_TEST_ONLY' };
    },
    fetchImpl: async (input, init) => {
      const url = String(input); seen.push({ url, method: init?.method, body: init?.body });
      assert.equal(new URL(url).origin, 'https://api.upbit.com');
      assert.equal(new URL(url).pathname, '/v1/accounts');
      return new Response(JSON.stringify([{ currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await readers.upbit!(SCOPE);
  assert.equal(seen.length, 1); assert.equal(seen[0]?.method, 'GET'); assert.equal(seen[0]?.body, undefined);
  assert.equal(result.connected, true); assert.equal(result.orderRequests, 0); assert.equal(result.cancelRequests, 0); assert.equal(result.transferRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('UPBIT_ACCESS_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('UPBIT_SECRET_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Bitget reader emits only the two allowlisted signed GET reads', async () => {
  const paths: string[] = []; const methods: string[] = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('bitget'),
    decryptCredentials: () => ({ apiKey: 'BITGET_KEY_RUNTIME_TEST_ONLY', secretKey: 'BITGET_SECRET_RUNTIME_TEST_ONLY', passphrase: 'BITGET_PASSPHRASE_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://api.bitget.com'); paths.push(url.pathname); methods.push(String(init?.method));
      const body = url.pathname.includes('/position/') ? { data: [{ symbol: 'BTCUSDT', total: '0.1', available: '0.1', leverage: '2' }] } : { data: [{ marginCoin: 'USDT', accountEquity: '100', available: '90' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await readers.bitget!(SCOPE);
  assert.deepEqual(new Set(paths), new Set(['/api/v2/mix/account/accounts', '/api/v2/mix/position/all-position']));
  assert.ok(methods.every((method) => method === 'GET')); assert.equal(result.connected, true); assert.equal(result.orderRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('BITGET_KEY_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('BITGET_PASSPHRASE_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Toss reader performs OAuth then account-list and holdings GET only', async () => {
  const seen: Array<{ origin: string; path: string; method: string; accountHeader: string | null }> = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('toss'),
    decryptCredentials: () => ({ clientId: 'TOSS_CLIENT_RUNTIME_TEST_ONLY', clientSecret: 'TOSS_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({ origin: url.origin, path: url.pathname, method: String(init?.method), accountHeader: headers.get('X-Tossinvest-Account') });
      if (url.pathname === '/oauth2/token') return new Response(JSON.stringify({ access_token: 'TOSS_TOKEN_RUNTIME_TEST_ONLY', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/v1/accounts') return new Response(JSON.stringify({ accounts: [{ accountSeq: '12345678', accountType: 'Brokerage', accountName: '투자계좌' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/v1/holdings') return new Response(JSON.stringify({ products: [{ productCode: '005930', productName: '삼성전자', exchangeCode: 'KRX', quantity: '3', tradableQuantity: '3', averagePurchasePrice: '70000', currentPrice: '71000', evaluationAmount: '213000', evaluationProfitLoss: '3000', yield: '1.42', currency: 'KRW' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    },
  });
  const result = await readers.toss!(SCOPE);
  assert.deepEqual(seen.map((row) => `${row.method} ${row.origin}${row.path}`), [
    'POST https://oauth2.tossinvest.com/oauth2/token',
    'GET https://openapi.tossinvest.com/api/v1/accounts',
    'GET https://openapi.tossinvest.com/api/v1/holdings',
  ]);
  assert.equal(seen[1]?.accountHeader, null); assert.equal(seen[2]?.accountHeader, '12345678');
  assert.equal(result.connected, true); assert.equal(result.positions[0]?.symbol, '005930'); assert.equal(result.positions[0]?.market, 'KR'); assert.equal(result.positions[0]?.marketValue, 213000);
  assert.equal(result.orderRequests, 0); assert.equal(result.cancelRequests, 0); assert.equal(result.transferRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('TOSS_CLIENT_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('TOSS_SECRET_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('TOSS_TOKEN_RUNTIME_TEST_ONLY'), false);
});

test('missing vault credentials fail closed before any provider call', async () => {
  let providerCalls = 0;
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('upbit', null),
    decryptCredentials: () => { throw new Error('must not decrypt missing ciphertext'); },
    fetchImpl: async () => { providerCalls += 1; return new Response('{}', { status: 200 }); },
  });
  await assert.rejects(() => readers.upbit!(SCOPE), /ACCOUNT_NOT_CONFIGURED/);
  assert.equal(providerCalls, 0);
});
