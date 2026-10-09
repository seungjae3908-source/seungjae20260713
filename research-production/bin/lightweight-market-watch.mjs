#!/usr/bin/env node
import { cpus, loadavg } from 'node:os';
import {
  lstat, mkdir, open, readFile, rm, statfs,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { preflightResearchProduction } from '../src/engine.mjs';
import { advancePublicWatchProspectiveEvidence } from '../src/lightweight-market-watch-prospective.mjs';
import { makePublicWatchCadenceRecord } from '../src/lightweight-market-watch-cadence.mjs';
import {
  appendBoundedWatchEvents, atomicDurableWatchJson, WATCH_STORAGE_LIMITS,
} from '../src/lightweight-market-watch-storage.mjs';
import {
  WATCH_CONTRACT, WATCH_LIMITS, WATCH_MARKETS, WATCH_SAFETY,
  blockedSource, evaluateMarketOpportunities, evaluateWatchBudget,
  normalizeBitgetSnapshot, normalizeStockFeed, normalizeUpbitSnapshot,
  parseBoundedPublicJson, watchCycleDigest,
} from '../src/lightweight-market-watch.mjs';

const UPBIT = 'https://api.upbit.com';
const BITGET = 'https://api.bitget.com';
let spotMarkets = null;
let spotMarketFetchedAt = 0;
let stopping = false;
let wake = null;
process.once('SIGTERM', () => { stopping = true; if (wake) wake(); });
process.once('SIGINT', () => { stopping = true; if (wake) wake(); });

function sleep(ms) {
  if (stopping) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    wake = () => { clearTimeout(timer); done(); };
  }).finally(() => { wake = null; });
}
function errorCode(error, fallback = 'SOURCE_UNAVAILABLE') {
  const safe = String(error?.message ?? '').toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_').slice(0, 75);
  return safe || fallback;
}
async function publicJson(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'research-market-watch-v1' },
    signal: AbortSignal.timeout(8_000),
  });
  return parseBoundedPublicJson(res);
}
async function spotSnapshot(nowMs) {
  if (!spotMarkets || nowMs - spotMarketFetchedAt >= 60 * 60_000) {
    spotMarkets = await publicJson(UPBIT + '/v1/market/all?isDetails=true');
    if (!Array.isArray(spotMarkets)) throw new Error('UPBIT_MARKET_LIST_INVALID');
    spotMarketFetchedAt = nowMs;
  }
  const marketCodes = spotMarkets.filter((row) =>
    /^KRW-[A-Z0-9._-]{1,32}$/.test(String(row?.market ?? ''))
    && String(row?.market_warning ?? 'NONE').toUpperCase() === 'NONE')
    .map((row) => row.market);
  if (!marketCodes.length) throw new Error('UPBIT_MARKET_LIST_EMPTY');
  const all = [];
  for (let offset = 0; offset < marketCodes.length; offset += 100) {
    const codes = marketCodes.slice(offset, offset + 100).join(',');
    const rows = await publicJson(UPBIT + '/v1/ticker?markets=' + encodeURIComponent(codes));
    if (!Array.isArray(rows)) throw new Error('UPBIT_TICKER_INVALID');
    all.push(...rows);
    if (offset + 100 < marketCodes.length) await sleep(160);
    if (stopping) throw new Error('WATCH_STOP_REQUESTED');
  }
  return normalizeUpbitSnapshot(spotMarkets, all, Date.now());
}
async function futuresSnapshot() {
  const payload = await publicJson(BITGET + '/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  return normalizeBitgetSnapshot(payload, Date.now());
}
async function readSmallFileNoFollow(path, maxBytes = 4_000_000) {
  const meta = await lstat(path);
  if (!meta.isFile() || meta.nlink !== 1 || meta.size > maxBytes
    || (meta.mode & 0o022) !== 0) throw new Error('UNSAFE_INPUT_FILE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const next = await handle.stat();
    if (!next.isFile() || next.ino !== meta.ino || next.size > maxBytes
      || next.nlink !== 1) throw new Error('INPUT_FILE_CHANGED');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}
async function stockSnapshot(root, market) {
  const path = join(root, 'market-watch-input', market + '.json');
  try {
    const contents = await readSmallFileNoFollow(path);
    return normalizeStockFeed(JSON.parse(contents), market, Date.now());
  } catch (error) {
    if (error?.code === 'ENOENT') return blockedSource(market, 'BLOCKED_PUBLIC_STOCK_FEED_MISSING');
    return blockedSource(market, 'BLOCKED_' + errorCode(error, 'PUBLIC_STOCK_FEED_INVALID'));
  }
}
async function readExisting(path) {
  try { return JSON.parse(await readSmallFileNoFollow(path, 8_000_000)); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('WATCH_PREVIOUS_STATE_INVALID');
  }
}
async function resourceTelemetry(root) {
  const m = await readFile('/proc/meminfo', 'utf8');
  const match = m.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  const storage = await statfs(root);
  return {
    cpuCount: cpus().length, loadOne: loadavg()[0],
    memoryAvailableBytes: match ? Number(match[1]) * 1024 : null,
    diskFreeBytes: Number(storage.bavail) * Number(storage.bsize),
  };
}
async function acquire(root) {
  const lock = join(root, 'watch', 'market-watch.lock');
  try {
    const handle = await open(lock, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid }) + '\n'); }
    finally { await handle.close(); }
    return lock;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const prior = await readExisting(lock);
    const pid = Number(prior?.pid);
    if (!(pid > 0 && Number.isInteger(pid))) throw new Error('WATCH_LOCK_INVALID');
    try {
      process.kill(pid, 0);
      throw new Error('WATCH_ALREADY_RUNNING');
    } catch (probeError) {
      if (probeError?.code !== 'ESRCH') throw probeError;
    }
    await rm(lock);
    const handle = await open(lock, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid }) + '\n'); }
    finally { await handle.close(); }
    return lock;
  }
}
async function cycle(root, researchSha, previous, telemetry) {
  const pollStartedAtMs = Date.now();
  const budget = evaluateWatchBudget(telemetry);
  const marketSummaries = [];
  const marketStates = {};
  const allCandidates = [];
  const savedAlerts = Object.fromEntries(Object.entries(previous?.lastAlerts ?? {})
    .filter(([, at]) => Number.isFinite(at) && pollStartedAtMs - at < 24 * 60 * 60_000));
  const sources = {};
  if (budget.status === 'RUN') {
    for (const market of WATCH_MARKETS) {
      try {
        sources[market] = market === 'CRYPTO_SPOT'
          ? await spotSnapshot(pollStartedAtMs)
          : market === 'CRYPTO_FUTURES'
            ? await futuresSnapshot()
            : await stockSnapshot(root, market);
      } catch (error) {
        sources[market] = blockedSource(market, 'BLOCKED_' + errorCode(error));
      }
      if (stopping) break;
    }
  }
  // The snapshot timestamp belongs to the completed public collection, not
  // the beginning of HTTP requests. Otherwise the first quote in the next
  // cycle can appear to be from the future when collection took >5 seconds.
  const nowMs = Date.now();
  for (const market of WATCH_MARKETS) {
    const source = sources[market] ?? blockedSource(
      market, budget.status === 'RUN' ? 'BLOCKED_STOPPED' : 'BLOCKED_HOST_' + budget.status,
    );
    const report = evaluateMarketOpportunities({
      market, source, nowMs,
      previous: previous?.marketStates?.[market],
      lastAlerts: savedAlerts,
    });
    marketSummaries.push(report.summary);
    marketStates[market] = source.quotes.length
      ? report.next : (previous?.marketStates?.[market] ?? report.next);
    for (const found of report.candidates) {
      // Exact public quote timestamps make a replayed observation recognizably
      // the same discovery after a crash; the event is still not a trade.
      const eventId = watchCycleDigest({
        researchSha, market, symbol: found.symbol,
        direction: found.direction, source: found.source,
        sourceAtMs: found.sourceAtMs,
        priorSourceAtMs: found.priorSourceAtMs,
      });
      allCandidates.push({ ...found, eventId, researchSha });
      savedAlerts[market + ':' + found.symbol + ':' + found.direction] = nowMs;
    }
  }
  // Research-only prospective evidence from public ticker snapshots. Real
  // future quotations are mandatory: no simulated fills, backfill or OOS PASS.
  const prospective = advancePublicWatchProspectiveEvidence({
    previousPending: previous?.prospectivePending ?? [],
    sources, discovered: allCandidates, nowMs,
  });
  const good = marketSummaries.filter((m) => m.status === 'READY').length;
  const partial = marketSummaries.filter((m) => m.status === 'PARTIAL_UNIVERSE'
    || m.status === 'PARTIAL_TICKERS').length;
  const state = {
    schemaVersion: WATCH_CONTRACT, researchSha, observedAt: new Date(nowMs).toISOString(),
    status: budget.status !== 'RUN' ? budget.status
      : good === 4 ? 'OBSERVING_ALL_FOUR'
        : good + partial > 0 ? 'PARTIAL_MARKET_COVERAGE' : 'BLOCKED_DATA',
    resourceBudget: budget,
    markets: marketSummaries,
    newCandidateCount: allCandidates.length,
    prospectiveObservation: {
      pendingCount: prospective.pendingCount,
      newlyObservedCoarse: prospective.completedCoarse,
      newlyBlockedData: prospective.blockedData,
      notTrackedDueToCapacityOrSource: prospective.notTrackedCount,
      status: 'PUBLIC_TICKER_SNAPSHOTS_ONLY',
      economicEvidenceCredit: 0,
      paperCredit: 0,
      oosCredit: 0,
      executionAuthority: 'NONE',
    },
    notes: [
      'Discovery evidence only; no formula PASS, ML, OOS, Paper admission or profitability.',
      'A missing/partial KR/US feed is not a full-universe market scan.',
    ],
    safety: WATCH_SAFETY,
  };
  const oldStats = previous?.stats && typeof previous.stats === 'object'
    ? previous.stats : {};
  const dayUtc = state.observedAt.slice(0, 10);
  const sameDay = oldStats.dayUtc === dayUtc;
  const previousCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000_000
    ? v : 0;
  const stats = Object.freeze({
    dayUtc,
    cyclesSinceRelease: previousCount(oldStats.cyclesSinceRelease) + 1,
    cyclesToday: (sameDay ? previousCount(oldStats.cyclesToday) : 0) + 1,
    candidatesToday: (sameDay ? previousCount(oldStats.candidatesToday) : 0)
      + allCandidates.length,
    observedCoarseToday: (sameDay ? previousCount(oldStats.observedCoarseToday) : 0)
      + prospective.completedCoarse,
    blockedProspectiveToday: (sameDay ? previousCount(oldStats.blockedProspectiveToday) : 0)
      + prospective.blockedData,
    daysInService: previousCount(oldStats.daysInService)
      + (oldStats.dayUtc === dayUtc ? 0 : 1),
    lastCollectedAt: good + partial > 0 ? state.observedAt
      : typeof oldStats.lastCollectedAt === 'string'
        ? oldStats.lastCollectedAt : null,
    lastCandidateAt: allCandidates.length ? state.observedAt
      : typeof oldStats.lastCandidateAt === 'string'
        ? oldStats.lastCandidateAt : null,
  });
  // These counters report observed cycles, not proven 24-hour uptime or
  // independent economic samples.
  state.statistics = stats;
  const next = { schemaVersion: WATCH_CONTRACT, researchSha,
    marketStates, lastAlerts: savedAlerts,
    prospectivePending: prospective.pending, stats };
  // Emit observations before advancing the local cursor: a storage failure
  // must not silently discard a discovered candidate. Consumers must dedupe
  // eventId because a crash between these writes can replay the same event.
  await appendBoundedWatchEvents(root, prospective.outcomes, state.observedAt, 'outcomes');
  await appendBoundedWatchEvents(root, allCandidates, state.observedAt, 'events');
  await atomicDurableWatchJson(join(root, 'watch', 'state-v1.json'), next);
  await atomicDurableWatchJson(join(root, 'latest', 'lightweight-market-watch.json'),
    state, WATCH_STORAGE_LIMITS.publicStatusJsonBytes);
  // Only record this cadence trace after the local state and public status
  // have been durably published. A missed heartbeat never becomes proof.
  await appendBoundedWatchEvents(root, [makePublicWatchCadenceRecord(state)],
    state.observedAt, 'cadence');
  process.stdout.write(JSON.stringify({
    observedAt: state.observedAt, status: state.status,
    budget: state.resourceBudget.status,
    markets: state.markets.map((m) => ({ market: m.market, status: m.status,
      scanned: m.observedCount, newCandidates: m.newCandidates })),
    newCandidateCount: state.newCandidateCount,
    orderAuthority: 'NONE',
  }) + '\n');
  return { next, budget };
}
async function main() {
  const root = resolve(process.env.RESEARCH_STATE_ROOT ?? '');
  const repoRoot = resolve(process.env.RESEARCH_REPO_ROOT ?? '');
  const sha = String(process.env.RESEARCH_CODE_SHA ?? '').trim().toLowerCase();
  if (!process.env.RESEARCH_STATE_ROOT || !process.env.RESEARCH_REPO_ROOT)
    throw new Error('RESEARCH_ROOT_CONFIGURATION_REQUIRED');
  await preflightResearchProduction({
    repoRoot, stateRoot: root, researchSha: sha,
    env: process.env, verifyGitHead: true,
  });
  await mkdir(join(root, 'watch', 'events'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'watch', 'outcomes'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'watch', 'cadence'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'latest'), { recursive: true, mode: 0o700 });
  const lock = await acquire(root);
  try {
    let previous = await readExisting(join(root, 'watch', 'state-v1.json')) ?? {};
    if (previous.researchSha !== sha || previous.schemaVersion !== WATCH_CONTRACT)
      previous = {};
    do {
      const telemetry = await resourceTelemetry(root);
      const result = await cycle(root, sha, previous, telemetry);
      previous = result.next;
      if (process.argv.includes('--once') || stopping) break;
      await sleep(result.budget.status === 'HOLD' ? 300_000
        : result.budget.status === 'THROTTLED' ? 240_000 : WATCH_LIMITS.intervalMs);
    } while (!stopping);
  } finally { await rm(lock, { force: true }); }
}
main().catch((error) => {
  process.stderr.write(JSON.stringify({
    status: 'FAILED_CLOSED', reason: errorCode(error, 'RESEARCH_WATCH_ERROR'),
    orderAuthority: 'NONE',
  }) + '\n');
  process.exitCode = 1;
});
