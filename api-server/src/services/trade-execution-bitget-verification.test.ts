import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import { TradeExecutionService } from './trade-execution.service';

const USER = 'bitget-live-verify-user';
const MASTER_KEY = Buffer.alloc(32, 11).toString('base64');

test('Bitget live verification falls back from Classic to UTA read-only probes with zero financial mutation', async () => {
  const previousKey = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  const previousFetch = globalThis.fetch;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;

  const repository = new InMemoryTradingRepository();
  await repository.saveConnection({
    userId: USER,
    exchange: 'bitget',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({
      apiKey: 'BITGET_API_KEY_TEST_ONLY',
      secretKey: 'BITGET_SECRET_KEY_TEST_ONLY',
      passphrase: 'BITGET_PASSPHRASE_TEST_ONLY',
    }),
    lastVerifiedAt: null,
    lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
    updatedAt: new Date(0).toISOString(),
  });

  const seen: Array<{ method: string; path: string }> = [];
  let financialMutationRequests = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL
      ? input
      : typeof input === 'string'
        ? new URL(input)
        : new URL(input.url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    seen.push({ method, path: url.pathname });

    if (method !== 'GET') {
      financialMutationRequests += 1;
      throw new Error('TEST_FINANCIAL_MUTATION_FORBIDDEN');
    }

    if (url.pathname === '/api/v2/mix/account/accounts') {
      return new Response(JSON.stringify({ code: '25245', msg: 'not classic', data: null }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/api/v3/account/assets') {
      return new Response(JSON.stringify({
        code: '00000',
        data: { assets: [{ coin: 'USDT', equity: '100', available: '90' }] },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/api/v3/position/current-position') {
      return new Response(JSON.stringify({
        code: '00000',
        data: { list: [] },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error('UNEXPECTED_BITGET_VERIFY_REQUEST:' + method + ':' + url.pathname);
  }) as typeof fetch;

  try {
    const result = await new TradeExecutionService(repository).verifyLiveConnection(USER, 'bitget');
    assert.equal(result.verified, true);
    assert.equal(result.providerRequests, 3);
    assert.equal(result.orderRequests, 0);
    assert.equal(result.cancelRequests, 0);
    assert.equal(result.amendRequests, 0);
    assert.equal(result.transferRequests, 0);
    assert.equal(result.withdrawalRequests, 0);
    assert.equal(result.realOrderSubmitted, false);
    assert.equal(financialMutationRequests, 0);
    assert.deepEqual(seen.map((row) => row.path), [
      '/api/v2/mix/account/accounts',
      '/api/v3/account/assets',
      '/api/v3/position/current-position',
    ]);

    const saved = await repository.getConnection(USER, 'bitget');
    assert.ok(saved?.lastVerifiedAt);
    assert.equal(saved?.lastErrorCode, null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previousKey;
  }
});
