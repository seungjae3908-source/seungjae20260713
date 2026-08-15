import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUpbitJwt } from '../../../services/trade-exchange-adapters.service';
import { maskAccountRef } from '../account-readonly.contract';
import { AccountReadonlyService } from '../account-readonly.service';
import { TossReadonlyProvider, TossTokenManager, type ReadonlyTransport } from '../providers/toss-readonly.provider';
import { readBitgetSnapshot, readUpbitSnapshot } from '../providers/exchange-readonly.providers';

test('disabled feature flag performs zero private calls', async () => { let calls = 0; const service = new AccountReadonlyService({ toss: async () => { calls++; throw new Error('unexpected'); } }, { toss: false }); const result = await service.read('toss'); assert.equal(calls, 0); assert.equal(result.status, 'NOT_CONFIGURED'); assert.equal(result.orderRequests, 0); });

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
  assert.match(seen[0].headers.Authorization, /^Bearer /); assert.equal(result.balances[0]?.total, 1.25); assert.equal(result.positions[0]?.averageEntryPrice, null); assert.equal(result.orderRequests, 0);
  assert.notEqual(buildUpbitJwt({ accessKey: 'a', secretKey: 'b' }, ''), buildUpbitJwt({ accessKey: 'a', secretKey: 'b' }, ''));
});

test('Bitget wrapper uses only signed GET account and position requests and redacts passphrase', async () => {
  const seen: any[] = []; const result = await readBitgetSnapshot({ apiKey: 'BITGET_KEY_TEST_ONLY', secretKey: 'BITGET_SECRET_TEST_ONLY', passphrase: 'BITGET_PASSPHRASE_TEST_ONLY' }, async (request) => { seen.push(request); return request.path.includes('position') ? { data: [{ symbol: 'BTCUSDT', total: '1', openPriceAvg: '60000', markPrice: '61000', leverage: '3', liquidationPrice: '' }] } : { data: [{ marginCoin: 'USDT', accountEquity: '100', available: '80' }] }; });
  assert.ok(seen.every((r) => r.method === 'GET')); assert.equal(result.positions[0]?.liquidationPrice, null); assert.equal(JSON.stringify(result).includes('BITGET_PASSPHRASE_TEST_ONLY'), false); assert.equal(result.withdrawalRequests, 0);
});

test('last-good data becomes stale while auth failure without data is distinct from zero balance', async () => {
  let fail = false; const snapshot = { provider: 'upbit' as const, readOnly: true as const, connected: true, status: 'CONNECTED' as const, accounts: [], balances: [{ currency: 'KRW', available: 0, locked: 0, total: 0, estimatedKrwValue: 0 }], positions: [], openOrders: [], checkedAt: '2026-01-01T00:00:00.000Z', lastGoodAt: '2026-01-01T00:00:00.000Z', stale: false, errorCode: null, orderRequests: 0 as const, cancelRequests: 0 as const, amendRequests: 0 as const, transferRequests: 0 as const, withdrawalRequests: 0 as const, credentialsReturned: false as const, liveTradingEnabled: false as const, autoTradingEnabled: false as const };
  const service = new AccountReadonlyService({ upbit: async () => { if (fail) throw new Error('401 invalid-token'); return snapshot; } }, { upbit: true });
  assert.equal((await service.read('upbit')).balances[0]?.total, 0); fail = true; const stale = await service.read('upbit'); assert.equal(stale.status, 'STALE'); assert.equal(stale.errorCode, 'AUTH_FAILED');
  const fresh = new AccountReadonlyService({ upbit: async () => { throw new Error('401'); } }, { upbit: true }); assert.equal((await fresh.read('upbit')).status, 'AUTH_FAILED');
});
