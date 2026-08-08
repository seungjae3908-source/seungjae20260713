import type { ScannerDataQualityResult } from './scanner-data-quality.service';
import {
  buildScannerIndicatorSnapshot,
  type ScannerIndicatorSnapshot,
} from './scanner-indicator-library.service';
import type { ScannerQualityCandle } from './scanner-data-quality.service';
import type { ScannerSignalDirection } from './scanner-signal.types';

export type ScannerStrategyMode = 'scalping' | 'swing';
export type ScannerSignalGrade = 'S' | 'A' | 'B' | 'C' | 'D';
export type ScannerAiValidationStatus = 'NOT_RUN' | 'PASS' | 'PARTIAL' | 'VETO';

export interface ScannerAiValidation {
  status: ScannerAiValidationStatus;
  provider: string | null;
  counterEvidence: string[];
  missingData: string[];
  risks: string[];
  explanation: string | null;
}

export interface ScannerQuantFactors {
  technical: number;
  trend: number;
  momentum: number;
  volume: number;
  liquidity: number;
  volatility: number;
  marketRegime: number;
  risk: number;
}

export interface ScannerQuantStrategyInput {
  mode: ScannerStrategyMode;
  timeframe: string;
  candles: ScannerQualityCandle[];
  contextCandles: ScannerQualityCandle[];
  price: number;
  tradingValue: number | null;
  spreadPercent: number | null;
  riskScore: number | null;
  dataQuality: ScannerDataQualityResult;
  allowShort: boolean;
  aiValidation?: ScannerAiValidation;
}

export interface ScannerQuantStrategyResult {
  mode: ScannerStrategyMode;
  score: number;
  grade: ScannerSignalGrade;
  direction: ScannerSignalDirection;
  factors: ScannerQuantFactors;
  primary: ScannerIndicatorSnapshot;
  context: ScannerIndicatorSnapshot;
  strongSignalEligible: boolean;
  reasons: string[];
  warnings: string[];
  aiValidation: ScannerAiValidation;
}

const SCALPING_WEIGHTS: Record<keyof ScannerQuantFactors, number> = {
  technical: 16,
  trend: 14,
  momentum: 16,
  volume: 16,
  liquidity: 14,
  volatility: 8,
  marketRegime: 10,
  risk: 6,
};

const SWING_WEIGHTS: Record<keyof ScannerQuantFactors, number> = {
  technical: 14,
  trend: 22,
  momentum: 14,
  volume: 10,
  liquidity: 8,
  volatility: 8,
  marketRegime: 16,
  risk: 8,
};

const DEFAULT_AI_VALIDATION: ScannerAiValidation = {
  status: 'NOT_RUN',
  provider: null,
  counterEvidence: [],
  missingData: [],
  risks: [],
  explanation: null,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function scoreRelativeVolume(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 25;
  if (value < 0.5) return 20;
  if (value < 0.8) return 35;
  if (value < 1.1) return 50;
  if (value < 1.5) return 65;
  if (value < 2) return 78;
  if (value < 3) return 90;
  return 100;
}

function scoreLiquidity(spreadPercent: number | null, tradingValue: number | null): number {
  let score = tradingValue != null && tradingValue > 0 ? 65 : 30;
  if (spreadPercent == null) return score;
  if (spreadPercent <= 0.05) score += 35;
  else if (spreadPercent <= 0.1) score += 28;
  else if (spreadPercent <= 0.2) score += 18;
  else if (spreadPercent <= 0.4) score += 4;
  else if (spreadPercent <= 0.8) score -= 20;
  else score -= 40;
  return clamp(score);
}

function scoreRisk(riskScore: number | null): number {
  return riskScore == null ? 35 : clamp(100 - riskScore);
}

function atrPercent(snapshot: ScannerIndicatorSnapshot, price: number): number | null {
  return snapshot.atr14 != null && price > 0 ? snapshot.atr14 / price * 100 : null;
}

function scoreScalpingVolatility(snapshot: ScannerIndicatorSnapshot, price: number): number {
  const value = atrPercent(snapshot, price);
  if (value == null) return 30;
  if (value < 0.15) return 45;
  if (value <= 0.4) return 70;
  if (value <= 2.5) return 90;
  if (value <= 4.5) return 75;
  if (value <= 7) return 50;
  return 20;
}

function scoreSwingVolatility(snapshot: ScannerIndicatorSnapshot, price: number): number {
  const value = atrPercent(snapshot, price);
  if (value == null) return 30;
  if (value < 0.5) return 55;
  if (value <= 4) return 90;
  if (value <= 7) return 72;
  if (value <= 12) return 48;
  return 20;
}

function trendDirection(snapshot: ScannerIndicatorSnapshot): -1 | 0 | 1 {
  const fast = snapshot.ema20 ?? snapshot.ema12;
  const slow = snapshot.ema60 ?? snapshot.ema26;
  if (fast == null || slow == null || fast === slow) return 0;
  return fast > slow ? 1 : -1;
}

function scalpingFactors(
  primary: ScannerIndicatorSnapshot,
  context: ScannerIndicatorSnapshot,
  input: ScannerQuantStrategyInput,
): ScannerQuantFactors {
  const close = primary.close ?? input.price;
  let technical = 45;
  if (primary.vwap != null) technical += close >= primary.vwap ? 22 : -18;
  if (primary.support20 != null && close >= primary.support20) technical += 8;
  if (primary.resistance20 != null && close >= primary.resistance20) technical += 15;

  let trend = 45;
  if (primary.ema12 != null && primary.ema26 != null) trend += primary.ema12 > primary.ema26 ? 25 : -20;
  const contextTrend = trendDirection(context);
  if (contextTrend > 0) trend += 20;
  if (contextTrend < 0) trend -= 20;

  let momentum = 45;
  if (primary.macd.histogram != null) momentum += primary.macd.histogram > 0 ? 20 : -18;
  if (primary.rsi14 != null) {
    if (primary.rsi14 >= 45 && primary.rsi14 <= 68) momentum += 20;
    else if (primary.rsi14 > 78) momentum -= 25;
    else if (primary.rsi14 < 30) momentum -= 10;
  }
  if (primary.momentum5 != null) momentum += clamp(primary.momentum5 * 700, -15, 15);

  let marketRegime = 50;
  if (contextTrend > 0) marketRegime += 30;
  if (contextTrend < 0) marketRegime -= 30;
  if (context.adx14 != null && context.adx14 >= 20) marketRegime += 12;

  return {
    technical: clamp(technical),
    trend: clamp(trend),
    momentum: clamp(momentum),
    volume: scoreRelativeVolume(primary.relativeVolume20),
    liquidity: scoreLiquidity(input.spreadPercent, input.tradingValue),
    volatility: scoreScalpingVolatility(primary, input.price),
    marketRegime: clamp(marketRegime),
    risk: scoreRisk(input.riskScore),
  };
}

function swingFactors(
  primary: ScannerIndicatorSnapshot,
  context: ScannerIndicatorSnapshot,
  input: ScannerQuantStrategyInput,
): ScannerQuantFactors {
  const close = primary.close ?? input.price;
  let trend = 40;
  if (primary.ema20 != null && primary.ema60 != null) trend += primary.ema20 > primary.ema60 ? 22 : -20;
  if (primary.sma20 != null && primary.sma60 != null) trend += primary.sma20 > primary.sma60 ? 14 : -12;
  if (primary.sma60 != null && primary.sma120 != null) trend += primary.sma60 > primary.sma120 ? 12 : -10;
  if (primary.adx14 != null) trend += primary.adx14 >= 25 ? 12 : primary.adx14 < 15 ? -8 : 0;

  let technical = 45;
  if (primary.resistance20 != null && close > primary.resistance20) technical += 28;
  if (primary.ema20 != null && close >= primary.ema20 * 0.98 && close <= primary.ema20 * 1.04) technical += 14;
  if (primary.support20 != null && close < primary.support20) technical -= 28;

  let momentum = 45;
  if (primary.macd.histogram != null) momentum += primary.macd.histogram > 0 ? 22 : -18;
  if (primary.rsi14 != null) {
    if (primary.rsi14 >= 45 && primary.rsi14 <= 70) momentum += 18;
    else if (primary.rsi14 > 80) momentum -= 22;
    else if (primary.rsi14 < 32) momentum -= 10;
  }

  let volume = scoreRelativeVolume(primary.relativeVolume20) * 0.65 + 35;
  if (primary.volumeTrend20 != null) volume += clamp(primary.volumeTrend20 * 80, -20, 20);

  let marketRegime = 50;
  const contextTrend = trendDirection(context);
  if (contextTrend > 0) marketRegime += 28;
  if (contextTrend < 0) marketRegime -= 28;
  if (context.adx14 != null && context.adx14 >= 20) marketRegime += 15;

  return {
    technical: clamp(technical),
    trend: clamp(trend),
    momentum: clamp(momentum),
    volume: clamp(volume),
    liquidity: scoreLiquidity(input.spreadPercent, input.tradingValue),
    volatility: scoreSwingVolatility(primary, input.price),
    marketRegime: clamp(marketRegime),
    risk: scoreRisk(input.riskScore),
  };
}

function weightedScore(
  factors: ScannerQuantFactors,
  weights: Record<keyof ScannerQuantFactors, number>,
): number {
  const total = (Object.keys(weights) as Array<keyof ScannerQuantFactors>)
    .reduce((sum, key) => sum + factors[key] * weights[key] / 100, 0);
  return Math.round(clamp(total));
}

function inferDirection(
  factors: ScannerQuantFactors,
  primary: ScannerIndicatorSnapshot,
  context: ScannerIndicatorSnapshot,
  allowShort: boolean,
): ScannerSignalDirection {
  const longBias = (factors.trend + factors.momentum + factors.marketRegime + factors.technical) / 4;
  const primaryTrend = trendDirection(primary);
  const contextTrend = trendDirection(context);
  if (longBias >= 62 && primaryTrend >= 0 && contextTrend >= 0) return 'LONG';
  if (allowShort && longBias <= 42 && primaryTrend <= 0 && contextTrend <= 0) return 'SHORT';
  return 'NEUTRAL';
}

function gradeFor(
  score: number,
  factors: ScannerQuantFactors,
  input: ScannerQuantStrategyInput,
  aiValidation: ScannerAiValidation,
): ScannerSignalGrade {
  const sEligible = score >= 88
    && input.dataQuality.state === 'TRUSTED'
    && input.dataQuality.score >= 90
    && (input.riskScore ?? 101) <= 35
    && factors.liquidity >= 70
    && factors.volatility >= 60
    && factors.marketRegime >= 70
    && aiValidation.status === 'PASS';
  if (sEligible) return 'S';
  if (score >= 78) return 'A';
  if (score >= 68) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

export function runScannerQuantStrategy(input: ScannerQuantStrategyInput): ScannerQuantStrategyResult {
  const primary = buildScannerIndicatorSnapshot(input.candles);
  const context = buildScannerIndicatorSnapshot(input.contextCandles.length ? input.contextCandles : input.candles);
  const aiValidation = input.aiValidation ?? DEFAULT_AI_VALIDATION;
  const factors = input.mode === 'scalping'
    ? scalpingFactors(primary, context, input)
    : swingFactors(primary, context, input);
  let score = weightedScore(factors, input.mode === 'scalping' ? SCALPING_WEIGHTS : SWING_WEIGHTS);
  if (input.dataQuality.state === 'DEGRADED') score = Math.min(score, 74);
  if (input.dataQuality.state === 'DATA_UNTRUSTED') score = Math.min(score, 49);
  if (aiValidation.status === 'VETO') score = Math.min(score, 49);
  if (aiValidation.status === 'PARTIAL') score = Math.min(score, 79);

  const direction = inferDirection(factors, primary, context, input.allowShort);
  const strongSignalEligible = direction !== 'NEUTRAL'
    && score >= 75
    && input.dataQuality.strongSignalAllowed
    && (input.riskScore ?? 101) <= 45
    && factors.liquidity >= 55
    && factors.volatility >= 45
    && aiValidation.status !== 'VETO';
  const grade = gradeFor(score, factors, input, aiValidation);

  const reasons = [
    `전략 ${input.mode}`,
    `기술 ${Math.round(factors.technical)}`,
    `추세 ${Math.round(factors.trend)}`,
    `모멘텀 ${Math.round(factors.momentum)}`,
    `거래량 ${Math.round(factors.volume)}`,
    `유동성 ${Math.round(factors.liquidity)}`,
    `시장국면 ${Math.round(factors.marketRegime)}`,
  ];
  const warnings = [
    ...input.dataQuality.issues.map((issue) => `${issue.code}: ${issue.message}`),
    ...aiValidation.counterEvidence.map((reason) => `AI 반대근거: ${reason}`),
    ...aiValidation.missingData.map((reason) => `AI 데이터부족: ${reason}`),
    ...aiValidation.risks.map((reason) => `AI 위험: ${reason}`),
  ];

  return {
    mode: input.mode,
    score,
    grade,
    direction,
    factors,
    primary,
    context,
    strongSignalEligible,
    reasons,
    warnings,
    aiValidation,
  };
}

export function scannerContextTimeframe(mode: ScannerStrategyMode): '15m' | '60m' {
  return mode === 'scalping' ? '15m' : '60m';
}

export function scannerStrategyForTimeframe(timeframe: string): ScannerStrategyMode {
  return ['1m', '3m', '5m', '15m'].includes(timeframe) ? 'scalping' : 'swing';
}

export function scannerStrategyTimeframeAllowed(mode: ScannerStrategyMode, timeframe: string): boolean {
  return mode === 'scalping'
    ? ['1m', '3m', '5m', '15m'].includes(timeframe)
    : ['60m', '1H', '4H', '1D'].includes(timeframe);
}
