import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  WATCH_CONTRACT, WATCH_LIMITS, WATCH_SAFETY,
  WATCH_CAPPED_AUDIT_CONTRACT, WATCH_CAPPED_AUDIT_LIMITS, blockedSource,
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
  assert.equal(market.status, 'PARTIAL_TICKERS'); // no independent contract roster
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
  // The producer and all readbacks must share one allowlisted source-ID
  // alphabet. A dotted vendor name or reserved NONE would otherwise write
  // a healthy watch cycle that the admin UI later labels INVALID.
  for (const invalidSource of ['KRX.V1', 'NONE', '../secret', 'PROVIDER=TOKEN']) {
    assert.throws(() => normalizeStockFeed(
      { ...input, source: invalidSource }, 'KR_STOCK', NOW),
    /STOCK_PUBLIC_FEED_INVALID/, invalidSource);
  }
  const validSource = normalizeStockFeed(
    { ...input, source: 'KRX_PUBLIC_V1' }, 'KR_STOCK', NOW);
  assert.equal(validSource.source, 'KRX_PUBLIC_V1');
  assert.equal(validSource.status, 'PARTIAL_UNIVERSE');
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




test('Bitget public USDT futures contract roster exposes truncated ticker results', () => {
  const c = (symbol, symbolStatus = 'normal') =>
    ({ symbol, quoteCoin: 'USDT', symbolStatus });
  const q = symbol => ({ symbol, lastPr: '100', usdtVolume: '22000000',
    change24h: '0.02', ts: String(NOW - 1000) });
  const contracts = { code: '00000', data: [
    c('BTCUSDT'), c('ETHUSDT'), c('OFFUSDT', 'off'),
  ] };
  const valid = normalizeBitgetSnapshot({ code: '00000',
    data: [q('BTCUSDT'), q('ETHUSDT')] }, NOW, contracts);
  assert.equal(valid.status, 'READY');
  assert.equal(valid.listedCount, 2);
  assert.equal(valid.quotes.length, 2);
  const missing = normalizeBitgetSnapshot({ code: '00000',
    data: [q('BTCUSDT')] }, NOW, contracts);
  assert.equal(missing.status, 'PARTIAL_TICKERS');
  assert.equal(missing.listedCount, 2);
  assert.equal(missing.quotes.length, 1);
  const extra = normalizeBitgetSnapshot({ code: '00000',
    data: [q('BTCUSDT'), q('ETHUSDT'), q('OFFUSDT')] }, NOW, contracts);
  assert.equal(extra.status, 'PARTIAL_TICKERS');
  assert.equal(extra.quotes.length, 2);
  const stale = normalizeBitgetSnapshot({ code: '00000',
    data: [q('BTCUSDT'), { ...q('ETHUSDT'), ts: String(NOW - 400000) }],
  }, NOW, contracts);
  assert.equal(stale.status, 'PARTIAL_TICKERS');
  assert.equal(stale.quotes.length, 1);
  const restricted = normalizeBitgetSnapshot({ code: '00000',
    data: [q('BTCUSDT'), q('ETHUSDT')] }, NOW,
  { code: '00000', data: [c('BTCUSDT'), c('ETHUSDT', 'limit_open')] });
  assert.equal(restricted.status, 'READY'); // coverage only, never order authority
  assert.equal(restricted.quotes.length, 2);
});
test('Bitget malformed contract rosters refuse fake readiness', () => {
  const q = { symbol: 'BTCUSDT', lastPr: '100', change24h: '0.02',
    usdtVolume: '22000000', ts: String(NOW - 1000) };
  const c = { symbol: 'BTCUSDT', quoteCoin: 'USDT', symbolStatus: 'normal' };
  for (const bad of [
    { code: '99999', data: [c] }, { code: '00000', data: [] },
    { code: '00000', data: [c, c] },
    { code: '00000', data: [{ ...c, symbolStatus: 'UNKNOWN' }] },
    { code: '00000', data: [{ ...c, quoteCoin: 'BTC' }] },
    { code: '00000', data: [{ ...c, symbolStatus: 'off' }] },
  ]) assert.throws(() => normalizeBitgetSnapshot({
    code: '00000', data: [q],
  }, NOW, bad), /BITGET_CONTRACT_ROSTER_(INVALID|EMPTY)/);
  assert.equal(normalizeBitgetSnapshot({ code: '00000', data: [q] }, NOW).status,
    'PARTIAL_TICKERS');
});
test('conflicting same-timestamp symbol prices cannot become provisional evidence', () => {
  const q = { symbol: 'BTCUSDT', lastPr: '100', change24h: '0.02',
    usdtVolume: '22000000', ts: String(NOW - 1000) };
  assert.throws(() => normalizeBitgetSnapshot({
    code: '00000', data: [q, { ...q, lastPr: '110' }],
  }, NOW), /WATCH_SOURCE_DUPLICATE_PRICE_CONFLICT/);
  const asOf = new Date(NOW - 1000).toISOString();
  const stock = { schemaVersion: 'research-stock-public-snapshot-v1',
    source: 'SAFE_SOURCE', market: 'KR_STOCK', asOf, completeUniverse: false };
  const row = { symbol: '005930', price: 100, turnover24h: 2e9,
    change24hPercent: 1, asOf };
  assert.throws(() => normalizeStockFeed({ ...stock,
    quotes: [row, { ...row, price: 110 }],
  }, 'KR_STOCK', NOW), /WATCH_SOURCE_DUPLICATE_PRICE_CONFLICT/);
  assert.equal(normalizeStockFeed({ ...stock, quotes: [row, { ...row }] },
    'KR_STOCK', NOW).status, 'PARTIAL_UNIVERSE');
});
test('worker queries only public contracts plus public all-tickers', async () => {
  const file = await readFile(new URL('../bin/lightweight-market-watch.mjs', import.meta.url), 'utf8');
  assert.match(file, /\/api\/v2\/mix\/market\/contracts\?productType=USDT-FUTURES/);
  assert.match(file, /\/api\/v2\/mix\/market\/tickers\?productType=USDT-FUTURES/);
  assert.match(file, /normalizeBitgetSnapshot\(payload, Date\.now\(\), contracts\)/);
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

test('self-declared stock full-universe cannot become READY without independent verification', () => {
  const base = { schemaVersion: 'research-stock-public-snapshot-v1',
    market: 'US_STOCK', source: 'verified-feed-v1',
    asOf: new Date(NOW - 1_000).toISOString(), completeUniverse: true };
  const q = { symbol: 'MSFT', price: 300, turnover24h: 3e6,
    change24hPercent: 1, asOf: new Date(NOW - 1_000).toISOString() };
  const complete = normalizeStockFeed({
    ...base, quotes: [q],
  }, 'US_STOCK', NOW);
  assert.equal(complete.status, 'PARTIAL_UNIVERSE');
  assert.equal(complete.listedCount, 1);
  assert.equal(complete.quotes.length, 1);
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

test('KR/US stock identifiers cannot be cross-labeled to fabricate another market', () => {
  const base = {
    schemaVersion: 'research-stock-public-snapshot-v1',
    source: 'PUBLIC_TEST_V1',
    asOf: new Date(NOW - 1_000).toISOString(),
    completeUniverse: false,
  };
  const q = {
    price: 300, turnover24h: 3e9, change24hPercent: 1.5,
    asOf: new Date(NOW - 1_000).toISOString(),
  };
  assert.equal(normalizeStockFeed({
    ...base, market: 'KR_STOCK', quotes: [{ ...q, symbol: '005930' }],
  }, 'KR_STOCK', NOW).quotes[0].symbol, '005930');
  assert.equal(normalizeStockFeed({
    ...base, market: 'US_STOCK', quotes: [{ ...q, symbol: 'BRK.B' }],
  }, 'US_STOCK', NOW).quotes[0].symbol, 'BRK.B');
  for (const [market, invalidSymbol] of [
    ['KR_STOCK', 'AAPL'], ['US_STOCK', '005930'], ['KR_STOCK', 'BRK.B'],
  ]) {
    assert.throws(() => normalizeStockFeed({
      ...base, market, quotes: [{ ...q, symbol: invalidSymbol }],
    }, market, NOW), /STOCK_PUBLIC_FEED_EMPTY/, market + ':' + invalidSymbol);
  }
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


test('8,001 Bitget quotes remain PARTIAL under overlapping bounded cohorts', () => {
  const count = WATCH_LIMITS.maxSymbolsPerMarket + 1;
  const data = Array.from({ length: count }, (_, i) => ({
    symbol: 'S' + String(i).padStart(5, '0') + 'USDT',
    lastPr: '100', change24h: '0.015', usdtVolume: '10000000',
    ts: String(NOW - 1_000),
  }));
  const source = normalizeBitgetSnapshot({ code: '00000', data }, NOW);
  assert.equal(source.listedCount, count);
  assert.equal(source.quotes.length, WATCH_LIMITS.maxSymbolsPerMarket);
  assert.equal(source.sourceCappedCount, 1);
  assert.equal(source.status, 'PARTIAL_TICKERS');
  assert.equal(new Set(source.quotes.map(q => q.symbol)).size, 8000);
  assert.ok(source.quotes.some(q => q.symbol === 'S00000USDT'));
  assert.ok(source.quotes.some(q => q.symbol === 'S05999USDT'));
  assert.equal(WATCH_SAFETY.orderAuthority, 'NONE');
});

test('stock 8k cap counts distinct valid symbols not examined, never missed trades', () => {
  const q = { price: 100, turnover24h: 9000000, change24hPercent: 1,
    asOf: new Date(NOW - 1000).toISOString() };
  const source = normalizeStockFeed({
    schemaVersion: 'research-stock-public-snapshot-v1', market: 'US_STOCK',
    source: 'US_SOURCE_V1', completeUniverse: true,
    asOf: new Date(NOW - 1000).toISOString(),
    quotes: Array.from({ length: WATCH_LIMITS.maxSymbolsPerMarket + 1 },
      (_, i) => ({ ...q, symbol: 'S' + i })),
  }, 'US_STOCK', NOW);
  assert.equal(source.status, 'PARTIAL_UNIVERSE');
  assert.equal(source.sourceCappedCount, 1);
  assert.equal(source.quotes.length, 8000);
  assert.equal(source.listedCount, 8001);
});


test('rotating tail observes formerly permanently excluded market names without raising the 8k cap', () => {
  const start = Date.parse('2026-10-10T06:00:00.000Z');
  const count = 9_000, symbolOf = i => 'S' + String(i).padStart(5, '0');
  function stockAt(nowMs, raise = null) {
    const timestamp = new Date(nowMs - 1_000).toISOString();
    return normalizeStockFeed({
      schemaVersion: 'research-stock-public-snapshot-v1',
      market: 'US_STOCK', source: 'LICENSED_SOURCE_FORMAT_ONLY',
      completeUniverse: true, asOf: timestamp,
      quotes: Array.from({ length: count }, (_, i) => ({
        symbol: symbolOf(i), price: symbolOf(i) === raise ? 101 : 100,
        turnover24h: 20_000_000_000 - i,
        change24hPercent: symbolOf(i) === raise ? 1 : 0,
        asOf: timestamp,
      })),
    }, 'US_STOCK', nowMs);
  }
  const at1 = stockAt(start + 60_000);
  const at2 = stockAt(start + 2 * 60_000);
  const at31 = stockAt(start + 31 * 60_000);
  const at61 = stockAt(start + 61 * 60_000);
  const names = x => new Set(x.quotes.map(q => q.symbol));
  const n1 = names(at1), n2 = names(at2), n31 = names(at31), n61 = names(at61);
  assert.deepEqual([...n1], [...n2]); // 2-minute cadence keeps its baseline
  assert.equal(at1.quotes.length, WATCH_LIMITS.maxSymbolsPerMarket);
  assert.equal(at31.quotes.length, WATCH_LIMITS.maxSymbolsPerMarket);
  assert.equal(at61.quotes.length, WATCH_LIMITS.maxSymbolsPerMarket);
  for (const at of [at1, at2, at31, at61]) {
    assert.equal(at.status, 'PARTIAL_UNIVERSE');
    assert.equal(at.sourceCappedCount, 1_000);
    assert.equal(at.listedCount, count);
  }
  const acrossWindows = new Set([...n1, ...n31, ...n61]);
  assert.equal(acrossWindows.size, count,
    'three 30-minute windows must cover all 9k supplied, not just top-turnover 8k');
  for (let i = 0; i < WATCH_LIMITS.stableHighTurnoverSymbols; i++)
    assert.ok(n1.has(symbolOf(i)) && n31.has(symbolOf(i)) && n61.has(symbolOf(i)));
  const newTail = [...n31].find(s => !n1.has(s));
  assert.ok(newTail);
  const at29 = stockAt(start + 29 * 60_000);
  const previous = {
    observedAtMs: start + 29 * 60_000,
    source: at29.source,
    quotes: at29.quotes.map(q => ({symbol:q.symbol, price:q.price,
      sourceAtMs:q.sourceAtMs})),
  };
  const premature = evaluateMarketOpportunities({
    market:'US_STOCK', source:stockAt(start + 31 * 60_000, newTail),
    previous, nowMs:start + 31 * 60_000, lastAlerts:{},
  });
  assert.equal(premature.candidates.some(q => q.symbol === newTail), false,
    'a newly included name has no authentic previous price baseline');
  const followUp = evaluateMarketOpportunities({
    market:'US_STOCK', source:stockAt(start + 33 * 60_000, newTail),
    previous:{
      observedAtMs:start + 31 * 60_000,
      source:at31.source,
      quotes:at31.quotes.map(q => ({symbol:q.symbol, price:q.price,
        sourceAtMs:q.sourceAtMs})),
    },
    nowMs:start + 33 * 60_000, lastAlerts:{},
  });
  assert.equal(followUp.candidates.filter(q => q.symbol === newTail).length,1);
  assert.equal(followUp.candidates[0].isTradingSignal,false);
  assert.equal(followUp.summary.sourceCappedCount,1_000);
  assert.equal(followUp.summary.candidateCappedCount,0);
  assert.equal(followUp.candidates[0].executionAuthority,'NONE');
});

test('rotating tail stays bounded for maximum 30k current source and never fabricates full coverage', () => {
  const now=Date.parse('2026-10-10T06:01:00.000Z');
  const count=30_000;
  const base={schemaVersion:'research-stock-public-snapshot-v1',
    market:'US_STOCK',source:'FORMAT_ONLY_SOURCE',
    completeUniverse:true,asOf:new Date(now-1_000).toISOString()};
  const quotes=Array.from({length:count},(_,i)=>({
    symbol:'S'+i,price:100,turnover24h:40_000_000_000-i,
    change24hPercent:0,asOf:base.asOf,
  }));
  const result=normalizeStockFeed({...base,quotes},'US_STOCK',now);
  assert.equal(result.quotes.length,8_000);
  assert.equal(new Set(result.quotes.map(r=>r.symbol)).size,8_000);
  assert.equal(result.sourceCappedCount,22_000);
  assert.equal(result.status,'PARTIAL_UNIVERSE');
  assert.equal(result.listedCount,30_000);
  assert.equal(WATCH_LIMITS.stableHighTurnoverSymbols
    + WATCH_LIMITS.rotationCohortSymbols*2,WATCH_LIMITS.maxSymbolsPerMarket);
  assert.equal(WATCH_LIMITS.maxCandidatesPerMarket,12);
});

test('13 qualified provisional observations emit only 12 but account for one capped candidate', () => {
  const quotes = Array.from({ length: 13 }, (_, i) => ({
    symbol: 'US' + i, price: 101, sourceAtMs: NOW - 1000,
    turnover24h: 5000000, change24hPercent: 1,
  }));
  const source = {
    market: 'US_STOCK', status: 'PARTIAL_UNIVERSE', source: 'PUBLIC_V1',
    listedCount: quotes.length, quotes, sourceCappedCount: 0,
  };
  const previous = {
    observedAtMs: NOW - 120000, source: 'PUBLIC_V1',
    quotes: quotes.map(q => ({
      symbol: q.symbol, price: 100, sourceAtMs: NOW - 121000,
    })),
  };
  const result = evaluateMarketOpportunities({
    market: 'US_STOCK', source, previous, nowMs: NOW, lastAlerts: {},
  });
  assert.equal(result.summary.qualifyingCandidateCount, 13);
  assert.equal(result.summary.newCandidates, 12);
  assert.equal(result.summary.candidateCappedCount, 1);
  assert.equal(result.cappedAudit.contract, WATCH_CAPPED_AUDIT_CONTRACT);
  assert.equal(result.cappedAudit.cappedCandidateCount, 1);
  assert.equal(result.cappedAudit.detailedCandidateCount, 1);
  assert.equal(result.cappedAudit.undetailedCandidateCount, 0);
  assert.equal(result.cappedAudit.executionAuthority, 'NONE');
  assert.equal(result.cappedAudit.isTradingSignal, false);
  assert.equal(result.candidates.length, WATCH_LIMITS.maxCandidatesPerMarket);
  assert.ok(result.candidates.every(x => x.executionAuthority === 'NONE'
    && x.isTradingSignal === false && x.paperAdmitted === false));
  const lastAlerts = Object.fromEntries(quotes.map(q => [
    'US_STOCK:' + q.symbol + ':UP', NOW - 30000,
  ]));
  const suppressed = evaluateMarketOpportunities({
    market: 'US_STOCK', source, previous, nowMs: NOW, lastAlerts,
  });
  assert.equal(suppressed.summary.qualifyingCandidateCount, 0);
  assert.equal(suppressed.summary.candidateCappedCount, 0);
  assert.equal(suppressed.cappedAudit, null);
});

test('80 eligible observations preserve bounded private capped details and truthful unmatched count', () => {
  const quotes = Array.from({ length: 80 }, (_, i) => ({
    symbol: 'US' + i, price: 101, sourceAtMs: NOW - 1_000,
    turnover24h: 5_000_000, change24hPercent: 1,
  }));
  const source = { market: 'US_STOCK', status: 'PARTIAL_UNIVERSE',
    source: 'PUBLIC_FORMAT_ONLY', listedCount: 80, quotes,
    sourceCappedCount: 0 };
  const previous = { observedAtMs: NOW - 120_000, source: source.source,
    quotes: quotes.map(q => ({
      symbol: q.symbol, price: 100, sourceAtMs: NOW - 121_000,
    })) };
  const input = {market: source.market, source, previous,
    nowMs: NOW, lastAlerts: {}};
  const result = evaluateMarketOpportunities(input);
  assert.equal(result.candidates.length, 12);
  assert.equal(result.summary.qualifyingCandidateCount, 80);
  assert.equal(result.summary.candidateCappedCount, 68);
  const audit = result.cappedAudit;
  assert.equal(audit.contract, WATCH_CAPPED_AUDIT_CONTRACT);
  assert.equal(audit.kind, 'CAPPED_RESEARCH_OBSERVATION_ONLY');
  assert.equal(audit.emittedCandidateCount, 12);
  assert.equal(audit.cappedCandidateCount, 68);
  assert.equal(audit.detailedCandidateCount, 32);
  assert.equal(audit.undetailedCandidateCount, 36);
  assert.equal(audit.details.length,
    WATCH_CAPPED_AUDIT_LIMITS.maxDetailedCandidatesPerMarketCycle);
  assert.ok(audit.details.every(x => typeof x.symbol === 'string'
    && Number.isFinite(x.sourceAtMs)
    && Number.isFinite(x.priorSourceAtMs)
    && x.sourceAtMs > x.priorSourceAtMs));
  assert.equal(audit.isTradingSignal, false);
  assert.equal(audit.paperAdmitted, false);
  assert.equal(audit.oosPassed, false);
  assert.equal(audit.profitabilityProven, false);
  assert.equal(audit.executionAuthority, 'NONE');
  assert.match(audit.cappedIdentityDigest, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(audit), 'utf8') < 16 * 1024);
  assert.equal(evaluateMarketOpportunities(input).cappedAudit.cappedIdentityDigest,
    audit.cappedIdentityDigest);
  const changed = { ...source, quotes: quotes.map(q =>
    q.symbol === 'US79' ? {...q, price: 103} : q) };
  assert.notEqual(evaluateMarketOpportunities({...input, source: changed})
    .cappedAudit.cappedIdentityDigest, audit.cappedIdentityDigest);
  const alerts = Object.fromEntries(quotes.map(q => [
    'US_STOCK:' + q.symbol + ':UP', NOW - 1_000,
  ]));
  assert.equal(evaluateMarketOpportunities({...input, lastAlerts: alerts})
    .cappedAudit, null);
});

test('8000 qualified rows never expand the capped research JSONL row or admitted event limit', () => {
  const quotes = Array.from({length:8_000},(_,i)=>({
    symbol:'SY'+i, price:102, sourceAtMs:NOW-1_000,
    turnover24h:1e9, change24hPercent:2,
  }));
  const source = { market:'US_STOCK', status:'PARTIAL_UNIVERSE',
    source:'PUBLIC_DATA', listedCount:quotes.length, quotes };
  const previous = { observedAtMs:NOW-120_000, source:source.source,
    quotes:quotes.map(q=>({symbol:q.symbol,price:100,
      sourceAtMs:NOW-121_000})) };
  const result = evaluateMarketOpportunities({
    market:'US_STOCK',source,previous,nowMs:NOW,lastAlerts:{},
  });
  assert.equal(result.candidates.length,12);
  assert.equal(result.summary.qualifyingCandidateCount,8_000);
  assert.equal(result.cappedAudit.cappedCandidateCount,7_988);
  assert.equal(result.cappedAudit.detailedCandidateCount,32);
  assert.equal(result.cappedAudit.undetailedCandidateCount,7_956);
  assert.ok(Buffer.byteLength(JSON.stringify(result.cappedAudit),'utf8') < 16 * 1024);
  assert.equal(result.cappedAudit.executionAuthority,'NONE');
});

test('market-watch worker persists private capped evidence before publishing ordinary events', async () => {
  const script = await readFile(
    new URL('../bin/lightweight-market-watch.mjs', import.meta.url), 'utf8');
  const capped = "appendBoundedWatchEvents(root, cappedCandidateAudits, state.observedAt, 'capped')";
  const events = 'appendBoundedWatchEvents(root, allCandidates, state.observedAt';
  const cursor = "atomicDurableWatchJson(join(root, 'watch', 'state-v1.json'), next)";
  assert.ok(script.includes(capped));
  assert.ok(script.indexOf(capped) < script.indexOf(events));
  assert.ok(script.indexOf(capped) < script.indexOf(cursor));
  assert.match(script, /cappedCandidateAudits\.push/);
  assert.match(script, /'watch', 'capped'/);
  assert.doesNotMatch(script, /placeOrder\(|AUTO_TRADING\s*=\s*true/);
});
