import assert from 'node:assert/strict';
import test from 'node:test';
import { createTossReadonlyTransport, TossTokenManager } from '../providers/toss-readonly.provider';

test('Toss OAuth token uses the canonical Open API origin and rejects redirect fallback', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
    seen.push({ url, init });
    return new Response(JSON.stringify({ access_token: 'FAKE_TOKEN', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const transport = createTossReadonlyTransport(fetchImpl);
  const manager = new TossTokenManager(transport, () => 1_000);

  assert.equal(
    await manager.token({ clientId: 'TOSS_CLIENT_TEST_ONLY', clientSecret: 'TOSS_SECRET_TEST_ONLY' }),
    'FAKE_TOKEN',
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://openapi.tossinvest.com/oauth2/token');
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.equal(seen[0]?.init?.redirect, 'error');
  assert.equal(seen[0]?.init?.cache, 'no-store');
  assert.equal(seen.some(({ url }) => url.startsWith('https://oauth2.tossinvest.com/')), false);
});
