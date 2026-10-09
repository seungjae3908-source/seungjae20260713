import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  WATCH_READBACK_CONTRACT,
  summarizeLightweightMarketWatch,
} from '../src/lightweight-market-watch-readback.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const MARKETS = [
  'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
];
function evidence(nowMs = NOW) {
  return {
    schemaVersion: 'lightweight-market-opportunity-watch-v1',
    researchSha: SHA,
    observedAt: new Date(nowMs - 30_000).toISOString(),
    status: 'PARTIAL_MARKET_COVERAGE',
    resourceBudget: { status: 'RUN', reason: 'WITHIN_BUDGET' },
    markets: MARKETS.map((market, i) => ({
      market,
      status: i < 2 ? 'BLOCKED_PUBLIC_STOCK_FEED_MISSING' : 'READY',
      source: i < 2 ? 'NONE' : i === 2 ? 'UPBIT_PUBLIC_TICKERS' : 'BITGET_PUBLIC_TICKERS',
      listedCount: i < 2 ? 0 : 10,
      observedCount: i < 2 ? 0 : 10,
      newCandidates: i === 2 ? 2 : i === 3 ? 1 : 0,
      executionAuthority: 'NONE',
    })),
    newCandidateCount: 3,
    safety: {
      researchOnly: true, orderAuthority: 'NONE', liveTrading: false,
      privateProviderApi: false, paperAdmissionAllowed: false,
      profitabilityProven: false, aiPassInvented: false,
    },
    statistics: {
      dayUtc: new Date(nowMs - 30_000).toISOString().slice(0, 10),
      cyclesToday: 120, candidatesToday: 25,
      cyclesSinceRelease: 300,
      daysInService: 2, lastCollectedAt: new Date(nowMs - 30_000).toISOString(),
    },
  };
}

test('missing and valid partial market discovery never invent 24h research or profitability', () => {
  const missing = summarizeLightweightMarketWatch(null, NOW);
  assert.equal(missing.status, 'MISSING');
  assert.equal(missing.present, false);
  const status = summarizeLightweightMarketWatch(evidence(), NOW, SHA);
  assert.equal(status.contract, WATCH_READBACK_CONTRACT);
  assert.equal(status.status, 'PARTIAL');
  assert.equal(status.marketCoverageCount, 2);
  assert.equal(status.cyclesToday, 120);
  assert.equal(status.candidatesToday, 25);
  assert.equal(status.continuous24hProven, false);
  assert.equal(status.formulaCandidateProduced, false);
  assert.equal(status.oosProven, false);
  assert.equal(status.paperExecutionProven, false);
  assert.equal(status.profitabilityProven, false);
  assert.equal(status.executionAuthority, 'NONE');
  assert.equal(JSON.stringify(status).includes('market-watch-input'), false);
});

test('stale and future state do not show current 24-hour observation', () => {
  const stale = evidence();
  stale.observedAt = new Date(NOW - 8 * 60_000).toISOString();
  stale.statistics.dayUtc = stale.observedAt.slice(0, 10);
  assert.equal(summarizeLightweightMarketWatch(stale, NOW).status, 'STALE');
  const future = evidence();
  future.observedAt = new Date(NOW + 7_000).toISOString();
  assert.equal(summarizeLightweightMarketWatch(future, NOW).status, 'INVALID');
  assert.equal(summarizeLightweightMarketWatch(evidence(), NOW, 'f'.repeat(40)).status, 'INVALID');
});

test('wrong research authority, forged counts, mutated SHA or market identity is rejected', () => {
  const forbidden = evidence();
  forbidden.safety.orderAuthority = 'LIVE';
  assert.equal(summarizeLightweightMarketWatch(forbidden, NOW).status, 'INVALID');
  const forged = evidence();
  forged.statistics.candidatesToday = -10;
  assert.equal(summarizeLightweightMarketWatch(forged, NOW).status, 'INVALID');
  const market = evidence();
  market.markets[2].market = 'US_STOCK';
  assert.equal(summarizeLightweightMarketWatch(market, NOW).status, 'INVALID');
  const count = evidence();
  count.newCandidateCount = 40;
  assert.equal(summarizeLightweightMarketWatch(count, NOW).status, 'INVALID');
  const leak = evidence();
  leak.markets[2].source = '/etc/stock-app/secret';
  assert.equal(summarizeLightweightMarketWatch(leak, NOW).status, 'INVALID');
});

test('host throttle and crash-safe source statuses are not successful completed research', () => {
  const hold = evidence();
  hold.status = 'HOLD';
  hold.resourceBudget = { status: 'HOLD', reason: 'MEMORY_PRESSURE' };
  hold.markets = MARKETS.map((market) => ({
    market, status: 'BLOCKED_HOST_HOLD', source: 'NONE',
    listedCount: 0, observedCount: 0, newCandidates: 0,
    executionAuthority: 'NONE',
  }));
  hold.newCandidateCount = 0;
  assert.equal(summarizeLightweightMarketWatch(hold, NOW).status, 'HOLD');
  const forged = evidence();
  forged.status = 'OBSERVING_ALL_FOUR';
  assert.equal(summarizeLightweightMarketWatch(forged, NOW).status, 'INVALID');
});


test('all public market feeds blocked is not mislabeled as successful observation', () => {
  const blocked = evidence();
  blocked.status = 'BLOCKED_DATA';
  blocked.markets = MARKETS.map((market) => ({
    market, status: 'BLOCKED_PUBLIC_STOCK_FEED_MISSING', source: 'NONE',
    listedCount: 0, observedCount: 0, newCandidates: 0,
    executionAuthority: 'NONE',
  }));
  blocked.newCandidateCount = 0;
  const result = summarizeLightweightMarketWatch(blocked, NOW);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.marketCoverageCount, 0);
  assert.equal(result.continuous24hProven, false);
});


test('raw PARTIAL, BLOCKED and all-four coverage are cross-validated', () => {
  const allReady = evidence();
  allReady.markets[0] = {
    market: 'KR_STOCK', status: 'READY', source: 'KR_PUBLIC_QUOTES',
    listedCount: 10, observedCount: 10, newCandidates: 0,
    executionAuthority: 'NONE',
  };
  allReady.markets[1] = {
    market: 'US_STOCK', status: 'READY', source: 'US_PUBLIC_QUOTES',
    listedCount: 10, observedCount: 10, newCandidates: 0,
    executionAuthority: 'NONE',
  };
  assert.equal(summarizeLightweightMarketWatch(allReady, NOW).status, 'INVALID');
  allReady.status = 'OBSERVING_ALL_FOUR';
  assert.equal(summarizeLightweightMarketWatch(allReady, NOW).status, 'OBSERVING');

  const falseBlocked = evidence();
  falseBlocked.status = 'BLOCKED_DATA';
  assert.equal(summarizeLightweightMarketWatch(falseBlocked, NOW).status, 'INVALID');

  const falsePartial = evidence();
  falsePartial.markets = MARKETS.map((market) => ({
    market, status: 'BLOCKED_NO_PUBLIC_DATA', source: 'NONE',
    listedCount: 0, observedCount: 0, newCandidates: 0,
    executionAuthority: 'NONE',
  }));
  falsePartial.newCandidateCount = 0;
  assert.equal(summarizeLightweightMarketWatch(falsePartial, NOW).status, 'INVALID');
});


test('misleading budget and zero-symbol READY are INVALID, not operating proof', () => {
  const underBudget = evidence();
  underBudget.resourceBudget = { status: 'HOLD', reason: 'MEMORY_PRESSURE' };
  assert.equal(summarizeLightweightMarketWatch(underBudget, NOW).status, 'INVALID');
  const wrongThrottle = evidence();
  wrongThrottle.resourceBudget = { status: 'THROTTLED', reason: 'HOST_PRESSURE' };
  assert.equal(summarizeLightweightMarketWatch(wrongThrottle, NOW).status, 'INVALID');
  const emptyReady = evidence();
  emptyReady.markets[2] = {
    market: 'CRYPTO_SPOT', status: 'READY', source: 'UPBIT_PUBLIC_TICKERS',
    listedCount: 0, observedCount: 0, newCandidates: 0,
    executionAuthority: 'NONE',
  };
  emptyReady.newCandidateCount = 1;
  assert.equal(summarizeLightweightMarketWatch(emptyReady, NOW).status, 'INVALID');
});

test('local status CLI is missing-safe and does not read from the network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-status-'));
  const exec = new URL('../bin/lightweight-market-watch-status.mjs', import.meta.url).pathname;
  try {
    await mkdir(join(root, 'latest'), { recursive: true, mode: 0o700 });
    const env = { ...process.env, RESEARCH_STATE_ROOT: root, RESEARCH_CODE_SHA: SHA };
    const absent = spawnSync(process.execPath, [exec], { env, encoding: 'utf8' });
    assert.equal(absent.status, 0);
    assert.equal(JSON.parse(absent.stdout).status, 'MISSING');
    const nowMs = Date.now();
    const data = evidence(nowMs);
    const path = join(root, 'latest', 'lightweight-market-watch.json');
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    const hit = spawnSync(process.execPath, [exec], { env, encoding: 'utf8' });
    assert.equal(hit.status, 0, hit.stderr);
    const actual = JSON.parse(hit.stdout);
    assert.equal(actual.status, 'PARTIAL');
    assert.equal(actual.marketCoverageCount, 2);
    assert.equal(JSON.stringify(actual).includes(root), false);
    assert.equal(JSON.stringify(actual).includes('secrets'), false);
    await rm(path);
    await symlink(join(root, 'not-present.json'), path);
    const unsafe = spawnSync(process.execPath, [exec], { env, encoding: 'utf8' });
    assert.equal(unsafe.status, 2);
    assert.equal(JSON.parse(unsafe.stdout).status, 'INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
