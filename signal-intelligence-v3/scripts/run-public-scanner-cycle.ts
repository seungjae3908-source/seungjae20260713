// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { CryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../../api-server/src/services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../../api-server/src/services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../../api-server/src/services/scanner-market-action.service';
import * as yahoo from '../../api-server/src/providers/yahoo';
import { adaptCanonicalScannerCards } from '../src/canonical-adapter.mjs';
import { assertSignalIntelligenceV3Snapshot, runSignalIntelligenceV3 } from '../src/engine.mjs';

const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const STATE_DIR = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_DIR ?? './state');
const CYCLE_STATE_FILE = path.join(STATE_DIR, 'cycle-state.json');
const SNAPSHOT_FILE = path.resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE ?? path.join(STATE_DIR, 'latest-snapshot.json'));
const MEMBER_ID = 'signal-intelligence-v3-public-only';

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

async function withYahooPublicOnly(operation) {
  const mutable = MarketDataService;
  const originalCandles = mutable.getCandles;
  const originalQuote = mutable.getQuote;
  mutable.getCandles = async (ticker, timeframe = '1D') => yahoo.getCandles(ticker, timeframe);
  mutable.getQuote = async (ticker) => yahoo.getQuote(ticker);
  try { return await operation(); } finally {
    mutable.getCandles = originalCandles;
    mutable.getQuote = originalQuote;
  }
}

async function scanStock(lane, cursor) {
  return withYahooPublicOnly(async () => {
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

async function scanCrypto(lane, cursor) {
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

function laneStatus(response) {
  if (!response) return 'SEARCH_FAILURE';
  if (response.outcome === 'PROVIDER_FAILURE' || response.outcome === 'REQUEST_TIMEOUT' || response.dataState === 'unavailable') return 'SEARCH_FAILURE';
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
      clearScannedWindow(state, lane.id, cursor);
      const adapted = adaptCanonicalScannerCards(response.cards.map((card) => ({ card, timeframe: '60m' })), { nowMs });
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
      coverage.push({
        laneId: lane.id,
        market: lane.market,
        cursorBefore: cursor,
        cursorAfter: state.cursors[lane.id],
        totalUniverse: response.universe.totalCount,
        scannedCards: response.cards.length,
        retainedFromBatch: adapted.length,
        status,
        outcome: response.outcome ?? null,
        providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount,
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
