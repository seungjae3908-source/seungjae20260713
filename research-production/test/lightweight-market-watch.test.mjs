import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  WATCH_CONTRACT, WATCH_LIMITS, WATCH_SAFETY, blockedSource,
  evaluateMarketOpportunities, evaluateWatchBudget,
  normalizeBitgetSnapshot, normalizeStockFeed, normalizeUpbitSnapshot,
  parseBoundedPublicJson, watchCycleDigest,
} from '../src/lightweight-market-watch.mjs';

const NOW = Date.parse('2026-10-09T04:00:00.000Z');
const GOOD_DISK = 37 * 1024 ** 3;
const GOOD_RAM = 2.3 * 1024 ** 3;

test('2-vCPU/4GB Vultr budget protects existing app under memory, CPU or disk pressure', () => {
  const normal = { cpuCount: 2, loadOne: 0.3,
    memoryAvailableBytes: GOOD_RAM, diskFreeBytes: GOOD_DISK };
  assert.equal(evaluateWatchBudget(normal).status, 'RUN');
  assert.equal(evaluateWatchBudget({ ...normal, loadOne: 1.8 }).status, 'THROTTLED');
  assert.equal(evaluateWatchBudget({
    ...normal, memoryAvailableBytes: 600 * 1024 ** 2,
  }).status, 'THROTTLED');
  assert.equal(evaluateWatchBudget({
    ...normal, memoryAvailableBytes: 400 * 1024 ** 2,
  }).status, 'HOLD');
  assert.equal(evaluateWatchBudget({ ...normal, diskFreeBytes: 3 * 1024 ** 3 }).status, 'HOLD');
  assert.equal(evaluateWatchBudget({ ...normal, memoryAvailableBytes: null }).status, 'HOLD');
});

test('Upbit public snapshot scans KRW tickers, excludes warning and stale quotes', () => {
  const markets = [
    { market: 'KRW-BTC', market_warning: 'NONE' },
    { market: 'KRW-ETH', market_warning: 'NONE' },
    { market: 'BTC-ETH', market_warning: 'NONE' },
    { market: 'KRW-BAD', market_warning: 'CAUTION' },
  ];
  const tickers = [
    { market: 'KRW-BTC', trade_price: 100, signed_change_rate: 0.05,
      acc_trade_price_24h: 1e10, timestamp: NOW - 2_000 },
    { market: 'KRW-ETH', trade_price: 200, signed_change_rate: -0.03,
      acc_trade_price_24h: 9e9, timestamp: NOW - 1_000 },
    { market: 'KRW-BAD', trade_price: 100, signed_change_rate: 0.1,
      acc_trade_price_24h: 9e9, timestamp: NOW - 1_000 },
  ];
  const data = normalizeUpbitSnapshot(markets, tickers, NOW);
  assert.equal(data.status, 'READY');
  assert.deepEqual(data.quotes.map((x) => x.symbol), ['BTC', 'ETH']);
  assert.equal(data.quotes[0].change24hPercent, 5);
  const stale = normalizeUpbitSnapshot(markets,
    tickers.map((x) => x.market === 'KRW-ETH'
      ? { ...x, timestamp: NOW - 500_000 } : x), NOW);
  assert.equal(stale.status, 'PARTIAL_TICKERS');
  assert.equal(stale.quotes.length, 1);
});

test('Bitget public aggregate does not manufacture a trade from ticker data', () => {
  const market = normalizeBitgetSnapshot({
    code: '00000',
    data: [
      { symbol: 'BTCUSDT', lastPr: '100', change24h: '0.04',
        usdtVolume: '22000000', ts: String(NOW - 1_000) },
      { symbol: 'ETHUSDT', lastPr: '1', change24h: '-0.1',
        usdtVolume: '0', ts: String(NOW - 1_000) },
    ],
  }, NOW);
  assert.equal(market.status, 'READY');
  assert.equal(market.quotes.length, 2);
  assert.equal(market.quotes[0].change24hPercent, 4);
  assert.equal(WATCH_SAFETY.orderAuthority, 'NONE');
  assert.equal(WATCH_SAFETY.paperAdmissionAllowed, false);
});

test('stock feeds require fresh explicit provenance and expose subset coverage', () => {
  const input = {
    schemaVersion: 'research-stock-public-snapshot-v1',
    market: 'KR_STOCK', source: 'licensed-public-snapshot',
    asOf: new Date(NOW - 2_000).toISOString(),
    completeUniverse: false,
    quotes: [{ symbol: '005930', price: 82000,
      turnover24h: 2e9, change24hPercent: 2.5,
      asOf: new Date(NOW - 3_000).toISOString() }],
  };
  const result = normalizeStockFeed(input, 'KR_STOCK', NOW);
  assert.equal(result.status, 'PARTIAL_UNIVERSE');
  assert.equal(result.quotes[0].symbol, '005930');
  assert.equal(result.quotes[0].sourceAtMs, NOW - 3_000);
  assert.throws(() => normalizeStockFeed({ ...input, quotes: [
    { ...input.quotes[0], asOf: undefined },
  ] }, 'KR_STOCK', NOW), /STOCK_PUBLIC_FEED_EMPTY/);
  assert.throws(() => normalizeStockFeed({ ...input, quotes: [
    { ...input.quotes[0], asOf: new Date(NOW - 500_000).toISOString() },
  ] }, 'KR_STOCK', NOW), /STOCK_PUBLIC_FEED_EMPTY/);
  assert.throws(() => normalizeStockFeed({ ...input, quotes: [
    { ...input.quotes[0], asOf: new Date(NOW + 20_000).toISOString() },
  ] }, 'KR_STOCK', NOW), /STOCK_PUBLIC_FEED_EMPTY/);
  assert.throws(() => normalizeStockFeed(
    { ...input, asOf: new Date(NOW - 500_000).toISOString() },
    'KR_STOCK', NOW), /STALE/);
  assert.throws(() => normalizeStockFeed(
    { ...input, source: 'my_secret=ABC' }, 'KR_STOCK', NOW), /INVALID/);
  assert.equal(blockedSource('US_STOCK', 'BLOCKED_PUBLIC_STOCK_FEED_MISSING').quotes.length, 0);
});

test('cold start never forges opportunity or historical price comparison', () => {
  const source = normalizeBitgetSnapshot({
    code: '00000', data: [{ symbol: 'BTCUSDT', lastPr: '105',
      change24h: '0.06', usdtVolume: '12000000', ts: NOW }],
  }, NOW);
  const r = evaluateMarketOpportunities({ market: 'CRYPTO_FUTURES',
    source, previous: null, lastAlerts: {}, nowMs: NOW });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.summary.previousSnapshotComparable, false);
});

test('fresh two-snapshot price acceleration generates only provisional research observations', () => {
  const source = normalizeBitgetSnapshot({
    code: '00000', data: [{ symbol: 'BTCUSDT', lastPr: '101',
      change24h: '0.03', usdtVolume: '12000000', ts: NOW - 1_000 }],
  }, NOW);
  const previous = { observedAtMs: NOW - 120_000,
    source: 'BITGET_PUBLIC_TICKERS',
    quotes: [{ symbol: 'BTCUSDT', price: 100, sourceAtMs: NOW - 121_000 }] };
  const r = evaluateMarketOpportunities({ market: 'CRYPTO_FUTURES',
    source, previous, lastAlerts: {}, nowMs: NOW });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].direction, 'UP');
  assert.equal(r.candidates[0].kind, 'PROVISIONAL_PRICE_ACCELERATION');
  assert.equal(r.candidates[0].executionAuthority, 'NONE');
  assert.equal(r.candidates[0].isTradingSignal, false);
  assert.equal(r.candidates[0].oosPassed, false);
  assert.equal(r.candidates[0].paperAdmitted, false);
  assert.equal(r.candidates[0].aiReviewed, false);
  const repeated = evaluateMarketOpportunities({ market: 'CRYPTO_FUTURES',
    source, previous, lastAlerts: { 'CRYPTO_FUTURES:BTCUSDT:UP': NOW - 30_000 },
    nowMs: NOW });
  assert.equal(repeated.candidates.length, 0);
});

test('KR/US/spot falling price is a watch observation, never a short sell instruction', () => {
  const source = {
    market: 'CRYPTO_SPOT', status: 'READY', source: 'PUBLIC_TEST',
    listedCount: 1, quotes: [{ symbol: 'BTC', price: 98,
      sourceAtMs: NOW - 1_000, turnover24h: 2e9, change24hPercent: -2 }],
  };
  const r = evaluateMarketOpportunities({
    market: 'CRYPTO_SPOT', source, nowMs: NOW, lastAlerts: {},
    previous: { observedAtMs: NOW - 60_000,
      source: 'PUBLIC_TEST',
      quotes: [{ symbol: 'BTC', price: 100, sourceAtMs: NOW - 61_000 }] },
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].direction, 'DOWN');
  assert.equal(r.candidates[0].isTradingSignal, false);
  assert.equal(r.candidates[0].executionAuthority, 'NONE');
});

test('same-timestamp and expired snapshots cannot create fake accelerations', () => {
  const source = { market: 'KR_STOCK', status: 'PARTIAL_UNIVERSE',
    source: 'PUBLIC_TEST', listedCount: 1,
    quotes: [{ symbol: '005930', price: 110,
      sourceAtMs: NOW - 1_000, turnover24h: 2e9, change24hPercent: 10 }] };
  const old = { quotes: [{ symbol: '005930', price: 100,
    sourceAtMs: NOW - 1_000 }], observedAtMs: NOW - 60_000,
    source: 'PUBLIC_TEST' };
  assert.equal(evaluateMarketOpportunities({ market: 'KR_STOCK',
    source, previous: old, nowMs: NOW }).candidates.length, 0);
  assert.equal(evaluateMarketOpportunities({ market: 'KR_STOCK',
    source, previous: { ...old, observedAtMs: NOW - 600_000 },
    nowMs: NOW }).candidates.length, 0);
});


test('switching stock data providers cannot fabricate a two-snapshot price move', () => {
  const source = { market: 'US_STOCK', status: 'PARTIAL_UNIVERSE',
    source: 'PROVIDER_B', listedCount: 1,
    quotes: [{ symbol: 'MSFT', price: 104,
      sourceAtMs: NOW - 1_000, turnover24h: 5e6, change24hPercent: 4 }] };
  const previous = { source: 'PROVIDER_A', observedAtMs: NOW - 60_000,
    quotes: [{ symbol: 'MSFT', price: 100, sourceAtMs: NOW - 61_000 }] };
  assert.equal(evaluateMarketOpportunities({
    market: 'US_STOCK', source, previous, nowMs: NOW,
  }).candidates.length, 0);
  const report = evaluateMarketOpportunities({
    market: 'US_STOCK', source, previous: { ...previous, source: 'PROVIDER_B' },
    nowMs: NOW,
  });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].sourceAtMs, NOW - 1_000);
  assert.equal(report.candidates[0].priorSourceAtMs, NOW - 61_000);
  assert.equal(report.candidates[0].isTradingSignal, false);
});

test('stale prior stock quote and tampered old source time are blocked', () => {
  const source = { market: 'KR_STOCK', status: 'READY',
    source: 'PUBLIC_B', listedCount: 1,
    quotes: [{ symbol: '005930', price: 106,
      sourceAtMs: NOW - 1_000, turnover24h: 2e9, change24hPercent: 6 }] };
  const previous = { source: 'PUBLIC_B', observedAtMs: NOW - 60_000,
    quotes: [{ symbol: '005930', price: 100, sourceAtMs: NOW - 450_000 }] };
  assert.equal(evaluateMarketOpportunities({ market: 'KR_STOCK',
    source, previous, nowMs: NOW }).candidates.length, 0);
  assert.equal(evaluateMarketOpportunities({ market: 'KR_STOCK',
    source, previous: { ...previous,
      quotes: [{ symbol: '005930', price: 100, sourceAtMs: NOW - 50_000 }] },
    nowMs: NOW }).candidates.length, 0);
});

test('digest is deterministic, never used as profit or authorization proof', () => {
  assert.equal(watchCycleDigest({ a: 1 }), watchCycleDigest({ a: 1 }));
  assert.notEqual(watchCycleDigest({ a: 1 }), watchCycleDigest({ a: 2 }));
  assert.equal(WATCH_CONTRACT, 'lightweight-market-opportunity-watch-v1');
  assert.equal(WATCH_LIMITS.maxCandidatesPerMarket, 12);
});

test('new systemd service is rate-limited, isolated and never enabled by this code', async () => {
  const unit = await readFile(new URL('../deploy/research-production-market-watch.service', import.meta.url), 'utf8');
  assert.match(unit, /CPUQuota=40%/);
  assert.match(unit, /ExecStart=\/usr\/bin\/env node --max-old-space-size=192/);
  assert.match(unit, /MemoryMax=512M/);
  assert.match(unit, /MemoryHigh=384M/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/investment-research-production/);
  assert.doesNotMatch(unit, /ExecStart=.*(trade-automation|order|broker)/i);
});




test('incomplete Bitget tickers cannot be labeled full-universe READY', () => {
  const snapshot = normalizeBitgetSnapshot({
    code: '00000',
    data: [
      { symbol: 'BTCUSDT', lastPr: '100', change24h: '0.02',
        usdtVolume: '10000000', ts: String(NOW - 1_000) },
      { symbol: 'ETHUSDT', lastPr: 'not-a-number', change24h: '0.01',
        usdtVolume: '11000000', ts: String(NOW - 1_000) },
    ],
  }, NOW);
  assert.equal(snapshot.status, 'PARTIAL_TICKERS');
  assert.equal(snapshot.listedCount, 2);
  assert.equal(snapshot.quotes.length, 1);
});

test('stock full-universe claims require unique current quotes and no cap truncation', () => {
  const base = { schemaVersion: 'research-stock-public-snapshot-v1',
    market: 'US_STOCK', source: 'verified-feed-v1',
    asOf: new Date(NOW - 1_000).toISOString(), completeUniverse: true };
  const q = { symbol: 'MSFT', price: 300, turnover24h: 3e6,
    change24hPercent: 1, asOf: new Date(NOW - 1_000).toISOString() };
  const complete = normalizeStockFeed({
    ...base, quotes: [q],
  }, 'US_STOCK', NOW);
  assert.equal(complete.status, 'READY');
  const duplicate = normalizeStockFeed({
    ...base, quotes: [q, q],
  }, 'US_STOCK', NOW);
  assert.equal(duplicate.status, 'PARTIAL_UNIVERSE');
  const capped = normalizeStockFeed({
    ...base, quotes: Array.from({ length: WATCH_LIMITS.maxSymbolsPerMarket + 1 },
      (_, i) => ({ ...q, symbol: 'S' + i })),
  }, 'US_STOCK', NOW);
  assert.equal(capped.status, 'PARTIAL_UNIVERSE');
  assert.equal(capped.quotes.length, WATCH_LIMITS.maxSymbolsPerMarket);
});

test('bounded public JSON parser refuses status errors, oversized and malformed payloads', async () => {
  assert.deepEqual(await parseBoundedPublicJson(new Response('{"a":1}')),
    { a: 1 });
  await assert.rejects(parseBoundedPublicJson(new Response('{}', { status: 429 })),
    /PUBLIC_HTTP_429/);
  await assert.rejects(parseBoundedPublicJson(new Response('{}', {
    headers: { 'content-length': '5000000' },
  })), /PUBLIC_RESPONSE_OVERSIZE/);
  await assert.rejects(parseBoundedPublicJson(new Response('{bad')), /PUBLIC_RESPONSE_JSON_INVALID/);
  await assert.rejects(parseBoundedPublicJson(new Response(null)), /PUBLIC_RESPONSE_BODY_MISSING/);
  await assert.rejects(parseBoundedPublicJson(new Response('{}'), 4000001),
    /PUBLIC_RESPONSE_LIMIT_INVALID/);
});

test('oversized chunked payload fails before accumulating beyond 4MB', async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2_500_000));
      controller.enqueue(new Uint8Array(2_500_000));
      controller.close();
    },
  }));
  await assert.rejects(parseBoundedPublicJson(response),
    /PUBLIC_RESPONSE_OVERSIZE/);
});

test('systemd unit passes real syntax verification in Linux CI', {
  skip: process.platform !== 'linux',
}, () => {
  const path = new URL('../deploy/research-production-market-watch.service', import.meta.url).pathname;
  const result = spawnSync('systemd-analyze', ['verify', path], { encoding: 'utf8' });
  assert.equal(result.status, 0,
    'systemd unit verify failed: ' + String(result.stderr || result.error || result.stdout));
});
