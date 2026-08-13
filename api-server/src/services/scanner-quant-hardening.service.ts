import type { Candle } from '../sample/types';
import { evaluateScannerDataQuality } from './scanner-data-quality.service';
import { applyScannerMarketProfile, type ScannerMarketProfile } from './scanner-market-profile-overlay.service';
import {
  runScannerQuantStrategy,
  scannerStrategyForTimeframe,
  type ScannerStrategyMode,
} from './scanner-quant-strategy.service';
import type { ScannerEvidence, ScannerPricePlan, ScannerSignalCard } from './scanner-signal.types';

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
  sessionAware?: boolean;
}

const EMPTY_PRICE_PLAN: ScannerPricePlan = {
  entryZone: null,
  invalidation: null,
  stopLoss: null,
  targets: [],
  riskReward: null,
};

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

function evidenceLabels(evidence: ScannerEvidence[], status: ScannerEvidence['status']): string[] {
  return [...new Set(evidence.filter((item) => item.status === status).map((item) => item.label))];
}

function marketProfileFor(card: ScannerSignalCard): ScannerMarketProfile {
  if (card.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (card.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return card.market === 'US' ? 'US_STOCK' : 'KR_STOCK';
}

function numberFromReason(reason: string | undefined): number | null {
  if (!reason) return null;
  const match = reason.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function futuresPublicContext(card: ScannerSignalCard): { fundingRate: number | null; openInterest: number | null } {
  if (card.assetClass !== 'coin_futures') return { fundingRate: null, openInterest: null };
  const evidence = card.evidence.find((item) => item.key === 'funding-open-interest');
  const fundingPercent = numberFromReason(evidence?.reasons.find((reason) => reason.startsWith('펀딩비 ')));
  const openInterest = numberFromReason(evidence?.reasons.find((reason) => reason.startsWith('미결제약정 ')));
  return {
    fundingRate: fundingPercent == null ? null : fundingPercent / 100,
    openInterest,
  };
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
    sessionAware: input.sessionAware,
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
  const directionChanged = quant.direction !== input.card.direction;
  const dataTrustedForPlan = quality.state !== 'DATA_UNTRUSTED' && quality.strongSignalAllowed;
  const pricePlan = directionChanged || !dataTrustedForPlan ? EMPTY_PRICE_PLAN : input.card.pricePlan;
  const planEligible = dataTrustedForPlan
    && !directionChanged
    && pricePlan.riskReward != null
    && pricePlan.riskReward >= 1.5;
  const strongSignalEligible = quality.state !== 'DATA_UNTRUSTED'
    && quant.strongSignalEligible
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
  const warnings = [
    ...input.card.warnings,
    ...quant.warnings,
    ...(directionChanged
      ? ['Quant 방향이 기존 후보 방향과 달라 기존 진입·손절·목표 가격을 폐기했습니다.']
      : []),
    ...(quality.state === 'DATA_UNTRUSTED'
      ? ['DATA_UNTRUSTED: 승인·실행 호환 가격정보를 폐기했습니다.']
      : []),
  ];
  const evidence: ScannerEvidence[] = [
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
  ];

  const hardened: ScannerSignalCard = {
    ...input.card,
    direction: quant.direction,
    pricePlan,
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
    warnings: [...new Set(warnings)],
    evidence,
    matched: evidenceLabels(evidence, 'matched'),
    notMatched: evidenceLabels(evidence, 'not_matched'),
    unverified: evidenceLabels(evidence, 'unverified'),
  };
  const futuresContext = futuresPublicContext(hardened);
  return applyScannerMarketProfile({
    card: hardened,
    profile: marketProfileFor(hardened),
    candles: input.candles,
    strategyMode,
    fundingRate: futuresContext.fundingRate,
    openInterest: futuresContext.openInterest,
  });
}