// @ts-nocheck
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { constants as fileConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { CryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../../api-server/src/services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../../api-server/src/services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import * as yahoo from '../../api-server/src/providers/yahoo';
import { parseNasdaqTraderDirectories } from '../../market-prediction-lab/src/public-coverage-audit-v1.js';
import { adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import { enrichFuturesLeverageInputs } from '../src/futures-leverage-enrichment.mjs';
import { assertSignalIntelligenceV3Snapshot, runSignalIntelligenceV3 } from '../src/engine.mjs';
import { summarizeV3EconomicReadiness } from '../src/public-v3-readiness-diagnostics.mjs';
import { summarizeV3BlockerTriage } from '../src/public-v3-blocker-triage.mjs';
import { summarizeV3RawCryptoQuality } from '../src/public-v3-crypto-quality-diagnostic.mjs';
import { selectV3TrustedSpotResearchOnly } from '../src/public-v3-spot-blocked-page-research.mjs';
import {readV3StageOneWatch} from '../src/public-watch-v3-readonly.mjs';
import {installV3WithinPageWatchPriority,v3WithinPagePriorityDiagnostic,
  selectV3OutOfCursorResearch} from '../src/public-watch-v3-priority.mjs';
import {runV3OutOfCursorResearch} from '../src/public-watch-v3-offpage-research.mjs';
import {validV3PublicPriorityRequest} from '../src/public-v3-priority-public-route.mjs';
import { summarizePublicProviderFailureReasons } from '../src/public-provider-cycle-diagnostics.mjs';
import { currentPagePublication } from '../src/public-v3-current-page-gate.mjs';
import { validV3PublicYahooCandlePage } from '../src/public-v3-stock-candle-integrity.mjs';
import {commitPublicV3CycleCheckpoint,recoverPublicV3CycleCheckpoint} from '../src/public-cycle-checkpoint.mjs';
import {accumulatePublicV3RosterProgress} from '../src/public-v3-roster-progress.mjs';
import {
  bindPublicStockCandleSource,
  enforcePublicStockRosterCoverage,
  createPublicStockQualityCounter,
  withPublicStockProviderFallback,
} from '../src/public-stock-candle-binding.mjs';
import {publicYahooProviderCandidates} from '../src/public-yahoo-symbol-candidates.mjs';
import {
  createPublicStockSessionGapAudit,
  summarizePublicKrExclusions,
} from '../src/public-stock-session-diagnostics.mjs';
import { evaluateScannerDataQuality } from '../../api-server/src/services/scanner-data-quality.service';
import { recoverV3CompletedPublicBars } from '../src/public-stock-complete-bars-recovery.mjs';
import { shouldProbeV3StockGap } from '../src/public-stock-gap-probe-policy.mjs';
import {
  classifyPublicCycleLaneStatus,
  decidePublicCycleCursor,
  recoverShrunkPublicV3Cursor,
  PUBLIC_V3_SPOT_STAGE_TWO_LIMIT,
  publicV3CryptoBatchSize,
  summarizePublicV3Execution,
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
const CHECKPOINT_FILE = path.join(STATE_DIR, 'pending-public-cycle.json');
const MEMBER_ID = 'signal-intelligence-v3-public-only';
const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

if (!/^[0-9a-f]{40}$/u.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');

const strategyProfiles = Object.freeze([
  Object.freeze({ label: 'SCALPING', strategyMode: 'scalping', timeframe: '15m' }),
  Object.freeze({ label: 'SWING', strategyMode: 'swing', timeframe: '60m' }),
  Object.freeze({ label: 'MID_LONG', strategyMode: 'position', timeframe: '1D' }),
]);
const marketProfiles = Object.freeze([
  Object.freeze({ prefix: 'KR', market: 'KR_STOCK', scannerMarket: 'KR', batchSize: 20 }),
  Object.freeze({ prefix: 'US', market: 'US_STOCK', scannerMarket: 'US', batchSize: 20 }),
  Object.freeze({ prefix: 'SPOT', market: 'CRYPTO_SPOT', scannerMarket: 'spot', batchSize: PUBLIC_V3_SPOT_STAGE_TWO_LIMIT }),
  Object.freeze({ prefix: 'FUTURES', market: 'CRYPTO_FUTURES', scannerMarket: 'futures', batchSize: 20 }),
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
    cursors: Object.fromEntries(lanes.map((lane) => [lane.id, 0])),
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
  // A rename is not a power-loss durability barrier without file/dir fsync.
  const dir=path.dirname(file);
  await mkdir(dir,{recursive:true});
  const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
  let handle=null,renamed=false;
  try{
    handle=await open(temp,fileConstants.O_WRONLY|fileConstants.O_CREAT
      |fileConstants.O_EXCL|fileConstants.O_NOFOLLOW,0o600);
    await handle.writeFile(JSON.stringify(value,null,2)+'\n',{encoding:'utf8'});
    await handle.sync();
    await handle.close();handle=null;
    await rename(temp,file);renamed=true;
    const directory=await open(dir,fileConstants.O_RDONLY);
    try{await directory.sync();}finally{await directory.close();}
  }finally{
    if(handle)await handle.close().catch(()=>{});
    if(!renamed)await unlink(temp).catch(()=>{});
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

// Isolated module helpers: exact exchange routing and fail-closed empty candles.
function yahooProviderCandidates(lane,ticker,entry){
  return publicYahooProviderCandidates(lane.market,ticker,entry);
}
async function withProviderFallback(candidates,operation,requirements={}){
  return withPublicStockProviderFallback(candidates,operation,{pause:sleep,...requirements});
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
  const marketData = MarketDataService;
  const universe = ScannerUniverseService;
  const originalQuote = marketData.getQuote;
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

  const entryByTicker = new Map((targetUniverse?.entries ?? []).map((entry) => [String(entry.ticker).toUpperCase(), entry]));
  const qualityCounter = createPublicStockQualityCounter();
  const sessionGapAudit = createPublicStockSessionGapAudit(lane.market, lane.timeframe);
  const qualityWindow = lane.strategyMode === 'scalping' ? 240
    : lane.strategyMode === 'swing' ? 320 : 400;
  // Verified V3-only public lower-bar repair never replaces native bars,
  // fabricates no-trade candles or affects normal member/Paper scanners.
  // The zero-recovery 28-call GitHub cycle is not an acceptable permanent
  // public API cost. Default OFF; a deliberate V3-only research opt-in allows
  // at most two lower-interval comparisons per US intraday lane.
  const gapProbeEnabled = process.env.SIGNAL_INTELLIGENCE_V3_LOWER_BAR_PROBE === 'true';
  const gapRecovery = {attempted:0,inserted:0,unchanged:0,
    sourceFailed:0,conflicting:0,providerRequestsAdded:0};
  // StockSignalScanner -> ScannerProviderHealth calls getCandlesMeta, not
  // getCandles. Bind BOTH methods to the same isolated Yahoo-only fetcher
  // so the real scanner cannot bypass this public source via app fallbacks.
  const restoreCandles = bindPublicStockCandleSource(marketData, async (ticker, timeframe = '1D') => {
    const entry = entryByTicker.get(String(ticker).toUpperCase());
    const candidates = yahooProviderCandidates(lane, ticker, entry);
    let successfulSymbol = null;
    const native = await withProviderFallback(candidates, async providerSymbol => {
      const rows = await yahoo.getCandles(providerSymbol, timeframe);
      // Yahoo may return years of old/adjustment-affected candles. V3's
      // current-cycle indicator and quality proof uses this SAME bounded
      // recent window, so never reject the latest page for an out-of-scope
      // historical row or feed those older rows into the scanner.
      const relevant = Array.isArray(rows) ? rows.slice(-qualityWindow) : rows;
      if (Array.isArray(relevant) && relevant.length>0) successfulSymbol = providerSymbol;
      return relevant;
    },{validValue:rows=>validV3PublicYahooCandlePage(rows,{nowMs:Date.now()})});
    let candles = native;
    // Only a BLOCKING missing-candle defect triggers one bounded public
    // shorter-interval Yahoo query. Verified complete lower bars may fill
    // gaps; failures leave the original source untouched and still blocked.
    if (lane.market === 'US_STOCK' && String(timeframe) === lane.timeframe
      && (timeframe === '15m' || timeframe === '60m')
      && successfulSymbol) {
      let missing=false;
      try {
        const preliminary=evaluateScannerDataQuality({
          symbol:'PUBLIC_SOURCE_DIAGNOSTIC',timeframe,
          candles:native.slice(-qualityWindow),now:Date.now(),
          sessionAware:true,
        });
        missing=preliminary.issues.some(issue=>
          issue.code==='MISSING_CANDLE'&&issue.severity==='blocking');
      } catch { /* invalid native data must remain blocked */ }
      if(shouldProbeV3StockGap({enabled:gapProbeEnabled,
        market:lane.market,timeframe,hasBlockingGap:missing,
        attempted:gapRecovery.attempted})){
        gapRecovery.attempted+=1;
        gapRecovery.providerRequestsAdded+=1;
        try {
          const lowerTimeframe=timeframe==='15m'?'5m':'15m';
          const lower=await yahoo.getCandles(successfulSymbol,lowerTimeframe);
          const result=recoverV3CompletedPublicBars(native,lower,{
            market:lane.market,timeframe,nowMs:Date.now(),
          });
          if(result.status==='CONFLICTING_PROVIDER_BARS')gapRecovery.conflicting+=1;
          else if(result.added>0){
            candles=result.candles;gapRecovery.inserted+=result.added;
          }else gapRecovery.unchanged+=1;
        }catch{gapRecovery.sourceFailed+=1;}
      }
    }
    // One final aggregate observation of the actual series passed to Scanner.
    if (String(timeframe) === lane.timeframe) {
      sessionGapAudit.observe(candles.slice(-qualityWindow));
      try {
        qualityCounter.observe(evaluateScannerDataQuality({
          symbol: 'PUBLIC_SOURCE_DIAGNOSTIC',
          timeframe: lane.timeframe,
          candles: candles.slice(-qualityWindow),
          now: Date.now(),
          sessionAware: true,
        }));
      } catch { qualityCounter.observeError(); }
    }
    return candles;
  });
  marketData.getQuote = async (ticker) => {
    const originalTicker = String(ticker).toUpperCase();
    const entry = entryByTicker.get(originalTicker);
    const candidates = yahooProviderCandidates(lane, ticker, entry);
    const quote = await withProviderFallback(candidates, (providerSymbol) => yahoo.getQuote(providerSymbol));
    return {
      ...quote,
      ticker: originalTicker,
      symbol: originalTicker,
      name: entry?.name ?? quote?.name ?? originalTicker,
    };
  };
  universe.get = async (market, signal, deadlineMs) => {
    if (market === lane.scannerMarket) return targetUniverse;
    return originalUniverseGet.call(universe, market, signal, deadlineMs);
  };

  try {
    const scanned = await operation();
    // An eligible 4,010-symbol KRX roster does not prove complete
    // coverage when upstream reports 2,837 explained unsupported codes.
    const withRosterEvidence = enforcePublicStockRosterCoverage(scanned, targetUniverse);
    return {
      ...withRosterEvidence,
      publicStockQualityDiagnostic: qualityCounter.snapshot(),
      publicStockSessionDiagnostic: sessionGapAudit.snapshot(),
      publicGapRecoveryDiagnostic: Object.freeze({
        ...gapRecovery, providerName:'yahoo-public',scope:'V3_US_REGULAR_COMPLETE_LOWER_ONLY',
        enabled:gapProbeEnabled,maximumAttemptsPerLane:2,
        sourceSymbolsIncluded:false,fullRosterPassProven:false,economicAuthority:'NONE',
      }),
      publicKrExclusionDiagnostic: lane.market === 'KR_STOCK'
        ? summarizePublicKrExclusions(targetUniverse) : null,
    };
  } finally {
    restoreCandles();
    marketData.getQuote = originalQuote;
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
    batchSize: publicV3CryptoBatchSize(lane.scannerMarket,lane.batchSize),
  });
  const aligned = await CryptoPricePrecisionService.align(lane.scannerMarket, scanned);
  const ranking = rankScannerCandidates({ cards: aligned.cards, market: aligned.market, strategy: lane.strategyMode, limit: 10 });
  const cards = ranking.cards
    .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
    .filter((card) => lane.scannerMarket === 'spot'
      ? card.direction === 'LONG'
      : card.direction === 'LONG' || card.direction === 'SHORT');
  const publicCryptoQualityDiagnostic=summarizeV3RawCryptoQuality(scanned,{
    rankedCards:cards.length,
  });
  return withScannerCanonicalActions({
    ...aligned,
    cards,
    publicCryptoQualityDiagnostic,
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

/** One read-only single-symbol V3 scanner operation for a verified off-page
 * public Watch observation. The esbuild V3-only scanner build forces an exact
 * currently listed symbol with no normal roster/page cursor modifications.
 * All outbound URLs pass the fixed Upbit/Bitget public GET allowlist and
 * are counted/capped, including retries and rejected provider responses.
 */
async function scanSingleV3WatchResearch(row) {
  const market=row.market==='CRYPTO_SPOT'?'spot':'futures';
  const oldFetch=globalThis.fetch;
  let publicHttpRequests=0;
  globalThis.fetch=async(input,init={})=>{
    const url=typeof input==='string'||input instanceof URL
      ? String(input):String(input?.url??'');
    const method=String(init?.method??(typeof input==='object'?input?.method:null)??'GET')
      .toUpperCase();
    if(!validV3PublicPriorityRequest(url,market,method))
      throw Error('PUBLIC_V3_PRIORITY_UNSAFE_OUTBOUND');
    if(publicHttpRequests>=20)
      throw Error('PUBLIC_V3_PRIORITY_HTTP_BUDGET_EXHAUSTED');
    publicHttpRequests+=1;
    return oldFetch(input,init);
  };
  try {
    // No canonical adaptation, economics, Telegram or Paper: the response
    // is reduced immediately to bounded review counters by the caller.
    const operation=()=>CryptoSignalScannerService.scan({
      memberId:'signal-intelligence-v3-priority-preflight-public-only',
      prioritySymbol:row.symbol,
      market,strategyMode:'scalping',timeframe:'15m',condition:'trend',
      cursor:0,batchSize:5,minimumScore:0,maximumRiskScore:100,
    });
    const response=market==='spot'
      ? await withUpbitPacing(operation)
      : await withBitgetPublicPacing(operation);
    return Object.freeze({response,httpRequests:publicHttpRequests,
      requestCountMeasured:true});
  }catch {
    // No raw HTTP error, symbol, personal detail or token is ever persisted.
    return Object.freeze({response:null,scannerFailed:true,
      httpRequests:publicHttpRequests,requestCountMeasured:true});
  }finally {
    globalThis.fetch=oldFetch;
  }
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const recovered=await recoverPublicV3CycleCheckpoint({
    journalFile:CHECKPOINT_FILE,cycleStateFile:CYCLE_STATE_FILE,
    snapshotFile:SNAPSHOT_FILE,serviceSha:SERVICE_SHA,
    atomicWrite:atomicJson,validateSnapshot:assertSignalIntelligenceV3Snapshot,
  });
  if(recovered.recovered){
    // Restore exact prior page without extra public HTTP or new source epoch.
    process.stdout.write(JSON.stringify({
      ok:true,checkpointRecovered:true,serviceSha:SERVICE_SHA,
      dataRequestCountAdded:0,telegramSent:0,executionAuthority:'NONE',
    })+'\n');
    return;
  }
  const persistedState = await readJson(CYCLE_STATE_FILE, null);
  const releaseChanged = persistedState?.serviceSha !== SERVICE_SHA || persistedState?.schemaVersion !== 2;
  const state = releaseChanged ? freshState() : persistedState;
  const persistedSnapshot = await readJson(SNAPSHOT_FILE, null);
  const previousSnapshot = !releaseChanged && persistedSnapshot?.serviceSha === SERVICE_SHA ? persistedSnapshot : null;
  const nowMs = Date.now();
  const sourceCycleId = randomUUID(); // new each cycle, including wrapped cursors
  // Explicit opt-in. Read ONLY the sealed local Research Watch public event
  // receipts; absence, SHA mismatch or stale data preserves normal V3 scan.
  const stageOneWatch = await readV3StageOneWatch({
    enabled:process.env.SIGNAL_INTELLIGENCE_V3_WATCH_HANDOFF_ENABLED==='true',
    expectedResearchSha:process.env.SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA,
    nowMs,
  });
  installV3WithinPageWatchPriority(stageOneWatch);
  pruneRetained(state, nowMs);

  const coverage = [];
  for (const lane of lanes) {
    const cursor = Number.isInteger(state.cursors?.[lane.id]) ? state.cursors[lane.id] : 0;
    try {
      const response = lane.market === 'KR_STOCK' || lane.market === 'US_STOCK'
        ? await scanStock(lane, cursor)
        : await scanCrypto(lane, cursor);
      // Delistings may shrink the full eligible roster below the cursor
      // persisted by a previous cycle. A zero-work clamped page would
      // otherwise pin this lane forever. Never use a fallback/stale/short
      // provider page to reset or to mint a new signal.
      const recovery = recoverShrunkPublicV3Cursor({
        market:lane.market,cursor,response,
      });
      const status = recovery ? 'BLOCKED_DATA' : laneStatus(response);
      let adapted = [];
      let blockedSpotResearchOnly=0;
      let blockedSpotResearchDiagnostic=null;
      let leverageDiagnostics = { evaluated: 0, available: 0, blocked: 0, unavailable: 0 };
      if(status==='BLOCKED_DATA'&&lane.market==='CRYPTO_SPOT'){
        // The whole source page stays BLOCKED_DATA for publication.
        // Separately preserve only independently trusted current cards
        // as research inputs, never as canonical source-page signal events.
        const isolated=selectV3TrustedSpotResearchOnly(response,{
          status,cursor,nowMs:Date.now(),
        });
        blockedSpotResearchDiagnostic=isolated.diagnostic;
        if(isolated.cards.length){
          const researchInputs=adaptCanonicalScannerCards(
            isolated.cards.map(card=>({card,timeframe:lane.timeframe})),
            {nowMs:Date.now()},
          ).filter(row=>row.dataStatus==='READY');
          for(const input of researchInputs){
            const card=isolated.cards.find(raw=>raw.symbol===input.symbol);
            if(!card)continue;
            state.retained[retainedKey(input)]={
              input:{...input,provenance:{...input.provenance,
                laneId:lane.id,cursor,sourceCycleId,
                blockedPageResearchOnly:true,economicAuthority:'NONE',
                publicationEligible:false,
              }},
              expiresAt:card.expiresAt??fallbackExpiry(lane,nowMs),
              laneId:lane.id,cursor,
            };
            blockedSpotResearchOnly+=1;
          }
        }
      }
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
            input: { ...input, provenance: { ...input.provenance, laneId: lane.id, cursor, sourceCycleId } },
            expiresAt: card?.expiresAt ?? fallbackExpiry(lane, nowMs),
            laneId: lane.id,
            cursor,
          };
        }
      }
      const rotation = recovery
        ?? decidePublicCycleCursor({ response, status, cursor });
      // Rotation may advance a completed, zero-error PARTIAL/UNTRUSTED batch
      // for research coverage only. These rows NEVER enter the candidate
      // adapter or grant Paper/Live entry authority.
      state.cursors[lane.id] = rotation.nextCursor;
      coverage.push({
        cursorRotatedBlockedOnly: rotation.blockedObservationOnly,
        cursorRotationReason: rotation.reason,
        laneId: lane.id,
        sourceCycleId,
        market: lane.market,
        strategy: lane.label,
        timeframe: lane.timeframe,
        cursorBefore: cursor,
        cursorAfter: state.cursors[lane.id],
        totalUniverse: response.universe.totalCount,
        universeSource: response.universe.source ?? null,
        universePartial: response.universe.partial === true,
        // Coarse aggregate-only source proof; do not expose symbols.
        universeRawTotalCount: response.publicRosterCoverage?.rawTotalCount ?? null,
        universeExplainedExcludedCount: response.publicRosterCoverage?.explainedExcludedCount ?? null,
        // Diagnostic-only, low-cardinality quality issues for the exact scan.
        // Its values do not grant a candidate, PASS, cursor or order authority.
        publicStockQualityDiagnostic: response.publicStockQualityDiagnostic ?? null,
        publicCryptoQualityDiagnostic:response.publicCryptoQualityDiagnostic ?? null,
        // Diagnostic-only: distinguish regular hours vs other gap candidates.
        // This does NOT waive MISSING_CANDLE or create a verified signal.
        publicStockSessionDiagnostic: response.publicStockSessionDiagnostic ?? null,
        publicGapRecoveryDiagnostic: response.publicGapRecoveryDiagnostic ?? null,
        publicKrExclusionDiagnostic: response.publicKrExclusionDiagnostic ?? null,
        // The prior futures 60m SEARCH_FAILURE reported 0 provider errors
        // while hiding incomplete started/completed work. Preserve the exact
        // execution accounting without any private provider payload.
        publicExecutionDiagnostic: summarizePublicV3Execution(response),
        universeStale: response.universe.stale === true,
        universeProviderErrors: Number(response.universe.providerErrorCount ?? 0),
        responseDataState: response.dataState ?? null,
        scannedCards: response.cards.length,
        retainedFromBatch: adapted.length,
        blockedSpotResearchOnly,
        blockedSpotResearchDiagnostic,
        status,
        outcome: response.outcome ?? null,
        providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount,
        // Only bounded reason classes from the SAME already completed cycle.
        // This emits no symbol, raw body, URL, token or extra network call.
        publicProviderFailureSummary: summarizePublicProviderFailureReasons(response.failures),
        leverage: leverageDiagnostics,
        lastGoodPreserved: status === 'SEARCH_FAILURE' || status === 'BLOCKED_DATA',
      });
    } catch (error) {
      coverage.push({
        laneId: lane.id,
        sourceCycleId,
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

  // Optional Stage-1 priority *outside* canonical cursor windows.
  // This is a separate public 15m research data-quality observation with
  // max ONE current listed coin per market and no Signal/Telegram authority.
  // If the watcher was not verified, or its observations became stale while
  // the twelve normal lanes ran, no additional public requests are made.
  const watchOutOfPage=selectV3OutOfCursorResearch(stageOneWatch);
  const offPageResearch=await runV3OutOfCursorResearch(watchOutOfPage,{
    enabled:process.env.SIGNAL_INTELLIGENCE_V3_WATCH_OFFPAGE_RESEARCH_ENABLED==='true'
      && ['VALIDATED','PARTIAL_SOURCE'].includes(stageOneWatch.status),
    nowMs:Date.now(),
    scanOne:scanSingleV3WatchResearch,
  });

  // Persistence of bounded cursor-only counts NEVER means all raw symbols
  // were covered. Failed/blocked pages are not trusted candidate evidence.
  state.rosterProgress = accumulatePublicV3RosterProgress(
    state.rosterProgress,coverage,
  );
  pruneRetained(state, nowMs);
  const inputs = Object.values(state.retained).map((row) => row.input);
  const baseSnapshot = runSignalIntelligenceV3(inputs, { previousSnapshot });
  const economicReadiness = summarizeV3EconomicReadiness(baseSnapshot.rows);
  // Aggregate current source/economic dependency diagnosis; no admission
  // change, no extra provider requests or profitability credit.
  const blockerTriage = summarizeV3BlockerTriage(coverage,economicReadiness);
  // Retained earlier research rows remain inspectable in rows/stateById,
  // but only the exact verified current source page can publish fresh lists
  // or Telegram candidate events. An invalid receipt returns empty outputs.
  const publication = currentPagePublication(baseSnapshot, coverage);
  const snapshot = {
    ...baseSnapshot,
    lists: publication.lists,
    events: publication.events,
    serviceSha: SERVICE_SHA,
    profile: { strategies: ['SCALPING', 'SWING', 'MID_LONG'], timeframes: ['15m', '60m', '1D'], fullStrategyCoverage: true },
    coverage,
    publicCycleRosterProgress: Object.values(state.rosterProgress),
    publicDataOnly: true,
    economicReadiness,
    blockerTriage,
    publicStageOneWatch:stageOneWatch.report,
    publicStageTwoPriority:v3WithinPagePriorityDiagnostic(),
    publicStageTwoOffPageResearch:offPageResearch,
    releaseStateReset: releaseChanged,
  };
  assertSignalIntelligenceV3Snapshot(snapshot);
  state.updatedAt = new Date().toISOString();
  await commitPublicV3CycleCheckpoint({
    journalFile:CHECKPOINT_FILE,cycleStateFile:CYCLE_STATE_FILE,
    snapshotFile:SNAPSHOT_FILE,serviceSha:SERVICE_SHA,state,snapshot,
    atomicWrite:atomicJson,validateSnapshot:assertSignalIntelligenceV3Snapshot,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    serviceSha: SERVICE_SHA,
    retainedInputs: inputs.length,
    lists: Object.fromEntries(Object.entries(snapshot.lists).map(([key, rows]) => [key, rows.length])),
    events: snapshot.events.length,
    profile: snapshot.profile,
    releaseStateReset: releaseChanged,
    economicReadiness,
    blockerTriage,
    publicStageOneWatch:stageOneWatch.report,
    publicStageTwoPriority:v3WithinPagePriorityDiagnostic(),
    publicStageTwoOffPageResearch:offPageResearch,
    coverage,
    publicCycleRosterProgress: Object.values(state.rosterProgress),
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
