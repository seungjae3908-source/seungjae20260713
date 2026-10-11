// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { createCryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../../api-server/src/services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../../api-server/src/services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import * as yahoo from '../../api-server/src/providers/yahoo';
import { parseNasdaqTraderDirectories } from '../../market-prediction-lab/src/public-coverage-audit-v1.js';
import { adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import { enrichFuturesLeverageInputs } from '../src/futures-leverage-enrichment.mjs';
import { assertSignalIntelligenceV3Snapshot, runSignalIntelligenceV3 } from '../src/engine.mjs';
import { summarizePublicProviderFailureReasons } from '../src/public-provider-cycle-diagnostics.mjs';
import { getPublicScannerProfileSet, PUBLIC_V3_FUTURES_STAGE_TWO_LIMIT } from '../src/public-scanner-profiles.mjs';
import { withReadOnlyStockProviderOverlay } from '../src/public-stock-provider-overlay.mjs';
import { resolvePublicResearchDataRetry, advancePublicResearchIndexProgress } from '../src/public-research-rotation.mjs';
import {decidePublicRosterContinuity,hashPublicStockSourceRoster} from '../src/public-roster-integrity.mjs';
import {createPublicV3CryptoProviders} from '../src/public-v3-crypto-providers.mjs';
import {createPublicStockSourceAudit} from '../src/public-stock-source-audit.mjs';
import {choosePublicStockCandles,choosePublicStockQuote} from '../src/public-stock-source-selection.mjs';
import {createPublicKrAlphaHistoricalDailyFeed} from '../src/public-kr-alpha-historical-daily.mjs';
import {publicKrAlphaDailyQuote} from '../src/public-kr-alpha-daily.mjs';
import {includeProvisionalKrAlphanumericRoster} from '../src/public-kr-provisional-roster.mjs';
import {suppressProvisionalKrResearchSignals} from '../src/public-kr-provisional-filter.mjs';
import {
  classifyPublicCycleLaneStatus,
  PUBLIC_V3_SPOT_STAGE_TWO_LIMIT,
  parsePublicRetryAfterMs,
  publicUpbitGroupForUrl,
  createPublicUpbitGroupPacer,
  publicBitgetMarketEndpoint,
  createPublicBitgetMarketPacer,
} from '../src/public-cycle-coverage.mjs';

const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const STATE_DIR = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_DIR ?? './state');
const CYCLE_STATE_FILE = path.join(STATE_DIR, 'cycle-state.json');
const SNAPSHOT_FILE = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE ?? path.join(STATE_DIR, 'latest-snapshot.json'));
const MEMBER_ID = 'signal-intelligence-v3-public-only';
const PUBLIC_PROFILE_MODE = String(process.env.SIGNAL_INTELLIGENCE_PUBLIC_PROFILE_MODE ?? 'RESEARCH_V3').trim();
// Disabled by default; requires a dedicated read-only QA invocation.
// Never changes member scanning, Paper authority or canonical listing claims.
const KR_ALPHA_MODE = String(process.env.SIGNAL_INTELLIGENCE_KR_ALPHA_RESEARCH_MODE ?? 'NONE').trim();
if (!['NONE','PILOT'].includes(KR_ALPHA_MODE)) throw new Error('KR_ALPHA_RESEARCH_MODE_INVALID');
if (KR_ALPHA_MODE === 'PILOT'
  && (process.env.SIGNAL_INTELLIGENCE_KR_ALPHA_RESEARCH_QA !== 'true'
    || process.env.SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY !== 'NONE'
    || process.env.LIVE_TRADING !== 'false'))
  throw new Error('KR_ALPHA_PUBLIC_QA_EXPLICIT_READONLY_GATE_REQUIRED');
const KR_ALPHA_DAILY_FEED = createPublicKrAlphaHistoricalDailyFeed();
if (PUBLIC_PROFILE_MODE === 'MEMBER_UI' && process.env.SIGNAL_INTELLIGENCE_MEMBER_UI_QA !== 'true')
  throw new Error('SIGNAL_INTELLIGENCE_MEMBER_UI_QA_EXPLICIT_FLAG_REQUIRED');
const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

if (!/^[0-9a-f]{40}$/u.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');

const strategyProfiles = getPublicScannerProfileSet(PUBLIC_PROFILE_MODE);
const marketProfiles = Object.freeze([
  Object.freeze({ prefix: 'KR', market: 'KR_STOCK', scannerMarket: 'KR', batchSize: PUBLIC_PROFILE_MODE === 'MEMBER_UI' ? 10 : 20 }),
  Object.freeze({ prefix: 'US', market: 'US_STOCK', scannerMarket: 'US', batchSize: PUBLIC_PROFILE_MODE === 'MEMBER_UI' ? 10 : 20 }),
  Object.freeze({ prefix: 'SPOT', market: 'CRYPTO_SPOT', scannerMarket: 'spot', batchSize: PUBLIC_V3_SPOT_STAGE_TWO_LIMIT }),
  Object.freeze({ prefix: 'FUTURES', market: 'CRYPTO_FUTURES', scannerMarket: 'futures', batchSize: PUBLIC_V3_FUTURES_STAGE_TWO_LIMIT }),
]);
const lanes = Object.freeze(marketProfiles.flatMap((market) => strategyProfiles.map((strategy) => Object.freeze({
  ...market,
  ...strategy,
  id: `${market.prefix}_${strategy.label}_${strategy.timeframe.toUpperCase()}`,
}))));

function freshState() {
  return {
    schemaVersion: 2,
    serviceSha: SERVICE_SHA,
    profileMode: PUBLIC_PROFILE_MODE,
    cursors: Object.fromEntries(lanes.map((lane) => [lane.id, 0])),
    dataRetry: Object.fromEntries(lanes.map((lane) => [lane.id, null])),
    coverageProgress: Object.fromEntries(lanes.map((lane) => [lane.id, null])),
    rosterDigests: Object.fromEntries(lanes.map((lane) => [lane.id, null])),
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
  if (lane.timeframe === '5m') return new Date(nowMs + 15 * 60_000).toISOString();
  if (lane.timeframe === '4H') return new Date(nowMs + 12 * 60 * 60_000).toISOString();
  if (lane.timeframe === '15m') return new Date(nowMs + 45 * 60_000).toISOString();
  if (lane.timeframe === '60m') return new Date(nowMs + 3 * 60 * 60_000).toISOString();
  return new Date(nowMs + 3 * 24 * 60 * 60_000).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('PUBLIC_DIRECTORY_TIMEOUT')), 8_000);
    try {
      const response = await fetch(url, {
        headers: { accept: 'text/plain', 'user-agent': 'signal-intelligence-v3/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`PUBLIC_DIRECTORY_HTTP_${response.status}`), { status: response.status });
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(250 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

let usPublicUniversePromise;
async function usPublicUniverse() {
  if (!usPublicUniversePromise) {
    usPublicUniversePromise = Promise.all([fetchText(NASDAQ_LISTED_URL), fetchText(OTHER_LISTED_URL)])
      .then(([nasdaqText, otherText]) => {
        const parsed = parseNasdaqTraderDirectories({ nasdaqText, otherText });
        if (!parsed || parsed.partial === true || !Array.isArray(parsed.entries) || parsed.entries.length < 1_000) {
          throw new Error('NASDAQ_TRADER_UNIVERSE_INCOMPLETE');
        }
        return {
          entries: parsed.entries,
          totalCount: parsed.entries.length,
          source: parsed.source,
          partial: false,
          stale: false,
          providerErrorCount: 0,
          loadedAt: new Date().toISOString(),
          rawTotal: parsed.rawTotal,
          exclusionReasons: parsed.exclusionReasons,
        };
      })
      .catch((error) => {
        usPublicUniversePromise = undefined;
        throw error;
      });
  }
  return usPublicUniversePromise;
}

function yahooProviderCandidates(lane, ticker, entry) {
  const clean = String(ticker ?? '').trim().toUpperCase();
  if (!clean) return [];
  if (lane.market === 'KR_STOCK' && /^\d{6}$/u.test(clean)) {
    const exchange = String(entry?.exchange ?? '').toUpperCase();
    const kosdaq = /KOSDAQ|코스닥/u.test(exchange);
    const primary = `${clean}.${kosdaq ? 'KQ' : 'KS'}`;
    const alternate = `${clean}.${kosdaq ? 'KS' : 'KQ'}`;
    return [primary, alternate];
  }
  if (lane.market === 'US_STOCK') {
    const canonical = /^[A-Z0-9]+\.[A-Z0-9]+$/u.test(clean) ? clean.replace(/\./gu, '-') : clean;
    const candidates = [canonical];
    if (canonical.includes('-')) candidates.push(canonical.replace(/-/gu, '.'));
    return [...new Set(candidates)];
  }
  return [clean];
}

async function withUpbitPacing(operation) {
  const originalFetch = globalThis.fetch;
  // Official public Quotation rate limits are separated by IP/group.
  // Only Research V3 uses this pacing: shared member, Forward, futures,
  // Paper worker timeouts and trading authority are unchanged.
  const pacer = createPublicUpbitGroupPacer();
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
    const group = publicUpbitGroupForUrl(rawUrl);
    if (group === null) return originalFetch(input, init);
    const signal = init?.signal ?? (typeof input === 'object' ? input?.signal : undefined);

    let lastError;
    let lastResponse;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('UPBIT_PUBLIC_V3_ABORTED');
      try {
        const response = await pacer.schedule(group, () => originalFetch(input, init), signal);
        lastResponse = response;
        if (response.status === 418) {
          // Public IP ban: block this group's queued calls; never retry 418.
          pacer.cooldown(group, 10_000);
          return response;
        }
        if (response.status !== 429) return response;
        // Provider cooldown applies to the whole public group, not just
        // the individual caller; unknown/long cooldowns fail closed.
        const providerDelay = parsePublicRetryAfterMs(response.headers.get('retry-after'));
        const backoff = Math.max(providerDelay ?? 0, 750 * attempt);
        pacer.cooldown(group, Math.min(backoff, 10_000));
        if (providerDelay !== null && providerDelay > 10_000) return response;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (attempt < 4) await sleep(250 * attempt);
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error('UPBIT_PUBLIC_FETCH_FAILED');
  };
  try { return await operation(); } finally { globalThis.fetch = originalFetch; }
}

async function withStockPublicOnly(lane, operation) {
  const audit=createPublicStockSourceAudit();
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
    if (lane.timeframe === '1D' && KR_ALPHA_MODE === 'PILOT')
      targetUniverse = includeProvisionalKrAlphanumericRoster(targetUniverse,'PILOT');
  }

  const researchAlpha = (ticker,entry) => KR_ALPHA_MODE === 'PILOT'
    && lane.market === 'KR_STOCK' && lane.timeframe === '1D'
    && entry?.publicResearchProvisional === true && ticker === '0193W0';
  // ScannerProviderHealthTracker reads getCandlesMeta, not getCandles. Route
  // BOTH entrypoints (and quote/roster) through the same public Yahoo source.
  // Never accidentally fall through to the app's private/cache providers.
  const observed=await withReadOnlyStockProviderOverlay({
    marketData, scannerUniverse: universe,
    scannerMarket: lane.scannerMarket, targetUniverse,
    readPublicCandles: async (ticker, timeframe, entry) => {
      if (researchAlpha(ticker,entry)) {
        try {
          if (timeframe !== '1D') throw new Error('KR_ALPHA_PUBLIC_SOURCE_INTRADAY_NOT_VERIFIED');
          const candles=await KR_ALPHA_DAILY_FEED.getCandles(ticker,timeframe);
          audit.recordCandles(timeframe,candles);
          return {candles,provider:'naver-public-dayCandle'};
        } catch(error){audit.candleError(timeframe,error);throw error;}
      }
      const symbols = yahooProviderCandidates(lane, ticker, entry);
      const candles=await choosePublicStockCandles({
        symbols,timeframe,market:lane.market,now:Date.now(),preferAtLeast:20,
        load:(symbol,tf)=>yahoo.getCandles(symbol,tf),
        onSource:(rows)=>audit.recordCandles(timeframe,rows),
        onError:(error)=>audit.candleError(timeframe,error),
      });
      // An alternate Yahoo class/exchange symbol is only considered after a
      // bad, empty or too-short returned chart. No invented OHLC or 429 retry.
      return {candles,provider:'yahoo-public'};
    },
    readPublicQuote: async (ticker, entry) => {
      if (researchAlpha(ticker,entry)) {
        try {
          const quote=publicKrAlphaDailyQuote(ticker,(await KR_ALPHA_DAILY_FEED.read(ticker)).candles);
          audit.recordQuote(quote);
          return quote;
        }catch(error){audit.quoteError(error);throw error;}
      }
      const symbols = yahooProviderCandidates(lane, ticker, entry);
      return choosePublicStockQuote({
        symbols,timeframe:lane.timeframe,now:Date.now(),
        load:(symbol)=>yahoo.getQuote(symbol),
        onSource:(quote)=>audit.recordQuote(quote),
        onError:(error)=>audit.quoteError(error),
      });
    },
    operation: () => operation(targetUniverse),
  });
  return {...observed,publicStockSourceAudit:audit.snapshot()};
}

async function scanStock(lane, cursor) {
  return withStockPublicOnly(lane, async (targetUniverse) => {
    const scanned = await StockSignalScannerService.scan({
      memberId: MEMBER_ID,
      market: lane.scannerMarket,
      indicators: [],
      filters: { timeframe: lane.timeframe },
      cursor,
      batchSize: lane.batchSize,
      strategyMode: lane.strategyMode,
    });
    // Strip provisional symbols from BOTH cards and alert identities before
    // handing the research result to canonical V3 adapter. A public candle
    // sample is not evidence of live listing/permission to trade.
    const safe = suppressProvisionalKrResearchSignals(scanned,targetUniverse);
    return withScannerCanonicalActions({
      ...safe,
      universe: {
        ...safe.universe,
        rosterDigest: hashPublicStockSourceRoster(lane.market,targetUniverse.source,targetUniverse.entries,createHash),
      },
      cards: safe.cards.map((card) => ({
        ...card,
        dataSources: [...new Set([...card.dataSources, 'yahoo-public'])],
      })),
    });
  });
}

// Independent source adapter leaves canonical/member/Forward/Paper
// CryptoSignalScannerService and its pinned executable bundle unchanged.
const V3_CRYPTO_PROVIDERS = createPublicV3CryptoProviders();
const V3_CRYPTO_SCANNER = createCryptoSignalScannerService(V3_CRYPTO_PROVIDERS);
async function scanCryptoRaw(lane, cursor) {
  V3_CRYPTO_PROVIDERS.clearLastRosterDigest(lane.scannerMarket);
  V3_CRYPTO_PROVIDERS.resetCandleQuality(lane.scannerMarket);
  const scanned = await V3_CRYPTO_SCANNER.scan({
    memberId: MEMBER_ID,
    market: lane.scannerMarket,
    strategyMode: lane.strategyMode,
    timeframe: lane.timeframe,
    condition: 'trend',
    cursor,
    batchSize: lane.batchSize,
  });
  const observedRosterDigest = V3_CRYPTO_PROVIDERS.readLastRosterDigest(lane.scannerMarket);
  const observedCandleQuality = V3_CRYPTO_PROVIDERS.readCandleQuality(lane.scannerMarket);
  const aligned = await CryptoPricePrecisionService.align(lane.scannerMarket, scanned);
  const ranking = rankScannerCandidates({ cards: aligned.cards, market: aligned.market, strategy: lane.strategyMode, limit: 10 });
  const cards = ranking.cards
    .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
    .filter((card) => lane.scannerMarket === 'spot'
      ? card.direction === 'LONG'
      : card.direction === 'LONG' || card.direction === 'SHORT');
  return withScannerCanonicalActions({
    ...aligned,
    // V3-only source roster identity. It is never a verified live quote,
    // Paper authority, or permission for automatic trading.
    universe: {...aligned.universe, rosterDigest: observedRosterDigest},
    publicCryptoCandleQuality: observedCandleQuality,
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
  });
}


async function withBitgetPublicPacing(operation) {
  const originalFetch = globalThis.fetch;
  const pacer = createPublicBitgetMarketPacer();
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? String(input) : String(input?.url ?? '');
    const endpoint = publicBitgetMarketEndpoint(rawUrl);
    if (endpoint === null) return originalFetch(input, init);
    const signal = init?.signal ?? (typeof input === 'object' ? input?.signal : undefined);
    // Bitget public market has a shared IP budget. Serializing request starts
    // (not responses) to 10/sec protects 1D after earlier 15m/60m scans.
    const response = await pacer.schedule(() => originalFetch(input, init), signal);
    if (response.status === 429 || response.status === 418) {
      // Never turn an exchange rejection into a success and never retry to
      // pass. A provider cooldown applies to all subsequent V3 market reads.
      const retryAfter = parsePublicRetryAfterMs(response.headers.get('retry-after'));
      const cooldown = retryAfter == null ? 1000
        : Number.isFinite(retryAfter) ? Math.max(1000, retryAfter) : 30000;
      pacer.cooldown(Math.min(30000, cooldown));
    }
    return response;
  };
  try { return await operation(); } finally { globalThis.fetch = originalFetch; }
}

async function scanCrypto(lane, cursor) {
  if (lane.scannerMarket === 'spot') return withUpbitPacing(() => scanCryptoRaw(lane, cursor));
  if (lane.scannerMarket === 'futures') return withBitgetPublicPacing(() => scanCryptoRaw(lane, cursor));
  return scanCryptoRaw(lane, cursor);
}

function laneStatus(response) {
  return classifyPublicCycleLaneStatus(response);
}

function verifiedThrownProviderMetrics(error) {
  // Only bounded Scanner's pre-defined numeric error format is accepted.
  // Never export exception text, symbols, URLs or raw provider responses.
  const raw=error instanceof Error?error.message:'';
  const matched=/^SCAN_PROVIDER_ERROR: completed=(\\d+), providerErrors=(\\d+), workerErrors=(\\d+), timeouts=(\\d+), started=(\\d+)$/u.exec(raw);
  if(!matched)return null;
  const [completed,providerErrors,workerErrors,timeouts,started]=matched.slice(1).map(Number);
  if(![completed,providerErrors,workerErrors,timeouts,started].every(Number.isSafeInteger)
    ||completed!==0||started<1||providerErrors+timeouts===0
    ||providerErrors+workerErrors+timeouts>started)return null;
  return Object.freeze({completed,providerErrors,workerErrors,timeouts,started,
    sourceFailureConfirmed:true,fullMarketVerified:false});
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const persistedState = await readJson(CYCLE_STATE_FILE, null);
  const releaseChanged = persistedState?.serviceSha !== SERVICE_SHA || persistedState?.schemaVersion !== 2
    || persistedState?.profileMode !== PUBLIC_PROFILE_MODE;
  const state = releaseChanged ? freshState() : persistedState;
  state.dataRetry ??= {};
  state.coverageProgress ??= {};
  state.rosterDigests ??= {};
  const persistedSnapshot = await readJson(SNAPSHOT_FILE, null);
  const previousSnapshot = !releaseChanged && persistedSnapshot?.serviceSha === SERVICE_SHA ? persistedSnapshot : null;
  const nowMs = Date.now();
  pruneRetained(state, nowMs);

  const coverage = [];
  for (const lane of lanes) {
    const cursor = Number.isInteger(state.cursors?.[lane.id]) ? state.cursors[lane.id] : 0;
    try {
      const response = lane.market === 'KR_STOCK' || lane.market === 'US_STOCK'
        ? await scanStock(lane, cursor)
        : await scanCrypto(lane, cursor);
      const rosterIdentity = decidePublicRosterContinuity({
        previousDigest: state.rosterDigests[lane.id] ?? null,
        observedDigest: response.universe.rosterDigest ?? null,
        stale: response.universe.stale === true,
        providerErrors: Number(response.universe.providerErrorCount ?? 0),
      });
      if (rosterIdentity.changed) {
        // The eligible set changed under a cursor, including same-count
        // delist/relist. No old signal, old attempted-index counter or old
        // retry can survive a source-index identity change.
        state.rosterDigests[lane.id] = rosterIdentity.nextDigest;
        state.cursors[lane.id] = 0;
        state.dataRetry[lane.id] = null;
        state.coverageProgress[lane.id] = null;
        for (const [key,row] of Object.entries(state.retained ?? {})) {
          if (row?.laneId === lane.id) delete state.retained[key];
        }
        coverage.push({
          laneId: lane.id, market: lane.market, strategy: lane.label,
          timeframe: lane.timeframe, cursorBefore: cursor,cursorAfter:0,
          totalUniverse: response.universe.totalCount,
          universeSource: response.universe.source,
          universePartial: response.universe.partial === true,
          universeStale: response.universe.stale === true,
          status:'SEARCH_FAILURE',error:'ROSTER_DIGEST_CHANGED_RESET',
          rosterVerified:false, retainedFromBatch:0,scannedCards:0,
          providerErrors:0,timeouts:0,lastGoodPreserved:false,
          leverage:{evaluated:0,available:0,blocked:0,unavailable:0},
        });
        continue;
      }
      if (rosterIdentity.trusted) state.rosterDigests[lane.id] = rosterIdentity.nextDigest;
      const status = rosterIdentity.trusted ? laneStatus(response) : 'SEARCH_FAILURE';
      const recovery = resolvePublicResearchDataRetry({
        response, status, cursor, priorRetry: state.dataRetry[lane.id] ?? null,
      });
      state.dataRetry[lane.id] = recovery.retry;
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
            input: { ...input, provenance: { ...input.provenance, laneId: lane.id, cursor } },
            expiresAt: card?.expiresAt ?? fallbackExpiry(lane, nowMs),
            laneId: lane.id,
            cursor,
          };
        }
      }
      const rotation = recovery.decision;
      const indexProgress = advancePublicResearchIndexProgress(
        state.coverageProgress[lane.id] ?? null,
        { response, status, decision: rotation, observedAt: new Date().toISOString() },
      );
      state.coverageProgress[lane.id] = indexProgress.state;
      // Rotation may advance a completed, zero-error PARTIAL/UNTRUSTED batch
      // for research coverage only. These rows NEVER enter the candidate
      // adapter or grant Paper/Live entry authority.
      state.cursors[lane.id] = rotation.nextCursor;
      coverage.push({
        cursorRotatedBlockedOnly: rotation.blockedObservationOnly,
        cursorRotationReason: rotation.reason,
        // A deferred data-only page stays observation-only, is not adapted to
        // signals and is revisited when the whole eligible index wraps.
        deferredDataRetry: rotation.deferredDataRetry === true,
        eligibleIndexProgress: indexProgress.summary,
        laneId: lane.id,
        market: lane.market,
        strategy: lane.label,
        timeframe: lane.timeframe,
        rosterVerified: rosterIdentity.trusted,
        rosterFingerprintPresent: typeof response.universe.rosterDigest === 'string',
        cursorBefore: cursor,
        cursorAfter: state.cursors[lane.id],
        totalUniverse: response.universe.totalCount,
        universeSource: response.universe.source ?? null,
        universePartial: response.universe.partial === true,
        universeStale: response.universe.stale === true,
        universeProviderErrors: Number(response.universe.providerErrorCount ?? 0),
        responseDataState: response.dataState ?? null,
        publicStockSourceAudit: response.publicStockSourceAudit ?? null,
        publicCryptoCandleQuality: response.publicCryptoCandleQuality ?? null,
        scannedCards: response.cards.length,
        retainedFromBatch: adapted.length,
        requestedCount: Number(response.execution.requestedCount ?? 0),
        startedCount: Number(response.execution.startedCount ?? 0),
        completedCount: Number(response.execution.completedCount ?? 0),
        // A task may finish technically while its candles are insufficient.
        insufficientDataCount: Number(response.execution.insufficientDataCount ?? 0),
        invalidDataFailureCount: Array.isArray(response.failures)
          ? response.failures.filter((failure) => failure.reason === 'invalid_data').length : null,
        status,
        outcome: response.outcome ?? null,
        providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount,
        // Overall 12-second budget may expire even with 0 per-item timeouts.
        // This must not be labeled as an unexplained successful zero-error scan.
        batchDeadlineExceeded: response.execution.timedOut === true,
        partialExecution: response.execution.partial === true,
        // Only bounded reason classes from the SAME already completed cycle.
        // This emits no symbol, raw body, URL, token or extra network call.
        publicProviderFailureSummary: summarizePublicProviderFailureReasons(response.failures),
        leverage: leverageDiagnostics,
        lastGoodPreserved: status === 'SEARCH_FAILURE' || status === 'BLOCKED_DATA',
      });
    } catch (error) {
      // An HTTP/runtime failure must not build an insufficient-data retry streak.
      const thrownProviderMetrics = verifiedThrownProviderMetrics(error);
      state.dataRetry[lane.id] = null;
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
        requestedCount: null,
        startedCount: null,
        completedCount: null,
        insufficientDataCount: null,
        invalidDataFailureCount: null,
        status: 'SEARCH_FAILURE',
        batchDeadlineExceeded: null,
        partialExecution: null,
        leverage: { evaluated: 0, available: 0, blocked: 0, unavailable: 0 },
        lastGoodPreserved: true,
        // Missing batch evidence stays null; sanitized aggregate failures
        // are diagnostics only and never convert this lane into a PASS.
        providerErrors: thrownProviderMetrics?.providerErrors ?? null,
        timeouts: thrownProviderMetrics?.timeouts ?? null,
        thrownProviderMetrics,
        error: error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN',
      });
    }
  }

  pruneRetained(state, nowMs);
  const inputs = Object.values(state.retained).map((row) => row.input);
  const baseSnapshot = runSignalIntelligenceV3(inputs, { previousSnapshot });
  const snapshot = {
    ...baseSnapshot,
    serviceSha: SERVICE_SHA,
    profile: {
      strategies: ['SCALPING', 'SWING', 'MID_LONG'],
      timeframes: strategyProfiles.map((row) => row.timeframe),
      fullStrategyCoverage: true,
      surface: PUBLIC_PROFILE_MODE,
    },
    coverage,
    publicDataOnly: true,
    releaseStateReset: releaseChanged,
  };
  assertSignalIntelligenceV3Snapshot(snapshot);
  state.updatedAt = new Date().toISOString();
  // Snapshot first, cursor state second: a crash between writes may replay a
  // page (safe, source-bounded), but must never permanently skip unpublished
  // research coverage. There is no order authority in this public producer.
  await atomicJson(SNAPSHOT_FILE, snapshot);
  await atomicJson(CYCLE_STATE_FILE, state);

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
