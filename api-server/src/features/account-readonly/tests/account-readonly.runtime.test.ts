import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AccountReadonlyError } from '../account-readonly.errors';
import type { ReadonlyCredentialProvider } from '../account-readonly.repository';
import { createVaultBackedAccountReaders } from '../account-readonly.runtime';
import { AccountReadonlyService } from '../account-readonly.service';

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
      const body = url.pathname.includes('/position/') ? { code: '00000', data: [{ symbol: 'BTCUSDT', total: '0.1', available: '0.1', leverage: '2' }] } : { code: '00000', data: [{ marginCoin: 'USDT', accountEquity: '100', available: '90' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await readers.bitget!(SCOPE);
  assert.deepEqual(new Set(paths), new Set(['/api/v2/mix/account/accounts', '/api/v2/mix/position/all-position']));
  assert.ok(methods.every((method) => method === 'GET')); assert.equal(result.connected, true); assert.equal(result.orderRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('BITGET_KEY_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('BITGET_PASSPHRASE_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Toss reader parses the canonical OpenAPI accounts and holdings envelopes', async () => {
  const seen: Array<{ origin: string; path: string; method: string; accountHeader: string | null }> = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('toss'),
    decryptCredentials: () => ({ clientId: 'TOSS_CLIENT_RUNTIME_TEST_ONLY', clientSecret: 'TOSS_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({ origin: url.origin, path: url.pathname, method: String(init?.method), accountHeader: headers.get('X-Tossinvest-Account') });
      if (url.pathname === '/oauth2/token') return new Response(JSON.stringify({ access_token: 'TOSS_TOKEN_RUNTIME_TEST_ONLY', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/v1/accounts') return new Response(JSON.stringify({ result: [{ accountNo: '12345678901', accountSeq: 1, accountType: 'BROKERAGE' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/v1/holdings') return new Response(JSON.stringify({
        result: {
          totalPurchaseAmount: { krw: '210000', usd: null },
          marketValue: { amount: { krw: '213000', usd: null }, amountAfterCost: { krw: '212500', usd: null } },
          profitLoss: { amount: { krw: '3000', usd: null }, amountAfterCost: { krw: '2500', usd: null }, rate: '0.0142857143', rateAfterCost: '0.0119' },
          dailyProfitLoss: { amount: { krw: '1000', usd: null }, rate: '0.0047' },
          items: [{
            symbol: '005930', name: '삼성전자', marketCountry: 'KR', currency: 'KRW', quantity: '3', lastPrice: '71000', averagePurchasePrice: '70000',
            marketValue: { purchaseAmount: '210000', amount: '213000', amountAfterCost: '212500' },
            profitLoss: { amount: '3000', amountAfterCost: '2500', rate: '0.0142857143', rateAfterCost: '0.0119' },
            dailyProfitLoss: { amount: '1000', rate: '0.0047' },
            cost: { commission: '100', tax: '400' },
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    },
  });
  const result = await readers.toss!(SCOPE);
  assert.deepEqual(seen.map((row) => `${row.method} ${row.origin}${row.path}`), [
    'POST https://openapi.tossinvest.com/oauth2/token',
    'GET https://openapi.tossinvest.com/api/v1/accounts',
    'GET https://openapi.tossinvest.com/api/v1/holdings',
  ]);
  assert.equal(seen[1]?.accountHeader, null); assert.equal(seen[2]?.accountHeader, '1');
  assert.equal(result.connected, true);
  assert.equal(result.positions?.[0]?.symbol, '005930');
  assert.equal(result.positions?.[0]?.market, 'KR');
  assert.equal(result.positions?.[0]?.quantity, 3);
  assert.equal(result.positions?.[0]?.availableQuantity, null);
  assert.equal(result.positions?.[0]?.averageEntryPrice, 70000);
  assert.equal(result.positions?.[0]?.currentPrice, 71000);
  assert.equal(result.positions?.[0]?.marketValue, 213000);
  assert.equal(result.positions?.[0]?.unrealizedPnl, 3000);
  assert.ok(Math.abs((result.positions?.[0]?.unrealizedPnlPercent ?? 0) - 1.42857143) < 1e-8);
  assert.equal(result.orderRequests, 0); assert.equal(result.cancelRequests, 0); assert.equal(result.transferRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('TOSS_CLIENT_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('TOSS_SECRET_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('TOSS_TOKEN_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Toss reader rejects legacy or malformed holdings instead of reporting connected empty', async () => {
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('toss'),
    decryptCredentials: () => ({ clientId: 'TOSS_CLIENT_RUNTIME_TEST_ONLY', clientSecret: 'TOSS_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/oauth2/token') return new Response(JSON.stringify({ access_token: 'TOSS_TOKEN_RUNTIME_TEST_ONLY', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/v1/accounts') return new Response(JSON.stringify({ result: [{ accountNo: '12345678901', accountSeq: 1, accountType: 'BROKERAGE' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/v1/holdings') return new Response(JSON.stringify({ products: [{ productCode: '005930', quantity: '3' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    },
  });

  await assert.rejects(
    () => readers.toss!(SCOPE),
    (error: unknown) => error instanceof AccountReadonlyError
      && error.code === 'TOSS_HOLDINGS_RESPONSE_INVALID',
  );
});

test('staging no-DB evidence accepts the same canonical Toss OAuth origin as the provider', () => {
  const source = readFileSync(
    'api-server/src/features/account-readonly/staging-account-readonly-no-db-evidence.ts',
    'utf8',
  );
  assert.match(source, /const TOSS_API_ORIGIN = 'https:\/\/openapi\.tossinvest\.com';/);
  assert.match(source, /const TOSS_OAUTH_ORIGIN = TOSS_API_ORIGIN;/);
  assert.match(source, /url\.origin === TOSS_OAUTH_ORIGIN && url\.pathname === '\/oauth2\/token' && method === 'POST'/);
  assert.equal(source.includes('https://oauth2.tossinvest.com'), false);
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

test('caller abort during credential lookup blocks private provider invocation', async () => {
  let providerCalls = 0;
  const controller = new AbortController();
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => ({
      get: async () => {
        controller.abort(new Error('client disconnected'));
        return record('upbit');
      },
      save: async () => { throw new Error('runtime reader must never mutate credential storage'); },
    }),
    decryptCredentials: () => ({ accessKey: 'UPBIT_ACCESS_RUNTIME_TEST_ONLY', secretKey: 'UPBIT_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  await assert.rejects(
    () => readers.upbit!(SCOPE, controller.signal),
    (error: unknown) => error instanceof AccountReadonlyError
      && error.code === 'PROVIDER_TIMEOUT'
      && error.retryable === true,
  );
  assert.equal(providerCalls, 0);
});

test('stalled private account provider is aborted by the bounded server deadline', async () => {
  let providerCalls = 0;
  const readers = createVaultBackedAccountReaders({
    providerTimeoutMs: 25,
    repositoryFactory: () => repositoryFor('upbit'),
    decryptCredentials: () => ({ accessKey: 'UPBIT_ACCESS_RUNTIME_TEST_ONLY', secretKey: 'UPBIT_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (_input, init) => {
      providerCalls += 1;
      const signal = init?.signal;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(new Error('upstream request aborted'));
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
    },
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => readers.upbit!(SCOPE),
    (error: unknown) => error instanceof AccountReadonlyError
      && error.code === 'PROVIDER_TIMEOUT'
      && error.retryable === true,
  );
  assert.equal(providerCalls, 1);
  assert.ok(Date.now() - startedAt < 1_000, 'provider read must terminate instead of hanging');
});

test('invalid provider timeout configuration fails closed before private provider access', () => {
  let providerCalls = 0;
  assert.throws(
    () => createVaultBackedAccountReaders({
      providerTimeoutMs: 0,
      fetchImpl: async () => {
        providerCalls += 1;
        return new Response('{}', { status: 200 });
      },
    }),
    (error: unknown) => error instanceof AccountReadonlyError
      && error.code === 'ACCOUNT_READONLY_PROVIDER_TIMEOUT_INVALID',
  );
  assert.equal(providerCalls, 0);
});


test('Upbit private read classifies IP, permission, rate-limit and request failures without leaking provider text', async () => {
  const cases = [
    { status: 401, body: { error: { name: 'no_authorization_ip', message: 'SECRET_PROVIDER_MESSAGE' } }, code: 'UPBIT_IP_NOT_ALLOWED', retryable: false },
    { status: 403, body: { error: { name: 'out_of_scope', message: 'SECRET_PROVIDER_MESSAGE' } }, code: 'UPBIT_PERMISSION_DENIED', retryable: false },
    { status: 418, body: { error: { name: 'too_many_requests', message: 'SECRET_PROVIDER_MESSAGE' } }, code: 'RATE_LIMITED', retryable: true },
    { status: 400, body: { error: { name: 'UNTRUSTED_PROVIDER_CODE', message: 'SECRET_PROVIDER_MESSAGE' } }, code: 'UPBIT_REQUEST_REJECTED', retryable: false },
  ] as const;

  for (const fixture of cases) {
    const readers = createVaultBackedAccountReaders({
      repositoryFactory: () => repositoryFor('upbit'),
      decryptCredentials: () => ({ accessKey: 'UPBIT_ACCESS_RUNTIME_TEST_ONLY', secretKey: 'UPBIT_SECRET_RUNTIME_TEST_ONLY' }),
      fetchImpl: async () => new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
    await assert.rejects(
      () => readers.upbit!(SCOPE),
      (error: unknown) => error instanceof AccountReadonlyError
        && error.code === fixture.code
        && error.retryable === fixture.retryable
        && !error.message.includes('SECRET_PROVIDER_MESSAGE')
        && !error.message.includes('UNTRUSTED_PROVIDER_CODE'),
    );
  }
});

test('Bitget application error codes map to bounded account-access causes without exposing provider payloads', async () => {
  for (const [providerCode, expected] of [
    ['40038', 'BITGET_IP_NOT_ALLOWED'],
    ['40014', 'BITGET_PERMISSION_DENIED'],
    ['40009', 'BITGET_AUTH_FAILED'],
    ['40008', 'BITGET_TIMESTAMP_REJECTED'],
    ['99999', 'BITGET_REQUEST_REJECTED'],
  ] as const) {
    const readers = createVaultBackedAccountReaders({
      repositoryFactory: () => repositoryFor('bitget'),
      decryptCredentials: () => ({ apiKey: 'BITGET_KEY_RUNTIME_TEST_ONLY', secretKey: 'BITGET_SECRET_RUNTIME_TEST_ONLY', passphrase: 'BITGET_PASSPHRASE_RUNTIME_TEST_ONLY' }),
      fetchImpl: async () => new Response(JSON.stringify({
        code: providerCode,
        msg: 'SECRET_PROVIDER_MESSAGE',
        data: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    await assert.rejects(
      () => readers.bitget!(SCOPE),
      (error: unknown) => error instanceof AccountReadonlyError
        && error.code === expected
        && !error.message.includes('SECRET_PROVIDER_MESSAGE')
        && !error.message.includes('99999'),
    );
  }
});

test('credential, IP or permission loss evicts same-user last-good account facts instead of serving stale balances', async () => {
  const connected = {
    provider: 'upbit' as const,
    readOnly: true as const,
    connected: true,
    status: 'CONNECTED' as const,
    accounts: [],
    balances: [{ currency: 'KRW', available: 100, locked: 0, total: 100, estimatedKrwValue: 100 }],
    positions: [],
    openOrders: [],
    checkedAt: '2026-09-25T00:00:00.000Z',
    lastGoodAt: '2026-09-25T00:00:00.000Z',
    stale: false,
    errorCode: null,
    orderRequests: 0 as const,
    cancelRequests: 0 as const,
    amendRequests: 0 as const,
    transferRequests: 0 as const,
    withdrawalRequests: 0 as const,
    credentialsReturned: false as const,
    liveTradingEnabled: false as const,
    autoTradingEnabled: false as const,
  };
  let mode: 'ok' | 'ip' | 'timeout' = 'ok';
  const service = new AccountReadonlyService({
    upbit: async () => {
      if (mode === 'ip') throw new AccountReadonlyError('UPBIT_IP_NOT_ALLOWED');
      if (mode === 'timeout') throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
      return connected;
    },
  }, { upbit: true });

  assert.equal((await service.read(SCOPE, 'upbit')).balances?.[0]?.total, 100);
  mode = 'ip';
  const denied = await service.read(SCOPE, 'upbit');
  assert.equal(denied.status, 'AUTH_FAILED');
  assert.equal(denied.errorCode, 'UPBIT_IP_NOT_ALLOWED');
  assert.equal(denied.balances, null);

  mode = 'timeout';
  const afterEviction = await service.read(SCOPE, 'upbit');
  assert.equal(afterEviction.status, 'UNAVAILABLE');
  assert.equal(afterEviction.stale, false);
  assert.equal(afterEviction.balances, null);
});
