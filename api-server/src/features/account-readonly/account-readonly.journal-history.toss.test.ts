import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountReadonlyCredentialRepository } from './account-readonly.repository';
import { createAccountJournalHistoryReader } from './account-readonly.journal-history';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-02T03:00:00.000Z');

const repository: AccountReadonlyCredentialRepository = {
  async get(userId, provider) {
    assert.equal(userId, USER_ID);
    if (provider !== 'toss') return null;
    return {
      userId,
      provider,
      configured: true,
      encryptedCredentials: 'TOSS_ENCRYPTED',
      lastVerifiedAt: null,
      lastErrorCode: null,
      updatedAt: NOW.toISOString(),
    };
  },
  async save() { throw new Error('READ_ONLY_TEST_REPOSITORY'); },
  async remove() { throw new Error('READ_ONLY_TEST_REPOSITORY'); },
};

test('Toss CLOSED orders are imported read-only as canonical manual journal history', async () => {
  const requests: Array<{ method:string; path:string; query:string }> = [];
  const reader = createAccountJournalHistoryReader({
    repositoryFactory: () => repository,
    decryptCredentials: () => ({ clientId: 'client', clientSecret: 'secret', accountSeq: '7' }),
    flags: { toss: true, kiwoom: false, upbit: false, bitget: false },
    fetchImpl: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      const method = String(init?.method ?? 'GET');
      requests.push({ method, path: url.pathname, query: url.searchParams.toString() });
      if (url.pathname === '/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'token-value', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/v1/accounts') {
        return new Response(JSON.stringify({ accounts: [{ accountSeq: '7', accountType: 'brokerage' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/v1/orders') {
        assert.equal(url.searchParams.get('status'), 'CLOSED');
        assert.equal(new Headers(init?.headers).get('X-Tossinvest-Account'), '7');
        return new Response(JSON.stringify({
          result: {
            orders: [{
              orderId: 'toss-history-1',
              symbol: '005930',
              side: 'BUY',
              orderType: 'LIMIT',
              timeInForce: 'DAY',
              status: 'FILLED',
              price: '70000',
              quantity: '2',
              orderAmount: null,
              currency: 'KRW',
              orderedAt: '2026-10-01T01:00:00.000Z',
              canceledAt: null,
              execution: {
                filledQuantity: '2',
                averageFilledPrice: '69950',
                filledAmount: '139900',
                commission: '10',
                tax: '0',
                filledAt: '2026-10-01T01:00:01.000Z',
                settlementDate: '2026-10-03',
              },
            }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('UNEXPECTED_URL:' + url.toString());
    },
  });

  const result = await reader({ userId: USER_ID, range: '30D', providers: ['toss'], now: NOW });
  assert.equal(result.providers[0]?.status, 'READY');
  assert.equal(result.privateProviderRequests, 2);
  assert.equal(result.payloads.length, 1);
  assert.equal(result.payloads[0]?.source, 'TOSS_API');
  assert.equal(result.payloads[0]?.brokerOrderId, 'toss-history-1');
  assert.equal(result.payloads[0]?.filledQuantity, 2);
  assert.equal(result.safety.orderRequests, 0);
  assert.equal(result.safety.cancelRequests, 0);
  assert.equal(result.safety.transferRequests, 0);
  assert.equal(requests.some((row) => row.method === 'POST' && row.path === '/oauth2/token'), true);
  assert.equal(requests.filter((row) => row.path.startsWith('/api/v1/')).every((row) => row.method === 'GET'), true);
});
