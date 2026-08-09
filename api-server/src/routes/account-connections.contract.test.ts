import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  decryptTradingCredentials,
  encryptTradingCredentials,
} from '../services/trade-credential-vault.service';

const repositoryRoot = process.cwd();

function source(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('credential vault encrypts secrets with AES-GCM and rejects the wrong key', () => {
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

test('account connection router is admin-mounted, GET-only, read-only, and never advertises credentials', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');
  const indexSource = source('api-server/src/routes/index.ts');

  assert.match(indexSource, /router\.use\('\/account-connections',\s*requireAdmin,\s*accountConnectionsRouter\)/);
  assert.match(routeSource, /router\.get\('\/status'/);
  assert.match(routeSource, /router\.get\('\/snapshot'/);
  assert.doesNotMatch(routeSource, /router\.(?:post|put|patch|delete)\(/);
  assert.match(routeSource, /decryptTradingCredentials/);
  assert.match(routeSource, /credentialsReturned:\s*false/);
  assert.match(routeSource, /mutationsAllowed:\s*false/);
  assert.match(routeSource, /credentialSource/);

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

test('account snapshot source never serializes the vault credential object into an API response', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');
  const responseBlocks = [...routeSource.matchAll(/res\.json\(\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
  assert.ok(responseBlocks.length >= 2);
  for (const block of responseBlocks) {
    assert.doesNotMatch(block, /\bcredentials\s*[:,]/);
    assert.doesNotMatch(block, /\bencryptedCredentials\b/);
    assert.doesNotMatch(block, /\bsecretKey\b/);
    assert.doesNotMatch(block, /\bpassphrase\b/);
    assert.doesNotMatch(block, /\baccessKey\b/);
    assert.doesNotMatch(block, /\bapiKey\b/);
  }
});

test('account connection router correctly uses adapter service and prohibits direct write access', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');

  // Check imports
  const importMatch = routeSource.match(/import {([\s\S]*?)} from '..\/services\/trade-exchange-adapters.service'/);
  assert.ok(importMatch, 'Missing import from ../services/trade-exchange-adapters.service');
  const importedNames = importMatch[1].split(',').map(s => s.trim().replace(/^type\s+/, ''));
  assert.ok(importedNames.includes('prepareUpbitAccounts'), 'Missing prepareUpbitAccounts');
  assert.ok(importedNames.includes('prepareBitgetAccount'), 'Missing prepareBitgetAccount');
  assert.ok(importedNames.includes('prepareBitgetPositions'), 'Missing prepareBitgetPositions');

  // Check forbidden local implementations
  assert.doesNotMatch(routeSource, /function upbitAuthorization/);
  assert.doesNotMatch(routeSource, /function bitgetHeaders/);

  // Check forbidden direct calls
  const forbiddenCalls = [
    'prepareBitgetMarginMode',
    'prepareBitgetLeverage',
    'prepareBitgetOrder',
    'prepareBitgetCancel',
    'prepareUpbitOrder',
    'prepareUpbitCancel',
  ];
  for (const call of forbiddenCalls) {
    assert.doesNotMatch(routeSource, new RegExp('\\b' + call + '\\b'), `Forbidden direct call detected: ${call}`);
  }
});
