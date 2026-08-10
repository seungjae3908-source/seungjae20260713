import type {
  ScannerBacktestQualitySummary,
  ScannerCandidateRankingSummary,
  ScannerSignalCard,
  ScannerSignalGrade,
  ScannerStrategyMode,
} from './scanner-signal.types';

export interface ScannerRankingWeights {
  oosWalkForwardWinRate: number;
  expectancy: number;
  profitFactor: number;
  drawdown: number;
  regime: number;
  oosStability: number;
  sampleConfidence: number;
  liveSignal: number;
}

export const DEFAULT_SCANNER_RANKING_WEIGHTS: Readonly<ScannerRankingWeights> = Object.freeze({
  oosWalkForwardWinRate: 25,
  expectancy: 25,
  profitFactor: 15,
  drawdown: 10,
  regime: 10,
  oosStability: 5,
  sampleConfidence: 5,
  liveSignal: 5,
});

export interface ScannerCandidateRankingInput {
  cards: ScannerSignalCard[];
  market: string;
  strategy: ScannerStrategyMode;
  backtests?: Readonly<Record<string, ScannerBacktestQualitySummary | undefined>>;
  weights?: ScannerRankingWeights;
  limit?: number;
}

export interface ScannerCandidateRankingDiagnostics {
  inputCount: number;
  hardFilterPassCount: number;
  hardFilterRejectedCount: number;
  softCandidateCount: number;
  finalDisplayedCount: number;
  sGradeCount: number;
  aGradeCount: number;
  bGradeCount: number;
  backtestMissingCount: number;
}

export interface ScannerCandidateRankingResult {
  cards: ScannerSignalCard[];
  diagnostics: ScannerCandidateRankingDiagnostics;
}

const GRADE_ORDER: Record<ScannerSignalGrade, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function percentile(values: number[], value: number | null | undefined): number {
  if (!finite(value) || !values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const belowOrEqual = ordered.filter((item) => item <= value).length;
  return round(belowOrEqual / ordered.length * 100);
}

function hardFilterReasons(card: ScannerSignalCard): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(card.price) || card.price <= 0) reasons.push('비정상 가격');
  if (card.listingStatus !== 'LISTED') reasons.push('거래가능 상장 상태 미확인');
  if (['stale', 'insufficient', 'unavailable', 'untrusted'].includes(card.dataState)) reasons.push(`데이터 상태 ${card.dataState}`);
  if (card.dataQuality?.state === 'DATA_UNTRUSTED') reasons.push('Data Quality Gate 차단');
  if (card.dataQuality?.issues.some((issue) => issue.severity === 'blocking')) reasons.push('차단형 데이터 품질 이슈');
  if (finite(card.spreadPercent) && card.spreadPercent > (card.assetClass === 'stock' ? 1 : 0.8)) reasons.push('과도한 spread');
  if (finite(card.tradingValue) && card.tradingValue <= 0) reasons.push('거래대금 부족');
  if (finite(card.volume) && card.volume < 0) reasons.push('비정상 거래량');
  return [...new Set(reasons)];
}

function metricScore(backtest: ScannerBacktestQualitySummary, weights: ScannerRankingWeights): number {
  const winRate = clamp(((backtest.oosWinRate ?? 0) + (backtest.walkForwardWinRate ?? backtest.oosWinRate ?? 0)) / 2);
  const expectancy = clamp(((backtest.expectancyPercent ?? -2) + 2) / 4 * 100);
  const pf = clamp(((backtest.profitFactor ?? 0) - 0.8) / 1.2 * 100);
  const drawdown = clamp(100 - Math.abs(backtest.maxDrawdownPercent ?? 100) * 4);
  const regime = clamp(backtest.regimeScore ?? 0);
  const stability = clamp(backtest.oosStabilityScore ?? 0);
  const sample = clamp((backtest.tradeCount ?? 0) / Math.max(1, backtest.minimumTradeCount ?? 40) * 100);
  return round(
    winRate * weights.oosWalkForwardWinRate / 100
    + expectancy * weights.expectancy / 100
    + pf * weights.profitFactor / 100
    + drawdown * weights.drawdown / 100
    + regime * weights.regime / 100
    + stability * weights.oosStability / 100
    + sample * weights.sampleConfidence / 100,
  );
}

export function passesMinimumBacktestQuality(summary: ScannerBacktestQualitySummary): boolean {
  if (summary.status !== 'verified') return false;
  const minTrades = summary.minimumTradeCount ?? 40;
  return (summary.tradeCount ?? 0) >= minTrades
    && finite(summary.expectancyPercent) && summary.expectancyPercent > 0
    && finite(summary.profitFactor) && summary.profitFactor >= 1.05
    && finite(summary.maxDrawdownPercent) && Math.abs(summary.maxDrawdownPercent) <= 25
    && finite(summary.netReturnPercent) && summary.netReturnPercent > 0
    && summary.costsIncluded === true
    && summary.slippageIncluded === true
    && summary.lookaheadGuarded === true
    && summary.oos === true
    && summary.walkForward === true;
}

function gradeCandidate(card: ScannerSignalCard, backtest: ScannerBacktestQualitySummary | undefined): ScannerSignalGrade {
  if (!backtest || !passesMinimumBacktestQuality(backtest)) return 'B';
  const risk = card.riskScore ?? 101;
  const trusted = card.dataQuality?.state === 'TRUSTED' && card.dataQuality.strongSignalAllowed;
  const actionable = card.direction !== 'NEUTRAL' && card.pricePlan.riskReward != null && card.pricePlan.riskReward >= 1.5;
  if (card.strongSignalEligible && trusted && actionable && card.score >= 88 && risk <= 35) return 'S';
  if (trusted && actionable && card.score >= 72 && risk <= 50) return 'A';
  return 'B';
}

function watchReasons(card: ScannerSignalCard, backtest: ScannerBacktestQualitySummary | undefined): string[] {
  const reasons: string[] = [];
  if (!backtest || backtest.status !== 'verified') reasons.push('OOS/Walk-forward 검증 데이터 필요');
  else if (!passesMinimumBacktestQuality(backtest)) reasons.push('최소 전략 품질 Gate 미충족');
  if (card.direction === 'NEUTRAL') reasons.push('현재 방향성 진입 신호 확인 필요');
  if (card.notMatched.length) reasons.push(...card.notMatched.slice(0, 3));
  if (card.unverified.length) reasons.push(...card.unverified.slice(0, 2).map((item) => `${item} 확인 필요`));
  if (card.pricePlan.entryZone == null) reasons.push('진입 후보가 형성 필요');
  return [...new Set(reasons)].slice(0, 5);
}

export function rankScannerCandidates(input: ScannerCandidateRankingInput): ScannerCandidateRankingResult {
  const limit = Math.max(1, Math.min(10, input.limit ?? 10));
  const weights = input.weights ?? DEFAULT_SCANNER_RANKING_WEIGHTS;
  const tradingValues = input.cards.map((card) => card.tradingValue).filter(finite);
  const momentumValues = input.cards.map((card) => card.quantScore?.momentum).filter(finite);
  const trendValues = input.cards.map((card) => card.quantScore?.trend).filter(finite);
  const volumeValues = input.cards.map((card) => card.quantScore?.volume).filter(finite);
  const volatilityValues = input.cards.map((card) => card.quantScore?.volatility).filter(finite);

  let hardFilterRejectedCount = 0;
  let backtestMissingCount = 0;
  const ranked = input.cards.flatMap((card) => {
    const hardReasons = hardFilterReasons(card);
    if (hardReasons.length) {
      hardFilterRejectedCount += 1;
      return [];
    }
    const backtest = input.backtests?.[card.symbol];
    if (!backtest || backtest.status !== 'verified') backtestMissingCount += 1;
    const relative = {
      tradingValuePercentile: percentile(tradingValues, card.tradingValue),
      momentumPercentile: percentile(momentumValues, card.quantScore?.momentum),
      trendPercentile: percentile(trendValues, card.quantScore?.trend),
      volumePercentile: percentile(volumeValues, card.quantScore?.volume),
      volatilityPercentile: percentile(volatilityValues, card.quantScore?.volatility),
    };
    const relativeScore = round(Object.values(relative).reduce((sum, value) => sum + value, 0) / 5);
    const backtestScore = backtest?.status === 'verified' ? metricScore(backtest, weights) : null;
    const liveSignalScore = clamp(card.score);
    const rankingScore = round(
      (backtestScore ?? 0) * (100 - weights.liveSignal) / 100
      + liveSignalScore * weights.liveSignal / 100
      + relativeScore * 0.05,
    );
    const signalGrade = gradeCandidate(card, backtest);
    const completion = Math.round(clamp((card.matched.length / Math.max(1, card.matched.length + card.notMatched.length + card.unverified.length)) * 100));
    const ranking: ScannerCandidateRankingSummary = {
      rank: 0,
      score: rankingScore,
      relativeScore,
      relative,
      watchCompletionPercent: signalGrade === 'B' ? completion : 100,
      watchReasons: signalGrade === 'B' ? watchReasons(card, backtest) : [],
      hardFilterPassed: true,
      hardFilterReasons: [],
    };
    return [{ ...card, signalGrade, backtestQuality: backtest ?? { status: 'missing' }, candidateRanking: ranking }];
  });

  const cards = ranked
    .filter((card) => card.signalGrade === 'S' || card.signalGrade === 'A' || card.signalGrade === 'B')
    .sort((left, right) => GRADE_ORDER[right.signalGrade ?? 'B'] - GRADE_ORDER[left.signalGrade ?? 'B']
      || (right.candidateRanking?.score ?? 0) - (left.candidateRanking?.score ?? 0)
      || right.score - left.score
      || right.confidence - left.confidence
      || left.symbol.localeCompare(right.symbol))
    .slice(0, limit)
    .map((card, index) => ({
      ...card,
      candidateRanking: card.candidateRanking ? { ...card.candidateRanking, rank: index + 1 } : undefined,
    }));

  return {
    cards,
    diagnostics: {
      inputCount: input.cards.length,
      hardFilterPassCount: input.cards.length - hardFilterRejectedCount,
      hardFilterRejectedCount,
      softCandidateCount: ranked.length,
      finalDisplayedCount: cards.length,
      sGradeCount: cards.filter((card) => card.signalGrade === 'S').length,
      aGradeCount: cards.filter((card) => card.signalGrade === 'A').length,
      bGradeCount: cards.filter((card) => card.signalGrade === 'B').length,
      backtestMissingCount,
    },
  };
}
