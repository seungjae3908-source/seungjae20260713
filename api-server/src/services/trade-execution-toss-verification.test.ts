import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { decryptTradingCredentials, encryptTradingCredentials } from './trade-credential-vault.service';
import { TradeExecutionService } from './trade-execution.service';

const USER = 'toss-live-verify-user';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

test('Toss live verification resolves missing accountSeq from accounts and persists it encrypted', async () => {
  const previousKey = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  const previousFetch = globalThis.fetch;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;

  const repository = new InMemoryTradingRepository();
  await repository.saveConnection({
    userId: USER,
    exchange: 'toss',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({
      clientId: 'CLIENT_ID_TEST_ONLY',
      clientSecret: 'CLIENT_SECRET_TEST_ONLY',
    }),
    lastVerifiedAt: null,
    lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
    updatedAt: new Date(0).toISOString(),
  });

  const seen: Array<{ path: string; accountHeader: string | null; query: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL
      ? input
      : typeof input === 'string'
        ? new URL(input)
        : new URL(input.url);
    const headers = new Headers(init?.headers);
    seen.push({
      path: url.pathname,
      accountHeader: headers.get('X-Tossinvest-Account'),
      query: url.search,
    });

    if (url.pathname === '/oauth2/token') {
      return new Response(JSON.stringify({ access_token: 'ACCESS_TOKEN_TEST_ONLY', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/v1/accounts') {
      assert.equal(headers.get('X-Tossinvest-Account'), null);
      return new Response(JSON.stringify({
        result: {
          accounts: [
            { accountSeq: 'BROKERAGE_ACCOUNT_SEQ_TEST_ONLY', accountType: 'brokerage' },
          ],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/v1/buying-power') {
      assert.equal(headers.get('X-Tossinvest-Account'), 'BROKERAGE_ACCOUNT_SEQ_TEST_ONLY');
      assert.equal(url.searchParams.get('currency'), 'KRW');
      return new Response(JSON.stringify({
        result: { currency: 'KRW', buyingPower: '1000000' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('UNEXPECTED_TOSS_TEST_REQUEST:' + url.pathname);
  }) as typeof fetch;

  try {
    const result = await new TradeExecutionService(repository).verifyLiveConnection(USER, 'toss');
    assert.equal(result.verified, true);
    assert.equal(result.providerRequests, 3);
    assert.equal(result.orderRequests, 0);
    assert.equal(result.cancelRequests, 0);
    assert.equal(result.amendRequests, 0);
    assert.equal(result.transferRequests, 0);
    assert.equal(result.withdrawalRequests, 0);
    assert.equal(result.realOrderSubmitted, false);

    const saved = await repository.getConnection(USER, 'toss');
    assert.ok(saved?.encryptedCredentials);
    assert.ok(saved.lastVerifiedAt);
    assert.equal(saved.lastErrorCode, null);
    const persisted = decryptTradingCredentials(saved.encryptedCredentials);
    assert.deepEqual(persisted, {
      clientId: 'CLIENT_ID_TEST_ONLY',
      clientSecret: 'CLIENT_SECRET_TEST_ONLY',
      accountSeq: 'BROKERAGE_ACCOUNT_SEQ_TEST_ONLY',
    });
    assert.deepEqual(seen.map((entry) => entry.path), [
      '/oauth2/token',
      '/api/v1/accounts',
      '/api/v1/buying-power',
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previousKey;
  }
});

test('Toss live verification retries bounded transient rate limits without order authority', async () => {
  const previousKey = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  const previousFetch = globalThis.fetch;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;

  const repository = new InMemoryTradingRepository();
  await repository.saveConnection({
    userId: USER,
    exchange: 'toss',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({
      clientId: 'CLIENT_ID_TEST_ONLY',
      clientSecret: 'CLIENT_SECRET_TEST_ONLY',
    }),
    lastVerifiedAt: null,
    lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
    updatedAt: new Date(0).toISOString(),
  });

  let tokenAttempts = 0;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof URL
      ? input
      : typeof input === 'string'
        ? new URL(input)
        : new URL(input.url);
    seen.push(url.pathname);
    if (url.pathname === '/oauth2/token') {
      tokenAttempts += 1;
      if (tokenAttempts < 3) {
        return new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 });
      }
      return new Response(JSON.stringify({ access_token: 'ACCESS_TOKEN_TEST_ONLY', expires_in: 3600 }));
    }
    if (url.pathname === '/api/v1/accounts') {
      return new Response(JSON.stringify({
        result: { accounts: [{ accountSeq: 'BROKERAGE_ACCOUNT_SEQ_TEST_ONLY', accountType: 'brokerage' }] },
      }));
    }
    if (url.pathname === '/api/v1/buying-power') {
      return new Response(JSON.stringify({ result: { currency: 'KRW', buyingPower: '1000000' } }));
    }
    throw new Error('UNEXPECTED_TOSS_TEST_REQUEST:' + url.pathname);
  }) as typeof fetch;

  const observedDelays: number[] = [];
  try {
    const result = await new TradeExecutionService(
      repository,
      async (delayMs) => { observedDelays.push(delayMs); },
    ).verifyLiveConnection(USER, 'toss');
    assert.equal(result.verified, true);
    assert.equal(result.providerRequests, 5);
    assert.equal(result.orderRequests, 0);
    assert.equal(result.cancelRequests, 0);
    assert.equal(result.amendRequests, 0);
    assert.equal(result.transferRequests, 0);
    assert.equal(result.withdrawalRequests, 0);
    assert.equal(result.realOrderSubmitted, false);
    assert.deepEqual(observedDelays, [1_000, 2_000]);
    assert.deepEqual(seen, [
      '/oauth2/token',
      '/oauth2/token',
      '/oauth2/token',
      '/api/v1/accounts',
      '/api/v1/buying-power',
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previousKey;
  }
});
