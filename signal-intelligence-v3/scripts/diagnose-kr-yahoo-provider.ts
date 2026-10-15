// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import * as yahoo from '../../api-server/src/providers/yahoo';

const OUTPUT = path.resolve(process.argv[2] ?? 'kr-yahoo-provider-diagnostic.json');
const SYMBOLS = ['005930', '000660', '035420', '005380', '068270'];
const PROFILES = [
  { profile: 'SCALPING', strategyMode: 'scalping', timeframe: '15m', range: '1mo', interval: '15m' },
  { profile: 'SWING', strategyMode: 'swing', timeframe: '60m', range: '2y', interval: '60m' },
  { profile: 'MID_LONG', strategyMode: 'position', timeframe: '1D', range: '10y', interval: '1d' },
];
const QUOTE_PROFILE = { profile: 'QUOTE', range: '1mo', interval: '1d' };

function sanitize(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s|]+/gu, '[url]').slice(0, 320);
}
function providerCandidates(symbol) { return [`${symbol}.KS`, `${symbol}.KQ`]; }

async function probe(symbol, profile) {
  const providerSymbol = `${symbol}.KS`;
  const started = Date.now();
  try {
    const value = profile.profile === 'QUOTE'
      ? await yahoo.getQuote(providerSymbol)
      : await yahoo.getCandles(providerSymbol, profile.timeframe);
    const count = Array.isArray(value) ? value.length : Number(value?.price) > 0 ? 1 : 0;
    return {
      symbol, providerSymbol, profile: profile.profile, transport: 'GOVERNED_YAHOO_PROVIDER',
      httpStatus: count > 0 ? 200 : 502, ok: count > 0,
      elapsedMs: Date.now() - started, count,
    };
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : error);
    return {
      symbol, providerSymbol, profile: profile.profile, transport: 'GOVERNED_YAHOO_PROVIDER',
      httpStatus: Number(message.match(/YAHOO_CHART_HTTP_(\d{3})/u)?.[1] ?? 0) || null, ok: false,
      elapsedMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UNKNOWN',
      error: message,
    };
  }
}

async function yahooFallback(symbol, operation, calls, kind) {
  let lastError;
  for (const providerSymbol of providerCandidates(symbol)) {
    const started = Date.now();
    try {
      const value = await operation(providerSymbol);
      calls.push({ kind, providerSymbol, attempt: 1, ok: true, elapsedMs: Date.now() - started, count: Array.isArray(value) ? value.length : undefined });
      return value;
    } catch (error) {
      lastError = error;
      calls.push({ kind, providerSymbol, attempt: 1, ok: false, elapsedMs: Date.now() - started, error: sanitize(error instanceof Error ? error.message : error) });
      if (/YAHOO_CHART_HTTP_429|RATE_LIMIT_COOLDOWN_ACTIVE/u.test(String(error?.message ?? error))) throw error;
    }
  }
  throw lastError ?? new Error('YAHOO_DIAGNOSTIC_FALLBACK_FAILED');
}

async function scannerProbe(symbol, profile) {
  const originalGet = ScannerUniverseService.get;
  const originalCandles = MarketDataService.getCandles;
  const originalQuote = MarketDataService.getQuote;
  const calls = [];
  const entry = {
    ticker: symbol, name: symbol, market: 'KR', currency: 'KRW', assetType: 'STOCK', exchange: 'KOSPI',
    listingStatus: 'LISTED', source: 'kr-diagnostic-explicit',
  };
  const universe = {
    entries: [entry], totalCount: 1, source: 'kr-diagnostic-explicit', partial: false,
    stale: false, providerErrorCount: 0, loadedAt: new Date().toISOString(),
  };
  const started = Date.now();
  try {
    ScannerUniverseService.get = async (market) => market === 'KR' ? universe : originalGet.call(ScannerUniverseService, market);
    MarketDataService.getCandles = async (ticker, timeframe = '1D') => {
      calls.push({ kind: 'getCandles:start', inputTicker: String(ticker), timeframe: String(timeframe) });
      return yahooFallback(symbol, (providerSymbol) => yahoo.getCandles(providerSymbol, timeframe), calls, `candles:${String(timeframe)}`);
    };
    MarketDataService.getQuote = async (ticker) => {
      calls.push({ kind: 'getQuote:start', inputTicker: String(ticker) });
      const value = await yahooFallback(symbol, (providerSymbol) => yahoo.getQuote(providerSymbol), calls, 'quote');
      return { ...value, ticker: symbol, symbol, name: symbol };
    };
    const response = await StockSignalScannerService.scan({
      memberId: 'signal-intelligence-v3-diagnostic', market: 'KR', indicators: [],
      filters: { timeframe: profile.timeframe }, cursor: 0, batchSize: 10, strategyMode: profile.strategyMode,
    });
    return {
      symbol, profile: profile.profile, timeframe: profile.timeframe, ok: true, elapsedMs: Date.now() - started,
      response: {
        dataState: response.dataState, cardCount: response.cards.length, providerErrors: response.execution.providerErrorCount,
        timeouts: response.execution.timeoutCount, requested: response.execution.requestedCount, completed: response.execution.completedCount,
        message: sanitize(response.message),
      },
      calls,
    };
  } catch (error) {
    return {
      symbol, profile: profile.profile, timeframe: profile.timeframe, ok: false, elapsedMs: Date.now() - started,
      errorName: error instanceof Error ? error.name : 'UNKNOWN', error: sanitize(error instanceof Error ? error.message : error), calls,
    };
  } finally {
    ScannerUniverseService.get = originalGet;
    MarketDataService.getCandles = originalCandles;
    MarketDataService.getQuote = originalQuote;
  }
}

const rows = [];
yahoo.resetYahooProviderRuntimeForDiagnostics();
for (const symbol of SYMBOLS) {
  for (const profile of [...PROFILES, QUOTE_PROFILE]) {
    rows.push(await probe(symbol, profile));
  }
}
const scannerRows = [];
for (const symbol of SYMBOLS) for (const profile of PROFILES) scannerRows.push(await scannerProbe(symbol, profile));

const summary = {
  directTotal: rows.length,
  directOk: rows.filter((row) => row.ok).length,
  directFailed: rows.filter((row) => !row.ok).length,
  governedProviderOk: rows.filter((row) => row.ok).length,
  under1650ms: rows.filter((row) => row.ok && row.elapsedMs <= 1650).length,
  under3500ms: rows.filter((row) => row.ok && row.elapsedMs <= 3500).length,
  scannerTotal: scannerRows.length,
  scannerOk: scannerRows.filter((row) => row.ok).length,
  scannerFailed: scannerRows.filter((row) => !row.ok).length,
};

const report = {
  schemaVersion: 3, generatedAt: new Date().toISOString(), publicOnly: true,
  executionAuthority: 'NONE', privateApiAllowed: false, realOrderAllowed: false,
  summary, yahooGovernor: yahoo.yahooProviderDiagnostics(), rows, scannerRows,
};
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
