import type { Candle } from '../sample/types';
import { evaluateScannerDataQuality } from './scanner-data-quality.service';
import {
  runScannerQuantStrategy,
  scannerStrategyForTimeframe,
  type ScannerStrategyMode,
} from './scanner-quant-strategy.service';
import type { ScannerSignalCard } from './scanner-signal.types';

export interface ScannerQuantHardeningInput {
  card: ScannerSignalCard;
  timeframe: string;
  candles: Candle[];
  contextCandles?: Candle[];
  strategyMode?: ScannerStrategyMode;
  allowShort?: boolean;
  now?: number;
  marketClosed?: boolean;
  tradingHalt?: boolean;
}

function completenessFromMarketData(
  card: ScannerSignalCard,
  candleCount: number,
  dataQualityScore: number,
): number {
  let value = dataQualityScore * 0.65;
  value += candleCount >= 60 ? 15 : candleCount >= 30 ? 10 : candleCount >= 20 ? 6 : 0;
  value += card.riskScore != null ? 8 : 0;
  value += card.tradingValue != null && card.tradingValue > 0 ? 7 : 0;
  value += card.listingStatus === 'LISTED' ? 5 : 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function applyScannerQuantHardening(input: ScannerQuantHardeningInput): ScannerSignalCard {
  const strategyMode = input.strategyMode ?? scannerStrategyForTimeframe(input.timeframe);
  const quality = evaluateScannerDataQuality({
    symbol: input.card.symbol,
    timeframe: input.timeframe,
    candles: input.candles,
    now: input.now,
    marketClosed: input.marketClosed,
    tradingHalt: input.tradingHalt,
  });
  const contextCandles = input.contextCandles?.length ? input.contextCandles : input.candles;
  const quant = runScannerQuantStrategy({
    mode: strategyMode,
    timeframe: input.timeframe,
    candles: input.candles,
    contextCandles,
    price: input.card.price,
    tradingValue: input.card.tradingValue,
    spreadPercent: input.card.spreadPercent,
    riskScore: input.card.riskScore,
    dataQuality: quality,
    allowShort: input.allowShort ?? input.card.assetClass === 'coin_futures',
  });
  const dataCompleteness = completenessFromMarketData(input.card, input.candles.length, quality.score);
  const planEligible = input.card.pricePlan.riskReward != null && input.card.pricePlan.riskReward >= 1.5;
  const strongSignalEligible = quant.strongSignalEligible
    && planEligible
    && input.card.listingStatus === 'LISTED'
    && dataCompleteness >= 75;
  const dataState = quality.state === 'DATA_UNTRUSTED'
    ? 'untrusted' as const
    : quality.state === 'DEGRADED'
      ? input.card.dataState === 'complete' ? 'partial' as const : input.card.dataState
      : input.card.dataState;
  const confidence = Math.round(Math.min(
    100,
    Math.max(0, quant.score),
    quality.score,
    dataCompleteness,
  ));

  return {
    ...input.card,
    direction: quant.direction,
    score: quant.score,
    confidence,
    dataCompleteness,
    dataState,
    strongSignalEligible,
    strategyMode,
    signalGrade: quant.grade,
    dataQuality: {
      state: quality.state,
      score: quality.score,
      strongSignalAllowed: quality.strongSignalAllowed,
      issues: quality.issues,
    },
    quantScore: quant.factors,
    aiValidation: quant.aiValidation,
    warnings: [...new Set([...input.card.warnings, ...quant.warnings])],
    evidence: [
      ...input.card.evidence,
      {
        key: `quant-${strategyMode}`,
        label: strategyMode === 'scalping' ? '단타 Quant 종합' : '스윙 Quant 종합',
        status: strongSignalEligible ? 'matched' : quality.state === 'DATA_UNTRUSTED' ? 'unverified' : 'not_matched',
        source: `scanner-${strategyMode}-engine`,
        observedAt: input.card.observedAt,
        reasons: quant.reasons,
      },
      {
        key: 'data-quality',
        label: 'Data Quality Gate',
        status: quality.state === 'TRUSTED' ? 'matched' : quality.state === 'DEGRADED' ? 'not_matched' : 'unverified',
        source: 'scanner-data-quality-gate',
        observedAt: quality.lastTimestamp,
        reasons: quality.issues.length
          ? quality.issues.map((issue) => `${issue.code}: ${issue.message}`)
          : ['timestamp·OHLC·volume·gap·duplicate 검증을 통과했습니다.'],
      },
    ],
  };
}
