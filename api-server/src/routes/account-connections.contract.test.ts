import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildBrokerCommonState } from './account-connections';
import {
  assertTossReadonlyContract,
  readTossAccountSnapshot,
  type TossReadonlyRequest,
  type TossReadonlyTransport,
} from '../features/toss-readonly/toss-readonly.service';
import {
  decryptTradingCredentials,
  encryptTradingCredentials,
} from '../services/trade-credential-vault.service';
import type { ExchangeConnection } from '../services/trade-automation.types';

const repositoryRoot = process.cwd();

function source(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function connection(overrides: Partial<ExchangeConnection> = {}): ExchangeConnection {
  return {
    userId: 'user-a',
    exchange: 'kiwoom',
    accountMode: 'live',
    configured: true,
    encryptedCredentials: 'MUST_NEVER_LEAVE_THE_VAULT',
    lastVerifiedAt: '2026-08-13T00:00:00.000Z',
    lastErrorCode: null,
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

test('credential vault still encrypts secrets with AES-GCM and rejects the wrong key', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const wrongKey = Buffer.alloc(32, 8).toString('base64');
  const credentials = {
    accessKey: 'ACCOUNT_ACCESS_TEST_ONLY_123',
    secretKey: 'ACCOUNT_SECRET_TEST_ONLY_456',
    passphrase: 'ACCOUNT_PASSPHRASE_TEST_ONLY_789',
  };

  const encrypted = encryptTradingCredentials(credentials, key);
  assert.notEqual(encrypted, JSON.stringify(credentials));
  assert.equal(encrypted.includes(credentials.accessKey), false);
  assert.equal(encrypted.includes(credentials.secretKey), false);
  assert.equal(encrypted.includes(credentials.passphrase), false);
  assert.deepEqual(decryptTradingCredentials(encrypted, key), credentials);
  assert.throws(() => decryptTradingCredentials(encrypted, wrongKey));
});

test('broker common state is self-scoped and rejects any cross-user repository row', () => {
  assert.throws(
    () => buildBrokerCommonState('user-a', [connection({ userId: 'user-b' })]),
    /ACCOUNT_CONNECTION_USER_SCOPE_MISMATCH/,
  );
});

test('configured providers expose vault metadata only and never serialize encrypted credentials', () => {
  const state = buildBrokerCommonState('user-a', [
    connection(),
    connection({ exchange: 'upbit' }),
    connection({ exchange: 'bitget' }),
  ]);

  for (const provider of ['kiwoom', 'upbit', 'bitget'] as const) {
    assert.equal(state.providers[provider].configured, true);
    assert.equal(state.providers[provider].connected, false);
    assert.equal(state.providers[provider].credentialSource, 'vault');
    assert.equal(state.providers[provider].connectivityStatus, 'configured_unverified');
    assert.equal(state.providers[provider].capabilities.privateAccountRead, false);
    assert.equal(state.providers[provider].capabilities.privatePositionRead, false);
    assert.equal(state.providers[provider].capabilities.placeOrder, false);
    assert.equal(state.providers[provider].capabilities.cancelOrder, false);
    assert.equal(state.providers[provider].capabilities.amendOrder, false);
  }

  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.assets, []);
  assert.equal(JSON.stringify(state).includes('MUST_NEVER_LEAVE_THE_VAULT'), false);
});

test('Toss stays an explicit waiting boundary on the canonical metadata-only route', () => {
  const state = buildBrokerCommonState('user-a', []);
  assert.equal(state.providers.toss.configured, false);
  assert.equal(state.providers.toss.connected, false);
  assert.equal(state.providers.toss.credentialSource, 'none');
  assert.equal(state.providers.toss.connectivityStatus, 'waiting_for_api_access');
  assert.equal(state.providers.toss.provenance, 'release_static_boundary');
  assert.equal(state.providers.toss.capabilities.privateAccountRead, false);
  assert.equal(state.providers.toss.capabilities.placeOrder, false);
});

test('server environment credentials can no longer become a user credential fallback', () => {
  const previousKey = process.env.KIWOOM_APP_KEY;
  const previousSecret = process.env.KIWOOM_APP_SECRET;
  process.env.KIWOOM_APP_KEY = 'SERVER_KEY_MUST_NOT_FALLBACK';
  process.env.KIWOOM_APP_SECRET = 'SERVER_SECRET_MUST_NOT_FALLBACK';
  try {
    const state = buildBrokerCommonState('user-a', []);
    assert.equal(state.providers.kiwoom.configured, false);
    assert.equal(state.providers.kiwoom.credentialSource, 'none');
    assert.equal(JSON.stringify(state).includes('SERVER_KEY_MUST_NOT_FALLBACK'), false);
  } finally {
    if (previousKey == null) delete process.env.KIWOOM_APP_KEY;
    else process.env.KIWOOM_APP_KEY = previousKey;
    if (previousSecret == null) delete process.env.KIWOOM_APP_SECRET;
    else process.env.KIWOOM_APP_SECRET = previousSecret;
  }
});

test('account connection route stays GET-only metadata-only and has no provider network or credential decryption path', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');
  const indexSource = source('api-server/src/routes/index.ts');

  assert.match(indexSource, /router\.use\('\/account-connections',\s*accountConnectionsRouter\)/);
  assert.doesNotMatch(indexSource, /router\.use\('\/account-connections',\s*requireAdmin/);
  assert.match(routeSource, /router\.get\('\/contract'/);
  assert.match(routeSource, /router\.get\('\/status'/);
  assert.match(routeSource, /router\.get\('\/snapshot'/);
  assert.doesNotMatch(routeSource, /router\.(?:post|put|patch|delete)\(/);
  assert.doesNotMatch(routeSource, /\bfetch\s*\(/);
  assert.doesNotMatch(routeSource, /decryptTradingCredentials/);
  assert.doesNotMatch(routeSource, /environmentCredentials/);
  assert.doesNotMatch(routeSource, /KIWOOM_APP_KEY|UPBIT_ACCESS_KEY|BITGET_API_KEY/);
  assert.doesNotMatch(routeSource, /prepare(?:Kiwoom|Upbit|Bitget).*(?:Account|Position|Order|Cancel|Amend)/);
  assert.match(routeSource, /serverCredentialFallback:\s*false/);
  assert.match(routeSource, /privateProviderRequests:\s*0/);
  assert.match(routeSource, /credentialsReturned:\s*false/);
  assert.match(routeSource, /mutationsAllowed:\s*false/);
  assert.match(routeSource, /orderSubmitted:\s*false/);
  assert.match(routeSource, /exchangeRequestSent:\s*false/);

  for (const privatePath of [
    '/crypto/futures/auto',
    '/crypto/spot/accounts',
    '/crypto/futures/account',
    '/crypto/futures/positions',
    '/stocks/auto-trade',
  ]) {
    assert.equal(indexSource.includes(privatePath), true, `missing private-path fail-closed guard: ${privatePath}`);
  }
});

test('isolated Toss read-only client maps account data without leaking secret or full account id', async () => {
  const seen: TossReadonlyRequest[] = [];
  const transport: TossReadonlyTransport = {
    async send<T>(request: TossReadonlyRequest): Promise<T> {
      seen.push(request);
      if (request.path === '/oauth2/token') return { access_token: 'ACCESS_TOKEN_TEST_ONLY' } as T;
      if (request.path === '/api/v1/accounts') {
        return { result: [{ accountSeq: '12345678', accountType: 'GENERAL' }] } as T;
      }
      if (request.path === '/api/v1/holdings') {
        return {
          result: {
            items: [{
              symbol: '005930',
              name: 'Samsung Electronics',
              marketCountry: 'KR',
              currency: 'KRW',
              quantity: '10',
              averagePurchasePrice: '70000',
              lastPrice: '72000',
              marketValue: { amount: '720000' },
              profitLoss: { amount: '20000', rate: '0.028571' },
            }],
            marketValue: { amount: { krw: '720000', usd: '0' } },
            profitLoss: { amount: { krw: '20000', usd: '0' }, rate: '0.028571' },
          },
        } as T;
      }
      if (request.path === '/api/v1/buying-power' && request.query === 'currency=KRW') {
        return { result: { currency: 'KRW', cashBuyingPower: '1500000' } } as T;
      }
      if (request.path === '/api/v1/buying-power' && request.query === 'currency=USD') {
        return { result: { currency: 'USD', cashBuyingPower: '850.25' } } as T;
      }
      throw new Error(`unexpected test request: ${request.method} ${request.path}?${request.query}`);
    },
  };

  const snapshot = await readTossAccountSnapshot({
    userId: 'user-a',
    credentials: {
      clientId: 'TOSS_CLIENT_TEST_ONLY',
      clientSecret: 'TOSS_SECRET_TEST_ONLY',
    },
    transport,
  });

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].accountMasked.includes('12345678'), false);
  assert.equal(snapshot.accounts[0].accountRef.length, 16);
  assert.equal(snapshot.accounts[0].holdings[0].symbol, '005930');
  assert.equal(snapshot.accounts[0].buyingPower.KRW, 1_500_000);
  assert.equal(snapshot.accounts[0].buyingPower.USD, 850.25);
  assert.equal(snapshot.orderRequests, 0);
  assert.equal(snapshot.cancelRequests, 0);
  assert.equal(snapshot.amendRequests, 0);
  assert.equal(snapshot.transferRequests, 0);
  assert.equal(snapshot.withdrawalRequests, 0);
  assert.equal(snapshot.providerRequests, 5);
  assertTossReadonlyContract(seen);

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('TOSS_SECRET_TEST_ONLY'), false);
  assert.equal(serialized.includes('ACCESS_TOKEN_TEST_ONLY'), false);
  assert.equal(serialized.includes('12345678'), false);
});

test('Toss read-only contract rejects order-like or mutating provider requests', () => {
  assert.throws(() => assertTossReadonlyContract([{
    method: 'POST',
    path: '/api/v1/holdings',
    query: '',
    headers: {},
    body: '{}',
  }]), /TOSS_PRIVATE_MUTATION_FORBIDDEN/);

  assert.throws(() => assertTossReadonlyContract([{
    method: 'POST',
    path: '/api/v1/orders',
    query: '',
    headers: {},
    body: '{}',
  }]), /TOSS_READONLY_PATH_FORBIDDEN/);
});

test('Toss read-only route is isolated, explicit-intent gated, and service-role stored', () => {
  const appSource = source('api-server/src/app.ts');
  const routeSource = source('api-server/src/routes/toss-readonly.ts');
  const repoSource = source('api-server/src/features/toss-readonly/toss-readonly.repository.ts');
  const serviceSource = source('api-server/src/features/toss-readonly/toss-readonly.service.ts');
  const migrationSource = source('api-server/supabase/migrations/2026081301_toss_readonly_connections.sql');

  assert.match(appSource, /\/api\/account-connections\/toss-readonly/);
  assert.match(routeSource, /x-toss-readonly-intent/);
  assert.match(routeSource, /account-snapshot/);
  assert.match(routeSource, /liveTradingEnabled:\s*false/);
  assert.match(routeSource, /autoTradingEnabled:\s*false/);
  assert.doesNotMatch(routeSource, /\/api\/v1\/orders/);
  assert.match(repoSource, /getSupabase\(\)/);
  assert.match(repoSource, /\.eq\('user_id',\s*owner\)/);
  assert.doesNotMatch(repoSource, /process\.env\.(?:TOSS|CLIENT)/);
  assert.doesNotMatch(serviceSource, /\/api\/v1\/orders/);
  assert.match(serviceSource, /TOSS_PRIVATE_MUTATION_FORBIDDEN/);
  assert.match(migrationSource, /revoke all privileges.*authenticated/i);
  assert.doesNotMatch(migrationSource, /client_secret\s+(?:text|varchar)/i);
  assert.doesNotMatch(migrationSource, /access_token\s+(?:text|varchar)/i);
});
