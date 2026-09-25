import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AccountReadonlyError } from '../account-readonly.errors';
import type { ReadonlyCredentialProvider } from '../account-readonly.repository';
import { createVaultBackedAccountReaders } from '../account-readonly.runtime';
import { AccountReadonlyService } from '../account-readonly.service';
import { KiwoomReadonlyProvider } from '../providers/kiwoom-readonly.provider';

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
      const url = new URL(String(input)); seen.push({ url: url.toString(), method: init?.method, body: init?.body });
      assert.equal(url.origin, 'https://api.upbit.com');
      if (url.pathname === '/v1/accounts') {
        return new Response(JSON.stringify([{ currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/v1/orders/open') {
        const state = url.searchParams.get('state');
        return new Response(JSON.stringify(state === 'wait' ? [{
          uuid: 'UPBIT-OPEN-1', side: 'bid', market: 'KRW-BTC', price: '100000000',
          volume: '0.01', remaining_volume: '0.004', state: 'wait',
        }] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    },
  });
  const result = await readers.upbit!(SCOPE);
  assert.equal(seen.length, 3); assert.ok(seen.every((row) => row.method === 'GET' && row.body === undefined));
  assert.equal(result.connected, true); assert.equal(result.openOrders?.length, 1); assert.equal(result.openOrders?.[0]?.id, 'UPBIT-OPEN-1'); assert.equal(result.openOrders?.[0]?.remainingQuantity, 0.004);
  assert.equal(result.orderRequests, 0); assert.equal(result.cancelRequests, 0); assert.equal(result.transferRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('UPBIT_ACCESS_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('UPBIT_SECRET_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Bitget reader emits only the three allowlisted signed GET reads', async () => {
  const paths: string[] = []; const methods: string[] = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('bitget'),
    decryptCredentials: () => ({ apiKey: 'BITGET_KEY_RUNTIME_TEST_ONLY', secretKey: 'BITGET_SECRET_RUNTIME_TEST_ONLY', passphrase: 'BITGET_PASSPHRASE_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://api.bitget.com'); paths.push(url.pathname); methods.push(String(init?.method));
      const body = url.pathname.includes('/position/')
        ? { code: '00000', data: [{ symbol: 'BTCUSDT', total: '0.1', available: '0.1', leverage: '2' }] }
        : url.pathname.includes('/orders-pending')
          ? { code: '00000', data: { entrustedList: [{ orderId: 'BG-OPEN-1', symbol: 'BTCUSDT', side: 'buy', price: '60000', size: '0.1', baseVolume: '0.04', status: 'partially_filled' }], endId: 'BG-OPEN-1' } }
          : { code: '00000', data: [{ marginCoin: 'USDT', accountEquity: '100', available: '90' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await readers.bitget!(SCOPE);
  assert.deepEqual(new Set(paths), new Set(['/api/v2/mix/account/accounts', '/api/v2/mix/position/all-position', '/api/v2/mix/order/orders-pending']));
  assert.ok(methods.every((method) => method === 'GET')); assert.equal(result.connected, true); assert.equal(result.openOrders?.[0]?.id, 'BG-OPEN-1'); assert.equal(result.openOrders?.[0]?.remainingQuantity, 0.06); assert.equal(result.orderRequests, 0); assert.equal(result.withdrawalRequests, 0);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('BITGET_KEY_RUNTIME_TEST_ONLY'), false); assert.equal(serialized.includes('BITGET_PASSPHRASE_RUNTIME_TEST_ONLY'), false);
});

test('vault-backed Toss reader parses the canonical OpenAPI accounts and holdings envelopes', async () => {
  const seen: Array<{ origin: string; path: string; search: string; method: string; accountHeader: string | null }> = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('toss'),
    decryptCredentials: () => ({ clientId: 'TOSS_CLIENT_RUNTIME_TEST_ONLY', clientSecret: 'TOSS_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({ origin: url.origin, path: url.pathname, search: url.search, method: String(init?.method), accountHeader: headers.get('X-Tossinvest-Account') });
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
      if (url.pathname === '/api/v1/orders') return new Response(JSON.stringify({
        result: {
          orders: [{
            orderId: 'TOSS-OPEN-1', symbol: '005930', side: 'BUY', status: 'PARTIAL_FILLED',
            price: '70000', quantity: '10', currency: 'KRW',
            execution: { filledQuantity: '4', averageFilledPrice: '69950' },
          }],
          nextCursor: null, hasNext: false,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    },
  });
  const result = await readers.toss!(SCOPE);
  assert.deepEqual(seen.map((row) => `${row.method} ${row.origin}${row.path}`), [
    'POST https://openapi.tossinvest.com/oauth2/token',
    'GET https://openapi.tossinvest.com/api/v1/accounts',
    'GET https://openapi.tossinvest.com/api/v1/orders',
    'GET https://openapi.tossinvest.com/api/v1/holdings',
  ]);
  assert.equal(seen[1]?.accountHeader, null); assert.equal(seen[2]?.accountHeader, '1'); assert.equal(seen[2]?.search, '?status=OPEN'); assert.equal(seen[3]?.accountHeader, '1');
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
  assert.equal(result.openOrders?.[0]?.id, 'TOSS-OPEN-1'); assert.equal(result.openOrders?.[0]?.remainingQuantity, 6);
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


test('vault-backed Kiwoom reader uses only official real OAuth and fixed read-only account TRs', async () => {
  const seen: Array<{ origin: string; path: string; method: string; apiId: string | null; body: string }> = [];
  const readers = createVaultBackedAccountReaders({
    repositoryFactory: () => repositoryFor('kiwoom'),
    decryptCredentials: () => ({ appKey: 'KIWOOM_APP_RUNTIME_TEST_ONLY', appSecret: 'KIWOOM_SECRET_RUNTIME_TEST_ONLY' }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      seen.push({ origin: url.origin, path: url.pathname, method: String(init?.method), apiId: headers.get('api-id'), body });
      if (url.pathname === '/oauth2/token') {
        return new Response(JSON.stringify({
          token: 'KIWOOM_TOKEN_RUNTIME_TEST_ONLY',
          token_type: 'bearer',
          expires_dt: '20991231235959',
          return_code: 0,
          return_msg: 'SECRET_PROVIDER_MESSAGE',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (headers.get('api-id') === 'kt00018') {
        return new Response(JSON.stringify({
          return_code: 0,
          acnt_evlt_remn_indv_tot: [{
            stk_cd: 'A005930', rmnd_qty: '3', trde_able_qty: '2', pur_pric: '70000',
            cur_prc: '-71000', evlt_amt: '213000', evltv_prft: '3000', prft_rt: '1.4285',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'cont-yn': 'N' } });
      }
      if (headers.get('api-id') === 'ka10075') {
        return new Response(JSON.stringify({
          return_code: 0,
          oso: [{ ord_no: '0001234', stk_cd: '005930', trde_tp: '2', ord_qty: '2', ord_pric: '70000', oso_qty: '1', ord_stt: '접수' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'cont-yn': 'N' } });
      }
      return new Response('{}', { status: 404 });
    },
  });

  const result = await readers.kiwoom!(SCOPE);
  assert.equal(result.connected, true);
  assert.equal(result.provider, 'kiwoom');
  assert.equal(result.positions?.[0]?.symbol, '005930');
  assert.equal(result.positions?.[0]?.currentPrice, 71000);
  assert.equal(result.positions?.[0]?.availableQuantity, 2);
  assert.equal(result.openOrders?.[0]?.id, '0001234');
  assert.equal(result.openOrders?.[0]?.side, 'BUY');
  assert.equal(result.orderRequests, 0);
  assert.equal(result.cancelRequests, 0);
  assert.equal(result.amendRequests, 0);
  assert.equal(result.transferRequests, 0);
  assert.equal(result.withdrawalRequests, 0);

  assert.deepEqual(seen.map((row) => [row.method, row.origin, row.path, row.apiId]), [
    ['POST', 'https://api.kiwoom.com', '/oauth2/token', null],
    ['POST', 'https://api.kiwoom.com', '/api/dostk/acnt', 'kt00018'],
    ['POST', 'https://api.kiwoom.com', '/api/dostk/acnt', 'ka10075'],
  ]);
  assert.equal(seen.some((row) => row.path.includes('/ordr')), false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('KIWOOM_APP_RUNTIME_TEST_ONLY'), false);
  assert.equal(serialized.includes('KIWOOM_SECRET_RUNTIME_TEST_ONLY'), false);
  assert.equal(serialized.includes('KIWOOM_TOKEN_RUNTIME_TEST_ONLY'), false);
  assert.equal(serialized.includes('SECRET_PROVIDER_MESSAGE'), false);
});


test('Kiwoom HTTP 200 auth failure is classified from embedded official code without leaking return_msg', async () => {
  const provider = new KiwoomReadonlyProvider(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') {
      return new Response(JSON.stringify({
        token: 'KIWOOM_TOKEN_RUNTIME_TEST_ONLY',
        token_type: 'bearer',
        expires_dt: '20991231235959',
        return_code: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(init?.method, 'POST');
    return new Response(JSON.stringify({
      return_code: 3,
      return_msg: '인증에 실패했습니다[8005:SECRET_TOKEN_PROVIDER_TEXT]',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await assert.rejects(
    () => provider.snapshot({ appKey: 'KIWOOM_APP_RUNTIME_TEST_ONLY', appSecret: 'KIWOOM_SECRET_RUNTIME_TEST_ONLY' }),
    (error: unknown) => error instanceof AccountReadonlyError
      && error.code === 'KIWOOM_AUTH_OR_IP_REJECTED'
      && !error.message.includes('SECRET_TOKEN_PROVIDER_TEXT'),
  );
});

test('Kiwoom payload rate-limit codes stay retryable without exposing provider messages', async () => {
  const provider = new KiwoomReadonlyProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') {
      return new Response(JSON.stringify({
        return_code: 1700,
        return_msg: 'SECRET_RATE_LIMIT_PROVIDER_TEXT',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 500 });
  });
  await assert.rejects(
    () => provider.snapshot({ appKey: 'KIWOOM_APP_RUNTIME_TEST_ONLY', appSecret: 'KIWOOM_SECRET_RUNTIME_TEST_ONLY' }),
    (error: unknown) => error instanceof AccountReadonlyError
      && error.code === 'RATE_LIMITED'
      && error.retryable === true
      && !error.message.includes('SECRET_RATE_LIMIT_PROVIDER_TEXT'),
  );
});

test('Kiwoom return_code 20 is a proven empty account result rather than a provider failure', async () => {
  const seenApiIds: string[] = [];
  const provider = new KiwoomReadonlyProvider(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') {
      return new Response(JSON.stringify({
        token: 'KIWOOM_TOKEN_RUNTIME_TEST_ONLY',
        token_type: 'bearer',
        expires_dt: '20991231235959',
        return_code: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const apiId = new Headers(init?.headers).get('api-id');
    if (apiId) seenApiIds.push(apiId);
    return new Response(JSON.stringify({
      return_code: 20,
      return_msg: 'NO_DATA',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await provider.snapshot({
    appKey: 'KIWOOM_APP_RUNTIME_TEST_ONLY',
    appSecret: 'KIWOOM_SECRET_RUNTIME_TEST_ONLY',
  });
  assert.equal(result.connected, true);
  assert.deepEqual(result.positions, []);
  assert.deepEqual(result.openOrders, []);
  assert.deepEqual(new Set(seenApiIds), new Set(['kt00018', 'ka10075']));
  assert.equal(result.orderRequests, 0);
  assert.equal(result.cancelRequests, 0);
  assert.equal(result.amendRequests, 0);
});
