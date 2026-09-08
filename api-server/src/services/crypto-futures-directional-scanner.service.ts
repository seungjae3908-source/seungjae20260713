import { createHash, randomUUID } from 'node:crypto';
import {
  applyFuturesDerivativesEvidenceGate,
  getFuturesDirectionalDerivativesEvidence,
  type FuturesDirectionalDerivativesEvidence,
} from './crypto-futures-derivatives-evidence.service';
import {
  evaluateFuturesDirectionalPair,
  type FuturesDirectionalCandle,
  type FuturesDirectionalFormulaResult,
  type FuturesScannerCondition,
  type FuturesScannerDirection,
} from './crypto-futures-directional-formula.service';
import type {
  ScannerDataState,
  ScannerSignalCard,
  ScannerStrategyMode,
} from './scanner-signal.types';

const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const PROVIDER_TIMEOUT_MS = 8_000;
const ITEM_TIMEOUT_MS = 10_000;
const MAX_CONCURRENCY = 4;
const FORMULA_VERSION = 'crypto-futures-directional-v1';

export type FuturesDirectionalView = 'LONG' | 'SHORT' | 'BOTH';

export interface FuturesDirectionalTicker {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  tradingValue: number;
  bid: number | null;
  ask: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  timestamp: number | null;
}

export interface FuturesDirectionalUniverse {
  rows: FuturesDirectionalTicker[];
  source: 'bitget-public';
  providerErrorCount: number;
}

export interface FuturesDirectionalRuntimeProviders {
  getUniverse(signal?: AbortSignal): Promise<FuturesDirectionalUniverse>;
  getCandles(symbol: string, timeframe: string, signal?: AbortSignal): Promise<FuturesDirectionalCandle[]>;
  getDerivativesEvidence(symbol: string, signal?: AbortSignal): Promise<FuturesDirectionalDerivativesEvidence>;
  now(): number;
}

export interface FuturesDirectionalScanRequest {
  memberId: string;
  view: FuturesDirectionalView;
  strategyMode: ScannerStrategyMode;
  timeframe: string;
  condition: FuturesScannerCondition;
  cursor: number;
  batchSize: number;
  minimumScore?: number;
  maximumRiskScore?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface FuturesDirectionalLane {
  direction: FuturesScannerDirection;
  formulaVersion: string;
  decision: 'SIGNAL_AVAILABLE' | 'NO_TRADE';
  evaluatedCount: number;
  displayedCount: number;
  actionableCount: number;
  cards: ScannerSignalCard[];
}

export interface FuturesDirectionalConflict {
  symbol: string;
  longScore: number;
  shortScore: number;
  reason: 'SIGNAL_CONFLICT';
}

export interface FuturesDirectionalScanFailure {
  symbol: string;
  reason: 'provider_error' | 'timeout' | 'invalid_data';
  message: string;
}

export interface FuturesDirectionalScanResponse {
  ok: true;
  requestId: string;
  assetClass: 'coin_futures';
  market: 'futures';
  exchange: 'Bitget';
  strategy: ScannerStrategyMode;
  timeframe: string;
  condition: FuturesScannerCondition;
  requestedView: FuturesDirectionalView;
  formulaVersion: string;
  lanes: {
    long: FuturesDirectionalLane;
    short: FuturesDirectionalLane;
  };
  cards: ScannerSignalCard[];
  conflicts: FuturesDirectionalConflict[];
  failures: FuturesDirectionalScanFailure[];
  universe: {
    totalCount: number;
    cursor: number;
    nextCursor: number | null;
    source: 'bitget-public' | 'unavailable';
  };
  execution: {
    requestedCount: number;
    completedCount: number;
    providerErrorCount: number;
    timeoutCount: number;
    elapsedMs: number;
    maxConcurrency: number;
  };
  dataState: ScannerDataState;
  message: string;
  generatedAt: string;
  publicDataOnly: true;
  executionAuthority: 'NONE';
  orderSubmitted: false;
  exchangeRequestSent: false;
  liveTradingEnabled: false;
}

type BitgetTickerRow = {
  symbol?: unknown;
  lastPr?: unknown;
  markPrice?: unknown;
  change24h?: unknown;
  baseVolume?: unknown;
  usdtVolume?: unknown;
  bidPr?: unknown;
  askPr?: unknown;
  fundingRate?: unknown;
  holdingAmount?: unknown;
  ts?: unknown;
};

type BitgetEnvelope<T> = { code?: unknown; data?: T };

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function timeframeMs(timeframe: string): number {
  const normalized = timeframe === '60m' ? '1H' : timeframe;
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 3 * 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1H': 60 * 60_000,
    '4H': 4 * 60 * 60_000,
    '6H': 6 * 60 * 60_000,
    '12H': 12 * 60 * 60_000,
    '1D': 24 * 60 * 60_000,
    '1W': 7 * 24 * 60 * 60_000,
  };
  return map[normalized] ?? 15 * 60_000;
}

function bitgetGranularity(timeframe: string): string {
  return timeframe === '60m' ? '1H' : timeframe;
}

function riskLevel(score: number): ScannerSignalCard['riskLevel'] {
  if (score <= 30) return 'LOW';
  if (score <= 60) return 'MEDIUM';
  return 'HIGH';
}

function spreadPercent(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask < bid) return null;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? ((ask - bid) / midpoint) * 100 : null;
}

function iso(value: number | null, fallback: number): string {
  const timestamp = value != null && Number.isFinite(value) && value > 0 ? value : fallback;
  return new Date(timestamp).toISOString();
}

function makeAbortController(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason ?? new Error('FUTURES_DIRECTIONAL_SCAN_ABORTED'));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('FUTURES_DIRECTIONAL_PROVIDER_TIMEOUT')), timeoutMs);
  return {
    controller,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function fetchJson<T>(url: string, signal?: AbortSignal, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<T> {
  const linked = makeAbortController(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/2.0',
      },
      signal: linked.controller.signal,
    });
    if (!response.ok) throw new Error(`BITGET_HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    linked.cleanup();
  }
}

async function defaultUniverse(signal?: AbortSignal): Promise<FuturesDirectionalUniverse> {
  const payload = await fetchJson<BitgetEnvelope<BitgetTickerRow[]>>(
    `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`,
    signal,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
    throw new Error(`BITGET_${text(payload.code) || 'INVALID_TICKERS'}`);
  }
  const newest = new Map<string, FuturesDirectionalTicker>();
  for (const row of payload.data) {
    const symbol = text(row.symbol).toUpperCase();
    const price = finite(row.markPrice ?? row.lastPr);
    if (!/^[A-Z0-9]{2,24}USDT$/.test(symbol) || price == null || price <= 0) continue;
    const timestamp = finite(row.ts);
    const ticker: FuturesDirectionalTicker = {
      symbol,
      name: symbol,
      price,
      changePercent: (finite(row.change24h) ?? 0) * 100,
      volume: finite(row.baseVolume) ?? 0,
      tradingValue: finite(row.usdtVolume) ?? 0,
      bid: finite(row.bidPr),
      ask: finite(row.askPr),
      fundingRate: finite(row.fundingRate),
      openInterest: finite(row.holdingAmount),
      timestamp,
    };
    const previous = newest.get(symbol);
    if (!previous || (timestamp ?? 0) >= (previous.timestamp ?? 0)) newest.set(symbol, ticker);
  }
  const rows = [...newest.values()]
    .sort((left, right) => right.tradingValue - left.tradingValue || left.symbol.localeCompare(right.symbol));
  if (!rows.length) throw new Error('BITGET_TICKERS_EMPTY');
  return { rows, source: 'bitget-public', providerErrorCount: 0 };
}

async function defaultCandles(
  symbol: string,
  timeframe: string,
  signal?: AbortSignal,
): Promise<FuturesDirectionalCandle[]> {
  const payload = await fetchJson<BitgetEnvelope<unknown[]>>(
    `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(bitgetGranularity(timeframe))}&limit=200`,
    signal,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
    throw new Error(`BITGET_${text(payload.code) || 'INVALID_CANDLES'}`);
  }
  const now = Date.now();
  const duration = timeframeMs(timeframe);
  const byTime = new Map<number, FuturesDirectionalCandle>();
  for (const raw of payload.data) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    const time = finite(raw[0]);
    const open = finite(raw[1]);
    const high = finite(raw[2]);
    const low = finite(raw[3]);
    const close = finite(raw[4]);
    const volume = finite(raw[5]);
    const quoteVolume = finite(raw[6]);
    if (time == null || open == null || high == null || low == null || close == null || volume == null) continue;
    if (time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    if (high < low || open > high || open < low || close > high || close < low) continue;
    // Never let the still-forming candle enter the deterministic formula.
    if (time + duration > now) continue;
    byTime.set(time, { time, open, high, low, close, volume, quoteVolume });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

const defaultProviders: FuturesDirectionalRuntimeProviders = {
  getUniverse: defaultUniverse,
  getCandles: defaultCandles,
  getDerivativesEvidence: getFuturesDirectionalDerivativesEvidence,
  now: Date.now,
};

function signalId(
  request: FuturesDirectionalScanRequest,
  ticker: FuturesDirectionalTicker,
  direction: FuturesScannerDirection,
): string {
  const digest = createHash('sha256')
    .update([
      request.memberId,
      'crypto-futures-directional',
      ticker.symbol,
      direction,
      request.strategyMode,
      request.timeframe,
      request.condition,
      FORMULA_VERSION,
    ].join(':'))
    .digest('hex')
    .slice(0, 24);
  return `signal:${digest}`;
}

function toCard(
  request: FuturesDirectionalScanRequest,
  ticker: FuturesDirectionalTicker,
  result: FuturesDirectionalFormulaResult,
  now: number,
  conflict: boolean,
): ScannerSignalCard {
  const direction = result.direction;
  const effectiveStrongSignal = result.strongSignalEligible && !conflict;
  const matched = result.evidence.filter((row) => row.status === 'matched').map((row) => row.label);
  const notMatched = result.evidence.filter((row) => row.status === 'not_matched').map((row) => row.label);
  const unverified = result.evidence.filter((row) => row.status === 'unverified').map((row) => row.label);
  const observedAt = iso(ticker.timestamp, now);
  const expiresAt = new Date(now + timeframeMs(request.timeframe) * 2).toISOString();
  return {
    signalId: signalId(request, ticker, direction),
    assetClass: 'coin_futures',
    market: 'futures',
    exchange: 'Bitget',
    symbol: ticker.symbol,
    name: ticker.name,
    currency: 'USDT',
    assetType: 'crypto_futures',
    listingStatus: 'LISTED',
    price: ticker.price,
    changePercent: ticker.changePercent,
    direction,
    action: direction,
    signalState: 'CANDIDATE',
    score: result.score,
    confidence: result.confidence,
    dataCompleteness: result.dataCompleteness,
    riskScore: result.riskScore,
    riskLevel: riskLevel(result.riskScore),
    liquidity: ticker.tradingValue,
    volume: ticker.volume,
    tradingValue: ticker.tradingValue,
    spreadPercent: spreadPercent(ticker.bid, ticker.ask),
    volatilityPercent: result.volatilityPercent,
    matched,
    notMatched,
    unverified,
    evidence: result.evidence,
    pricePlan: result.pricePlan,
    dataState: result.dataState,
    dataSources: ['bitget-public', 'closed-candles', FORMULA_VERSION],
    observedAt,
    expiresAt,
    strongSignalEligible: effectiveStrongSignal,
    warnings: [
      ...result.warnings,
      ...(conflict ? ['LONG/SHORT 독립 강신호 충돌로 매매 승격을 차단했습니다.'] : []),
      '방향별 Formula는 Research Candidate이며 OOS/WF/비용·홀드아웃 검증 전 수익성 근거가 아닙니다.',
    ],
    strategyMode: request.strategyMode,
    aiValidation: {
      status: 'NOT_RUN',
      provider: null,
      counterEvidence: [],
      missingData: [],
      risks: [],
      explanation: null,
    },
    backtestQuality: {
      status: 'missing',
      source: FORMULA_VERSION,
      oos: false,
      walkForward: false,
      costsIncluded: false,
      slippageIncluded: false,
      lookaheadGuarded: true,
      survivorshipGuarded: false,
    },
  };
}

function rankLane(
  cards: ScannerSignalCard[],
  request: FuturesDirectionalScanRequest,
): ScannerSignalCard[] {
  const minimumScore = request.minimumScore ?? 0;
  const maximumRiskScore = request.maximumRiskScore ?? 100;
  const limit = Math.max(1, Math.min(20, request.limit ?? 10));
  return cards
    .filter((card) => card.score >= minimumScore && (card.riskScore ?? 100) <= maximumRiskScore)
    .sort((left, right) => (
      Number(right.strongSignalEligible) - Number(left.strongSignalEligible)
      || right.score - left.score
      || right.confidence - left.confidence
      || (left.riskScore ?? 100) - (right.riskScore ?? 100)
      || (right.tradingValue ?? 0) - (left.tradingValue ?? 0)
      || left.symbol.localeCompare(right.symbol)
    ))
    .slice(0, limit);
}

async function mapBounded<T, R>(
  rows: T[],
  concurrency: number,
  mapper: (row: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(rows.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= rows.length) return;
      result[index] = await mapper(rows[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
  return result;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout|aborted/i.test(`${error.name}:${error.message}`);
}

type EvaluationRow = {
  ticker: FuturesDirectionalTicker;
  pair: ReturnType<typeof evaluateFuturesDirectionalPair> | null;
  derivativesEvidence: FuturesDirectionalDerivativesEvidence | null;
  failure: FuturesDirectionalScanFailure | null;
};

export function createCryptoFuturesDirectionalScannerService(
  providers: FuturesDirectionalRuntimeProviders = defaultProviders,
) {
  return {
    async scan(request: FuturesDirectionalScanRequest): Promise<FuturesDirectionalScanResponse> {
      const startedAt = providers.now();
      const requestId = randomUUID();
      if (request.signal?.aborted) throw request.signal.reason ?? new Error('FUTURES_DIRECTIONAL_SCAN_ABORTED');

      let universe: FuturesDirectionalUniverse;
      try {
        universe = await providers.getUniverse(request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        const generatedAt = new Date(providers.now()).toISOString();
        return {
          ok: true,
          requestId,
          assetClass: 'coin_futures',
          market: 'futures',
          exchange: 'Bitget',
          strategy: request.strategyMode,
          timeframe: request.timeframe,
          condition: request.condition,
          requestedView: request.view,
          formulaVersion: FORMULA_VERSION,
          lanes: {
            long: { direction: 'LONG', formulaVersion: FORMULA_VERSION, decision: 'NO_TRADE', evaluatedCount: 0, displayedCount: 0, actionableCount: 0, cards: [] },
            short: { direction: 'SHORT', formulaVersion: FORMULA_VERSION, decision: 'NO_TRADE', evaluatedCount: 0, displayedCount: 0, actionableCount: 0, cards: [] },
          },
          cards: [],
          conflicts: [],
          failures: [{ symbol: '*', reason: 'provider_error', message: error instanceof Error ? error.message : 'FUTURES_UNIVERSE_UNAVAILABLE' }],
          universe: { totalCount: 0, cursor: request.cursor, nextCursor: null, source: 'unavailable' },
          execution: { requestedCount: 0, completedCount: 0, providerErrorCount: 1, timeoutCount: 0, elapsedMs: providers.now() - startedAt, maxConcurrency: MAX_CONCURRENCY },
          dataState: 'unavailable',
          message: '선물 공개 데이터 Universe를 확인할 수 없어 NO_TRADE로 종료했습니다.',
          generatedAt,
          publicDataOnly: true,
          executionAuthority: 'NONE',
          orderSubmitted: false,
          exchangeRequestSent: false,
          liveTradingEnabled: false,
        };
      }

      const cursor = Math.max(0, Math.trunc(request.cursor));
      const batchSize = Math.max(1, Math.min(40, Math.trunc(request.batchSize)));
      const batch = universe.rows.slice(cursor, cursor + batchSize);
      const evaluations = await mapBounded(batch, MAX_CONCURRENCY, async (ticker): Promise<EvaluationRow> => {
        const linked = makeAbortController(request.signal, ITEM_TIMEOUT_MS);
        try {
          const candles = await providers.getCandles(ticker.symbol, request.timeframe, linked.controller.signal);
          if (candles.length < 20) {
            return {
              ticker,
              pair: null,
              derivativesEvidence: null,
              failure: { symbol: ticker.symbol, reason: 'invalid_data', message: 'CLOSED_CANDLES_INSUFFICIENT' },
            };
          }

          const baseInput = {
            timeframe: request.timeframe,
            condition: request.condition,
            price: ticker.price,
            changePercent: ticker.changePercent,
            tradingValue: ticker.tradingValue,
            fundingRate: ticker.fundingRate,
            openInterest: ticker.openInterest,
            bid: ticker.bid,
            ask: ticker.ask,
            tickerTimestamp: ticker.timestamp,
            candles,
            now: providers.now(),
          };
          const preliminaryPair = evaluateFuturesDirectionalPair(baseInput);
          if (preliminaryPair.decision === 'NO_TRADE') {
            return { ticker, pair: preliminaryPair, derivativesEvidence: null, failure: null };
          }

          let derivativesEvidence: FuturesDirectionalDerivativesEvidence;
          try {
            derivativesEvidence = await providers.getDerivativesEvidence(ticker.symbol, linked.controller.signal);
          } catch (error) {
            if (request.signal?.aborted) throw request.signal.reason ?? error;
            return {
              ticker,
              pair: preliminaryPair,
              derivativesEvidence: null,
              failure: {
                symbol: ticker.symbol,
                reason: isTimeout(error) ? 'timeout' : 'provider_error',
                message: `BLOCKED_DERIVATIVES_EVIDENCE:${error instanceof Error ? error.message : 'DERIVATIVES_EVIDENCE_UNAVAILABLE'}`,
              },
            };
          }

          const pair = evaluateFuturesDirectionalPair({
            ...baseInput,
            fundingRate: derivativesEvidence.fundingRate,
            openInterest: derivativesEvidence.openInterest,
            now: providers.now(),
          });
          return {
            ticker,
            pair,
            derivativesEvidence,
            failure: derivativesEvidence.status === 'READY'
              ? null
              : {
                symbol: ticker.symbol,
                reason: 'invalid_data',
                message: `BLOCKED_DERIVATIVES_EVIDENCE:${derivativesEvidence.blockers.join(',') || 'UNKNOWN'}`,
              },
          };
        } catch (error) {
          if (request.signal?.aborted) throw request.signal.reason ?? error;
          return {
            ticker,
            pair: null,
            derivativesEvidence: null,
            failure: {
              symbol: ticker.symbol,
              reason: isTimeout(error) ? 'timeout' : 'provider_error',
              message: error instanceof Error ? error.message : 'FUTURES_DIRECTIONAL_ITEM_FAILED',
            },
          };
        } finally {
          linked.cleanup();
        }
      });

      if (request.signal?.aborted) throw request.signal.reason ?? new Error('FUTURES_DIRECTIONAL_SCAN_ABORTED');
      const failures = evaluations.flatMap((row) => row.failure ? [row.failure] : []);
      const valid = evaluations.filter((row): row is EvaluationRow & { pair: NonNullable<EvaluationRow['pair']> } => row.pair != null);
      const conflicts: FuturesDirectionalConflict[] = valid
        .filter((row) => row.pair.decision === 'SIGNAL_CONFLICT' && row.derivativesEvidence?.status === 'READY')
        .map((row) => ({ symbol: row.ticker.symbol, longScore: row.pair.long.score, shortScore: row.pair.short.score, reason: 'SIGNAL_CONFLICT' }));
      const conflictSymbols = new Set(conflicts.map((row) => row.symbol));
      const longCards = rankLane(valid.map((row) => applyFuturesDerivativesEvidenceGate(
        toCard(request, row.ticker, row.pair.long, providers.now(), conflictSymbols.has(row.ticker.symbol)),
        row.derivativesEvidence,
      )), request);
      const shortCards = rankLane(valid.map((row) => applyFuturesDerivativesEvidenceGate(
        toCard(request, row.ticker, row.pair.short, providers.now(), conflictSymbols.has(row.ticker.symbol)),
        row.derivativesEvidence,
      )), request);
      const longActionable = longCards.filter((card) => card.strongSignalEligible).length;
      const shortActionable = shortCards.filter((card) => card.strongSignalEligible).length;
      const longLane: FuturesDirectionalLane = {
        direction: 'LONG',
        formulaVersion: FORMULA_VERSION,
        decision: longActionable > 0 ? 'SIGNAL_AVAILABLE' : 'NO_TRADE',
        evaluatedCount: valid.length,
        displayedCount: longCards.length,
        actionableCount: longActionable,
        cards: longCards,
      };
      const shortLane: FuturesDirectionalLane = {
        direction: 'SHORT',
        formulaVersion: FORMULA_VERSION,
        decision: shortActionable > 0 ? 'SIGNAL_AVAILABLE' : 'NO_TRADE',
        evaluatedCount: valid.length,
        displayedCount: shortCards.length,
        actionableCount: shortActionable,
        cards: shortCards,
      };
      const cards = request.view === 'LONG' ? longCards : request.view === 'SHORT' ? shortCards : [];
      const nextCursor = cursor + batchSize < universe.rows.length ? cursor + batchSize : null;
      const providerErrorCount = failures.filter((row) => row.reason === 'provider_error').length + universe.providerErrorCount;
      const timeoutCount = failures.filter((row) => row.reason === 'timeout').length;
      const allDirectionalCards = [...longCards, ...shortCards];
      const staleCount = allDirectionalCards.filter((card) => card.dataState === 'stale').length;
      const blockedDerivativesCount = allDirectionalCards.filter((card) => card.warnings.includes('BLOCKED_DERIVATIVES_EVIDENCE')).length;
      const dataState: ScannerDataState = valid.length === 0
        ? providerErrorCount > 0 ? 'unavailable' : 'insufficient'
        : staleCount > 0 || failures.length > 0 || blockedDerivativesCount > 0 ? 'partial' : 'complete';
      const generatedAt = new Date(providers.now()).toISOString();
      const decisionText = `LONG ${longLane.decision}(${longActionable}) · SHORT ${shortLane.decision}(${shortActionable})`;
      return {
        ok: true,
        requestId,
        assetClass: 'coin_futures',
        market: 'futures',
        exchange: 'Bitget',
        strategy: request.strategyMode,
        timeframe: request.timeframe,
        condition: request.condition,
        requestedView: request.view,
        formulaVersion: FORMULA_VERSION,
        lanes: { long: longLane, short: shortLane },
        cards,
        conflicts,
        failures,
        universe: { totalCount: universe.rows.length, cursor, nextCursor, source: universe.source },
        execution: {
          requestedCount: batch.length,
          completedCount: valid.length,
          providerErrorCount,
          timeoutCount,
          elapsedMs: providers.now() - startedAt,
          maxConcurrency: MAX_CONCURRENCY,
        },
        dataState,
        message: `${decisionText}${conflicts.length ? ` · SIGNAL_CONFLICT ${conflicts.length}` : ''}${blockedDerivativesCount ? ` · BLOCKED_DERIVATIVES_EVIDENCE ${blockedDerivativesCount}` : ''}`,
        generatedAt,
        publicDataOnly: true,
        executionAuthority: 'NONE',
        orderSubmitted: false,
        exchangeRequestSent: false,
        liveTradingEnabled: false,
      };
    },
  };
}

export const CryptoFuturesDirectionalScannerService = createCryptoFuturesDirectionalScannerService();
export const cryptoFuturesDirectionalFormulaVersion = FORMULA_VERSION;
