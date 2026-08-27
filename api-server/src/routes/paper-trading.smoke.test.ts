// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createPaperTradingRouter } from './paper-trading';
import { createPaperTradingState } from '../services/paper-trading-engine.service';
import {
  PAPER_STATE_RUNTIME_BINDING_VERSION,
  publishAuthenticatedPaperTradingState,
} from '../services/paper-trading-state-publisher.service';
import { validateImmutablePaperTradingStateSnapshot } from '../services/paper-trading-state-snapshot.service';

const NOW = new Date('2026-08-02T02:30:00.000Z');
const DEPLOY_SHA = '0123456789abcdef0123456789abcdef01234567';
const PAPER_RUNTIME_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const PUBLISHER_ACCOUNT_ID = 'paper-publisher-account-fixture';
const PUBLISHER_ACCOUNT_ID_SHA256 = createHash('sha256').update(PUBLISHER_ACCOUNT_ID).digest('hex');

async function startServer(dependencies: Parameters<typeof createPaperTradingRouter>[0] = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((request, _response, next) => {
    (request as AuthenticatedRequest).member = { id: PUBLISHER_ACCOUNT_ID } as AuthenticatedRequest['member'];
    next();
  });
  app.use('/api', createPaperTradingRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function safeJson(response: Response) {
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(text, /(?:stack|api[_-]?key|secret|authorization|bearer|crypto-auto|place-order)/i);
  return JSON.parse(text);
}

const action = {
  type: 'mark_price',
  eventId: 'smoke-mark',
  symbol: 'BTCUSDT',
  price: 101,
  at: NOW.toISOString(),
};

test('paper evaluate returns simulation-only safety contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action, now: NOW.toISOString() }),
    });
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'paper-only');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(body.result.mode, 'paper-only');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('paper evaluate rejects malformed body with safe 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 400);
    const body = await safeJson(response);
    assert.equal(body.code, 'INVALID_PAPER_REQUEST');
    assert.equal(body.exchangeRequestSent, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('paper evaluate rejects invalid timestamp', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action, now: 'not-a-date' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await safeJson(response)).code, 'INVALID_TIMESTAMP');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('paper evaluate rejects oversized request before execution', async () => {
  let called = false;
  const { server, baseUrl } = await startServer({ evaluate: () => { called = true; throw new Error('unexpected'); } });
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action, padding: 'x'.repeat(140_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await safeJson(response)).code, 'REQUEST_TOO_LARGE');
    assert.equal(called, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('paper evaluate generalizes unexpected errors', async () => {
  const { server, baseUrl } = await startServer({ evaluate: () => { throw new Error('secret stack database detail'); } });
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action }),
    });
    assert.equal(response.status, 500);
    const body = await safeJson(response);
    assert.equal(body.code, 'PAPER_TRADING_EVALUATION_FAILED');
    assert.doesNotMatch(body.message, /secret|database|stack/i);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('authenticated exact-account publisher writes canonical snapshot-v2 atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-state-transport-v2-'));
  const snapshotPath = join(root, 'canonical-paper-state.json');
  const env = Object.freeze({
    PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: snapshotPath,
    PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: PUBLISHER_ACCOUNT_ID_SHA256,
    PAPER_FORWARD_PAPER_STATE_MAXIMUM_AGE_MS: '3900000',
  });
  const { server, baseUrl } = await startServer({
    publishState: (input) => publishAuthenticatedPaperTradingState(
      { ...input, sourceSha: DEPLOY_SHA },
      { env },
    ),
  });
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action, now: NOW.toISOString() }),
    });
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.paperStateTransport.status, 'PUBLISHED');
    assert.equal(body.paperStateTransport.invoked, true);
    assert.equal(body.paperStateTransport.callbackEligible, true);
    assert.equal(body.paperStateTransport.publisherAccountBound, true);
    assert.equal(body.paperStateTransport.unknownIsZero, false);

    const persisted = validateImmutablePaperTradingStateSnapshot(
      JSON.parse(await readFile(snapshotPath, 'utf8')),
      NOW.getTime(),
    );
    assert.equal(persisted.schemaVersion, 'paper-trading-state-snapshot-v2');
    assert.equal(persisted.market, 'CRYPTO_FUTURES');
    assert.equal(persisted.currency, 'USDT');
    assert.equal(persisted.sourceSha, DEPLOY_SHA);
    assert.equal(persisted.accountId, body.result.state.account.id);
    assert.match(persisted.publisherAccountIdSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(persisted.provenance, [
      'authenticated-member-session',
      'paper-trading-engine-result',
      'lossless-atomic-shared-path',
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('protected runtime binding publishes target Paper SHA without mutating application deploy identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-runtime-binding-v1-'));
  const bindingPath = join(root, 'publisher-binding.json');
  const snapshotPath = join(root, 'publisher', 'paper-state-v2.json');
  await writeFile(bindingPath, `${JSON.stringify({
    schemaVersion: PAPER_STATE_RUNTIME_BINDING_VERSION,
    paperRuntimeSourceSha: PAPER_RUNTIME_SHA,
    snapshotPath,
    publisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  }, null, 2)}\n`, { mode: 0o600 });

  const { server, baseUrl } = await startServer({
    publishState: (input) => publishAuthenticatedPaperTradingState(
      { ...input, sourceSha: DEPLOY_SHA },
      {
        env: Object.freeze({
          PAPER_FORWARD_STATE_ROOT: root,
          PAPER_FORWARD_PAPER_STATE_MAXIMUM_AGE_MS: '3900000',
        }),
      },
    ),
  });
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action, now: NOW.toISOString() }),
    });
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.paperStateTransport.status, 'PUBLISHED');
    const persisted = validateImmutablePaperTradingStateSnapshot(
      JSON.parse(await readFile(snapshotPath, 'utf8')),
      NOW.getTime(),
    );
    assert.equal(persisted.sourceSha, PAPER_RUNTIME_SHA);
    assert.notEqual(persisted.sourceSha, DEPLOY_SHA);
    assert.equal(persisted.publisherAccountIdSha256, PUBLISHER_ACCOUNT_ID_SHA256);
    assert.deepEqual(persisted.provenance, [
      'authenticated-member-session',
      'paper-trading-engine-result',
      'lossless-atomic-shared-path',
      'paper-runtime-source-binding',
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid protected runtime binding never falls back to legacy publisher configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-runtime-binding-invalid-'));
  const bindingPath = join(root, 'publisher-binding.json');
  const legacySnapshotPath = join(root, 'legacy-paper-state.json');
  await writeFile(bindingPath, `${JSON.stringify({
    schemaVersion: 'wrong-runtime-binding',
    paperRuntimeSourceSha: PAPER_RUNTIME_SHA,
    snapshotPath: join(root, 'publisher', 'paper-state-v2.json'),
    publisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  })}\n`, { mode: 0o600 });

  const result = await publishAuthenticatedPaperTradingState({
    state: createPaperTradingState(10_000, NOW),
    authenticatedPublisherAccountId: PUBLISHER_ACCOUNT_ID,
    sourceSha: DEPLOY_SHA,
    observedAtMs: NOW.getTime(),
  }, {
    env: Object.freeze({
      PAPER_FORWARD_STATE_ROOT: root,
      PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: legacySnapshotPath,
      PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: PUBLISHER_ACCOUNT_ID_SHA256,
      PAPER_FORWARD_PAPER_STATE_MAXIMUM_AGE_MS: '3900000',
    }),
  });

  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'PAPER_STATE_RUNTIME_BINDING_INVALID');
  await assert.rejects(readFile(legacySnapshotPath, 'utf8'), /ENOENT/u);
  await rm(root, { recursive: true, force: true });
});

test('publisher account mismatch stays BLOCKED_DATA and writes no snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-state-account-binding-'));
  const snapshotPath = join(root, 'canonical-paper-state.json');
  const { server, baseUrl } = await startServer({
    publishState: (input) => publishAuthenticatedPaperTradingState(
      { ...input, sourceSha: DEPLOY_SHA },
      {
        env: Object.freeze({
          PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: snapshotPath,
          PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: createHash('sha256')
            .update('different-account')
            .digest('hex'),
        }),
      },
    ),
  });
  try {
    const response = await fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action, now: NOW.toISOString() }),
    });
    const body = await safeJson(response);
    assert.equal(response.status, 200);
    assert.equal(body.paperStateTransport.status, 'BLOCKED_DATA');
    assert.equal(body.paperStateTransport.reason, 'PAPER_STATE_PUBLISHER_ACCOUNT_MISMATCH');
    assert.equal(body.paperStateTransport.invoked, false);
    await assert.rejects(readFile(snapshotPath, 'utf8'), /ENOENT/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('paper evaluate never performs an outbound exchange request', async () => {
  const nativeFetch = globalThis.fetch;
  let outboundCalls = 0;
  const { server, baseUrl } = await startServer();
  try {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) {
        outboundCalls += 1;
        throw new Error('outbound request blocked');
      }
      return nativeFetch(input, init);
    }) as typeof fetch;
    const response = await globalThis.fetch(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: createPaperTradingState(10_000, NOW), action }),
    });
    assert.equal(response.status, 200);
    assert.equal(outboundCalls, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
