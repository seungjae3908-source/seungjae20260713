import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import { TradeExecutionService } from './trade-execution.service';

const USER = 'kiwoom-live-verify-user';
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

test('Kiwoom live verification uses read-only account-number probe instead of kt00010 orderability request', async () => {
  const previousKey = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  const previousFetch = globalThis.fetch;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;

  const repository = new InMemoryTradingRepository();
  await repository.saveConnection({
    userId: USER,
    exchange: 'kiwoom',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({
      appKey: 'KIWOOM_APP_KEY_TEST_ONLY',
      secretKey: 'KIWOOM_SECRET_KEY_TEST_ONLY',
    }),
    lastVerifiedAt: null,
    lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
    updatedAt: new Date(0).toISOString(),
  });

  const seenApiIds: string[] = [];
  let financialMutationRequests = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL
      ? input
      : typeof input === 'string'
        ? new URL(input)
        : new URL(input.url);
    const headers = new Headers(init?.headers);
    const apiId = headers.get('api-id');
    if (apiId) seenApiIds.push(apiId);

    if (url.pathname.includes('/ordr')) {
      financialMutationRequests += 1;
      throw new Error('TEST_FINANCIAL_MUTATION_FORBIDDEN');
    }

    if (url.pathname === '/oauth2/token') {
      return new Response(JSON.stringify({
        return_code: 0,
        token: 'KIWOOM_ACCESS_TOKEN_TEST_ONLY',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/api/dostk/acnt' && apiId === 'ka00001') {
      return new Response(JSON.stringify({
        return_code: 0,
        return_msg: 'success',
        acclst: [{ acct_no: '1234567890' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/api/dostk/acnt' && apiId === 'kt00010') {
      return new Response(JSON.stringify({
        return_code: 2,
        return_msg: 'orderability request rejected',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    throw new Error(`UNEXPECTED_KIWOOM_VERIFY_REQUEST:${url.pathname}:${apiId ?? 'NO_API_ID'}`);
  }) as typeof fetch;

  try {
    const result = await new TradeExecutionService(repository).verifyLiveConnection(USER, 'kiwoom');
    assert.equal(result.verified, true);
    assert.equal(result.providerRequests, 2);
    assert.equal(result.orderRequests, 0);
    assert.equal(result.cancelRequests, 0);
    assert.equal(result.amendRequests, 0);
    assert.equal(result.transferRequests, 0);
    assert.equal(result.withdrawalRequests, 0);
    assert.equal(result.realOrderSubmitted, false);
    assert.deepEqual(seenApiIds, ['ka00001']);
    assert.equal(financialMutationRequests, 0);

    const saved = await repository.getConnection(USER, 'kiwoom');
    assert.ok(saved?.lastVerifiedAt);
    assert.equal(saved?.lastErrorCode, null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previousKey;
  }
});
