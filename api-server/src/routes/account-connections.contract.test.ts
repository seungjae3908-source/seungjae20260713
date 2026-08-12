import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  decryptTradingCredentials,
  encryptTradingCredentials,
} from '../services/trade-credential-vault.service';
import { validateKiwoomReadResponse } from '../services/kiwoom-readonly-response.service';
import { memberBrokerJournalSnapshot } from './account-connections';

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

test('account snapshots stay GET-only while authenticated members receive self-scoped routes', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');
  const indexSource = source('api-server/src/routes/index.ts');
  const tradeRouteSource = source('api-server/src/routes/trade-automation.ts');

  assert.match(indexSource, /router\.use\('\/account-connections',\s*requireAdmin,\s*accountConnectionsRouter\)/);
  assert.match(tradeRouteSource, /router\.get\('\/account-connections\/status'/);
  assert.match(tradeRouteSource, /router\.get\('\/account-connections\/snapshot'/);
  assert.match(tradeRouteSource, /router\.get\('\/account-connections\/journal'/);
  assert.match(routeSource, /router\.get\('\/status'/);
  assert.match(routeSource, /router\.get\('\/snapshot'/);
  assert.match(routeSource, /router\.get\('\/journal'/);
  assert.doesNotMatch(routeSource, /router\.(?:post|put|patch|delete)\(/);
  assert.match(routeSource, /decryptTradingCredentials/);
  assert.match(routeSource, /credentialsReturned:\s*false/);
  assert.match(routeSource, /mutationsAllowed:\s*false/);
  assert.match(routeSource, /credentialSource/);
  assert.doesNotMatch(routeSource, /function environmentCredentials/);
  assert.match(routeSource, /WAITING_FOR_TOSS_API_ACCESS/);

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
  const responseBlocks = [
    routeSource.match(/export async function memberAccountConnectionStatus[\s\S]*?\n}\n\nrouter\.get\('\/status'/)?.[0] ?? '',
    routeSource.match(/export async function memberAccountConnectionSnapshot[\s\S]*?\n}\n\nrouter\.get\('\/snapshot'/)?.[0] ?? '',
    routeSource.match(/export async function memberBrokerJournalSnapshot[\s\S]*?\n}\n\nrouter\.get\('\/journal'/)?.[0] ?? '',
  ];
  assert.ok(responseBlocks.every(Boolean));
  for (const block of responseBlocks) {
    assert.doesNotMatch(block, /\bcredentials\s*[:,]/);
    assert.doesNotMatch(block, /\bencryptedCredentials\b/);
    assert.doesNotMatch(block, /\bsecretKey\b/);
    assert.doesNotMatch(block, /\bpassphrase\b/);
    assert.doesNotMatch(block, /\baccessKey\b/);
    assert.doesNotMatch(block, /\bapiKey\b/);
  }
});

test('member broker journal without a session stays disconnected and sends no private read or mutation', async () => {
  const result = await memberBrokerJournalSnapshot({} as never);
  assert.equal(result.records.length, 0);
  assert.equal(result.providers.toss.configured, false);
  assert.equal(result.providers.upbit.configured, false);
  assert.equal(result.providers.bitget.configured, false);
  assert.equal(result.providers.toss.privateReadRequests, 0);
  assert.equal(result.providers.upbit.privateReadRequests, 0);
  assert.equal(result.providers.bitget.privateReadRequests, 0);
  assert.equal(result.safety.privateMutationRequests, 0);
  assert.equal(result.credentialsReturned, false);
  assert.equal(result.mutationsAllowed, false);
});

test('account connection router correctly uses adapter service and prohibits direct write access', () => {
  const routeSource = source('api-server/src/routes/account-connections.ts');

  const importMatch = routeSource.match(
    /import\s*{\s*([^}]*)\s*}\s*from\s*'\.\.\/services\/trade-exchange-adapters\.service';/,
  );
  assert.ok(importMatch, 'Missing import from ../services/trade-exchange-adapters.service');
  const importedNames = importMatch[1].split(',').map((value) => value.trim().replace(/^type\s+/, ''));
  for (const required of [
    'prepareUpbitAccounts',
    'prepareBitgetAccount',
    'prepareBitgetPositions',
    'prepareKiwoomToken',
    'prepareKiwoomAccountNumber',
    'prepareKiwoomDomesticAccount',
    'prepareKiwoomUsAccount',
    'prepareTossToken',
    'prepareTossAccounts',
    'prepareTossHoldings',
  ]) {
    assert.ok(importedNames.includes(required), `Missing ${required}`);
  }

  assert.doesNotMatch(routeSource, /function upbitAuthorization/);
  assert.doesNotMatch(routeSource, /function bitgetHeaders/);
  assert.doesNotMatch(routeSource, /kiwoom-readonly-account/);
  assert.match(routeSource, /KIWOOM_READ_API_IDS/);
  assert.match(routeSource, /ACCOUNT_READONLY_REQUEST_REQUIRED/);

  const forbiddenCalls = [
    'prepareBitgetMarginMode',
    'prepareBitgetLeverage',
    'prepareBitgetOrder',
    'prepareBitgetCancel',
    'prepareUpbitOrder',
    'prepareUpbitCancel',
    'prepareKiwoomOrder',
    'prepareKiwoomCancel',
    'prepareTossOrder',
    'prepareTossCancel',
    'prepareTossAmend',
  ];
  for (const call of forbiddenCalls) {
    assert.doesNotMatch(routeSource, new RegExp('\\b' + call + '\\b'), `Forbidden direct call detected: ${call}`);
  }
});

test('Kiwoom account adapters are exact read-only requests and stay separate from order adapters', () => {
  const adapterSource = source('api-server/src/services/trade-exchange-adapters.service.ts');
  assert.match(adapterSource, /prepareKiwoomAccountNumber/);
  assert.match(adapterSource, /prepareKiwoomDomesticAccount/);
  assert.match(adapterSource, /prepareKiwoomUsAccount/);
  assert.match(adapterSource, /'ka00001'/);
  assert.match(adapterSource, /'kt00018'/);
  assert.match(adapterSource, /'ust21070'/);
  assert.doesNotMatch(
    adapterSource.match(/function kiwoomReadRequest[\s\S]*?\n}\n/)?.[0] ?? '',
    /\/api\/dostk\/ordr|kt1000[0-9]/,
  );
});

test('Kiwoom read-only responses fail closed on provider errors and malformed account payloads', () => {
  assert.throws(
    () => validateKiwoomReadResponse('ka00001', { return_code: 1, return_msg: 'provider error', acctNo: '1234567890' }),
    /KIWOOM_PROVIDER_ERROR/,
  );
  assert.throws(() => validateKiwoomReadResponse('ka00001', null), /KIWOOM_RESPONSE_MALFORMED/);
  assert.throws(() => validateKiwoomReadResponse('ka00001', { return_code: 'not-a-number', acctNo: '1234567890' }), /KIWOOM_RESPONSE_MALFORMED/);
  assert.throws(() => validateKiwoomReadResponse('ka00001', { return_code: 0 }), /KIWOOM_RESPONSE_MALFORMED/);
  assert.throws(
    () => validateKiwoomReadResponse('kt00018', { return_code: 0, acnt_evlt_remn_indv_tot: {} }),
    /KIWOOM_RESPONSE_MALFORMED/,
  );
  assert.throws(
    () => validateKiwoomReadResponse('ust21070', { return_code: 0, result_list: {} }),
    /KIWOOM_RESPONSE_MALFORMED/,
  );

  assert.equal(validateKiwoomReadResponse('ka00001', { return_code: 0, acctNo: '1234567890' }).acctNo, '1234567890');
  assert.deepEqual(
    validateKiwoomReadResponse('kt00018', { return_code: 0, tot_evlt_amt: '0', acnt_evlt_remn_indv_tot: [] }).acnt_evlt_remn_indv_tot,
    [],
  );
  assert.deepEqual(
    validateKiwoomReadResponse('ust21070', { return_code: 0, crnc_code: 'USD', result_list: [] }).result_list,
    [],
  );
});
