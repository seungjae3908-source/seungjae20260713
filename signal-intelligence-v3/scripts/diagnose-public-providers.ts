// @ts-nocheck
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import { StockSignalScannerService } from '../../api-server/src/services/stock-signal-scanner.service';
import { CryptoSignalScannerService } from '../../api-server/src/services/crypto-signal-scanner.service';
import * as yahoo from '../../api-server/src/providers/yahoo';

const MEMBER_ID = 'signal-intelligence-v3-provider-diagnostic';

function candidates(ticker, exchange) {
  const clean = String(ticker ?? '').toUpperCase();
  const kosdaq = /KOSDAQ|코스닥/u.test(String(exchange ?? '').toUpperCase());
  return [`${clean}.${kosdaq ? 'KQ' : 'KS'}`, `${clean}.${kosdaq ? 'KS' : 'KQ'}`];
}

async function fallback(symbols, fn) {
  let lastError;
  for (const symbol of symbols) {
    try { return await fn(symbol); } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function diagnoseKr() {
  const universe = await ScannerUniverseService.get('KR');
  const map = new Map(universe.entries.map((entry) => [entry.ticker, entry]));
  const originalCandles = MarketDataService.getCandles;
  const originalQuote = MarketDataService.getQuote;
  try {
    MarketDataService.getCandles = async (ticker, timeframe = '1D') => {
      const entry = map.get(ticker);
      return fallback(candidates(ticker, entry?.exchange), (symbol) => yahoo.getCandles(symbol, timeframe));
    };
    MarketDataService.getQuote = async (ticker) => {
      const entry = map.get(ticker);
      return fallback(candidates(ticker, entry?.exchange), (symbol) => yahoo.getQuote(symbol));
    };
    const response = await StockSignalScannerService.scan({
      memberId: MEMBER_ID,
      market: 'KR',
      indicators: [],
      filters: { timeframe: '60m' },
      cursor: 0,
      batchSize: 20,
      strategyMode: 'swing',
    });
    return {
      market: 'KR_STOCK',
      universe: response.universe.totalCount,
      failures: response.failures.map((row) => ({ symbol: row.symbol, reason: row.reason, message: row.message })),
      providerErrorCount: response.execution.providerErrorCount,
      timeoutCount: response.execution.timeoutCount,
    };
  } finally {
    MarketDataService.getCandles = originalCandles;
    MarketDataService.getQuote = originalQuote;
  }
}

async function diagnoseSpot() {
  const response = await CryptoSignalScannerService.scan({
    memberId: MEMBER_ID,
    market: 'spot',
    strategyMode: 'swing',
    timeframe: '60m',
    condition: 'trend',
    cursor: 0,
    batchSize: 20,
  });
  return {
    market: 'CRYPTO_SPOT',
    universe: response.universe.totalCount,
    failures: response.failures.map((row) => ({ symbol: row.symbol, reason: row.reason, message: row.message })),
    providerErrorCount: response.execution.providerErrorCount,
    timeoutCount: response.execution.timeoutCount,
  };
}

const result = { generatedAt: new Date().toISOString(), publicOnly: true, rows: [] };
for (const task of [diagnoseKr, diagnoseSpot]) {
  try { result.rows.push(await task()); }
  catch (error) { result.rows.push({ market: task === diagnoseKr ? 'KR_STOCK' : 'CRYPTO_SPOT', error: error instanceof Error ? error.message : String(error) }); }
}
console.log(JSON.stringify(result, null, 2));
