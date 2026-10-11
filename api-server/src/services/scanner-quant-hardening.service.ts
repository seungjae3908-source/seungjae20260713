import type { Candle } from '../sample/types';
import {
  evaluateScannerDataQuality,
  type ScannerProviderObservation,
} from './scanner-data-quality.service';
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

// Live signal quality should validate the bars that can actually affect the
// current decision. Long-history integrity is validated separately by the
// Research Lab over the complete dataset. Keeping a bounded live window avoids
// allowing one ancient corporate-action/malformed bar outside every strategy
// lookback to invalidate today's otherwise healthy market data.
const LIVE_QUALITY_WINDOW: Record<ScannerStrategyMode, number> = {
  scalping: 240,
  swing: 320,
  position: 400,
};

function recentQualityCandles(candles: Candle[], mode: ScannerStrategyMode): Candle[] {
  const limit = LIVE_QUALITY_WINDOW[mode];
  return candles.length > limit ? candles.slice(-limit) : candles;
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

function evidenceLabels(evidence: ScannerEvidence[], status: ScannerEvidence['status']): string[] {
  return [...new Set(evidence.filter((item) => item.status === status).map((item) => item.label))];
}

function marketProfileFor(card: ScannerSignalCard): ScannerMarketProfile {
  if (card.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (card.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return card.market === 'US' ? 'US_STOCK' : 'KR_STOCK';
}

function futuresPriceObservations(
  input: ScannerQuantHardeningInput,
  qualityCandles: Candle[],
): ScannerProviderObservation[] | undefined {
  if (input.card.assetClass !== 'coin_futures') return undefined;
  const latest = qualityCandles.at(-1);
  if (
    !latest
    || !Number.isFinite(input.card.price)
    || input.card.price <= 0
    || !Number.isFinite(latest.close)
    || latest.close <= 0
  ) return undefined;
  const provider = input.card.exchange?.trim() || 'CRYPTO_FUTURES';
  return [
    {
      provider: `${provider}-ticker`,
      symbol: input.card.symbol,
      price: input.card.price,
      observedAt: input.card.observedAt,
    },
    {
      provider: `${provider}-candles`,
      symbol: input.card.symbol,
      price: latest.close,
      observedAt: latest.time,
    },
  ];
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
  const qualityCandles = recentQualityCandles(input.candles, strategyMode);
  const quality = evaluateScannerDataQuality({
    symbol: input.card.symbol,
    timeframe: input.timeframe,
    candles: qualityCandles,
    now: input.now,
    providerObservations: futuresPriceObservations(input, qualityCandles),
    marketClosed: input.marketClosed,
    tradingHalt: input.tradingHalt,
    sessionAware: input.sessionAware,
    sessionTimeZone: input.card.market === 'US' ? 'America/New_York' : 'Asia/Seoul',
  });
  const contextMissing = input.contextCandles !== undefined && input.contextCandles.length === 0;
  // undefined means the caller did not request separate context. An explicit
  // empty response means the higher-timeframe request failed or lacked bars.
  const contextCandles = input.contextCandles ?? input.candles;
  const quant = runScannerQuantStrategy({
    sessionTimeZone: input.card.assetClass === 'stock'
      ? input.card.market === 'US' ? 'America/New_York' : 'Asia/Seoul' : 'UTC',
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
  const dataCompleteness = completenessFromMarketData(input.card, qualityCandles.length, quality.score);
  const directionChanged = quant.direction !== input.card.direction;
  const dataTrustedForPlan = !contextMissing && quality.state !== 'DATA_UNTRUSTED' && quality.strongSignalAllowed;
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
    : quality.state === 'DEGRADED' || contextMissing
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
    ...(contextMissing ? ['CONTEXT_TIMEFRAME_EVIDENCE_UNAVAILABLE'] : []),
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
      label: strategyMode === 'scalping' ? '단타 Quant 종합' : strategyMode === 'position' ? '중장기 Quant 종합' : '스윙 Quant 종합',
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
        : [`최근 ${qualityCandles.length}개 전략 관련 캔들의 timestamp·OHLC·volume·gap·duplicate 검증을 통과했습니다.`],
    },
    ...(contextMissing ? [{ key: 'context-timeframe', label: '상위 시간봉 근거', status: 'unverified' as const,
      source: 'scanner-context-timeframe', observedAt: null,
      reasons: ['상위 시간봉 자료를 확보하지 못했습니다. 기본 시간봉으로 대신 검증하지 않습니다.'] }] : []),
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
    signalGrade: contextMissing && (quant.grade === 'S' || quant.grade === 'A') ? 'B' : quant.grade,
    dataQuality: {
      state: contextMissing && quality.state === 'TRUSTED' ? 'DEGRADED' : quality.state,
      score: quality.score,
      strongSignalAllowed: !contextMissing && quality.strongSignalAllowed,
      issues: [...quality.issues, ...(contextMissing ? [{ code: 'MISSING_CANDLE' as const, severity: 'warning' as const,
        message: '상위 시간봉 자료가 없어 강신호와 진입 계획을 차단했습니다.' }] : [])],
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
