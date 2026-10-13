import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchNasdaqDirectoryPair, parseNasdaqDirectoryPair } from './nasdaq-trader';
import { clearUsUniverseCacheForTests, getUsUniverse, getUsPublicUniverse } from './us-universe';
import { ScannerUniverseService, clearScannerUniverseCacheForTests } from '../services/scanner-universe.service';
import { refreshUnifiedAssetSearchIndex, resetUnifiedAssetSearchStateForTests } from '../services/unified-asset-search.service';

function footer(at: number): string {
  const p = new Map(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `File Creation Time: ${p.get('month')}${p.get('day')}${p.get('year')}${p.get('hour')}:${p.get('minute')}`;
}
function pair(at = Date.now(), count = 600) {
  return [
    ['Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
      ...Array.from({ length: count }, (_, i) => `N${i}|Company ${i}|Q|N|N|100|N|N`), `${footer(at)}|||||||`].join('\n'),
    ['ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
      ...Array.from({ length: count }, (_, i) => `O${i}|Company ${i}|N|O${i}|N|100|N|O${i}`), `${footer(at)}|||||||`].join('\n'),
  ] as const;
}
async function withPublicFixtures(run: (stats: { calls: number }) => Promise<void>) {
  const keys = ['FINNHUB_API_KEY', 'FINNHUB_KEY', 'VITE_FINNHUB_API_KEY'] as const;
  const saved = new Map(keys.map(k => [k, process.env[k]]));
  const original = globalThis.fetch;
  const stats = { calls: 0 };
  keys.forEach(k => delete process.env[k]);
  clearUsUniverseCacheForTests(); clearScannerUniverseCacheForTests();
  globalThis.fetch = async (input, init) => {
    stats.calls++;
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    const url = String(input);
    assert.ok(url.startsWith('https://www.nasdaqtrader.com/'));
    const texts = pair();
    return new Response(url.includes('nasdaqlisted') ? texts[0] : texts[1]);
  };
  try { await run(stats); } finally {
    globalThis.fetch = original; clearUsUniverseCacheForTests(); clearScannerUniverseCacheForTests();
    for (const [k, value] of saved) { if (value == null) delete process.env[k]; else process.env[k] = value; }
  }
}

test('strict directory parser preserves source ET timestamp, class-share symbols and official ETF flag', () => {
  const now = Date.parse('2026-10-12T15:30:00Z'); const texts = pair(now, 1);
  const n = texts[0].replace('N0|Company 0|Q|N|N|100|N|N', 'BRK.B|Berkshire|Q|N|N|100|N|N');
  const o = texts[1].replace('O0|Company 0|N|O0|N|100|N|O0', 'SPY|SPDR ETF|N|SPY|Y|100|N|SPY');
  const result = parseNasdaqDirectoryPair(n, o, now);
  assert.equal(result.rawTotalCount, 2);
  assert.equal(result.sourceAsOf, '2026-10-12T15:30:00.000Z');
  assert.equal(result.entries[0].ticker, 'BRK.B');
  assert.equal(result.entries[1].assetType, 'ETF');
  assert.equal(result.entries[1].source, 'nasdaq-trader-public-directory');
});

test('both directory schemas, footer and source freshness are required, not a large HTML or truncated page', () => {
  const now = Date.parse('2026-10-12T15:30:00Z'); const [n, o] = pair(now, 1);
  for (const text of [o.replace('Test Issue', 'Ignored'), o.split('\n').slice(0, -1).join('\n'),
    `${o}\n${footer(now)}|||||||`, o.replace('|100|N|O0', '|100||O0'),
    o.replace('Company 0|N|', 'Company 0|'), '<html>error</html>', o.replace(footer(now), 'File Creation Time: 1332202611:00')]) {
    assert.throws(() => parseNasdaqDirectoryPair(n, text, now), /NASDAQ_DIRECTORY_/);
  }
  for (const at of [now + 24 * 60 * 60_000, now - 8 * 24 * 60 * 60_000]) {
    const texts = pair(at, 1);
    assert.throws(() => parseNasdaqDirectoryPair(...texts, now), /SOURCE_STALE_OR_FUTURE/);
  }
});

test('test issues and unsupported warrants/rights/units are explicitly counted, not ordinary active stocks', () => {
  const now = Date.now(); const [n, o] = pair(now, 3);
  const result = parseNasdaqDirectoryPair(n.replace('Q|N|N|100|N|N', 'Q|Y|N|100|N|N')
    .replace('Company 1', 'Company warrants').replace('Company 2', 'Company rights'), o, now);
  assert.equal(result.rawTotalCount, 6);
  assert.equal(result.entries.length, 3);
  assert.equal(result.exclusionReasons.TEST_ISSUE, 1);
  assert.equal(result.exclusionReasons.UNSUPPORTED_SECURITY_TYPE, 2);
});

test('normal app without a paid provider token receives the same current public roster and paginates it', async () => {
  await withPublicFixtures(async stats => {
    const rows = await getUsUniverse();
    assert.equal(rows.length, 1200);
    assert.ok(rows.every(row => row.source === 'nasdaq-trader-public-directory' && row.listingStatus === 'LISTED'));
    rows[0].ticker = 'MUTATED'; rows.pop();
    const again = await getUsUniverse();
    assert.equal(again.length, 1200); assert.notEqual(again[0].ticker, 'MUTATED');
    const a = await ScannerUniverseService.batch('US', 0, 20);
    assert.equal(a.source, 'nasdaq-trader-public-directory'); assert.equal(a.partial, false);
    a.entries[0].ticker = 'MUTATED_SCANNER_CACHE';
    const b = await ScannerUniverseService.batch('US', 20, 20);
    const zero = await ScannerUniverseService.batch('US', 0, 20);
    assert.equal(b.cursor, 20); assert.equal(b.nextCursor, 40); assert.equal(b.totalCount, 1200);
    assert.notEqual(zero.entries[0].ticker, 'MUTATED_SCANNER_CACHE');
    assert.match(a.rosterId, /^[a-f0-9]{64}$/);
    assert.equal(a.rosterId, b.rosterId); assert.equal(a.rosterId, zero.rosterId);
    assert.equal(stats.calls, 2, 'only the two public files are fetched, no quote/AI/private endpoint');
    const controller = new AbortController(); controller.abort(new Error('CANCELLED_BEFORE_CACHE'));
    await assert.rejects(getUsUniverse(controller.signal), /CANCELLED_BEFORE_CACHE/);
    await assert.rejects(ScannerUniverseService.get('US', controller.signal), /CANCELLED_BEFORE_CACHE/);
    assert.equal(stats.calls, 2);
  });
});

test('configured provider cancellation also settles when Finnhub ignores its abort signal', async () => {
  await withPublicFixtures(async () => {
    process.env.FINNHUB_API_KEY = 'offline-fixture-only'; let calls = 0;
    globalThis.fetch = () => { calls++; return new Promise<Response>(() => {}); };
    const controller = new AbortController();
    const pending = getUsUniverse(controller.signal);
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(new Error('CANCELLED_FINNHUB_CALLER'));
    await assert.rejects(pending, /CANCELLED_FINNHUB_CALLER/);
    assert.equal(calls, 1, 'cancelled callers must not start the public fallback');
  });
});

test('unified search reports actual directory basis time, not the index download time', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'nasdaq-search-index-'));
  const saved = process.env.UNIFIED_SEARCH_INDEX_CACHE_FILE;
  process.env.UNIFIED_SEARCH_INDEX_CACHE_FILE = path.join(scratch, 'index.json');
  resetUnifiedAssetSearchStateForTests();
  try {
    await withPublicFixtures(async () => {
      const sourceAt = Date.now() - 2 * 24 * 60 * 60_000;
      const texts = pair(sourceAt);
      const expectedAsOf = parseNasdaqDirectoryPair(...texts).sourceAsOf;
      globalThis.fetch = async input => {
        const url = String(input);
        if (!url.startsWith('https://www.nasdaqtrader.com/')) throw new Error('OFFLINE_OTHER_PROVIDER');
        return new Response(url.includes('nasdaqlisted') ? texts[0] : texts[1]);
      };
      const index = await refreshUnifiedAssetSearchIndex();
      const rows = index.documents.filter(row => row.market === 'US');
      assert.equal(rows.length, 1200);
      assert.ok(rows.every(row => row.provider === 'NASDAQ_TRADER' && row.active && row.dataAsOf === expectedAsOf));
      assert.equal(index.providers.find(provider => provider.provider === 'finnhub')?.dataAsOf, expectedAsOf);
      assert.notEqual(index.builtAt, expectedAsOf);
    });
  } finally {
    resetUnifiedAssetSearchStateForTests();
    if (saved == null) delete process.env.UNIFIED_SEARCH_INDEX_CACHE_FILE; else process.env.UNIFIED_SEARCH_INDEX_CACHE_FILE = saved;
    await rm(scratch, { recursive: true, force: true });
  }
});

test('one successful directory or tiny duplicated source pair cannot become a cached current roster', async () => {
  await withPublicFixtures(async stats => {
    globalThis.fetch = async input => { stats.calls++; const [n] = pair(); return new Response(String(input).includes('nasdaqlisted') ? n : '<html>unavailable</html>'); };
    const first = await getUsUniverse(); const second = await getUsUniverse();
    assert.ok(first.every(row => row.source === 'static-catalog' && row.listingStatus === 'UNKNOWN'));
    assert.ok(second.every(row => row.listingStatus === 'UNKNOWN'));
    assert.equal(stats.calls, 4, 'failed pair must not be success-cached');
    const texts = pair(Date.now(), 1);
    globalThis.fetch = async input => new Response(String(input).includes('nasdaqlisted') ? texts[0] : texts[1]);
    await assert.rejects(getUsPublicUniverse(), /PAIR_INCOMPLETE/);
  });
});

test('public directory caller cancellation settles even if a transport ignores abort', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise<Response>(() => {}); };
  const controller = new AbortController();
  const pending = fetchNasdaqDirectoryPair(controller.signal);
  controller.abort(new Error('CANCELLED_DIRECTORY_CALLER'));
  try { await assert.rejects(pending, /CANCELLED_DIRECTORY_CALLER/); assert.equal(calls, 2); }
  finally { globalThis.fetch = original; }
});

test('tiny Finnhub 200 does not poison the provider cache or suppress the public source', async () => {
  await withPublicFixtures(async stats => {
    process.env.FINNHUB_API_KEY = 'offline-fixture-only';
    const publicFetch = globalThis.fetch; let paidCalls = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://finnhub.io/')) {
        paidCalls++; return Response.json([{ symbol: 'ONLY', description: 'Truncated roster', mic: 'XNAS' }]);
      }
      return publicFetch(input, init);
    };
    assert.equal((await getUsUniverse()).length, 1200);
    assert.equal((await getUsUniverse()).length, 1200);
    assert.equal(paidCalls, 2, 'a truncated Finnhub response is never cached as the current full-size roster');
    assert.equal(stats.calls, 2);
  });
});
