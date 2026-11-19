import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { COMBINATION_UNIVERSE_V1 } from '../src/combination-search-lane-v1.mjs';
import {
  RESEARCH_UNIVERSE_POLICY_V2,
  combinationUniverseFromSnapshotV2,
  isTransientUniverseErrorV1,
  splitProbeBudgetV2,
  fetchBitgetUsdtPerpListingV2,
  fetchUpbitKrwListingV2,
  fetchUsListingV2,
  probeDailyLiquidityV2,
  readResearchUniverseSnapshotV2,
  refreshResearchUniverseV2,
  selectStratifiedUniverseV2,
  watchUniverseFromSnapshotV2,
} from '../src/research-universe-v2.mjs';

const json = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
const text = (value) => ({ ok: true, status: 200, text: async () => value, json: async () => JSON.parse(value) });

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'universe-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('listings keep only plain tradeable symbols', async () => {
  const upbit = await fetchUpbitKrwListingV2(async () => json([
    { market: 'KRW-BTC', korean_name: '비트코인', market_warning: 'NONE' },
    { market: 'BTC-ETH', korean_name: '이더' },
    { market: 'KRW-XYZ', korean_name: '주의', market_warning: 'CAUTION' },
  ]));
  assert.deepEqual(upbit.map((row) => row.symbol), ['KRW-BTC', 'KRW-XYZ']);
  assert.equal(upbit[1].warning, true);
  const bitget = await fetchBitgetUsdtPerpListingV2(async () => json({ data: [
    { symbol: 'BTCUSDT', symbolStatus: 'normal' }, { symbol: 'OLDUSDT', symbolStatus: 'off' }, { symbol: 'ETHUSDC', symbolStatus: 'normal' },
  ] }));
  assert.deepEqual(bitget.map((row) => row.symbol), ['BTCUSDT']);
  const nasdaq = ['Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
    ...Array.from({ length: 1500 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}|Co ${i}|Q|N|N|100|N|N`),
    'ZTEST|Test|Q|Y|N|100|N|N', 'File Creation Time: 1|||||||'].join('\n');
  const other = ['ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    ...Array.from({ length: 900 }, (_, i) => `B${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}|Other ${i}|N|X|Y|100|N|X`),
    'BRK.B|Berkshire B|N|X|N|100|N|X'].join('\n');
  const us = await fetchUsListingV2(async (url) => text(url.includes('nasdaqlisted') ? nasdaq : other));
  assert.ok(us.length >= 2000);
  assert.ok(!us.some((row) => row.symbol === 'ZTEST' || row.symbol === 'BRK.B'));
});

test('liquidity probe uses only pre-2026 history and applies value + age + halt filters', async () => {
  const start = Date.UTC(2023, 0, 1);
  const days = Array.from({ length: 1095 }, (_, i) => start + (i * 86_400_000));
  // Upbit pages are newest-first, 200 rows per page.
  const fetchImpl = async (url) => {
    const to = Date.parse(decodeURIComponent(new URL(url).searchParams.get('to')));
    const rows = days.filter((ts) => ts <= to).slice(-200).reverse().map((ts) => ({
      candle_date_time_utc: new Date(ts).toISOString().slice(0, 19), trade_price: 100, candle_acc_trade_price: 2_000_000_000,
    }));
    return json(rows);
  };
  const probe = await probeDailyLiquidityV2({ source: 'UPBIT_1H', symbol: 'KRW-BTC', fetchImpl });
  assert.equal(probe.liquid, true);
  assert.ok(probe.historyDays >= 1000);
  const thin = await probeDailyLiquidityV2({ source: 'UPBIT_1H', symbol: 'KRW-THIN', fetchImpl: async (url) => {
    const response = await fetchImpl(url); const rows = await response.json();
    return json(rows.map((row) => ({ ...row, candle_acc_trade_price: 10_000_000 })));
  } });
  assert.equal(thin.liquid, false);
});

test('stratified selection takes equal thirds across large, mid and small liquidity', () => {
  const probes = Array.from({ length: 90 }, (_, i) => ({ symbol: `S${String(i).padStart(2, '0')}`, liquid: i < 75, medianDailyValue: 1_000 - i }));
  const picked = selectStratifiedUniverseV2(probes, 30);
  assert.equal(picked.length, 30);
  const tiers = picked.reduce((acc, row) => ({ ...acc, [row.tier]: (acc[row.tier] ?? 0) + 1 }), {});
  assert.deepEqual(tiers, { LARGE: 10, MID: 10, SMALL: 10 });
  assert.ok(picked.every((row) => Number(row.symbol.slice(1)) < 75), 'illiquid names never selected');
  assert.deepEqual(selectStratifiedUniverseV2(probes, 30), picked, 'deterministic');
});

test('universe state machine probes within budget, then freezes; lane universe falls back to V1 until frozen', async (t) => {
  const root = await tempRoot(t);
  const symbols = Array.from({ length: 40 }, (_, i) => `KRW-C${i}`);
  const policy = { ...RESEARCH_UNIVERSE_POLICY_V2, researchPerSource: 15, watchPerSource: 30,
    sources: { UPBIT_1H: RESEARCH_UNIVERSE_POLICY_V2.sources.UPBIT_1H } };
  const prober = async ({ symbol }) => ({ symbol, liquid: !symbol.endsWith('9'), medianDailyValue: 1e10 - Number(symbol.slice(6)), historyDays: 900, candles: 900, zeroValueShare: 0 });
  const listingFetchers = { UPBIT_1H: async () => symbols.map((symbol) => ({ symbol })) };
  let tick = 0;
  let result;
  do {
    result = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, maximumProbes: 12,
      now: () => new Date(Date.UTC(2026, 9, 17, 0, tick)).toISOString() });
    tick += 1;
    if (tick === 1) {
      const early = combinationUniverseFromSnapshotV2(await readResearchUniverseSnapshotV2(root));
      assert.deepEqual(early.UPBIT_1H.symbols, COMBINATION_UNIVERSE_V1.UPBIT_1H.symbols, 'V1 used while probing');
    }
  } while (!result.frozenSources.includes('UPBIT_1H') && tick < 10);
  assert.equal(tick, 4, '40 symbols at 12 probes per tick');
  const snapshot = await readResearchUniverseSnapshotV2(root);
  assert.equal(snapshot.sources.UPBIT_1H.research.length, 15);
  assert.equal(snapshot.sources.UPBIT_1H.survivorshipBias, 'CURRENT_LISTINGS_ONLY');
  const lane = combinationUniverseFromSnapshotV2(snapshot);
  assert.equal(lane.UPBIT_1H.universeVersion, 'V2');
  assert.equal(lane.UPBIT_1H.lookbackDays, COMBINATION_UNIVERSE_V1.UPBIT_1H.lookbackDays);
  assert.equal(lane.BITGET_1H.universeVersion, 'V1');
  const watch = watchUniverseFromSnapshotV2(snapshot);
  assert.ok(watch.UPBIT_1H.length >= 30);
  // Frozen: a later tick with a changed listing does not alter membership.
  await refreshResearchUniverseV2({ stateRoot: root, policy, prober, maximumProbes: 12,
    listingFetchers: { UPBIT_1H: async () => [{ symbol: 'KRW-NEW' }] }, now: () => new Date(Date.UTC(2026, 11, 1)).toISOString() });
  assert.deepEqual((await readResearchUniverseSnapshotV2(root)).sources.UPBIT_1H.research, snapshot.sources.UPBIT_1H.research);
});

test('frozen sets drop symbols the backtest contract rejects instead of failing the whole search', () => {
  const research = ['KRW-W', ...Array.from({ length: 12 }, (_, i) => `KRW-C${String(i).padStart(2, '0')}`)];
  const snapshot = { sources: { UPBIT_1H: { research, watch: ['KRW-T', 'KRW-BTC'] } } };
  const universe = combinationUniverseFromSnapshotV2(snapshot);
  assert.equal(universe.UPBIT_1H.universeVersion, 'V2');
  assert.deepEqual(universe.UPBIT_1H.symbols, research.slice(1));
  const watch = watchUniverseFromSnapshotV2(snapshot);
  assert.equal(watch.UPBIT_1H.includes('KRW-T'), false);
  assert.equal(watch.UPBIT_1H.includes('KRW-W'), false);
  assert.equal(watch.UPBIT_1H.includes('KRW-BTC'), true);
});

test('rate limits, server errors and network failures are transient; symbol-level errors are not', () => {
  assert.equal(isTransientUniverseErrorV1(Object.assign(new Error('UNIVERSE_HTTP_429'), { status: 429 })), true);
  assert.equal(isTransientUniverseErrorV1(Object.assign(new Error('UNIVERSE_HTTP_503'), { status: 503 })), true);
  assert.equal(isTransientUniverseErrorV1(new Error('YAHOO_STOCK_HTTP_429')), true);
  assert.equal(isTransientUniverseErrorV1(new Error('UPBIT_HISTORY_HTTP_502')), true);
  assert.equal(isTransientUniverseErrorV1(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isTransientUniverseErrorV1(new Error('YAHOO_STOCK_SYMBOL_UNSUPPORTED:ABC.KS')), false);
  assert.equal(isTransientUniverseErrorV1(new Error('YAHOO_STOCK_INSUFFICIENT_HISTORY_12')), false);
  assert.equal(isTransientUniverseErrorV1(Object.assign(new Error('UNIVERSE_HTTP_404'), { status: 404 })), false);
  assert.deepEqual(splitProbeBudgetV2(15, 4), [4, 4, 4, 3]);
  assert.deepEqual(splitProbeBudgetV2(2, 4), [1, 1, 0, 0]);
  assert.deepEqual(splitProbeBudgetV2(10, 0), []);
});

test('the probe budget is shared across markets; a 429 pauses only that source and blames no symbol', async (t) => {
  const root = await tempRoot(t);
  const policy = { ...RESEARCH_UNIVERSE_POLICY_V2, researchPerSource: 5, watchPerSource: 10,
    sources: { UPBIT_1H: RESEARCH_UNIVERSE_POLICY_V2.sources.UPBIT_1H, YAHOO_US_1D: RESEARCH_UNIVERSE_POLICY_V2.sources.YAHOO_US_1D } };
  const listingFetchers = {
    UPBIT_1H: async () => Array.from({ length: 6 }, (_, i) => ({ symbol: `KRW-A${i}` })),
    YAHOO_US_1D: async () => Array.from({ length: 200 }, (_, i) => ({ symbol: `U${String(i).padStart(3, '0')}` })),
  };
  const probed = [];
  let usRateLimited = true;
  const prober = async ({ source, symbol }) => {
    probed.push(`${source}:${symbol}`);
    if (source === 'YAHOO_US_1D' && usRateLimited) throw Object.assign(new Error('UNIVERSE_HTTP_429'), { status: 429, retryAfterMs: 120_000 });
    if (symbol === 'KRW-A5') throw new Error('UPBIT_HISTORY_INSUFFICIENT_12');
    return { symbol, liquid: true, medianDailyValue: 1e10, historyDays: 900, candles: 900, zeroValueShare: 0 };
  };
  const t0 = Date.UTC(2026, 9, 18, 0, 0);
  const first = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, maximumProbes: 8, now: () => new Date(t0).toISOString() });
  // 8 probes split 4/4; the US source hit a rate limit on its first probe and stopped.
  assert.equal(first.quotas.UPBIT_1H, 4);
  assert.equal(probed.filter((row) => row.startsWith('UPBIT')).length, 4, 'the Korean exchange kept its share');
  assert.equal(probed.filter((row) => row.startsWith('YAHOO_US')).length, 1, 'one 429 pauses the source');
  assert.ok(first.backoff.YAHOO_US_1D, 'US source in backoff');
  assert.equal(Date.parse(first.backoff.YAHOO_US_1D.until), t0 + 120_000, 'Retry-After honoured');
  assert.ok(first.log.some((line) => line.startsWith('YAHOO_US_1D:TRANSIENT_BACKOFF:PROBE')));
  const state = JSON.parse(await readFile(join(root, 'research-universe-v2', 'state.json'), 'utf8'));
  assert.deepEqual(state.sources.YAHOO_US_1D.failures, {}, 'a rate limit is never a symbol failure');

  // One minute later the US source is still paused: its share is not probed, Upbit continues.
  probed.length = 0;
  const second = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, maximumProbes: 8, now: () => new Date(t0 + 60_000).toISOString() });
  assert.equal(probed.filter((row) => row.startsWith('YAHOO_US')).length, 0);
  assert.ok(second.log.some((line) => line.startsWith('YAHOO_US_1D:BACKOFF')));
  assert.ok(second.frozenSources.includes('UPBIT_1H') || probed.filter((row) => row.startsWith('UPBIT')).length > 0);

  // After the backoff the US source resumes and the symbol-level failure counted once.
  usRateLimited = false;
  probed.length = 0;
  const third = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, maximumProbes: 8, now: () => new Date(t0 + 180_000).toISOString() });
  assert.ok(probed.filter((row) => row.startsWith('YAHOO_US')).length >= 4, 'US probing resumed');
  assert.deepEqual(third.backoff, {});
  const after = JSON.parse(await readFile(join(root, 'research-universe-v2', 'state.json'), 'utf8'));
  assert.equal(after.sources.UPBIT_1H.failures['KRW-A5']?.attempts, 1, 'a real symbol error counts');
  assert.equal(after.sources.YAHOO_US_1D.transient.count, 0, 'a successful probe clears the transient counter');
});

test('a source listing that fails with 5xx is retried after a backoff instead of counting against anything', async (t) => {
  const root = await tempRoot(t);
  const policy = { ...RESEARCH_UNIVERSE_POLICY_V2, sources: { BITGET_1H: RESEARCH_UNIVERSE_POLICY_V2.sources.BITGET_1H } };
  let calls = 0;
  const listingFetchers = { BITGET_1H: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('UNIVERSE_HTTP_503'), { status: 503 }); return [{ symbol: 'BTCUSDT' }]; } };
  const prober = async ({ symbol }) => ({ symbol, liquid: true, medianDailyValue: 1e9, historyDays: 900, candles: 900, zeroValueShare: 0 });
  const t0 = Date.UTC(2026, 9, 18);
  const first = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, now: () => new Date(t0).toISOString() });
  assert.ok(first.backoff.BITGET_1H);
  assert.equal(first.backoff.BITGET_1H.stage, 'LISTING');
  const paused = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, now: () => new Date(t0 + 60_000).toISOString() });
  assert.equal(calls, 1, 'no listing call while paused');
  assert.deepEqual(paused.frozenSources, []);
  const resumed = await refreshResearchUniverseV2({ stateRoot: root, policy, listingFetchers, prober, now: () => new Date(t0 + (16 * 60_000)).toISOString() });
  assert.equal(calls, 2);
  assert.deepEqual(resumed.frozenSources, ['BITGET_1H']);
});
