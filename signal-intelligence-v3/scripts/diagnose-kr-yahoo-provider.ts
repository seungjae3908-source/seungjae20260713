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
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const HARD_TIMEOUT_MS = 8_000;

function sanitize(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s|]+/gu, '[url]').slice(0, 320);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function providerCandidates(symbol) { return [`${symbol}.KS`, `${symbol}.KQ`]; }

async function probe(host, symbol, profile) {
  const providerSymbol = `${symbol}.KS`;
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(providerSymbol)}?range=${profile.range}&interval=${profile.interval}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('DIAGNOSTIC_TIMEOUT')), HARD_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/json,text/plain,*/*',
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    });
    const elapsedMs = Date.now() - started;
    let json = null;
    let parseError = null;
    try { json = await response.json(); } catch (error) { parseError = sanitize(error instanceof Error ? error.message : error); }
    const result = json?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = Array.isArray(quote?.close) ? quote.close.filter((v) => Number.isFinite(Number(v))) : [];
    return {
      symbol, providerSymbol, profile: profile.profile, host, httpStatus: response.status,
      ok: response.ok && Boolean(quote) && timestamps.length > 0 && closes.length > 0,
      elapsedMs, timestampCount: timestamps.length, validCloseCount: closes.length,
      chartErrorCode: sanitize(json?.chart?.error?.code ?? ''), chartErrorDescription: sanitize(json?.chart?.error?.description ?? ''), parseError,
    };
  } catch (error) {
    return {
      symbol, providerSymbol, profile: profile.profile, host, httpStatus: null, ok: false,
      elapsedMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UNKNOWN',
      error: sanitize(error instanceof Error ? error.message : error),
    };
  } finally { clearTimeout(timeout); }
}

async function yahooFallback(symbol, operation, calls, kind) {
  let lastError;
  for (const providerSymbol of providerCandidates(symbol)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = Date.now();
      try {
        const value = await operation(providerSymbol);
        calls.push({ kind, providerSymbol, attempt, ok: true, elapsedMs: Date.now() - started, count: Array.isArray(value) ? value.length : undefined });
        return value;
      } catch (error) {
        lastError = error;
        calls.push({ kind, providerSymbol, attempt, ok: false, elapsedMs: Date.now() - started, error: sanitize(error instanceof Error ? error.message : error) });
        if (attempt < 3) await sleep(150 * attempt);
      }
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
for (const symbol of SYMBOLS) {
  for (const profile of [...PROFILES, QUOTE_PROFILE]) {
    for (const host of HOSTS) rows.push(await probe(host, symbol, profile));
  }
}
const scannerRows = [];
for (const symbol of SYMBOLS) for (const profile of PROFILES) scannerRows.push(await scannerProbe(symbol, profile));

const summary = {
  directTotal: rows.length,
  directOk: rows.filter((row) => row.ok).length,
  directFailed: rows.filter((row) => !row.ok).length,
  query1Ok: rows.filter((row) => row.host.startsWith('query1') && row.ok).length,
  query2Ok: rows.filter((row) => row.host.startsWith('query2') && row.ok).length,
  under1650ms: rows.filter((row) => row.ok && row.elapsedMs <= 1650).length,
  under3500ms: rows.filter((row) => row.ok && row.elapsedMs <= 3500).length,
  scannerTotal: scannerRows.length,
  scannerOk: scannerRows.filter((row) => row.ok).length,
  scannerFailed: scannerRows.filter((row) => !row.ok).length,
};

const report = {
  schemaVersion: 2, generatedAt: new Date().toISOString(), publicOnly: true,
  executionAuthority: 'NONE', privateApiAllowed: false, realOrderAllowed: false,
  hardTimeoutMs: HARD_TIMEOUT_MS, summary, rows, scannerRows,
};
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
