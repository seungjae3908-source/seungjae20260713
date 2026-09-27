import { createHash } from 'node:crypto';
import {
  createCryptoSignalScannerService,
  type CryptoCandle,
  type CryptoSignalScanRequest,
  type CryptoTicker,
  type CryptoTimeframe,
} from './crypto-signal-scanner.service';
import { withScannerCanonicalActions } from './scanner-market-action.service';
import {
  scannerContextTimeframe,
  type ScannerStrategyMode,
} from './scanner-quant-strategy.service';
import type { ScannerResponse } from './scanner-signal.types';

type CryptoMarket = 'spot' | 'futures';

const SHA64 = /^[0-9a-f]{64}$/iu;
const historicalSessionLastDecision = new Map<string, number>();

export const SCANNER_CRYPTO_HISTORICAL_CARD_V1 =
  'scanner-crypto-historical-card-v1' as const;

export type HistoricalPublicEvidence = Readonly<{
  sourceId: string;
  sourceDigest: string;
  asOfMs: number;
  publicMarketData: true;
}>;

export type HistoricalCryptoScannerInput = Readonly<{
  replaySessionId: string;
  decisionTimeMs: number;
  market: CryptoMarket;
  timeframe: CryptoTimeframe;
  condition: CryptoSignalScanRequest['condition'];
  strategyMode: ScannerStrategyMode;
  ticker: CryptoTicker;
  spread: Readonly<{ bid: number | null; ask: number | null }>;
  candlesByTimeframe: Readonly<Partial<Record<CryptoTimeframe, readonly CryptoCandle[]>>>;
  provenance: Readonly<{
    ticker: HistoricalPublicEvidence;
    spread: HistoricalPublicEvidence;
    candles: Readonly<Partial<Record<CryptoTimeframe, HistoricalPublicEvidence>>>;
  }>;
}>;

export type HistoricalCryptoScannerDecision = Readonly<{
  schemaVersion: typeof SCANNER_CRYPTO_HISTORICAL_CARD_V1;
  status: 'READY' | 'VALID_ZERO_SIGNAL' | 'BLOCKED_DATA';
  reason: string | null;
  decisionTime: string;
  market: CryptoMarket;
  timeframe: CryptoTimeframe;
  contextTimeframe: CryptoTimeframe;
  symbol: string;
  response: ScannerResponse | null;
  evidenceDigest: string | null;
  historicalReplayOnly: true;
  pointInTimeOnly: true;
  rankingQualityInjected: false;
  economicSampleCredit: 0;
  profitabilityClaimAllowed: false;
  executionAuthority: 'NONE';
}>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function blocked(
  input: Pick<HistoricalCryptoScannerInput, 'decisionTimeMs' | 'market' | 'timeframe' | 'ticker'>,
  contextTimeframe: CryptoTimeframe,
  reason: string,
): HistoricalCryptoScannerDecision {
  return Object.freeze({
    schemaVersion: SCANNER_CRYPTO_HISTORICAL_CARD_V1,
    status: 'BLOCKED_DATA',
    reason,
    decisionTime: Number.isSafeInteger(input.decisionTimeMs) && input.decisionTimeMs > 0
      ? new Date(input.decisionTimeMs).toISOString()
      : 'INVALID',
    market: input.market,
    timeframe: input.timeframe,
    contextTimeframe,
    symbol: String(input.ticker?.symbol ?? '').trim().toUpperCase(),
    response: null,
    evidenceDigest: null,
    historicalReplayOnly: true,
    pointInTimeOnly: true,
    rankingQualityInjected: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

function evidenceValid(
  evidence: HistoricalPublicEvidence | undefined,
  decisionTimeMs: number,
): boolean {
  return evidence?.publicMarketData === true
    && typeof evidence.sourceId === 'string'
    && evidence.sourceId.trim().length > 0
    && SHA64.test(evidence.sourceDigest)
    && Number.isSafeInteger(evidence.asOfMs)
    && evidence.asOfMs > 0
    && evidence.asOfMs <= decisionTimeMs;
}

function candleValid(candle: CryptoCandle, decisionTimeMs: number): boolean {
  return Number.isSafeInteger(candle.time)
    && candle.time > 0
    && candle.time <= decisionTimeMs
    && [candle.open, candle.high, candle.low, candle.close]
      .every((value) => Number.isFinite(value) && value > 0)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && Number.isFinite(candle.volume)
    && candle.volume >= 0;
}

function validateCandles(
  rows: readonly CryptoCandle[] | undefined,
  decisionTimeMs: number,
): string | null {
  if (!Array.isArray(rows) || rows.length < 30) return 'HISTORICAL_SCANNER_CANDLES_INSUFFICIENT';
  let previous = 0;
  for (const row of rows) {
    if (!candleValid(row, decisionTimeMs)) return 'HISTORICAL_SCANNER_CANDLE_INVALID_OR_FUTURE';
    if (row.time <= previous) return 'HISTORICAL_SCANNER_CANDLES_NOT_STRICTLY_ORDERED';
    previous = row.time;
  }
  return null;
}

function requestedContextTimeframe(
  strategyMode: ScannerStrategyMode,
): CryptoTimeframe {
  return scannerContextTimeframe(strategyMode) as CryptoTimeframe;
}

export function clearHistoricalCryptoScannerReplaySessionsForTests(): void {
  historicalSessionLastDecision.clear();
}

export async function buildHistoricalCryptoScannerDecisionV1(
  input: HistoricalCryptoScannerInput,
): Promise<HistoricalCryptoScannerDecision> {
  const contextTimeframe = requestedContextTimeframe(input.strategyMode);
  const replaySessionId = String(input.replaySessionId ?? '').trim().toLowerCase();
  if (!SHA64.test(replaySessionId)) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_REPLAY_SESSION_ID_REQUIRED');
  }
  const previousDecision = historicalSessionLastDecision.get(replaySessionId);
  if (previousDecision != null && input.decisionTimeMs <= previousDecision) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_NON_MONOTONIC_SESSION');
  }
  if (!Number.isSafeInteger(input.decisionTimeMs) || input.decisionTimeMs <= 0) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_DECISION_TIME_INVALID');
  }
  if (input.market !== 'spot' && input.market !== 'futures') {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_MARKET_INVALID');
  }
  const symbol = String(input.ticker?.symbol ?? '').trim().toUpperCase();
  if (!symbol || !(input.ticker.price > 0)
      || !(input.ticker.volume > 0)
      || !(input.ticker.tradingValue > 0)
      || !Number.isFinite(input.ticker.changePercent)
      || !Number.isSafeInteger(input.ticker.timestamp)
      || (input.ticker.timestamp as number) <= 0
      || (input.ticker.timestamp as number) > input.decisionTimeMs) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_TICKER_INVALID_OR_FUTURE');
  }
  if (!evidenceValid(input.provenance?.ticker, input.decisionTimeMs)
      || !evidenceValid(input.provenance?.spread, input.decisionTimeMs)) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_TICKER_OR_SPREAD_PROVENANCE_INVALID');
  }
  const bid = input.spread?.bid;
  const ask = input.spread?.ask;
  if (!(Number.isFinite(bid) && Number.isFinite(ask)
      && (bid as number) > 0 && (ask as number) >= (bid as number))) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_SPREAD_INVALID');
  }
  if (input.market === 'futures'
      && (!(Number.isFinite(input.ticker.fundingRate))
        || !(Number.isFinite(input.ticker.openInterest) && (input.ticker.openInterest as number) > 0))) {
    return blocked(input, contextTimeframe, 'HISTORICAL_FUTURES_FUNDING_OI_REQUIRED');
  }

  const requiredTimeframes = [...new Set([input.timeframe, contextTimeframe])];
  for (const timeframe of requiredTimeframes) {
    const rows = input.candlesByTimeframe?.[timeframe];
    const candleReason = validateCandles(rows, input.decisionTimeMs);
    if (candleReason) return blocked(input, contextTimeframe, `${candleReason}:${timeframe}`);
    if (!evidenceValid(input.provenance?.candles?.[timeframe], input.decisionTimeMs)) {
      return blocked(input, contextTimeframe, `HISTORICAL_SCANNER_CANDLE_PROVENANCE_INVALID:${timeframe}`);
    }
  }

  const primaryRows = input.candlesByTimeframe[input.timeframe] as readonly CryptoCandle[];
  const latestPrimary = primaryRows.at(-1)!;
  if (latestPrimary.time > input.decisionTimeMs) {
    return blocked(input, contextTimeframe, 'HISTORICAL_SCANNER_PRIMARY_CANDLE_FUTURE');
  }

  const providers = {
    async getUniverse(market: CryptoMarket) {
      if (market !== input.market) throw new Error('HISTORICAL_SCANNER_MARKET_MISMATCH');
      return {
        rows: [{ ...input.ticker, symbol }],
        source: input.market === 'spot' ? 'upbit-public' as const : 'bitget-public' as const,
        providerErrorCount: 0,
      };
    },
    async getCandles(
      market: CryptoMarket,
      requestedSymbol: string,
      timeframe: CryptoTimeframe,
    ) {
      if (market !== input.market || requestedSymbol.toUpperCase() !== symbol) {
        throw new Error('HISTORICAL_SCANNER_CANDLE_IDENTITY_MISMATCH');
      }
      const rows = input.candlesByTimeframe[timeframe];
      if (!rows) throw new Error(`HISTORICAL_SCANNER_TIMEFRAME_EVIDENCE_MISSING:${timeframe}`);
      return rows.map((row) => ({ ...row }));
    },
    async getSpread(market: CryptoMarket, ticker: CryptoTicker) {
      if (market !== input.market || ticker.symbol.toUpperCase() !== symbol) {
        throw new Error('HISTORICAL_SCANNER_SPREAD_IDENTITY_MISMATCH');
      }
      return { bid: bid as number, ask: ask as number };
    },
    now() {
      return input.decisionTimeMs;
    },
  };

  const scanner = createCryptoSignalScannerService(providers);
  const response = withScannerCanonicalActions(await scanner.scan({
    memberId: `historical-scanner-v1:${replaySessionId}`,
    market: input.market,
    timeframe: input.timeframe,
    condition: input.condition,
    cursor: 0,
    batchSize: 5,
    strategyMode: input.strategyMode,
  }));

  historicalSessionLastDecision.set(replaySessionId, input.decisionTimeMs);

  const evidenceIdentity = {
    replaySessionId,
    decisionTimeMs: input.decisionTimeMs,
    market: input.market,
    timeframe: input.timeframe,
    contextTimeframe,
    condition: input.condition,
    strategyMode: input.strategyMode,
    ticker: input.ticker,
    spread: input.spread,
    provenance: input.provenance,
    candleDigests: Object.fromEntries(requiredTimeframes.map((timeframe) => [
      timeframe,
      digest(input.candlesByTimeframe[timeframe]),
    ])),
  };

  return Object.freeze({
    schemaVersion: SCANNER_CRYPTO_HISTORICAL_CARD_V1,
    status: response.cards.length ? 'READY' : 'VALID_ZERO_SIGNAL',
    reason: null,
    decisionTime: new Date(input.decisionTimeMs).toISOString(),
    market: input.market,
    timeframe: input.timeframe,
    contextTimeframe,
    symbol,
    response,
    evidenceDigest: digest(evidenceIdentity),
    historicalReplayOnly: true,
    pointInTimeOnly: true,
    rankingQualityInjected: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
