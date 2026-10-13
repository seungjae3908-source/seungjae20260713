// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicCyclePageDecision, currentPublicCyclePublication } from '../src/public-cycle-progress-v2.mjs';
import { withPublicStockProvider } from '../src/public-stock-provider-adapter.mjs';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { CryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../../api-server/src/services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../../api-server/src/services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import { withScannerOutcome } from '../../api-server/src/services/scanner-signal.types';
import * as yahoo from '../../api-server/src/providers/yahoo';
import { getUsPublicUniverse } from '../../api-server/src/providers/us-universe';
import { adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import { enrichFuturesLeverageInputs } from '../src/futures-leverage-enrichment.mjs';
import { assertSignalIntelligenceV3Snapshot, runSignalIntelligenceV3 } from '../src/engine.mjs';

const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const STATE_DIR = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_DIR ?? './state');
const CYCLE_STATE_FILE = path.join(STATE_DIR, 'cycle-state.json');
const SNAPSHOT_FILE = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE ?? path.join(STATE_DIR, 'latest-snapshot.json'));
const MEMBER_ID = 'signal-intelligence-v3-public-only';

if (!/^[0-9a-f]{40}$/u.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');

const strategyProfiles = Object.freeze([
  Object.freeze({ label: 'SCALPING', strategyMode: 'scalping', timeframe: '15m' }),
  Object.freeze({ label: 'SWING', strategyMode: 'swing', timeframe: '60m' }),
  Object.freeze({ label: 'MID_LONG', strategyMode: 'position', timeframe: '1D' }),
]);
const marketProfiles = Object.freeze([
  Object.freeze({ prefix: 'KR', market: 'KR_STOCK', scannerMarket: 'KR', batchSize: 20 }),
  Object.freeze({ prefix: 'US', market: 'US_STOCK', scannerMarket: 'US', batchSize: 20 }),
  Object.freeze({ prefix: 'SPOT', market: 'CRYPTO_SPOT', scannerMarket: 'spot', batchSize: 20 }),
  Object.freeze({ prefix: 'FUTURES', market: 'CRYPTO_FUTURES', scannerMarket: 'futures', batchSize: 20 }),
]);
const lanes = Object.freeze(marketProfiles.flatMap((market) => strategyProfiles.map((strategy) => Object.freeze({
  ...market,
  ...strategy,
  id: `${market.prefix}_${strategy.label}_${strategy.timeframe.toUpperCase()}`,
}))));

function freshState() {
  return {
    schemaVersion: 3,
    serviceSha: SERVICE_SHA,
    cursors: Object.fromEntries(lanes.map((lane) => [lane.id, 0])),
    rosterIds: Object.fromEntries(lanes.map((lane) => [lane.id, null])),
    retained: {},
    updatedAt: new Date(0).toISOString(),
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

function retainedKey(input) {
  return [input.market, input.symbol, input.strategy, input.timeframe, input.direction].join('|');
}

function pruneRetained(state, nowMs) {
  for (const [key, row] of Object.entries(state.retained ?? {})) {
    const expires = Date.parse(String(row?.expiresAt ?? ''));
    if (!Number.isFinite(expires) || expires <= nowMs) delete state.retained[key];
  }
}

function clearScannedWindow(state, laneId, cursor) {
  for (const [key, row] of Object.entries(state.retained ?? {})) {
    if (row?.laneId === laneId && row?.cursor === cursor) delete state.retained[key];
  }
}

function fallbackExpiry(lane, nowMs) {
  if (lane.timeframe === '15m') return new Date(nowMs + 45 * 60_000).toISOString();
  if (lane.timeframe === '60m') return new Date(nowMs + 3 * 60 * 60_000).toISOString();
  return new Date(nowMs + 3 * 24 * 60 * 60_000).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStartScheduler(minIntervalMs) {
  let tail = Promise.resolve();
  let nextStartAt = 0;
  return async (operation) => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const delayMs = Math.max(0, nextStartAt - Date.now());
    if (delayMs > 0) await sleep(delayMs);
    nextStartAt = Date.now() + minIntervalMs;
    release();
    return operation();
  };
}

async function usPublicUniverse() {
  // Same strict two-source/footer validation as the normal app. No alternate
  // permissive parser or paid-provider call is used by the public producer.
  const entries = await getUsPublicUniverse();
  return { entries, totalCount: entries.length, source: 'nasdaq-trader-public-directory',
    partial: false, stale: false, providerErrorCount: 0, loadedAt: new Date().toISOString() };
}

async function withUpbitPacing(operation) {
  const originalFetch = globalThis.fetch;
  const schedule = createStartScheduler(130);
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return originalFetch(input, init); }
    if (parsed.hostname !== 'api.upbit.com') return originalFetch(input, init);

    let lastError;
    let lastResponse;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const response = await schedule(() => originalFetch(input, init));
        lastResponse = response;
        if (response.status !== 429) return response;
        if (attempt < 4) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 250 * attempt;
          await sleep(backoff);
        }
      } catch (error) {
        lastError = error;
        if (init?.signal?.aborted) throw error;
        if (attempt < 4) await sleep(250 * attempt);
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error('UPBIT_PUBLIC_FETCH_FAILED');
  };
  try { return await operation(); } finally { globalThis.fetch = originalFetch; }
}

async function withStockPublicOnly(lane, operation) {
  const marketData = MarketDataService;
  const universe = ScannerUniverseService;
  const originalUniverseGet = universe.get;

  let targetUniverse;
  if (lane.market === 'US_STOCK') {
    try {
      targetUniverse = await usPublicUniverse();
    } catch {
      const fallback = await originalUniverseGet.call(universe, 'US');
      targetUniverse = {
        ...fallback,
        partial: true,
        stale: true,
        providerErrorCount: Math.max(1, Number(fallback.providerErrorCount ?? 0)),
      };
    }
  } else {
    targetUniverse = await originalUniverseGet.call(universe, 'KR');
  }

  universe.get = async (market, signal, deadlineMs) => {
    if (market === lane.scannerMarket) return targetUniverse;
    return originalUniverseGet.call(universe, market, signal, deadlineMs);
  };

  try { return await withPublicStockProvider({ marketData, yahoo, entries: targetUniverse?.entries ?? [], market: lane.market }, operation); } finally {
    universe.get = originalUniverseGet;
  }
}

async function scanStock(lane, cursor) {
  return withStockPublicOnly(lane, async () => {
    const scanned = await StockSignalScannerService.scan({
      memberId: MEMBER_ID,
      market: lane.scannerMarket,
      indicators: [],
      filters: { timeframe: lane.timeframe },
      cursor,
      batchSize: lane.batchSize,
      strategyMode: lane.strategyMode,
    });
    return withScannerCanonicalActions({
      ...scanned,
      cards: scanned.cards.map((card) => ({ ...card, dataSources: [...new Set([...card.dataSources, 'yahoo-public'])] })),
    });
  });
}

async function scanCryptoRaw(lane, cursor) {
  const scanned = await CryptoSignalScannerService.scan({
    memberId: MEMBER_ID,
    market: lane.scannerMarket,
    strategyMode: lane.strategyMode,
    timeframe: lane.timeframe,
    condition: 'trend',
    cursor,
    batchSize: lane.scannerMarket === 'spot' ? Math.min(lane.batchSize, 5) : Math.min(lane.batchSize, 10),
  });
  const aligned = await CryptoPricePrecisionService.align(lane.scannerMarket, scanned);
  const ranking = rankScannerCandidates({ cards: aligned.cards, market: aligned.market, strategy: lane.strategyMode, limit: 10 });
  const cards = ranking.cards
    .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
    .filter((card) => lane.scannerMarket === 'spot'
      ? card.direction === 'LONG'
      : card.direction === 'LONG' || card.direction === 'SHORT');
  return withScannerCanonicalActions(withScannerOutcome({
    ...aligned,
    cards,
    execution: {
      ...aligned.execution,
      hardFilterPassCount: ranking.diagnostics.hardFilterPassCount,
      hardFilterRejectedCount: ranking.diagnostics.hardFilterRejectedCount,
      softCandidateCount: ranking.diagnostics.softCandidateCount,
      finalDisplayedCount: cards.length,
      sGradeCount: cards.filter((card) => card.signalGrade === 'S').length,
      aGradeCount: cards.filter((card) => card.signalGrade === 'A').length,
      bGradeCount: cards.filter((card) => card.signalGrade === 'B').length,
      backtestMissingCount: ranking.diagnostics.backtestMissingCount,
    },
  }));
}

async function scanCrypto(lane, cursor) {
  if (lane.scannerMarket === 'spot') return withUpbitPacing(() => scanCryptoRaw(lane, cursor));
  return scanCryptoRaw(lane, cursor);
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const persistedState = await readJson(CYCLE_STATE_FILE, null);
  const releaseChanged = persistedState?.serviceSha !== SERVICE_SHA || persistedState?.schemaVersion !== 3;
  const state = releaseChanged ? freshState() : persistedState;
  const persistedSnapshot = await readJson(SNAPSHOT_FILE, null);
  const previousSnapshot = !releaseChanged && persistedSnapshot?.serviceSha === SERVICE_SHA ? persistedSnapshot : null;
  const nowMs = Date.now();
  const sourceCycleId = randomUUID();
  pruneRetained(state, nowMs);

  const coverage = [];
  for (const lane of lanes) {
    const cursor = Number.isInteger(state.cursors?.[lane.id]) ? state.cursors[lane.id] : 0;
    try {
      const response = lane.market === 'KR_STOCK' || lane.market === 'US_STOCK'
        ? await scanStock(lane, cursor)
        : await scanCrypto(lane, cursor);
      const decision = publicCyclePageDecision(response, lane.market, cursor, state.rosterIds?.[lane.id] ?? null);
      const rosterId = response.universe.rosterId ?? null;
      if (['VERIFIED_BATCH', 'BLOCKED_RESEARCH_ROTATION_ONLY', 'ROSTER_CHANGED_RESTART', 'ROSTER_SHRUNK_RESTART'].includes(decision.reason)) {
        state.rosterIds[lane.id] = rosterId;
      }
      const status = decision.status;
      let adapted = [];
      let leverageDiagnostics = { evaluated: 0, available: 0, blocked: 0, unavailable: 0 };
      if (status !== 'SEARCH_FAILURE' && status !== 'BLOCKED_DATA') {
        clearScannedWindow(state, lane.id, cursor);
        adapted = adaptCanonicalScannerCards(response.cards.map((card) => ({ card, timeframe: lane.timeframe })), { nowMs });
        if (lane.market === 'CRYPTO_FUTURES' && adapted.length > 0) {
          const enriched = await enrichFuturesLeverageInputs(adapted, response.cards, {
            maxCandidates: 2,
            strategy: lane.label,
            nowMs,
            minimumStartIntervalMs: 100,
          });
          adapted = [...enriched.inputs];
          leverageDiagnostics = enriched.diagnostics;
        }
        for (const input of adapted) {
          const card = response.cards.find((candidate) => candidate.symbol === input.symbol && String(candidate.action ?? candidate.direction) === input.direction)
            ?? response.cards.find((candidate) => candidate.symbol === input.symbol);
          state.retained[retainedKey(input)] = {
            input: { ...input, provenance: { ...input.provenance, laneId: lane.id, cursor, sourceCycleId, rosterId } },
            expiresAt: card?.expiresAt ?? fallbackExpiry(lane, nowMs),
            laneId: lane.id,
            cursor,
          };
        }
      }
      state.cursors[lane.id] = decision.nextCursor;
      coverage.push({
        laneId: lane.id,
        sourceCycleId,
        rosterId,
        cursorRotatedBlockedOnly: decision.blockedObservationOnly,
        cursorRotationReason: decision.reason,
        pageExecution: { requestedCount: response.execution.requestedCount, startedCount: response.execution.startedCount,
          completedCount: response.execution.completedCount, partial: response.execution.partial,
          timedOut: response.execution.timedOut, cancelled: response.execution.cancelled,
          failuresObserved: response.failures.length },
        market: lane.market,
        strategy: lane.label,
        timeframe: lane.timeframe,
        cursorBefore: cursor,
        cursorAfter: state.cursors[lane.id],
        totalUniverse: response.universe.totalCount,
        universeSource: response.universe.source ?? null,
        universePartial: response.universe.partial,
        universeStale: response.universe.stale,
        universeProviderErrors: Number(response.universe.providerErrorCount ?? 0),
        responseDataState: response.dataState ?? null,
        scannedCards: response.cards.length,
        retainedFromBatch: adapted.length,
        status,
        outcome: response.outcome ?? null,
        providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount,
        leverage: leverageDiagnostics,
        lastGoodPreserved: status === 'SEARCH_FAILURE' || status === 'BLOCKED_DATA',
      });
    } catch (error) {
      coverage.push({
        laneId: lane.id,
        market: lane.market,
        strategy: lane.label,
        timeframe: lane.timeframe,
        cursorBefore: cursor,
        cursorAfter: cursor,
        totalUniverse: null,
        scannedCards: 0,
        retainedFromBatch: 0,
        status: 'SEARCH_FAILURE',
        leverage: { evaluated: 0, available: 0, blocked: 0, unavailable: 0 },
        lastGoodPreserved: true,
        error: error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN',
      });
    }
  }

  pruneRetained(state, nowMs);
  const inputs = Object.values(state.retained).map((row) => row.input);
  const baseSnapshot = runSignalIntelligenceV3(inputs, { previousSnapshot });
  const snapshot = {
    ...baseSnapshot,
    sourceCycleId,
    rosterBindingVersion: 1,
    serviceSha: SERVICE_SHA,
    profile: { strategies: ['SCALPING', 'SWING', 'MID_LONG'], timeframes: ['15m', '60m', '1D'], fullStrategyCoverage: true },
    coverage,
    publicDataOnly: true,
    releaseStateReset: releaseChanged,
  };
  const publication = currentPublicCyclePublication(snapshot);
  snapshot.lists = publication.lists;
  snapshot.events = publication.events;
  snapshot.currentPageSourceReady = publication.currentPageReady;
  assertSignalIntelligenceV3Snapshot(snapshot);
  state.updatedAt = new Date().toISOString();
  await atomicJson(CYCLE_STATE_FILE, state);
  await atomicJson(SNAPSHOT_FILE, snapshot);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    serviceSha: SERVICE_SHA,
    retainedInputs: inputs.length,
    lists: Object.fromEntries(Object.entries(snapshot.lists).map(([key, rows]) => [key, rows.length])),
    events: snapshot.events.length,
    profile: snapshot.profile,
    releaseStateReset: releaseChanged,
    coverage,
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
