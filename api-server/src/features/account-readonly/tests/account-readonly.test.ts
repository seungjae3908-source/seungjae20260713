import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildUpbitJwt } from '../../../services/trade-exchange-adapters.service';
import { maskAccountRef, nullableNumber } from '../account-readonly.contract';
import { bindAccountReadonlyDisconnectAbort } from '../account-readonly.route';
import { AccountReadonlyService } from '../account-readonly.service';
import { TossReadonlyProvider, TossTokenManager, type ReadonlyTransport } from '../providers/toss-readonly.provider';
import { readBitgetSnapshot, readUpbitSnapshot } from '../providers/exchange-readonly.providers';

const USER_A = { userId: 'user-a', accessToken: 'SUPABASE_ACCESS_A_TEST_ONLY' };
const USER_B = { userId: 'user-b', accessToken: 'SUPABASE_ACCESS_B_TEST_ONLY' };

test('read-only account numbers reject coercion and preserve actual zero', () => {
  for (const value of [true, false, [], [1], {}, '', ' ', '0x10', '1,2']) assert.equal(nullableNumber(value), null);
  assert.equal(nullableNumber('0'), 0);
  assert.equal(nullableNumber('-1.25'), -1.25);
  assert.equal(nullableNumber('1,000.50'), 1000.5);
});

test('Bitget read-only provider error and malformed data never become a connected empty account', async () => {
  const credentials = { apiKey: 'fixture', secretKey: 'fixture', passphrase: 'fixture' };
  for (const response of [{}, { code: '40009', data: [] }, { code: '00000' }, { code: '00000', data: [null] }]) {
    await assert.rejects(readBitgetSnapshot(credentials, async () => response), /RESPONSE_INVALID/);
  }
  await assert.rejects(readBitgetSnapshot(credentials, async (request) => ({ code: '00000', data: request.path.includes('position') ? [] : [{ accountEquity: '1' }] })), /IDENTITY_INVALID/);
});

test('client response close aborts unfinished account read and cleanup removes both listeners', () => {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), { writableEnded: false });
  const controller = new AbortController();
  const cleanup = bindAccountReadonlyDisconnectAbort(request, response, controller);

  assert.equal(request.listenerCount('aborted'), 1);
  assert.equal(response.listenerCount('close'), 1);
  response.emit('close');
  assert.equal(controller.signal.aborted, true);

  cleanup();
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

test('normal completed response close does not abort completed account read', () => {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), { writableEnded: true });
  const controller = new AbortController();
  const cleanup = bindAccountReadonlyDisconnectAbort(request, response, controller);

  response.emit('close');
  assert.equal(controller.signal.aborted, false);
  cleanup();
});

test('request aborted event still aborts unfinished account read', () => {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), { writableEnded: false });
  const controller = new AbortController();
  const cleanup = bindAccountReadonlyDisconnectAbort(request, response, controller);

  request.emit('aborted');
  assert.equal(controller.signal.aborted, true);
  cleanup();
});

test('disabled feature flag reports configured credentials as unverified with zero private calls', async () => {
  let privateCalls = 0;
  let metadataCalls = 0;
  const service = new AccountReadonlyService(
    { toss: async () => { privateCalls++; throw new Error('unexpected'); } },
    { toss: false },
    () => new Date('2026-08-26T00:00:00.000Z'),
    async (userId, provider) => {
      metadataCalls += 1;
      assert.equal(userId, USER_A.userId);
      assert.equal(provider, 'toss');
      return true;
    },
  );
  const result = await service.read(USER_A, 'toss');
  assert.equal(privateCalls, 0);
  assert.equal(metadataCalls, 1);
  assert.equal(result.status, 'CONFIGURED_UNVERIFIED');
  assert.equal(result.errorCode, 'ACCOUNT_READ_DISABLED');
  assert.equal(result.accounts, null);
  assert.equal(result.balances, null);
  assert.equal(result.positions, null);
  assert.equal(result.orderRequests, 0);
  assert.equal(result.cancelRequests, 0);
  assert.equal(result.transferRequests, 0);
  assert.equal(result.withdrawalRequests, 0);
  assert.equal(result.credentialsReturned, false);
});

test('disabled feature flag reports not configured only when metadata confirms no credential', async () => {
  let privateCalls = 0;
  const service = new AccountReadonlyService(
    { upbit: async () => { privateCalls++; throw new Error('unexpected'); } },
    { upbit: false },
    () => new Date('2026-08-26T00:00:00.000Z'),
    async () => false,
  );

  const result = await service.read(USER_A, 'upbit');
  assert.equal(privateCalls, 0);
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(result.errorCode, 'ACCOUNT_NOT_CONFIGURED');
  assert.equal(result.balances, null);
});

test('credential metadata outage remains unavailable instead of becoming not configured', async () => {
  let privateCalls = 0;
  const service = new AccountReadonlyService(
    { bitget: async () => { privateCalls++; throw new Error('unexpected'); } },
    { bitget: false },
    () => new Date('2026-08-26T00:00:00.000Z'),
    async () => { throw new Error('metadata storage unavailable'); },
  );

  const result = await service.read(USER_A, 'bitget');
  assert.equal(privateCalls, 0);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.errorCode, 'ACCOUNT_CREDENTIAL_METADATA_UNAVAILABLE');
  assert.equal(result.accounts, null);
  assert.equal(result.positions, null);
});

test('missing authenticated request scope fails closed before private reader use', async () => {
  let calls = 0;
  const service = new AccountReadonlyService(
    { upbit: async () => { calls++; throw new Error('unexpected'); } },
    { upbit: true },
  );
  const result = await service.read({ userId: '', accessToken: '' }, 'upbit');
  assert.equal(calls, 0);
  assert.equal(result.status, 'AUTH_FAILED');
  assert.equal(result.errorCode, 'ACCOUNT_REQUEST_SCOPE_REQUIRED');
});

test('Toss token refresh is single-flight, cached, and never uses account header', async () => {
  let calls = 0; const seen: any[] = [];
  const transport: ReadonlyTransport = async (request) => { calls++; seen.push(request); await new Promise((r) => setTimeout(r, 2)); return { status: 200, body: { access_token: 'FAKE_TOKEN', expires_in: 3600 } }; };
  const manager = new TossTokenManager(transport, () => 1_000);
  assert.deepEqual(await Promise.all([manager.token({ clientId: 'TOSS_CLIENT_TEST_ONLY', clientSecret: 'TOSS_SECRET_TEST_ONLY' }), manager.token({ clientId: 'TOSS_CLIENT_TEST_ONLY', clientSecret: 'TOSS_SECRET_TEST_ONLY' })]), ['FAKE_TOKEN', 'FAKE_TOKEN']);
  assert.equal(calls, 1); assert.equal(seen[0].headers['X-Tossinvest-Account'], undefined);
});

test('Toss provider rejects every mutation path and masks accountSeq', async () => {
  const transport: ReadonlyTransport = async (request) => request.path === '/oauth2/token' ? { status: 200, body: { access_token: 'FAKE', expires_in: 60 } } : { status: 200, body: { result: [] } };
  const provider = new TossReadonlyProvider(transport, new TossTokenManager(transport));
  await assert.rejects(() => provider.request('/api/v1/orders/1/cancel', { clientId: 'x', clientSecret: 'y', accountSeq: '12345678' }), /READONLY_PATH_REJECTED/);
  assert.equal(maskAccountRef('12345678'), '12****78');
});

test('Upbit wrapper reuses JWT signer and preserves locked and missing values', async () => {
  const seen: any[] = []; const result = await readUpbitSnapshot({ accessKey: 'UPBIT_ACCESS_TEST_ONLY', secretKey: 'UPBIT_SECRET_TEST_ONLY' }, async (request) => { seen.push(request); return [{ currency: 'BTC', balance: '1', locked: '0.25', avg_buy_price: '' }]; });
  assert.match(seen[0].headers.Authorization, /^Bearer /); assert.equal(result.balances?.[0]?.total, 1.25); assert.equal(result.positions?.[0]?.averageEntryPrice, null); assert.equal(result.orderRequests, 0);
  assert.notEqual(buildUpbitJwt({ accessKey: 'a', secretKey: 'b' }, ''), buildUpbitJwt({ accessKey: 'a', secretKey: 'b' }, ''));
});

test('Bitget wrapper uses only signed GET account and position requests and redacts passphrase', async () => {
  const seen: any[] = []; const result = await readBitgetSnapshot({ apiKey: 'BITGET_KEY_TEST_ONLY', secretKey: 'BITGET_SECRET_TEST_ONLY', passphrase: 'BITGET_PASSPHRASE_TEST_ONLY' }, async (request) => { seen.push(request); return request.path.includes('position') ? { code: '00000', data: [{ symbol: 'BTCUSDT', total: '1', openPriceAvg: '60000', markPrice: '61000', leverage: '3', liquidationPrice: '' }] } : { code: '00000', data: [{ marginCoin: 'USDT', accountEquity: '100', available: '80' }] }; });
  assert.ok(seen.every((r) => r.method === 'GET')); assert.equal(result.positions?.[0]?.liquidationPrice, null); assert.equal(JSON.stringify(result).includes('BITGET_PASSPHRASE_TEST_ONLY'), false); assert.equal(result.withdrawalRequests, 0);
});

test('last-good fallback is same-user only and auth failure evicts it fail-closed', async () => {
  let userAMode: 'ok' | 'timeout' | 'auth' = 'ok';
  const snapshot = { provider: 'upbit' as const, readOnly: true as const, connected: true, status: 'CONNECTED' as const, accounts: [], balances: [{ currency: 'KRW', available: 0, locked: 0, total: 0, estimatedKrwValue: 0 }], positions: [], openOrders: [], checkedAt: '2026-01-01T00:00:00.000Z', lastGoodAt: '2026-01-01T00:00:00.000Z', stale: false, errorCode: null, orderRequests: 0 as const, cancelRequests: 0 as const, amendRequests: 0 as const, transferRequests: 0 as const, withdrawalRequests: 0 as const, credentialsReturned: false as const, liveTradingEnabled: false as const, autoTradingEnabled: false as const };
  const service = new AccountReadonlyService(
    {
      upbit: async (scope) => {
        if (scope.userId === USER_B.userId) throw new Error('401 user-b');
        if (userAMode === 'timeout') throw new Error('provider timeout');
        if (userAMode === 'auth') throw new Error('401 user-a');
        return snapshot;
      },
    },
    { upbit: true },
  );

  assert.equal((await service.read(USER_A, 'upbit')).balances?.[0]?.total, 0);

  const userB = await service.read(USER_B, 'upbit');
  assert.equal(userB.status, 'AUTH_FAILED');
  assert.equal(userB.stale, false);
  assert.equal(userB.balances, null);

  userAMode = 'timeout';
  const staleUserA = await service.read(USER_A, 'upbit');
  assert.equal(staleUserA.status, 'STALE');
  assert.equal(staleUserA.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(staleUserA.balances?.[0]?.total, 0);

  userAMode = 'auth';
  const authFailedUserA = await service.read(USER_A, 'upbit');
  assert.equal(authFailedUserA.status, 'AUTH_FAILED');
  assert.equal(authFailedUserA.stale, false);
  assert.equal(authFailedUserA.balances, null);

  userAMode = 'timeout';
  const afterEviction = await service.read(USER_A, 'upbit');
  assert.equal(afterEviction.status, 'UNAVAILABLE');
  assert.equal(afterEviction.stale, false);
  assert.equal(afterEviction.balances, null);
});
