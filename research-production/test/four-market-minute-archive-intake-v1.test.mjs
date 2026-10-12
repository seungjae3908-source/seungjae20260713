import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, lstat, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINUTE_MS, MINUTE_ARCHIVE_LIMITS, validateMinuteTask, validateMinuteCandles,
  normalizePublicMinuteResponse, fetchCryptoMinutePage, readOriginalMinutePage,
  persistOriginalMinutePage, runMinuteArchiveIntakeV1,
} from '../src/four-market-minute-archive-intake-v1.mjs';

const SHA = 'a'.repeat(40);
const BEGIN = Date.parse('2026-10-10T10:00:00.000Z');
const END = BEGIN + 60 * MINUTE_MS;
const NOW = END + 20 * MINUTE_MS;
const spot = { market: 'CRYPTO_SPOT', symbol: 'BTC',
  windowStartMs: BEGIN, windowEndMs: END };
const future = { ...spot, market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT' };
const candle = (timestamp = BEGIN) => ({
  timestamp, open: 100, high: 110, low: 95, close: 105, volume: 8, quoteVolume: 800,
});
const upbit = (timestamp = BEGIN, overrides = {}) => ({
  market: 'KRW-BTC', candle_date_time_utc: new Date(timestamp).toISOString().slice(0,19),
  timestamp: timestamp + 45_000, opening_price: 100, high_price: 110,
  low_price: 95, trade_price: 105, candle_acc_trade_volume: 8,
  candle_acc_trade_price: 800, ...overrides,
});
const bitget = (timestamp = BEGIN) =>
  [String(timestamp), '100', '110', '95', '105', '8', '800'];
const fakeResponse = (body, status = 200) => ({
  ok: status === 200, status, headers: { get: () => null },
  text: async () => JSON.stringify(body),
});
async function workspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'four-market-minute-intake-'));
  try { return await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('strict four-market identity and 120-minute UTC closed window guard', () => {
  assert.equal(validateMinuteTask(spot).symbol, 'BTC');
  assert.equal(validateMinuteTask({ ...spot, market: 'KR_STOCK', symbol: '005930' }).market, 'KR_STOCK');
  assert.equal(validateMinuteTask({ ...spot, market: 'US_STOCK', symbol: 'AAPL' }).market, 'US_STOCK');
  for (const bad of [
    { ...spot, symbol: '../../secret' },
    { ...spot, symbol: 'btc' },
    { ...spot, windowStartMs: BEGIN + 1 },
    { ...spot, windowEndMs: BEGIN + 121 * MINUTE_MS },
    { ...spot, windowEndMs: BEGIN - MINUTE_MS },
    { ...spot, market: 'FAKE' },
  ]) assert.throws(() => validateMinuteTask(bad), /MINUTE_/);
  assert.throws(() => validateMinuteCandles(spot, [candle()], END + 3_000),
    /MINUTE_WINDOW_NOT_CLOSED/);
});

test('Upbit uses candle UTC start not last-tick timestamp, and never makes no-trade bars', () => {
  const rows = normalizePublicMinuteResponse(spot, [
    upbit(BEGIN + 2 * MINUTE_MS),
    upbit(BEGIN, { timestamp: BEGIN + 59_999 }),
    upbit(BEGIN - MINUTE_MS),
    upbit(END),
  ]);
  const normalized = validateMinuteCandles(spot, rows, NOW);
  assert.deepEqual(normalized.map(r => r.timestamp), [BEGIN, BEGIN + 2 * MINUTE_MS]);
  assert.equal(normalized.length, 2); // no fabricated candle for missing 10:01
  assert.throws(() => normalizePublicMinuteResponse(spot, [upbit(BEGIN, { market: 'KRW-ETH' })]),
    /MINUTE_UPBIT_MARKET_MISMATCH/);
  assert.throws(() => normalizePublicMinuteResponse(spot, [
    upbit(BEGIN, { candle_date_time_utc: '2026-10-10T10:00:29' }),
  ]), /MINUTE_UPBIT_START_INVALID/);
  assert.throws(() => validateMinuteCandles(spot, [candle(), candle()], NOW),
    /MINUTE_DUPLICATE_CANDLE/);
  assert.throws(() => validateMinuteCandles(spot, [{ ...candle(), high: 99 }], NOW),
    /MINUTE_OHLCV_INVALID/);
});

test('public GET requests are fixed and bounded; Bitget extra interval is excluded', async () => {
  const seen = [];
  const data = await fetchCryptoMinutePage(future, { fetchImpl: async (url, init) => {
    seen.push({ url, init });
    return fakeResponse({ code: '00000', data: [
      bitget(BEGIN - MINUTE_MS), bitget(BEGIN + MINUTE_MS), bitget(END),
    ] });
  } });
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).hostname, 'api.bitget.com');
  assert.equal(new URL(seen[0].url).searchParams.get('granularity'), '1m');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.redirect, 'error');
  assert.deepEqual(validateMinuteCandles(future, data, NOW).map(r => r.timestamp),
    [BEGIN + MINUTE_MS]);
  assert.rejects(fetchCryptoMinutePage(spot, {
    fetchImpl: async () => fakeResponse({}, 429),
  }), /MINUTE_SOURCE_HTTP_429/);
  await assert.rejects(fetchCryptoMinutePage(future, {
    fetchImpl: async () => fakeResponse({ code: '20000', data: [bitget()] }),
  }), /MINUTE_SOURCE_RESPONSE_INVALID/);
  await assert.rejects(fetchCryptoMinutePage(spot, {
    fetchImpl: async () => fakeResponse({ data: 'x'.repeat(600_000) }),
  }), /MINUTE_SOURCE_RESPONSE_OVERSIZE/);
});

test('default-OFF means zero provider requests and no filesystem access', async () => {
  let calls = 0;
  const result = await runMinuteArchiveIntakeV1({
    tasks: [spot], fetchImpl: async () => { calls++; throw Error('not allowed'); },
  });
  assert.equal(result.status, 'DISABLED');
  assert.equal(result.providerCalls, 0);
  assert.equal(calls, 0);
  assert.equal(result.executionAuthority, 'NONE');
});

test('immutable private archive readback: identical retry skips provider, conflict blocks', async () => {
  await workspace(async root => {
    let calls = 0;
    const args = { enabled: true, root, tasks: [spot], researchSha: SHA,
      now: () => NOW, sleep: async () => {},
      fetchImpl: async () => { calls++; return fakeResponse([upbit(BEGIN)]); } };
    const first = await runMinuteArchiveIntakeV1(args);
    assert.equal(first.status, 'ARCHIVED_OR_REUSED');
    assert.equal(first.providerCalls, 1);
    assert.equal(first.filesWritten, 1);
    assert.equal(first.results[0].status, 'ARCHIVED');
    const row = await readOriginalMinutePage(root, spot, SHA);
    assert.equal(row.candles[0].timestamp, BEGIN);
    assert.equal(row.candleCount, 1);
    assert.equal(row.missingMinutesUnclassified, true);
    assert.equal(row.profitabilityProven, false);
    assert.equal(row.oosCredit, 0);
    const parent = join(root, spot.market, spot.symbol, '2026-10-10');
    assert.equal((await lstat(parent)).mode & 0o077, 0);
    const replay = await runMinuteArchiveIntakeV1(args);
    assert.equal(replay.providerCalls, 0);
    assert.equal(replay.filesWritten, 0);
    assert.equal(replay.results[0].status, 'REUSED_IDENTICAL');
    assert.equal(calls, 1);
    await assert.rejects(persistOriginalMinutePage({
      root, task: spot, researchSha: SHA,
      rows: [{ ...candle(), close: 104 }], retrievedAtMs: NOW,
    }), /MINUTE_ARCHIVE_SOURCE_CONFLICT/);
  });
});

test('receipt availability timestamp integrity rejects quiet backdating', async () => {
  await workspace(async root => {
    await persistOriginalMinutePage({
      root, task: spot, researchSha: SHA, rows: [candle()], retrievedAtMs: NOW,
    });
    const file = join(root, spot.market, spot.symbol, '2026-10-10',
      BEGIN + '-' + END + '.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.retrievedAt = new Date(BEGIN + 5 * MINUTE_MS).toISOString();
    await writeFile(file, JSON.stringify(record), 'utf8');
    await assert.rejects(readOriginalMinutePage(root, spot, SHA), /MINUTE_ARCHIVE_CORRUPT/);
  });
});

test('zero-candle responses remain blocked; stock provider remains unconfigured', async () => {
  await workspace(async root => {
    const empty = await runMinuteArchiveIntakeV1({
      enabled:true, root, tasks:[spot], researchSha:SHA, now:()=>NOW,
      sleep:async()=>{}, fetchImpl:async()=>fakeResponse([]),
    });
    assert.equal(empty.status, 'PARTIAL_OR_BLOCKED');
    assert.equal(empty.results[0].status, 'BLOCKED_EMPTY_RESPONSE');
    assert.equal(await readOriginalMinutePage(root, spot, SHA), null);
    let calls = 0;
    const stock = await runMinuteArchiveIntakeV1({
      enabled:true, root, tasks:[{...spot,market:'KR_STOCK',symbol:'005930'}],
      researchSha:SHA, now:()=>NOW,
      fetchImpl:async()=>{ calls++; return fakeResponse([]); },
    });
    assert.equal(stock.results[0].status, 'BLOCKED_STOCK_FEED_NOT_CONFIGURED');
    assert.equal(stock.providerCalls, 0);
    assert.equal(calls, 0);
    await assert.rejects(persistOriginalMinutePage({
      root, task:{...spot,market:'KR_STOCK',symbol:'005930'},
      researchSha:SHA, rows:[candle()],retrievedAtMs:NOW,
    }), /MINUTE_STOCK_FEED_NOT_CONFIGURED/);
  });
});

test('unsafe root and insufficient disk stop before any provider requests', async () => {
  await workspace(async root => {
    let calls = 0;
    const args = { enabled:true, tasks:[spot], researchSha:SHA, now:()=>NOW,
      fetchImpl: async()=>{ calls++; return fakeResponse([upbit(BEGIN)]); } };
    const held = await runMinuteArchiveIntakeV1({
      ...args, root, freeBytes:MINUTE_ARCHIVE_LIMITS.minFreeBytes - 1,
    });
    assert.equal(held.status,'HOLD_DISK');
    const rootLink = join(root,'link');
    await symlink(root,rootLink);
    await assert.rejects(runMinuteArchiveIntakeV1({
      ...args, root:rootLink,
    }), /MINUTE_ARCHIVE_DIRECTORY_UNSAFE/);
    await assert.rejects(runMinuteArchiveIntakeV1({
      ...args, root, tasks:[spot,spot],
    }), /MINUTE_INTAKE_DUPLICATE_TASK/);
    assert.equal(calls,0);
  });
});
