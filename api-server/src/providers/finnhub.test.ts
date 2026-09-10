import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogEntry } from '../data/catalog';
import { getQuote } from './finnhub';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalKey = process.env.FINNHUB_API_KEY;

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function entry(ticker: string): CatalogEntry {
  return {
    ticker,
    name: ticker,
    market: 'US',
    currency: 'USD',
    aliases: [],
  } as CatalogEntry;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  if (originalKey == null) delete process.env.FINNHUB_API_KEY;
  else process.env.FINNHUB_API_KEY = originalKey;
});

test('preserves Finnhub provider quote time instead of request wall clock', async () => {
  process.env.FINNHUB_API_KEY = 'ci-finnhub-key';
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  const providerTime = Math.floor(Date.parse('2026-09-10T09:42:17.000Z') / 1000);

  globalThis.fetch = async () => response({
    c: 250.5,
    d: 1.5,
    dp: 0.602,
    h: 252,
    l: 247,
    o: 248,
    pc: 249,
    t: providerTime,
  });

  const quote = await getQuote(entry('QATRUTH1'));
  assert.equal(quote.price, 250.5);
  assert.equal(quote.updatedAt, '2026-09-10T09:42:17.000Z');
  assert.notEqual(quote.updatedAt, new Date(Date.now()).toISOString());
});

test('fails closed when Finnhub omits quote timestamp evidence', async () => {
  process.env.FINNHUB_API_KEY = 'ci-finnhub-key';
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');

  globalThis.fetch = async () => response({
    c: 100,
    d: 0,
    dp: 0,
    h: 101,
    l: 99,
    o: 100,
    pc: 100,
  });

  await assert.rejects(
    getQuote(entry('QATRUTH2')),
    /invalid quote timestamp/,
  );
});

test('fails closed on materially future Finnhub quote timestamp', async () => {
  process.env.FINNHUB_API_KEY = 'ci-finnhub-key';
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  const futureTime = Math.floor(Date.parse('2026-09-10T10:10:01.000Z') / 1000);

  globalThis.fetch = async () => response({
    c: 100,
    d: 0,
    dp: 0,
    h: 101,
    l: 99,
    o: 100,
    pc: 100,
    t: futureTime,
  });

  await assert.rejects(
    getQuote(entry('QATRUTH3')),
    /invalid quote timestamp/,
  );
});
