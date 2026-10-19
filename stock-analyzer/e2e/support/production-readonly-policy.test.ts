import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyProductionRequest,
  isIgnorableProductionConsoleError,
  isIgnorableProductionRequestFailure,
  privateAccountDisconnectedFixture,
} from './production-readonly-policy';

const ORIGIN = 'https://production.example';

test('production public GET requests remain allowed', () => {
  assert.deepEqual(
    classifyProductionRequest(`${ORIGIN}/api/market/summary?market=KR`, 'GET', ORIGIN),
    { action: 'allow' },
  );
});

test('financial POST, PUT, PATCH and DELETE requests fail closed', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const decision = classifyProductionRequest(`${ORIGIN}/api/trade-automation/orders`, method, ORIGIN);
    assert.equal(decision.action, 'block');
    assert.equal(decision.action === 'block' ? decision.reason : '', 'FINANCIAL_MUTATION_REQUEST_BLOCKED');
  }
});

test('non-financial same-origin API mutations are also blocked in read-only QA', () => {
  const decision = classifyProductionRequest(`${ORIGIN}/api/watchlist`, 'POST', ORIGIN);
  assert.deepEqual(decision, { action: 'block', reason: 'PRODUCTION_APP_MUTATION_BLOCKED' });
});

test('Supabase table and storage mutations are blocked while auth token POST remains available', () => {
  assert.deepEqual(
    classifyProductionRequest('https://example.supabase.co/rest/v1/profiles?id=eq.user', 'PATCH', ORIGIN),
    { action: 'block', reason: 'PRODUCTION_DATABASE_MUTATION_BLOCKED' },
  );
  assert.deepEqual(
    classifyProductionRequest('https://example.supabase.co/storage/v1/object/user-backups/file.json', 'POST', ORIGIN),
    { action: 'block', reason: 'PRODUCTION_STORAGE_MUTATION_BLOCKED' },
  );
  assert.deepEqual(
    classifyProductionRequest('https://example.supabase.co/auth/v1/token?grant_type=password', 'POST', ORIGIN),
    { action: 'allow' },
  );
});

test('private account snapshot is intercepted instead of reaching the provider backend', () => {
  assert.deepEqual(
    classifyProductionRequest(`${ORIGIN}/api/account-connections/snapshot`, 'GET', ORIGIN),
    { action: 'mock-private-account', reason: 'PRIVATE_ACCOUNT_LIVE_QA_NOT_RUN' },
  );
  const fixture = privateAccountDisconnectedFixture();
  assert.equal(fixture.privateAccountLiveQa, 'NOT_RUN');
  assert.equal(fixture.mutationsAllowed, false);
  assert.equal(fixture.providers.kiwoom.configured, false);
  assert.equal(fixture.providers.upbit.connected, false);
  assert.equal(fixture.providers.bitget.connected, false);
});

test('direct private broker provider traffic is blocked before transmission', () => {
  for (const url of [
    'https://api.upbit.com/v1/accounts',
    'https://api.bitget.com/api/v2/mix/account/account',
    'https://mockapi.kiwoom.com/api/dostk/acnt',
  ]) {
    assert.deepEqual(
      classifyProductionRequest(url, 'GET', ORIGIN),
      { action: 'block', reason: 'PRIVATE_PROVIDER_NETWORK_BLOCKED' },
    );
  }
});

test('same-origin read requests cancelled by navigation remain ignored without masking other failures', () => {
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/api/market/summary?market=KR`, 'GET', 'net::ERR_ABORTED', ORIGIN),
    true,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/api/market/summary?market=KR`, 'HEAD', 'net::ERR_ABORTED', ORIGIN),
    true,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/api/market/summary?market=KR`, 'GET', 'net::ERR_FAILED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure('https://cdn.example/asset.js', 'GET', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/api/watchlist`, 'POST', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure('not-a-url', 'GET', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
});

test('Cloudflare same-origin RUM POST navigation abort is ignored without masking other POST failures', () => {
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/cdn-cgi/rum`, 'POST', 'net::ERR_ABORTED', ORIGIN),
    true,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/cdn-cgi/rum?sample=1`, 'POST', 'net::ERR_ABORTED', ORIGIN),
    true,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/cdn-cgi/rum`, 'POST', 'net::ERR_FAILED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/cdn-cgi/rum`, 'PUT', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure('https://telemetry.example/cdn-cgi/rum', 'POST', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(`${ORIGIN}/api/watchlist`, 'POST', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
});

test('Cloudflare Insights beacon script failures are ignored without masking other hosts or methods', () => {
  const beacon = 'https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092';
  assert.equal(isIgnorableProductionRequestFailure(beacon, 'GET', 'net::ERR_FAILED', ORIGIN), true);
  assert.equal(isIgnorableProductionRequestFailure(beacon, 'GET', 'net::ERR_ABORTED', ORIGIN), true);
  assert.equal(isIgnorableProductionRequestFailure(beacon, 'POST', 'net::ERR_FAILED', ORIGIN), false);
  assert.equal(isIgnorableProductionRequestFailure(beacon, 'GET', 'net::ERR_CONNECTION_RESET', ORIGIN), false);
  assert.equal(
    isIgnorableProductionRequestFailure('https://static.cloudflareinsights.com/other.js', 'GET', 'net::ERR_FAILED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure('https://cdn.example/beacon.min.js', 'GET', 'net::ERR_FAILED', ORIGIN),
    false,
  );
  assert.equal(isIgnorableProductionRequestFailure(`${ORIGIN}/api/quotes`, 'GET', 'net::ERR_FAILED', ORIGIN), false);

  const corsText = `Access to script at '${beacon}' from origin '${ORIGIN}' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`;
  assert.equal(isIgnorableProductionConsoleError(corsText, ''), true);
  assert.equal(isIgnorableProductionConsoleError('Failed to load resource: net::ERR_FAILED', beacon), true);
  assert.equal(isIgnorableProductionConsoleError('Failed to load resource: net::ERR_FAILED', `${ORIGIN}/api/quotes`), false);
  assert.equal(isIgnorableProductionConsoleError('TypeError: x is undefined', ''), false);
  assert.equal(
    isIgnorableProductionConsoleError(`Access to fetch at '${ORIGIN}/api/quotes' from origin '${ORIGIN}' has been blocked by CORS policy`, ''),
    false,
  );
});

test('Supabase REST reads cancelled by route navigation are ignored without masking other failures', () => {
  const holdingsUrl = 'https://example.supabase.co/rest/v1/portfolio_holdings?select=*';
  assert.equal(
    isIgnorableProductionRequestFailure(holdingsUrl, 'GET', 'net::ERR_ABORTED', ORIGIN),
    true,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(holdingsUrl, 'HEAD', 'net::ERR_ABORTED', ORIGIN),
    true,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(holdingsUrl, 'GET', 'net::ERR_FAILED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(holdingsUrl, 'POST', 'net::ERR_ABORTED', ORIGIN),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(
      'https://example.supabase.co/auth/v1/token?grant_type=password',
      'GET',
      'net::ERR_ABORTED',
      ORIGIN,
    ),
    false,
  );
  assert.equal(
    isIgnorableProductionRequestFailure(
      'https://example.supabase.co/storage/v1/object/file.json',
      'GET',
      'net::ERR_ABORTED',
      ORIGIN,
    ),
    false,
  );
});
