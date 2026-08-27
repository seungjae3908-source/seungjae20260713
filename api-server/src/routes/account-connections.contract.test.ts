import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildBrokerCommonState, legacySnapshot } from './account-connections';
import {
  decryptTradingCredentials,
  encryptTradingCredentials,
} from '../services/trade-credential-vault.service';
import type { ExchangeConnection } from '../services/trade-automation.types';
import '../features/account-readonly/tests/account-readonly.test';
import '../features/account-readonly/tests/account-readonly.runtime.test';
import '../features/member-investment/member-investment.test';
import '../features/member-investment/member-investment.route.test';

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

test('legacy account snapshot preserves unavailable evidence instead of fabricating zero balances', () => {
  const configured = buildBrokerCommonState('user-a', [connection()]);
  const configuredSnapshot = legacySnapshot(configured.providers.kiwoom);
  assert.equal(configuredSnapshot.evidenceStatus, 'NOT_COLLECTED');
  assert.equal(configuredSnapshot.observed, false);
  assert.equal(configuredSnapshot.totalBalance, null);
  assert.equal(configuredSnapshot.available, null);
  assert.equal(configuredSnapshot.holdings, null);
  assert.equal(configuredSnapshot.positions, null);
  assert.equal(configuredSnapshot.error, 'PRIVATE_PROVIDER_READ_DISABLED');

  const unconfigured = buildBrokerCommonState('user-a', []);
  const unconfiguredSnapshot = legacySnapshot(unconfigured.providers.upbit);
  assert.equal(unconfiguredSnapshot.evidenceStatus, 'UNAVAILABLE');
  assert.equal(unconfiguredSnapshot.totalBalance, null);
  assert.equal(unconfiguredSnapshot.available, null);
  assert.equal(unconfiguredSnapshot.error, 'ACCOUNT_NOT_CONFIGURED');

  const tossSnapshot = legacySnapshot(unconfigured.providers.toss);
  assert.equal(tossSnapshot.evidenceStatus, 'PERMISSION_REQUIRED');
  assert.equal(tossSnapshot.totalBalance, null);
  assert.equal(tossSnapshot.error, 'TOSS_API_ACCESS_WAITING');
});

test('Toss stays an explicit waiting boundary without schema or private API changes', () => {
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

test('disabled-read status lookup selects configured metadata without reading credential payloads', () => {
  const repositorySource = source('api-server/src/features/account-readonly/account-readonly.repository.ts');
  const lookup = repositorySource.match(
    /export async function accountReadonlyCredentialConfigured[\s\S]*?\r?\n}\r?\n\r?\nexport class/,
  )?.[0];

  assert.ok(lookup, 'configured metadata lookup must remain explicit');
  assert.match(lookup, /\.select\('configured'\)/);
  assert.doesNotMatch(lookup, /encrypted_credentials|encryptedCredentials|decrypt/i);
});

test('account connection route requires approved-member capability and stays GET-only metadata-only', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');
  const indexSource = source('api-server/src/routes/index.ts');

  assert.match(indexSource, /router\.use\('\/account-connections',\s*accountConnectionsRouter\)/);
  assert.doesNotMatch(indexSource, /router\.use\('\/account-connections',\s*requireAdmin/);
  assert.match(routeSource, /router\.use\(requireCapability\('canAccessBasicInfo'\)\)/);
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
  assert.doesNotMatch(routeSource, /totalBalance:\s*0/);
  assert.doesNotMatch(routeSource, /available:\s*0/);
  assert.match(routeSource, /totalBalance:\s*null/);
  assert.match(routeSource, /evidenceStatus/);

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

test('user integrations GET degrades only broker metadata storage outage and preserves trading fail-closed safety', () => {
  const routeSource = source('api-server/src/routes/user-broker-telegram.ts');

  assert.match(routeSource, /code !== 'TRADE_AUTOMATION_STORAGE_UNAVAILABLE'/);
  assert.match(routeSource, /brokerConnectionsAvailable:\s*false/);
  assert.match(routeSource, /brokerConnectionsErrorCode:\s*code/);
  assert.match(
    routeSource,
    /partial:\s*state\.telegramStorageAvailable === false \|\| brokerState\.brokerConnectionsAvailable === false/,
  );
  assert.match(
    routeSource,
    /brokerMetadataRead:\s*canReadBrokerConnections && brokerState\.brokerConnectionsAvailable === true/,
  );
  assert.match(routeSource, /privateApiRequests:\s*0/);
  assert.match(routeSource, /ordersSubmitted:\s*0/);
  assert.match(routeSource, /ordersCancelled:\s*0/);
  assert.match(routeSource, /userBrokerTelegramRouter\.post\('\/execution\/sync'/);
  assert.match(routeSource, /userBrokerTelegramRouter\.post\('\/telegram\/link'/);
  assert.match(routeSource, /userBrokerTelegramRouter\.patch\('\/notifications'/);
  assert.match(routeSource, /res\.status\(503\)\.json\(\{ ok: false, error: errorCode\(error\)/);
});
