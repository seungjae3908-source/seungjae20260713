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
import {
  readForwardObserverScannerQualityArtifact,
  selectForwardObserverScannerBacktests,
} from '../../api-server/src/services/forward-observer-scanner-quality-consumer.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import { withScannerOutcome } from '../../api-server/src/services/scanner-signal.types';
import * as yahoo from '../../api-server/src/providers/yahoo';
import { getUsPublicUniverse } from '../../api-server/src/providers/us-universe';
import { adaptCanonicalScannerCard, adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import {
  canonicalAdapterInputForCard,
  canonicalAdapterInputsForCards,
  selectSignalAdmittedHandoffEntries,
} from '../src/auto-trading-handoff-bridge.mjs';
import { enrichFuturesLeverageInputs } from '../src/futures-leverage-enrichment.mjs';
import { assertSignalIntelligenceV3Snapshot, runSignalIntelligenceV3 } from '../src/engine.mjs';
import { validateMemberAutoTradingPaperHandoff } from '../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const STATE_DIR = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_DIR ?? './state');
const CYCLE_STATE_FILE = path.join(STATE_DIR, 'cycle-state.json');
const SNAPSHOT_FILE = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE ?? path.join(STATE_DIR, 'latest-snapshot.json'));
const HANDOFF_FILE = String(process.env.SIGNAL_INTELLIGENCE_CANONICAL_HANDOFF_FILE
  ?? '/opt/stock-app-data/paper-forward-v1/runtime-state/handoff/member-auto-trading-latest.json').trim();
const QUALITY_ROOT = String(process.env.SIGNAL_INTELLIGENCE_SCANNER_QUALITY_ROOT ?? '').trim();
// These are the existing public-only producer identities used by the canonical
// Paper observer. Signal IDs include memberId, so a different value makes an
// exact canonical handoff join structurally impossible.
const STOCK_MEMBER_ID = 'signal-intelligence-forward-observer-public-only';
const CRYPTO_MEMBER_ID = 'forward-observer-public-only';

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
const lanes = Object.freeze(marketProfiles.flatMap((market) => strategyProfiles.map((profile) => {
  const strategy = market.prefix === 'SPOT' && profile.label === 'SWING'
    ? { ...profile, timeframe: '4H' }
    : profile;
  return Object.freeze({
    ...market,
    ...strategy,
    id: `${market.prefix}_${strategy.label}_${strategy.timeframe.toUpperCase()}`,
  });
})));

function forwardObserverLane(lane) {
  if (lane.label !== 'SWING') return null;
  const ids = {
    KR_STOCK: 'KR_SWING_60M',
    US_STOCK: 'US_SWING_60M',
    CRYPTO_SPOT: 'SPOT_SWING_4H',
    CRYPTO_FUTURES: 'FUTURES_SWING_60M',
  };
  const id = ids[lane.market];
  return id ? Object.freeze({
    id,
    market: lane.market,
    scannerMarket: lane.scannerMarket,
    batchSize: lane.batchSize,
    timeframe: lane.timeframe,
  }) : null;
}

function unavailableQuality(status = 'DISABLED', blocker = null) {
  return Object.freeze({ status, matchedSymbols: Object.freeze([]), blockers: blocker
    ? Object.freeze([Object.freeze({ code: blocker, symbol: null })])
    : Object.freeze([]), backtests: Object.freeze({}) });
}

function qualitySelectionForCards(scannerQuality, lane, cards) {
  const qualityLane = forwardObserverLane(lane);
  if (!qualityLane || !scannerQuality) return unavailableQuality(scannerQuality ? 'NOT_APPLICABLE' : 'DISABLED');
  return selectForwardObserverScannerBacktests({
    artifact: scannerQuality,
    cards,
    lane: qualityLane,
    researchCodeSha: SERVICE_SHA,
  });
}

function freshState() {
  return {
    schemaVersion: 5,
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

async function canonicalHandoff(nowMs) {
  if (!HANDOFF_FILE) return { status: 'DISABLED', handoff: null, blocker: null };
  try {
    const value = JSON.parse(await readFile(path.resolve(HANDOFF_FILE), 'utf8'));
    const handoff = validateMemberAutoTradingPaperHandoff(value, nowMs);
    return { status: handoff.status, handoff, blocker: handoff.status === 'READY' ? null : handoff.blockers?.[0] ?? 'HANDOFF_BLOCKED' };
  } catch (error) {
    return { status: 'BLOCKED_DATA', handoff: null,
      blocker: error?.code === 'ENOENT' ? 'HANDOFF_MISSING' : String(error?.message ?? 'HANDOFF_INVALID').split(':')[0] };
  }
}

async function canonicalScannerQuality() {
  if (!QUALITY_ROOT) return { status: 'DISABLED', artifact: null, blocker: 'SCANNER_QUALITY_ROOT_NOT_CONFIGURED' };
  try {
    const artifact = await readForwardObserverScannerQualityArtifact({
      artifactRoot: path.resolve(QUALITY_ROOT),
      researchCodeSha: SERVICE_SHA,
    });
    return { status: 'READY', artifact, blocker: null };
  } catch (error) {
    return {
      status: 'BLOCKED_DATA',
      artifact: null,
      blocker: error?.code === 'ENOENT'
        ? 'SCANNER_QUALITY_ARTIFACT_MISSING'
        : String(error?.message ?? 'SCANNER_QUALITY_ARTIFACT_INVALID').split(':')[0],
    };
  }
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

function qualityArtifactCards(scannerQuality, lane) {
  if (!scannerQuality || lane.label !== 'SWING') return [];
  return scannerQuality.entries
    .filter((entry) => entry.identity.market === lane.market
      && entry.identity.timeframe === lane.timeframe
      && entry.identity.direction === 'BUY')
    .map((entry) => ({ symbol: entry.identity.symbol, action: entry.identity.direction }));
}

async function scanStock(lane, cursor, scannerQuality) {
  return withStockPublicOnly(lane, async () => {
    const qualitySelection = qualitySelectionForCards(
      scannerQuality,
      lane,
      qualityArtifactCards(scannerQuality, lane),
    );
    const scanned = await StockSignalScannerService.scan({
      memberId: STOCK_MEMBER_ID,
      market: lane.scannerMarket,
      indicators: [],
      filters: { timeframe: lane.timeframe },
      cursor,
      batchSize: lane.batchSize,
      strategyMode: lane.strategyMode,
      backtests: qualitySelection.backtests,
    });
    return withScannerCanonicalActions({
      ...scanned,
      cards: scanned.cards.map((card) => ({ ...card, dataSources: [...new Set([...card.dataSources, 'yahoo-public'])] })),
      scannerQualityDiagnostic: qualitySelection,
    });
  });
}

async function scanCryptoRaw(lane, cursor, scannerQuality) {
  const scanned = await CryptoSignalScannerService.scan({
    memberId: CRYPTO_MEMBER_ID,
    market: lane.scannerMarket,
    strategyMode: lane.strategyMode,
    timeframe: lane.timeframe,
    condition: 'trend',
    cursor,
    batchSize: lane.scannerMarket === 'spot' ? Math.min(lane.batchSize, 5) : Math.min(lane.batchSize, 10),
  });
  const aligned = await CryptoPricePrecisionService.align(lane.scannerMarket, scanned);
  const qualitySelection = qualitySelectionForCards(scannerQuality, lane, aligned.cards);
  const ranking = rankScannerCandidates({
    cards: aligned.cards,
    market: aligned.market,
    strategy: lane.strategyMode,
    backtests: qualitySelection.backtests,
    limit: 10,
  });
  const cards = ranking.cards
    .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
    .filter((card) => lane.scannerMarket === 'spot'
      ? card.direction === 'LONG'
      : card.direction === 'LONG' || card.direction === 'SHORT');
  return withScannerCanonicalActions(withScannerOutcome({
    ...aligned,
    cards,
    scannerQualityDiagnostic: qualitySelection,
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

async function scanCrypto(lane, cursor, scannerQuality) {
  if (lane.scannerMarket === 'spot') return withUpbitPacing(() => scanCryptoRaw(lane, cursor, scannerQuality));
  return scanCryptoRaw(lane, cursor, scannerQuality);
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const persistedState = await readJson(CYCLE_STATE_FILE, null);
  const releaseChanged = persistedState?.serviceSha !== SERVICE_SHA || persistedState?.schemaVersion !== 5;
  const state = releaseChanged ? freshState() : persistedState;
  const persistedSnapshot = await readJson(SNAPSHOT_FILE, null);
  const previousSnapshot = !releaseChanged && persistedSnapshot?.serviceSha === SERVICE_SHA ? persistedSnapshot : null;
  const nowMs = Date.now();
  let handoffState = await canonicalHandoff(nowMs);
  const scannerQualityState = await canonicalScannerQuality();
  const sourceCycleId = randomUUID();
  pruneRetained(state, nowMs);

  const coverage = [];
  for (const lane of lanes) {
    const cursor = Number.isInteger(state.cursors?.[lane.id]) ? state.cursors[lane.id] : 0;
    try {
      const response = lane.market === 'KR_STOCK' || lane.market === 'US_STOCK'
        ? await scanStock(lane, cursor, scannerQualityState.artifact)
        : await scanCrypto(lane, cursor, scannerQualityState.artifact);
      const decision = publicCyclePageDecision(response, lane.market, cursor, state.rosterIds?.[lane.id] ?? null);
      const rosterId = response.universe.rosterId ?? null;
      if (['VERIFIED_BATCH', 'BLOCKED_RESEARCH_ROTATION_ONLY', 'ROSTER_CHANGED_RESTART', 'ROSTER_SHRUNK_RESTART'].includes(decision.reason)) {
        state.rosterIds[lane.id] = rosterId;
      }
      const status = decision.status;
      let adapted = [];
      let leverageDiagnostics = { evaluated: 0, available: 0, blocked: 0, unavailable: 0 };
      let bridgeDiagnostics = { scanned: response.cards.length, joined: 0,
        blocked: response.cards.length, sGradeScanned: response.cards.filter((card) => card.signalGrade === 'S').length,
        joinedSGrade: 0, handoffStatus: handoffState.status };
      if (status !== 'SEARCH_FAILURE' && status !== 'BLOCKED_DATA') {
        const laneNowMs = Date.now();
        handoffState = await canonicalHandoff(laneNowMs);
        clearScannedWindow(state, lane.id, cursor);
        const bridge = canonicalAdapterInputsForCards(response.cards, lane.timeframe, handoffState.handoff);
        const admissionInputs = bridge.inputs.filter((input) => input.paperIdentity && input.card?.signalGrade === 'S');
        bridgeDiagnostics = {
          ...bridge.diagnostics,
          handoffStatus: handoffState.status,
          sGradeScanned: response.cards.filter((card) => card.signalGrade === 'S').length,
          joinedSGrade: admissionInputs.length,
        };
        adapted = adaptCanonicalScannerCards(admissionInputs, { nowMs: laneNowMs });
        if (lane.market === 'CRYPTO_FUTURES' && adapted.length > 0) {
          const enriched = await enrichFuturesLeverageInputs(adapted, response.cards, {
            maxCandidates: 2,
            strategy: lane.label,
            nowMs: laneNowMs,
            minimumStartIntervalMs: 100,
          });
          adapted = [...enriched.inputs];
          leverageDiagnostics = enriched.diagnostics;
        }
        for (const input of adapted) {
          const card = response.cards.find((candidate) => candidate.symbol === input.symbol && String(candidate.action ?? candidate.direction) === input.direction)
            ?? response.cards.find((candidate) => candidate.symbol === input.symbol);
          state.retained[retainedKey(input)] = {
            card,
            timeframe: lane.timeframe,
            leverageEvidence: input.leverageEvidence,
            provenance: { laneId: lane.id, cursor, sourceCycleId, rosterId },
            expiresAt: card?.expiresAt ?? fallbackExpiry(lane, laneNowMs),
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
          failuresObserved: response.failures.length,
          providerAcceptedCount: Number(response.execution.providerAcceptedCount ?? 0),
          dataSuccessCount: Number(response.execution.dataSuccessCount ?? 0),
          insufficientDataCount: Number(response.execution.insufficientDataCount ?? 0),
          filteredByStrategyCount: Number(response.execution.filteredByStrategyCount ?? 0),
          staleCount: Number(response.execution.staleCount ?? 0) },
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
        sGradeCards: response.cards.filter((card) => card.signalGrade === 'S').length,
        retainedFromBatch: adapted.length,
        status,
        outcome: response.outcome ?? null,
        providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount,
        leverage: leverageDiagnostics,
        scannerQuality: {
          artifactStatus: scannerQualityState.status,
          artifactBlocker: scannerQualityState.blocker,
          selectionStatus: response.scannerQualityDiagnostic?.status ?? 'UNAVAILABLE',
          matchedSymbols: response.scannerQualityDiagnostic?.matchedSymbols?.length ?? 0,
          blockerCount: response.scannerQualityDiagnostic?.blockers?.length ?? 0,
        },
        canonicalHandoffJoin: bridgeDiagnostics,
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

  const publicationNowMs = Date.now();
  pruneRetained(state, publicationNowMs);
  handoffState = await canonicalHandoff(publicationNowMs);
  const inputs = Object.values(state.retained)
    .map((row) => {
      const rebound = canonicalAdapterInputForCard(row.card, row.timeframe, handoffState.handoff);
      const adapted = adaptCanonicalScannerCard({ ...rebound, leverageEvidence: row.leverageEvidence }, { nowMs: publicationNowMs });
      return adapted ? { ...adapted, provenance: { ...adapted.provenance, ...row.provenance } } : null;
    })
    .filter(Boolean);
  const baseSnapshot = runSignalIntelligenceV3(inputs, { previousSnapshot });
  const snapshot = {
    ...baseSnapshot,
    sourceCycleId,
    rosterBindingVersion: 1,
    serviceSha: SERVICE_SHA,
    profile: { strategies: ['SCALPING', 'SWING', 'MID_LONG'], timeframes: ['15m', '60m', '4H', '1D'],
      spotSwingTimeframe: '4H', fullStrategyCoverage: true },
    coverage,
    publicDataOnly: true,
    canonicalHandoff: { status: handoffState.status, blocker: handoffState.blocker,
      entryCount: handoffState.handoff?.entryCount ?? 0 },
    scannerQuality: { status: scannerQualityState.status, blocker: scannerQualityState.blocker,
      entryCount: scannerQualityState.artifact?.entries?.length ?? 0 },
    releaseStateReset: releaseChanged,
  };
  const publication = currentPublicCyclePublication(snapshot);
  snapshot.lists = publication.lists;
  snapshot.events = publication.events;
  snapshot.currentPageSourceReady = publication.currentPageReady;
  const workerSelection = selectSignalAdmittedHandoffEntries({
    handoff: handoffState.handoff,
    snapshot,
    expectedServiceSha: SERVICE_SHA,
    nowMs: Date.now(),
  });
  snapshot.canonicalWorkerHandoff = {
    status: workerSelection.status,
    candidateCount: workerSelection.candidateCount ?? 0,
    admittedCount: workerSelection.admittedCount ?? 0,
    rejectedCount: workerSelection.rejectedCount ?? (handoffState.handoff?.entryCount ?? 0),
    blockers: workerSelection.blockers,
    executionAuthority: 'NONE',
  };
  snapshot.marketSummary = Object.fromEntries(marketProfiles.map(({ market }) => {
    const pages = coverage.filter((row) => row.market === market);
    const selected = workerSelection.entries?.filter((entry) => entry.identity.market === market) ?? [];
    const queried = Math.max(0, ...pages.map((row) => Number(row.pageExecution?.requestedCount ?? 0)));
    const successful = Math.max(0, ...pages.map((row) => Number(row.pageExecution?.dataSuccessCount ?? 0)));
    return [market, {
      totalUniverse: Math.max(0, ...pages.map((row) => Number(row.totalUniverse ?? 0))),
      queriedCount: queried,
      dataSuccessCount: successful,
      dataBlockedCount: Math.max(0, queried - successful),
      sGradeCandidateCount: pages.reduce((sum, row) => sum + Number(row.sGradeCards ?? 0), 0),
      canonicalJoinCount: pages.reduce((sum, row) => sum + Number(row.canonicalHandoffJoin?.joinedSGrade ?? 0), 0),
      workerAdmissionCount: selected.length,
      errorCount: pages.reduce((sum, row) => sum + Number(row.providerErrors ?? 0)
        + Number(row.timeouts ?? 0) + Number(row.pageExecution?.failuresObserved ?? 0)
        + (row.error ? 1 : 0), 0),
    }];
  }));
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
    canonicalHandoff: snapshot.canonicalHandoff,
    canonicalWorkerHandoff: snapshot.canonicalWorkerHandoff,
    scannerQuality: snapshot.scannerQuality,
    marketSummary: snapshot.marketSummary,
    releaseStateReset: releaseChanged,
    coverage,
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
