// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
import { assertSignalIntelligenceV3Snapshot, runSignalIntelligenceV3 } from '../src/engine.mjs';

const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const STATE_DIR = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_DIR ?? './state');
const CYCLE_STATE_FILE = path.join(STATE_DIR, 'cycle-state.json');
const SNAPSHOT_FILE = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE ?? path.join(STATE_DIR, 'latest-snapshot.json'));
const MEMBER_ID = 'signal-intelligence-v3-public-only';
const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

if (!/^[0-9a-f]{40}$/u.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');

const lanes = [
  { id: 'KR_SWING_60M', market: 'KR_STOCK', scannerMarket: 'KR', batchSize: 20 },
  { id: 'US_SWING_60M', market: 'US_STOCK', scannerMarket: 'US', batchSize: 20 },
  { id: 'SPOT_SWING_60M', market: 'CRYPTO_SPOT', scannerMarket: 'spot', batchSize: 20 },
  { id: 'FUTURES_SWING_60M', market: 'CRYPTO_FUTURES', scannerMarket: 'futures', batchSize: 20 },
];

function freshState() {
  return {
    schemaVersion: 1,
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
    const candidates = [clean];
    if (clean.includes('.')) candidates.push(clean.replace(/\./gu, '-'));
    if (clean.includes('-')) candidates.push(clean.replace(/-/gu, '.'));
    return [...new Set(candidates)];
  }
  return [clean];
}

async function withProviderFallback(candidates, operation) {
  let lastError;
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation(candidate);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(150 * attempt);
      }
    }
  }
  throw lastError ?? new Error('PUBLIC_STOCK_PROVIDER_CANDIDATES_EMPTY');
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
  const originalCandles = marketData.getCandles;
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
  marketData.getCandles = async (ticker, timeframe = '1D') => {
    const entry = entryByTicker.get(String(ticker).toUpperCase());
    const candidates = yahooProviderCandidates(lane, ticker, entry);
    return withProviderFallback(candidates, (providerSymbol) => yahoo.getCandles(providerSymbol, timeframe));
  };
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

  try { return await operation(); } finally {
    marketData.getCandles = originalCandles;
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
      filters: { timeframe: '60m' },
      cursor,
      batchSize: lane.batchSize,
      strategyMode: 'swing',
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
    strategyMode: 'swing',
    timeframe: '60m',
    condition: 'trend',
    cursor,
    batchSize: lane.batchSize,
  });
  const aligned = await CryptoPricePrecisionService.align(lane.scannerMarket, scanned);
  const ranking = rankScannerCandidates({ cards: aligned.cards, market: aligned.market, strategy: 'swing', limit: 10 });
  const cards = ranking.cards
    .map((card) => card.signalGrade === 'B' ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' } : card)
    .filter((card) => lane.scannerMarket === 'spot'
      ? card.direction === 'LONG'
      : card.direction === 'LONG' || card.direction === 'SHORT');
  return withScannerCanonicalActions({
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
  });
}

async function scanCrypto(lane, cursor) {
  if (lane.scannerMarket === 'spot') return withUpbitPacing(() => scanCryptoRaw(lane, cursor));
  return scanCryptoRaw(lane, cursor);
}

function laneStatus(response) {
  if (!response) return 'SEARCH_FAILURE';
  if (response.outcome === 'PROVIDER_FAILURE' || response.outcome === 'REQUEST_TIMEOUT' || response.dataState === 'unavailable') return 'SEARCH_FAILURE';
  if (response.universe?.partial === true || response.universe?.stale === true || Number(response.universe?.providerErrorCount ?? 0) > 0) return 'SEARCH_FAILURE';
  if (Number(response.execution?.providerErrorCount ?? 0) > 0 || Number(response.execution?.timeoutCount ?? 0) > 0) return 'SEARCH_FAILURE';
  return response.cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_NO_TRADE';
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const state = await readJson(CYCLE_STATE_FILE, freshState());
  if (state.serviceSha !== SERVICE_SHA) throw new Error('SIGNAL_INTELLIGENCE_STATE_SHA_MISMATCH');
  const previousSnapshot = await readJson(SNAPSHOT_FILE, null);
  const nowMs = Date.now();
  pruneRetained(state, nowMs);

  const coverage = [];
  for (const lane of lanes) {
    const cursor = Number.isInteger(state.cursors?.[lane.id]) ? state.cursors[lane.id] : 0;
    try {
      const response = lane.market === 'KR_STOCK' || lane.market === 'US_STOCK'
        ? await scanStock(lane, cursor)
        : await scanCrypto(lane, cursor);
      const status = laneStatus(response);
      let adapted = [];
      if (status !== 'SEARCH_FAILURE') {
        clearScannedWindow(state, lane.id, cursor);
        adapted = adaptCanonicalScannerCards(response.cards.map((card) => ({ card, timeframe: '60m' })), { nowMs });
        for (const input of adapted) {
          const card = response.cards.find((candidate) => candidate.symbol === input.symbol && String(candidate.action ?? candidate.direction) === input.direction)
            ?? response.cards.find((candidate) => candidate.symbol === input.symbol);
          state.retained[retainedKey(input)] = {
            input: { ...input, provenance: { ...input.provenance, laneId: lane.id, cursor } },
            expiresAt: card?.expiresAt ?? new Date(nowMs + 90 * 60_000).toISOString(),
            laneId: lane.id,
            cursor,
          };
        }
        state.cursors[lane.id] = response.universe.nextCursor == null ? 0 : response.universe.nextCursor;
      }
      coverage.push({
        laneId: lane.id,
        market: lane.market,
        cursorBefore: cursor,
        cursorAfter: state.cursors[lane.id],
        totalUniverse: response.universe.totalCount,
        universeSource: response.universe.source ?? null,
        universePartial: response.universe.partial === true,
        universeStale: response.universe.stale === true,
        universeProviderErrors: Number(response.universe.providerErrorCount ?? 0),
        scannedCards: response.cards.length,
        retainedFromBatch: adapted.length,
        status,
        outcome: response.outcome ?? null,
        providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount,
        lastGoodPreserved: status === 'SEARCH_FAILURE',
      });
    } catch (error) {
      coverage.push({
        laneId: lane.id,
        market: lane.market,
        cursorBefore: cursor,
        cursorAfter: cursor,
        totalUniverse: null,
        scannedCards: 0,
        retainedFromBatch: 0,
        status: 'SEARCH_FAILURE',
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
    serviceSha: SERVICE_SHA,
    profile: { strategies: ['SWING'], timeframes: ['60m'], fullStrategyCoverage: false },
    coverage,
    publicDataOnly: true,
  };
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
    coverage,
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
