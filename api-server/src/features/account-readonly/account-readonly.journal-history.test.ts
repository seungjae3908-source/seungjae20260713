import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountReadonlyCredentialRepository } from './account-readonly.repository';
import { createAccountJournalHistoryReader } from './account-readonly.journal-history';

const USER_ID = 'journal-history-user';
const NOW = new Date('2026-09-25T02:30:00.000Z');

function repository(rows: Partial<Record<'kiwoom' | 'upbit' | 'bitget', string>>): AccountReadonlyCredentialRepository {
  return {
    async get(userId, provider) {
      if (userId !== USER_ID) throw new Error('USER_SCOPE_MISMATCH');
      const encrypted = rows[provider as 'kiwoom' | 'upbit' | 'bitget'];
      return encrypted ? {
        userId,
        provider,
        configured: true,
        encryptedCredentials: encrypted,
        lastVerifiedAt: null,
        lastErrorCode: null,
        updatedAt: NOW.toISOString(),
      } : null;
    },
    async save() { throw new Error('READ_ONLY_TEST_REPOSITORY'); },
    async remove() { throw new Error('READ_ONLY_TEST_REPOSITORY'); },
  };
}

test('unconfigured journal-history providers stop at credential metadata and send zero private requests', async () => {
  let fetchCalls = 0;
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({}),
    decryptCredentials: () => { throw new Error('must not decrypt'); },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 500 });
    },
    flags: { kiwoom: true, upbit: true, bitget: true },
  });

  const result = await reader({
    userId: USER_ID,
    range: '30D',
    providers: ['kiwoom', 'upbit', 'bitget'],
    now: NOW,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.privateProviderRequests, 0);
  assert.equal(result.payloads.length, 0);
  assert.deepEqual(result.providers.map((row) => [row.provider, row.status, row.privateProviderRequests]), [
    ['kiwoom', 'NOT_CONFIGURED', 0],
    ['upbit', 'NOT_CONFIGURED', 0],
    ['bitget', 'NOT_CONFIGURED', 0],
  ]);
});

test('disabled provider never decrypts or sends a private request', async () => {
  let decryptCalls = 0;
  let fetchCalls = 0;
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({ upbit: 'UPBIT_ENCRYPTED_FIXTURE' }),
    decryptCredentials: () => {
      decryptCalls += 1;
      return { accessKey: 'A', secretKey: 'S' };
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 500 });
    },
    flags: { upbit: false, bitget: false },
  });
  const result = await reader({ userId: USER_ID, range: '7D', providers: ['upbit'], now: NOW });
  assert.equal(decryptCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(result.providers[0]?.status, 'DISABLED');
});

test('Kiwoom reader caps exact fill history to seven days and preserves read-only request counts', async () => {
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({ kiwoom: 'KIWOOM_ENCRYPTED_FIXTURE' }),
    decryptCredentials: () => ({ appKey: 'KIWOOM_APP_TEST_ONLY', appSecret: 'KIWOOM_SECRET_TEST_ONLY' }),
    flags: { kiwoom: true, upbit: false, bitget: false },
    kiwoomProvider: {
      async journalFillRows(_credentials, dates, _signal, requestCounter) {
        assert.equal(dates.length, 7);
        if (requestCounter) requestCounter.value += 2;
        return {
          privateProviderRequests: 2,
          domestic: [{
            orderDate: dates.at(-1)!,
            row: {
              ord_no: 'KR-1', stk_cd: '005930', trde_tp: '2', cntr_no: 'KR-FILL-1',
              cntr_qty: '1', cntr_uv: '70000', cntr_tm: '101530',
            },
          }],
          us: [{
            orderDate: dates.at(-1)!,
            row: {
              ord_no: 'US-1', crnc_code: 'USD', stk_cd: 'AAPL', frgn_trde_tp: '1',
              cntr_qty: '1', cntr_uv: '200', ord_time: '090000', cntr_time: '091500',
            },
          }],
        };
      },
    },
  });

  const result = await reader({ userId: USER_ID, range: '30D', providers: ['kiwoom'], now: NOW });
  assert.equal(result.privateProviderRequests, 2);
  assert.equal(result.payloads.length, 2);
  assert.equal(result.providers[0]?.status, 'PARTIAL');
  assert.equal(result.providers[0]?.effectiveDays, 7);
  assert.equal(result.providers[0]?.rangeCapped, true);
  assert.equal(result.providers[0]?.truncated, true);
  assert.equal(result.providers[0]?.errorCode, 'KIWOOM_HISTORY_CAPPED_7D');
  assert.equal(result.payloads.every((row) => row.source === 'KIWOOM_API'), true);
});

test('Kiwoom failed history read retains attempted private request count', async () => {
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({ kiwoom: 'KIWOOM_ENCRYPTED_FIXTURE' }),
    decryptCredentials: () => ({ appKey: 'A', appSecret: 'S' }),
    flags: { kiwoom: true, upbit: false, bitget: false },
    kiwoomProvider: {
      async journalFillRows(_credentials, _dates, _signal, requestCounter) {
        if (requestCounter) requestCounter.value += 1;
        throw new Error('provider failed after one read');
      },
    },
  });

  const result = await reader({ userId: USER_ID, range: '7D', providers: ['kiwoom'], now: NOW });
  assert.equal(result.privateProviderRequests, 1);
  assert.equal(result.payloads.length, 0);
  assert.equal(result.providers[0]?.status, 'UNAVAILABLE');
  assert.equal(result.providers[0]?.privateProviderRequests, 1);
});

test('Upbit closed-order history is re-read by UUID and normalized only from proven detail trades', async () => {
  const seen: Array<{ path: string; method: string; query: string }> = [];
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({ upbit: 'UPBIT_ENCRYPTED_FIXTURE' }),
    decryptCredentials: () => ({ accessKey: 'UPBIT_ACCESS_TEST_ONLY', secretKey: 'UPBIT_SECRET_TEST_ONLY' }),
    flags: { upbit: true, bitget: false },
    maxUpbitOrders: 10,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, method: String(init?.method), query: url.search });
      if (url.pathname === '/v1/orders/closed') {
        return new Response(JSON.stringify([{
          uuid: 'ORDER-1',
          side: 'bid',
          state: 'done',
          market: 'KRW-BTC',
          created_at: '2026-09-24T10:00:00+09:00',
          volume: '0.01',
          remaining_volume: '0',
          executed_volume: '0.01',
          paid_fee: '700',
          trades_count: 2,
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/v1/order') {
        assert.match(url.search, /uuid=ORDER-1/);
        return new Response(JSON.stringify({
          uuid: 'ORDER-1',
          identifier: 'client-1',
          side: 'bid',
          state: 'done',
          market: 'KRW-BTC',
          created_at: '2026-09-24T10:00:00+09:00',
          volume: '0.01',
          remaining_volume: '0',
          executed_volume: '0.01',
          paid_fee: '700',
          trades: [
            { uuid: 'FILL-1', price: '100000000', volume: '0.004', funds: '400000', created_at: '2026-09-24T10:00:01+09:00' },
            { uuid: 'FILL-2', price: '100100000', volume: '0.006', funds: '600600', created_at: '2026-09-24T10:00:02+09:00' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    },
  });

  const result = await reader({ userId: USER_ID, range: '7D', providers: ['upbit'], now: NOW });
  assert.equal(result.providers[0]?.status, 'READY');
  assert.equal(result.payloads.length, 1);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((row) => row.method === 'GET'));
  const payload = result.payloads[0]!;
  assert.equal(payload.source, 'UPBIT_API');
  assert.equal(payload.broker, 'UPBIT');
  assert.equal(payload.symbol, 'BTC');
  assert.equal(payload.market, 'CRYPTO_SPOT');
  assert.equal(payload.filledQuantity, 0.01);
  assert.equal(payload.remainingQuantity, 0);
  assert.equal(payload.averageFillPrice, 100060000);
  assert.equal(payload.filledAt, '2026-09-24T10:00:02+09:00');
  assert.equal(String(payload.accountIdMasked).includes(USER_ID), false);
  assert.match(String(payload.accountIdMasked), /^UPBIT-\*\*\*\*-/);
  assert.equal(JSON.stringify(payload).includes('UPBIT_SECRET_TEST_ONLY'), false);
});

test('Bitget historical closed positions normalize as provider cycles without promoting provider net PnL into canonical net analytics', async () => {
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({ bitget: 'BITGET_ENCRYPTED_FIXTURE' }),
    decryptCredentials: () => ({ apiKey: 'K', secretKey: 'S', passphrase: 'P' }),
    flags: { upbit: false, bitget: true },
    maxBitgetPages: 2,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.bitget.com');
      assert.equal(url.pathname, '/api/v2/mix/position/history-position');
      assert.equal(init?.method, 'GET');
      assert.equal(url.searchParams.get('productType'), 'USDT-FUTURES');
      return new Response(JSON.stringify({
        code: '00000',
        msg: 'success',
        data: {
          list: [{
            positionId: 'POS-1',
            marginCoin: 'USDT',
            symbol: 'BTCUSDT',
            holdSide: 'long',
            openAvgPrice: '60000',
            closeAvgPrice: '61000',
            marginMode: 'isolated',
            openTotalPos: '0.01',
            closeTotalPos: '0.01',
            pnl: '10',
            netProfit: '9.5',
            totalFunding: '-0.1',
            openFee: '-0.2',
            closeFee: '-0.2',
            cashDividend: '0',
            posMode: 'one_way_mode',
            ctime: '1790250000000',
            utime: '1790253600000',
          }],
          endId: null,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const result = await reader({ userId: USER_ID, range: '30D', providers: ['bitget'], now: NOW });
  assert.equal(result.providers[0]?.status, 'READY');
  assert.equal(result.payloads.length, 1);
  const payload = result.payloads[0]!;
  assert.equal(payload.source, 'BITGET_API');
  assert.equal(payload.positionSide, 'LONG');
  assert.equal(payload.market, 'CRYPTO_FUTURES');
  assert.equal(payload.grossPnl, 10);
  assert.equal(payload.fees, 0.4);
  assert.equal(payload.tax, null);
  assert.equal(payload.providerReportedNetPnl, 9.5);
  assert.equal(payload.providerReportedNetPnlBasis, 'BITGET_HISTORY_POSITION');
  assert.match(String(payload.accountIdMasked), /^BITGET-\*\*\*\*-/);
});

test('90D/1Y/ALL requests are explicitly capped to 30 days for private account history', async () => {
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository({}),
    decryptCredentials: () => ({}),
    fetchImpl: async () => new Response('{}', { status: 500 }),
    flags: { upbit: true, bitget: true },
  });
  for (const range of ['90D', '1Y', 'ALL'] as const) {
    const result = await reader({ userId: USER_ID, range, providers: [], now: NOW });
    assert.equal(result.effectiveDays, 30);
    assert.equal(result.rangeCapped, true);
    assert.equal(result.truncated, true);
    assert.equal(result.persisted, false);
  }
});
