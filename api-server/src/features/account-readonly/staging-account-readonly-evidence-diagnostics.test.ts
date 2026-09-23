import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProviderEvidence, observeProviderRequest, type ProviderRequestObservation } from './staging-account-readonly-evidence-diagnostics';

test('provider failure is retained while every independent reader executes once', async () => {
  const calls: string[] = [];
  const results = await collectProviderEvidence(async (provider) => {
    calls.push(provider);
    if (provider === 'toss') throw new Error('secret-account-id and bearer-token');
    return { connected: true };
  });
  assert.deepEqual(calls, ['toss', 'upbit', 'bitget']);
  assert.deepEqual(results.map((row) => row.verdict), ['FAIL', 'PASS', 'PASS']);
  assert.equal(JSON.stringify(results).includes('secret-account-id'), false);
  assert.equal(results.every((row) => row.verdict === 'PASS'), false);
});

test('HTTP rejection records only provider, operation and status without consuming response', async () => {
  const observations: ProviderRequestObservation[] = [];
  const response = new Response('private-provider-body', { status: 401, headers: { authorization: 'secret' } });
  assert.equal(await observeProviderRequest(observations, 'toss', 'OAUTH_TOKEN', async () => response), response);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(observations, [{ provider: 'toss', operation: 'OAUTH_TOKEN', httpStatus: 401, transport: 'HTTP_RESPONSE' }]);
  assert.equal(JSON.stringify(observations).includes('private-provider-body'), false);
});

test('transport errors remain failures and never retain error messages or arbitrary codes', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('secret'), { name: 'AbortError' }), 'TIMEOUT'],
    [Object.assign(new Error('secret'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'TLS_ERROR'],
    [Object.assign(new Error('secret'), { code: 'secret-key' }), 'NETWORK_ERROR'],
  ] as const) {
    const observations: ProviderRequestObservation[] = [];
    await assert.rejects(observeProviderRequest(observations, 'upbit', 'READONLY_GET', async () => { throw error; }), error);
    assert.equal(observations[0]?.transport, expected);
    assert.equal(JSON.stringify(observations).includes('secret'), false);
  }
});
