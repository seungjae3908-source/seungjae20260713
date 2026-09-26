import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySnapshot } from './account-readonly.contract';
import { readPortfolioAccountSources } from './account-readonly.portfolio-source';

test('portfolio account source never calls a private reader when credentials are not configured', async () => {
  let reads = 0;
  const result = await readPortfolioAccountSources({
    userId: 'user-a',
    accessToken: 'token-a',
    providers: ['toss', 'upbit'],
  }, {
    credentialConfigured: async (_userId, provider) => provider === 'upbit',
    read: async (_scope, provider) => {
      reads += 1;
      return {
        ...emptySnapshot(provider, 'CONNECTED', '2026-09-25T01:00:00.000Z'),
        connected: true,
        accounts: [],
        balances: [],
        positions: [],
        openOrders: [],
        lastGoodAt: '2026-09-25T01:00:00.000Z',
      };
    },
  });

  assert.equal(reads, 1);
  assert.equal(result[0]?.provider, 'toss');
  assert.equal(result[0]?.configured, false);
  assert.equal(result[0]?.snapshot, null);
  assert.equal(result[1]?.provider, 'upbit');
  assert.equal(result[1]?.configured, true);
  assert.equal(result[1]?.snapshot?.connected, true);
});

test('portfolio account source fails closed on credential metadata errors without calling provider', async () => {
  let reads = 0;
  const result = await readPortfolioAccountSources({
    userId: 'user-a',
    accessToken: 'token-a',
    providers: ['kiwoom'],
  }, {
    credentialConfigured: async () => { throw new Error('SECRET_STORAGE_DETAIL'); },
    read: async () => {
      reads += 1;
      throw new Error('must not run');
    },
  });

  assert.equal(reads, 0);
  assert.deepEqual(result, [{
    provider: 'kiwoom',
    configured: null,
    snapshot: null,
    errorCode: 'ACCOUNT_CREDENTIAL_METADATA_UNAVAILABLE',
  }]);
  assert.equal(JSON.stringify(result).includes('SECRET_STORAGE_DETAIL'), false);
});

test('portfolio account source rejects missing authenticated scope before metadata or provider calls', async () => {
  let metadataCalls = 0;
  let reads = 0;
  const result = await readPortfolioAccountSources({
    userId: '',
    accessToken: '',
    providers: ['bitget'],
  }, {
    credentialConfigured: async () => { metadataCalls += 1; return true; },
    read: async () => {
      reads += 1;
      return emptySnapshot('bitget', 'UNAVAILABLE', '2026-09-25T01:00:00.000Z');
    },
  });

  assert.equal(metadataCalls, 0);
  assert.equal(reads, 0);
  assert.equal(result[0]?.errorCode, 'ACCOUNT_REQUEST_SCOPE_REQUIRED');
});
