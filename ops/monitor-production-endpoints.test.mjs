import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { healthPayloadErrors, parityErrors } from './monitor-production-endpoints.mjs';

const SHA = 'd308d8dd4d00ce0e1b99b90bbb09d46dcc1610bc';

function health(overrides = {}) {
  return {
    ok: true,
    route: '/api/health',
    deploySha: SHA,
    processDeploySha: SHA,
    deployMarkerSha: SHA,
    identityMatch: true,
    identityStatus: 'match',
    ...overrides,
  };
}

test('canonical production endpoint config keeps Dynu primary and DuckDNS fallback', async () => {
  const config = JSON.parse(await readFile(new URL('./production-endpoints.json', import.meta.url), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.mode, 'PRIMARY_WITH_MANUAL_FALLBACK');
  assert.equal(config.expectedIpv4, '158.247.235.32');
  assert.equal(config.primary.hostname, 'lsj119.ddnsfree.com');
  assert.equal(config.primary.baseUrl, 'https://lsj119.ddnsfree.com');
  assert.equal(config.fallback.hostname, 'lsj119.duckdns.org');
  assert.equal(config.fallback.baseUrl, 'https://lsj119.duckdns.org');
});

test('health contract accepts exact matching deployment identity', () => {
  assert.deepEqual(healthPayloadErrors(health()), []);
});

test('health contract fails closed on process or marker identity drift', () => {
  const other = 'a'.repeat(40);
  assert.deepEqual(
    healthPayloadErrors(health({ processDeploySha: other, deployMarkerSha: other })),
    ['PROCESS_DEPLOY_SHA_MISMATCH', 'DEPLOY_MARKER_SHA_MISMATCH'],
  );
});

test('health contract fails closed when server identity is not matched', () => {
  assert.deepEqual(
    healthPayloadErrors(health({ identityMatch: false, identityStatus: 'mismatch' })),
    ['IDENTITY_MATCH_FALSE', 'IDENTITY_STATUS_NOT_MATCH'],
  );
});

test('two healthy domains must expose the same deployed SHA', () => {
  const endpoint = { health: { deploySha: SHA } };
  assert.deepEqual(parityErrors(endpoint, endpoint), []);
  assert.match(parityErrors(endpoint, { health: { deploySha: 'b'.repeat(40) } })[0], /^DEPLOY_SHA_MISMATCH:/u);
});

test('missing health evidence cannot be interpreted as parity success', () => {
  assert.deepEqual(parityErrors({ health: { deploySha: SHA } }, { health: { deploySha: null } }), ['DEPLOY_SHA_PARITY_UNAVAILABLE']);
});
