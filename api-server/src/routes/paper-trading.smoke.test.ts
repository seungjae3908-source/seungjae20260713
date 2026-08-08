// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createPaperTradingRouter } from './paper-trading';
import { createPaperTradingState } from '../services/paper-trading-engine.service';

const NOW = new Date('2026-08-02T02:30:00.000Z');

async function startServer(evaluate?: any) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createPaperTradingRouter(evaluate ? { evaluate } : {}));
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
  const { server, baseUrl } = await startServer(() => { called = true; });
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
  const { server, baseUrl } = await startServer(() => { throw new Error('secret stack database detail'); });
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
