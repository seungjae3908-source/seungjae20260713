import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import app from '../app';

async function startServer() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

for (const queryKey of ['userId', 'user_id']) {
  test(`paper journal snapshot rejects client ${queryKey} before authentication or repository work`, async () => {
    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(
        `${baseUrl}/api/paper-journal/snapshot?${queryKey}=11111111-1111-1111-1111-111111111111`,
      );
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.ok, false);
      assert.equal(body.mode, 'journal-sync-only');
      assert.equal(body.code, 'CLIENT_USER_ID_FORBIDDEN');
      assert.equal(body.orderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
      assert.doesNotMatch(JSON.stringify(body), /(?:token|cookie|authorization|email|stack|sql|connection)/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
