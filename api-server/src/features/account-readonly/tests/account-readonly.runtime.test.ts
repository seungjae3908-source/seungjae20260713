import assert from 'node:assert/strict';
import test from 'node:test';
import { createVaultBackedAccountReaders } from '../account-readonly.runtime';

const SCOPE = { userId: 'user-runtime-test', accessToken: 'SUPABASE_ACCESS_RUNTIME_TEST_ONLY' };

function connection(exchange: 'upbit' | 'bitget') {
  return {
    userId: SCOPE.userId,
    exchange,
    accountMode: 'paper' as const,
    configured: true,
    encryptedCredentials: 'ciphertext-test-only',
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

test('vault-backed Upbit reader is user-scoped, GET-only, and never returns credentials', async () => {
  const seen: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined }> = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: (accessToken, userId) => ({
      getConnection: async (requestedUserId, exchange) => {
        assert.equal(accessToken, SCOPE.accessToken);
        assert.equal(userId, SCOPE.userId);
        assert.equal(requestedUserId, SCOPE.userId);
        assert.equal(exchange, 'upbit');
        return connection('upbit');
      },
    }),
    decryptCredentials: (payload) => {
      assert.equal(payload, 'ciphertext-test-only');
      return { accessKey: 'UPBIT_ACCESS_RUNTIME_TEST_ONLY', secretKey: 'UPBIT_SECRET_RUNTIME_TEST_ONLY' };
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, method: init?.method, body: init?.body });
      assert.equal(new URL(url).origin, 'https://api.upbit.com');
      assert.equal(new URL(url).pathname, '/v1/accounts');
      return new Response(JSON.stringify([
        { currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const result = await readers.upbit!(SCOPE);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, 'GET');
  assert.equal(seen[0]?.body, undefined);
  assert.equal(result.connected, true);
  assert.equal(result.orderRequests, 0);
  assert.equal(result.cancelRequests, 0);
  assert.equal(result.transferRequests, 0);
  assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('UPBIT_ACCESS_RUNTIME_TEST_ONLY'), false);
  assert.equal(serialized.includes('UPBIT_SECRET_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Bitget reader emits only the two allowlisted signed GET reads', async () => {
  const paths: string[] = [];
  const methods: string[] = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => ({
      getConnection: async (_requestedUserId, exchange) => connection(exchange as 'bitget'),
    }),
    decryptCredentials: () => ({
      apiKey: 'BITGET_KEY_RUNTIME_TEST_ONLY',
      secretKey: 'BITGET_SECRET_RUNTIME_TEST_ONLY',
      passphrase: 'BITGET_PASSPHRASE_RUNTIME_TEST_ONLY',
    }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.bitget.com');
      paths.push(url.pathname);
      methods.push(String(init?.method));
      const body = url.pathname.includes('/position/')
        ? { data: [{ symbol: 'BTCUSDT', total: '0.1', available: '0.1', leverage: '2' }] }
        : { data: [{ marginCoin: 'USDT', accountEquity: '100', available: '90' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const result = await readers.bitget!(SCOPE);
  assert.deepEqual(new Set(paths), new Set([
    '/api/v2/mix/account/accounts',
    '/api/v2/mix/position/all-position',
  ]));
  assert.ok(methods.every((method) => method === 'GET'));
  assert.equal(result.connected, true);
  assert.equal(result.orderRequests, 0);
  assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('BITGET_KEY_RUNTIME_TEST_ONLY'), false);
  assert.equal(serialized.includes('BITGET_PASSPHRASE_RUNTIME_TEST_ONLY'), false);
});

test('missing or undecryptable vault credentials fail closed before any provider call', async () => {
  let providerCalls = 0;
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => ({
      getConnection: async () => ({ ...connection('upbit'), encryptedCredentials: null }),
    }),
    decryptCredentials: () => {
      throw new Error('must not decrypt missing ciphertext');
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });

  await assert.rejects(() => readers.upbit!(SCOPE), /ACCOUNT_NOT_CONFIGURED/);
  assert.equal(providerCalls, 0);
});
