import type {
  SignalMarketRegime,
  SignalOutcomeEvaluation,
  SignalPerformanceDirection,
  SignalPerformanceHorizon,
  SignalPerformanceMarket,
} from './signal-performance-learning.service';
import { SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY } from './signal-performance-learning.service';

export type ProfitEvidenceStatus = 'READY' | 'INSUFFICIENT_SAMPLE' | 'NOT_EVIDENCED' | 'NO_VALIDATED_HISTORY';
export type RuntimeEvidenceStatus = 'VALIDATED_RUNTIME' | 'NOT_EVIDENCED' | 'NO_VALIDATED_HISTORY';

export interface TradingCostPolicy {
  id: string;
  market: SignalPerformanceMarket;
  commissionPercent: number;
  taxPercent: number;
  spreadPercent: number;
  slippagePercent: number;
  fundingPercent: number;
  latencyPercent: number;
  liquidityImpactPercent: number;
  partialFillImpactPercent: number;
  source: 'EXPLICIT_RUNTIME_POLICY';
}

export interface ProfitConfidenceInterval {
  level: 0.95;
  lowerPercent: number;
  upperPercent: number;
}

export interface ProfitEvidence {
  status: ProfitEvidenceStatus;
  market: SignalPerformanceMarket;
  strategyHorizon: SignalPerformanceHorizon;
  direction: SignalPerformanceDirection;
  timeframe: string;
  marketRegime: SignalMarketRegime;
  strategyVersion: string;
  profitProbability: number | null;
  targetBeforeStopProbability: number | null;
  lossProbability: number | null;
  expectedGrossReturn: number | null;
  expectedNetReturn: number | null;
  expectedLoss: number | null;
  expectedValue: number | null;
  expectedNetEdge: number | null;
  riskRewardRatio: number | null;
  sampleSize: number;
  confidenceInterval: ProfitConfidenceInterval | null;
  tradingCostPercent: number | null;
  totalExpectedCostPercent: number | null;
  costPolicyId: string | null;
  executionAuthority: 'NONE';
}

export interface NoTradeDecision {
  decision: 'ELIGIBLE' | 'NO_TRADE';
  eligible: boolean;
  reasons: readonly string[];
  executionAuthority: 'NONE';
}

export interface ProfitRankCandidate {
  signalId: string;
  evidence: ProfitEvidence;
  evidenceQuality: 'RUNTIME_VALIDATED' | 'INSUFFICIENT' | 'MISSING';
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function validNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function validateTradingCostPolicy(policy: TradingCostPolicy): TradingCostPolicy {
  if (!policy.id.trim()) throw new Error('Trading cost policy id is required');
  const components = [
    policy.commissionPercent,
    policy.taxPercent,
    policy.spreadPercent,
    policy.slippagePercent,
    policy.fundingPercent,
    policy.latencyPercent,
    policy.liquidityImpactPercent,
    policy.partialFillImpactPercent,
  ];
  if (components.some((value) => !validNonNegative(value))) {
    throw new Error('Trading cost components must be finite and non-negative');
  }
  return Object.freeze({ ...policy });
}

export function totalTradingCostPercent(policy: TradingCostPolicy): number {
  validateTradingCostPolicy(policy);
  return round(
    policy.commissionPercent
    + policy.taxPercent
    + policy.spreadPercent
    + policy.slippagePercent
    + policy.fundingPercent
    + policy.latencyPercent
    + policy.liquidityImpactPercent
    + policy.partialFillImpactPercent,
  );
}

function wilson95(successes: number, total: number): ProfitConfidenceInterval | null {
  if (total <= 0) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Object.freeze({
    level: 0.95 as const,
    lowerPercent: round(Math.max(0, center - margin) * 100),
    upperPercent: round(Math.min(1, center + margin) * 100),
  });
}

function emptyEvidence(input: {
  status: Exclude<ProfitEvidenceStatus, 'READY'>;
  market: SignalPerformanceMarket;
  strategyHorizon: SignalPerformanceHorizon;
  direction: SignalPerformanceDirection;
  timeframe: string;
  marketRegime: SignalMarketRegime;
  strategyVersion: string;
  sampleSize: number;
  riskRewardRatio: number | null;
  costPolicyId?: string | null;
  tradingCostPercent?: number | null;
}): ProfitEvidence {
  const totalExpectedCostPercent = input.tradingCostPercent ?? null;
  return Object.freeze({
    status: input.status,
    market: input.market,
    strategyHorizon: input.strategyHorizon,
    direction: input.direction,
    timeframe: input.timeframe,
    marketRegime: input.marketRegime,
    strategyVersion: input.strategyVersion,
    profitProbability: null,
    targetBeforeStopProbability: null,
    lossProbability: null,
    expectedGrossReturn: null,
    expectedNetReturn: null,
    expectedLoss: null,
    expectedValue: null,
    expectedNetEdge: null,
    riskRewardRatio: input.riskRewardRatio,
    sampleSize: input.sampleSize,
    confidenceInterval: null,
    tradingCostPercent: totalExpectedCostPercent,
    totalExpectedCostPercent,
    costPolicyId: input.costPolicyId ?? null,
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  });
}

export function calculateProfitEvidence(input: {
  market: SignalPerformanceMarket;
  strategyHorizon: SignalPerformanceHorizon;
  direction: SignalPerformanceDirection;
  timeframe: string;
  marketRegime: SignalMarketRegime;
  strategyVersion: string;
  evidenceStatus: RuntimeEvidenceStatus;
  outcomes: readonly SignalOutcomeEvaluation[];
  costPolicy: TradingCostPolicy | null;
  riskRewardRatio: number | null;
  minimumSampleSize?: number;
}): ProfitEvidence {
  const minimumSampleSize = Math.max(1, input.minimumSampleSize ?? 30);
  if (input.evidenceStatus === 'NO_VALIDATED_HISTORY') {
    return emptyEvidence({ ...input, status: 'NO_VALIDATED_HISTORY', sampleSize: input.outcomes.length });
  }
  if (input.evidenceStatus !== 'VALIDATED_RUNTIME' || input.costPolicy == null) {
    return emptyEvidence({ ...input, status: 'NOT_EVIDENCED', sampleSize: input.outcomes.length });
  }
  if (input.costPolicy.market !== input.market) throw new Error('Trading cost policy market mismatch');
  const policy = validateTradingCostPolicy(input.costPolicy);
  const tradingCostPercent = totalTradingCostPercent(policy);
  const completed = input.outcomes.filter((item) => item.returnPercent != null);
  if (completed.length < minimumSampleSize) {
    return emptyEvidence({
      ...input,
      status: 'INSUFFICIENT_SAMPLE',
      sampleSize: completed.length,
      costPolicyId: policy.id,
      tradingCostPercent,
    });
  }

  const grossReturns = completed.map((item) => item.returnPercent as number);
  const netReturns = grossReturns.map((value) => value - tradingCostPercent);
  const profitable = netReturns.filter((value) => value > 0).length;
  const losing = netReturns.filter((value) => value < 0).length;
  const winGross = completed.filter((item) => item.outcome === 'WIN').map((item) => item.returnPercent as number).filter((value) => value > 0);
  const lossGross = completed.filter((item) => item.outcome === 'LOSS').map((item) => item.returnPercent as number).filter((value) => value < 0);
  const averageGrossWin = mean(winGross) ?? 0;
  const averageGrossLoss = Math.abs(mean(lossGross) ?? 0);
  const winProbability = completed.filter((item) => item.outcome === 'WIN').length / completed.length;
  const lossOutcomeProbability = completed.filter((item) => item.outcome === 'LOSS').length / completed.length;
  const expectedNetEdge = winProbability * averageGrossWin - lossOutcomeProbability * averageGrossLoss - tradingCostPercent;
  const decisiveTargetStop = completed.filter((item) => item.target1Hit || item.stopLossHit);
  const targetFirstCount = decisiveTargetStop.filter((item) => item.target1Hit && !item.stopLossHit).length;
  const negativeNet = netReturns.filter((value) => value < 0).map((value) => Math.abs(value));

  return Object.freeze({
    status: 'READY' as const,
    market: input.market,
    strategyHorizon: input.strategyHorizon,
    direction: input.direction,
    timeframe: input.timeframe,
    marketRegime: input.marketRegime,
    strategyVersion: input.strategyVersion,
    profitProbability: round((profitable / completed.length) * 100),
    targetBeforeStopProbability: decisiveTargetStop.length ? round((targetFirstCount / decisiveTargetStop.length) * 100) : null,
    lossProbability: round((losing / completed.length) * 100),
    expectedGrossReturn: round(mean(grossReturns) ?? 0),
    expectedNetReturn: round(mean(netReturns) ?? 0),
    expectedLoss: negativeNet.length ? round(mean(negativeNet) ?? 0) : 0,
    expectedValue: round(expectedNetEdge),
    expectedNetEdge: round(expectedNetEdge),
    riskRewardRatio: input.riskRewardRatio,
    sampleSize: completed.length,
    confidenceInterval: wilson95(profitable, completed.length),
    tradingCostPercent,
    totalExpectedCostPercent: tradingCostPercent,
    costPolicyId: policy.id,
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  });
}

export function evaluateNoTradeGate(input: {
  evidence: ProfitEvidence;
  dataQualityPass: boolean;
  riskEnginePass: boolean;
  minimumExpectedNetReturnPercent?: number;
  minimumRiskRewardRatio?: number;
}): NoTradeDecision {
  const reasons: string[] = [];
  if (input.evidence.status !== 'READY') reasons.push(input.evidence.status);
  if (input.evidence.status === 'READY') {
    const minNet = input.minimumExpectedNetReturnPercent ?? 0;
    const minRr = input.minimumRiskRewardRatio ?? 1;
    if ((input.evidence.expectedNetEdge ?? Number.NEGATIVE_INFINITY) <= 0) reasons.push('NET_EDGE_NON_POSITIVE');
    if ((input.evidence.expectedNetReturn ?? Number.NEGATIVE_INFINITY) <= minNet) reasons.push('EXPECTED_NET_RETURN_BELOW_THRESHOLD');
    if (input.evidence.riskRewardRatio == null || input.evidence.riskRewardRatio < minRr) reasons.push('RISK_REWARD_INSUFFICIENT');
  }
  if (!input.dataQualityPass) reasons.push('DATA_QUALITY_FAIL');
  if (!input.riskEnginePass) reasons.push('RISK_ENGINE_FAIL');
  return Object.freeze({
    decision: reasons.length ? 'NO_TRADE' as const : 'ELIGIBLE' as const,
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  });
}

function evidenceQualityRank(value: ProfitRankCandidate['evidenceQuality']): number {
  if (value === 'RUNTIME_VALIDATED') return 2;
  if (value === 'INSUFFICIENT') return 1;
  return 0;
}

export function rankProfitCandidates(candidates: readonly ProfitRankCandidate[]): readonly ProfitRankCandidate[] {
  return Object.freeze([...candidates]
    .filter((item) => item.evidence.status === 'READY')
    .sort((left, right) => {
      const a = left.evidence;
      const b = right.evidence;
      return (b.expectedNetEdge ?? Number.NEGATIVE_INFINITY) - (a.expectedNetEdge ?? Number.NEGATIVE_INFINITY)
        || (b.expectedNetReturn ?? Number.NEGATIVE_INFINITY) - (a.expectedNetReturn ?? Number.NEGATIVE_INFINITY)
        || (b.riskRewardRatio ?? Number.NEGATIVE_INFINITY) - (a.riskRewardRatio ?? Number.NEGATIVE_INFINITY)
        || (b.profitProbability ?? Number.NEGATIVE_INFINITY) - (a.profitProbability ?? Number.NEGATIVE_INFINITY)
        || evidenceQualityRank(right.evidenceQuality) - evidenceQualityRank(left.evidenceQuality)
        || left.signalId.localeCompare(right.signalId);
    }));
}
