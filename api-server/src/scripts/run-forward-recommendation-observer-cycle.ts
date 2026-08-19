import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from '../services/market-data.service';
import { StockSignalScannerService } from '../services/stock-signal-scanner.service';
import { CryptoSignalScannerService } from '../services/crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from '../services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../services/scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from '../services/scanner-market-action.service';
import type { ScannerResponse, ScannerSignalCard } from '../services/scanner-signal.types';
import type { ForwardRecommendationObservation } from '../services/forward-recommendation-observer.service';
import type { SignalOutcomeBar } from '../services/signal-performance-learning.service';
import {
  createForwardObserverRuntimeState,
  runForwardRecommendationObserverCycle,
  validateForwardObserverRuntimeState,
  type ForwardObserverLane,
  type ForwardObserverRuntimeState,
} from '../services/forward-recommendation-observer-runtime.service';
import * as yahoo from '../providers/yahoo';
import type { Candle, Quote, Timeframe } from '../sample/types';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const direct = process.argv.find((item) => item.startsWith(prefix));
  if (direct) return direct.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : null;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`FORWARD_OBSERVER_${name.toUpperCase().replace(/-/gu, '_')}_REQUIRED`);
  return value;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value: Candle['time'] | number): string | null {
  if (typeof value === 'number') {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('FORWARD_OBSERVER_PUBLIC_PROVIDER_TIMEOUT')), 8_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'forward-recommendation-observer/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`PUBLIC_PROVIDER_HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function addSource(card: ScannerSignalCard, source: string): ScannerSignalCard {
  return { ...card, dataSources: [...new Set([...card.dataSources, source])] };
}

async function withYahooPublicOnlyStockData<T>(operation: () => Promise<T>): Promise<T> {
  const mutable = MarketDataService as unknown as {
    getCandles(ticker: string, timeframe?: Timeframe): Promise<Candle[]>;
    getQuote(ticker: string): Promise<Quote>;
  };
  const originalCandles = mutable.getCandles;
  const originalQuote = mutable.getQuote;
  mutable.getCandles = async (ticker, timeframe = '1D') => yahoo.getCandles(ticker, timeframe);
  mutable.getQuote = async (ticker) => await yahoo.getQuote(ticker) as Quote;
  try {
    return await operation();
  } finally {
    mutable.getCandles = originalCandles;
    mutable.getQuote = originalQuote;
  }
}

async function scanStockLane(lane: ForwardObserverLane, cursor: number): Promise<ScannerResponse> {
  const market = lane.scannerMarket;
  if (market !== 'KR' && market !== 'US') throw new Error('STOCK_LANE_MARKET_INVALID');
  return await withYahooPublicOnlyStockData(async () => {
    const scanned = await StockSignalScannerService.scan({
      memberId: 'forward-observer-public-only',
      market,
      indicators: [],
      filters: { timeframe: lane.timeframe } as never,
      cursor,
      batchSize: lane.batchSize,
      strategyMode: 'swing',
    });
    return withScannerCanonicalActions({
      ...scanned,
      cards: scanned.cards.map((card) => addSource(card, 'yahoo-public')),
    });
  });
}

async function scanCryptoLane(lane: ForwardObserverLane, cursor: number): Promise<ScannerResponse> {
  const market = lane.scannerMarket;
  if (market !== 'spot' && market !== 'futures') throw new Error('CRYPTO_LANE_MARKET_INVALID');
  const scanned = await CryptoSignalScannerService.scan({
    memberId: 'forward-observer-public-only',
    market,
    strategyMode: 'swing',
    timeframe: '60m',
    condition: 'trend',
    cursor,
    batchSize: lane.batchSize,
  });
  const aligned = await CryptoPricePrecisionService.align(market, scanned);
  const ranking = rankScannerCandidates({
    cards: aligned.cards,
    market: aligned.market,
    strategy: 'swing',
    limit: 10,
  });
  const rankedCards = ranking.cards
    .map((card) => card.signalGrade === 'B'
      ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' as const }
      : card)
    .filter((card) => market === 'spot'
      ? card.direction === 'LONG'
      : card.direction === 'LONG' || card.direction === 'SHORT');
  return withScannerCanonicalActions({
    ...aligned,
    cards: rankedCards,
    execution: {
      ...aligned.execution,
      hardFilterPassCount: ranking.diagnostics.hardFilterPassCount,
      hardFilterRejectedCount: ranking.diagnostics.hardFilterRejectedCount,
      softCandidateCount: ranking.diagnostics.softCandidateCount,
      finalDisplayedCount: rankedCards.length,
      sGradeCount: rankedCards.filter((card) => card.signalGrade === 'S').length,
      aGradeCount: rankedCards.filter((card) => card.signalGrade === 'A').length,
      bGradeCount: rankedCards.filter((card) => card.signalGrade === 'B').length,
      backtestMissingCount: ranking.diagnostics.backtestMissingCount,
    },
  });
}

async function stockFutureBars(observation: ForwardRecommendationObservation): Promise<SignalOutcomeBar[]> {
  const candles = await yahoo.getCandles(observation.snapshot.symbol, '60m');
  return candles.flatMap((candle) => {
    const at = timestamp(candle.time);
    if (!at) return [];
    return [{ timestamp: at, high: candle.high, low: candle.low, close: candle.close }];
  });
}

type UpbitCandleRow = {
  timestamp?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  trade_price?: unknown;
};
type BitgetEnvelope = { code?: unknown; data?: unknown[] };

async function cryptoFutureBars(observation: ForwardRecommendationObservation): Promise<SignalOutcomeBar[]> {
  const symbol = observation.snapshot.symbol.trim().toUpperCase();
  if (observation.identity.market === 'CRYPTO_SPOT') {
    const rows = await fetchJson<UpbitCandleRow[]>(
      `${UPBIT_BASE}/v1/candles/minutes/60?market=${encodeURIComponent(`KRW-${symbol}`)}&count=200`,
    );
    return rows.flatMap((row) => {
      const at = finite(row.timestamp);
      const high = finite(row.high_price);
      const low = finite(row.low_price);
      const close = finite(row.trade_price);
      if (at == null || high == null || low == null || close == null || high <= 0 || low <= 0 || close <= 0) return [];
      return [{ timestamp: new Date(at).toISOString(), high, low, close }];
    });
  }
  const payload = await fetchJson<BitgetEnvelope>(
    `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=1H&limit=200`,
  );
  if (String(payload.code ?? '') !== '00000' || !Array.isArray(payload.data)) throw new Error('BITGET_PUBLIC_CANDLES_INVALID');
  return payload.data.flatMap((raw) => {
    if (!Array.isArray(raw)) return [];
    const at = finite(raw[0]);
    const high = finite(raw[2]);
    const low = finite(raw[3]);
    const close = finite(raw[4]);
    if (at == null || high == null || low == null || close == null || high <= 0 || low <= 0 || close <= 0) return [];
    return [{ timestamp: new Date(at).toISOString(), high, low, close }];
  });
}

async function readState(file: string | null, researchCodeSha: string): Promise<ForwardObserverRuntimeState> {
  if (!file) return createForwardObserverRuntimeState(researchCodeSha);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as ForwardObserverRuntimeState;
  validateForwardObserverRuntimeState(parsed, researchCodeSha);
  return parsed;
}

async function main(): Promise<void> {
  const researchCodeSha = requiredArgument('research-sha').toLowerCase();
  const outputDir = path.resolve(requiredArgument('output-dir'));
  const stateInput = argument('state-input');
  const state = await readState(stateInput ? path.resolve(stateInput) : null, researchCodeSha);
  const result = await runForwardRecommendationObserverCycle({
    state,
    researchCodeSha,
    dependencies: {
      scanLane: async (lane, cursor) => lane.market === 'KR_STOCK' || lane.market === 'US_STOCK'
        ? scanStockLane(lane, cursor)
        : scanCryptoLane(lane, cursor),
      loadFutureBars: async (observation) => observation.identity.market === 'KR_STOCK' || observation.identity.market === 'US_STOCK'
        ? stockFutureBars(observation)
        : cryptoFutureBars(observation),
      now: () => new Date(),
    },
  });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'state.json'), `${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(result.summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    researchCodeSha,
    counts: result.summary.counts,
    coverage: result.summary.coverage,
    safety: result.summary.safety,
  })}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'FORWARD_OBSERVER_CYCLE_FAILED');
  process.exitCode = 1;
});
