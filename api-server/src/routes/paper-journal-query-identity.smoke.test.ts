import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { rejectPaperJournalQueryIdentity } from '../middleware/paper-journal-query-identity';

async function startServer() {
  const app = express();
  let downstreamCalls = 0;
  app.use('/api/paper-journal', rejectPaperJournalQueryIdentity);
  app.get('/api/paper-journal/snapshot', (_request, response) => {
    downstreamCalls += 1;
    return response.json({ ok: true });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    getDownstreamCalls: () => downstreamCalls,
  };
}

for (const queryKey of ['userId', 'user_id']) {
  test(`paper journal snapshot rejects client ${queryKey} before authentication or repository work`, async () => {
    const { server, baseUrl, getDownstreamCalls } = await startServer();
    try {
      const response = await fetch(
        `${baseUrl}/api/paper-journal/snapshot?${queryKey}=11111111-1111-1111-1111-111111111111`,
      );
      assert.equal(response.status, 400);
      assert.equal(getDownstreamCalls(), 0);
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

test('paper journal query identity guard is mounted before the authenticated API router', async () => {
  const appSource = await readFile(
    path.join(process.cwd(), 'api-server/src/app.ts'),
    'utf8',
  );
  const guardIndex = appSource.indexOf(
    "app.use('/api/paper-journal', rejectPaperJournalQueryIdentity);",
  );
  const authenticatedRouterIndex = appSource.indexOf('app.use("/api", router);');

  assert.notEqual(guardIndex, -1);
  assert.notEqual(authenticatedRouterIndex, -1);
  assert.ok(guardIndex < authenticatedRouterIndex);
});
