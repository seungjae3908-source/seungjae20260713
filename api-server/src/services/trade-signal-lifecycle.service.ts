import type {
  TradingApprovalStatus,
  TradingPlan,
  TradingPlanInput,
  TradingSignalState,
  TradingSignalStateEvent,
  TradingSignalValidationInput,
} from './trade-automation.types';

export const SIGNAL_VALIDATION_MAX_AGE_MS = 30_000;
const SIGNAL_CLOCK_SKEW_MS = 5_000;
const DEFAULT_SIGNAL_TTL_MS = 10 * 60_000;
const HISTORY_LIMIT = 100;

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function finiteOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringList(value: unknown, maximum = 30) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, maximum)
    : [];
}

function validDateOr(value: unknown, fallback: Date) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

export type SignalLifecycleEvaluation = {
  state: TradingSignalState;
  reasonCode: string;
  score: number;
  confidence: number;
  riskReward: number | null;
  coreConditionsMaintained: boolean;
  reasons: string[];
  warnings: string[];
  dataTimestamp: string;
};

export function evaluateSignalLifecycle(
  minimums: Pick<TradingPlan, 'minimumSignalScore' | 'minimumSignalConfidence' | 'minimumRiskReward' | 'signalExpiresAt'>,
  validation: TradingSignalValidationInput,
  now = new Date(),
): SignalLifecycleEvaluation {
  const score = clamp(validation.score, 0, 100, 0);
  const confidence = clamp(validation.confidence, 0, 100, 0);
  const riskReward = finiteOrNull(validation.riskReward);
  const reasons = stringList(validation.reasons);
  const warnings = stringList(validation.warnings);
  const coreConditionsMaintained = validation.coreConditionsMaintained === true;
  const dataTimestampMs = Date.parse(String(validation.dataTimestamp ?? ''));
  const signalExpiresAtMs = Date.parse(minimums.signalExpiresAt);
  const invalidationReason = String(validation.invalidationReason ?? '').trim();

  const base = {
    score,
    confidence,
    riskReward,
    coreConditionsMaintained,
    reasons,
    warnings,
    dataTimestamp: Number.isFinite(dataTimestampMs)
      ? new Date(dataTimestampMs).toISOString()
      : String(validation.dataTimestamp ?? ''),
  };

  if (Number.isFinite(signalExpiresAtMs) && signalExpiresAtMs <= now.getTime()) {
    return { ...base, state: 'EXPIRED', reasonCode: 'SIGNAL_EXPIRED' };
  }
  if (!Number.isFinite(dataTimestampMs)) {
    return { ...base, state: 'INVALIDATED', reasonCode: 'SIGNAL_DATA_TIMESTAMP_INVALID' };
  }
  if (dataTimestampMs > now.getTime() + SIGNAL_CLOCK_SKEW_MS) {
    return { ...base, state: 'INVALIDATED', reasonCode: 'SIGNAL_DATA_FROM_FUTURE' };
  }
  if (now.getTime() - dataTimestampMs > SIGNAL_VALIDATION_MAX_AGE_MS) {
    return { ...base, state: 'INVALIDATED', reasonCode: 'SIGNAL_DATA_STALE' };
  }
  if (invalidationReason) {
    return { ...base, state: 'INVALIDATED', reasonCode: invalidationReason };
  }
  if (!coreConditionsMaintained) {
    return { ...base, state: 'INVALIDATED', reasonCode: 'SIGNAL_CORE_CONDITION_BROKEN' };
  }
  if (minimums.minimumRiskReward > 0 && (riskReward == null || riskReward < minimums.minimumRiskReward)) {
    return { ...base, state: 'INVALIDATED', reasonCode: 'SIGNAL_RISK_REWARD_BELOW_MINIMUM' };
  }
  if (score < minimums.minimumSignalScore) {
    const deficit = minimums.minimumSignalScore - score;
    return {
      ...base,
      state: deficit >= 10 ? 'INVALIDATED' : 'WEAKENED',
      reasonCode: 'SIGNAL_SCORE_BELOW_MINIMUM',
    };
  }
  if (confidence < minimums.minimumSignalConfidence) {
    const deficit = minimums.minimumSignalConfidence - confidence;
    return {
      ...base,
      state: deficit >= 10 ? 'INVALIDATED' : 'WEAKENED',
      reasonCode: 'SIGNAL_CONFIDENCE_BELOW_MINIMUM',
    };
  }

  return { ...base, state: 'READY_FOR_APPROVAL', reasonCode: 'SIGNAL_READY' };
}

export function initializeSignalLifecycle(
  input: TradingPlanInput,
  approvalExpiresAt: string | null,
  now = new Date(),
) {
  const signalExpiresAt = validDateOr(
    input.signalExpiresAt,
    approvalExpiresAt ? new Date(approvalExpiresAt) : new Date(now.getTime() + DEFAULT_SIGNAL_TTL_MS),
  ).toISOString();
  const minimumSignalScore = clamp(input.minimumSignalScore, 0, 100, 0);
  const minimumSignalConfidence = clamp(input.minimumSignalConfidence, 0, 100, 0);
  const minimumRiskReward = clamp(input.minimumRiskReward, 0, 100, 0);
  const validation: TradingSignalValidationInput = {
    score: clamp(input.signalScore, 0, 100, 100),
    confidence: clamp(input.signalConfidence, 0, 100, 100),
    coreConditionsMaintained: input.signalCoreConditionsMaintained !== false,
    riskReward: finiteOrNull(input.signalRiskReward),
    reasons: input.signalReasons,
    warnings: input.signalWarnings,
    dataTimestamp: input.marketSnapshot.observedAt,
  };
  const evaluation = evaluateSignalLifecycle({
    minimumSignalScore,
    minimumSignalConfidence,
    minimumRiskReward,
    signalExpiresAt,
  }, validation, now);
  const event: TradingSignalStateEvent = {
    fromState: null,
    toState: evaluation.state,
    reason: evaluation.reasonCode,
    score: evaluation.score,
    confidence: evaluation.confidence,
    coreConditionsMaintained: evaluation.coreConditionsMaintained,
    riskReward: evaluation.riskReward,
    dataTimestamp: evaluation.dataTimestamp,
    createdAt: now.toISOString(),
  };
  return {
    signalState: evaluation.state,
    signalScore: evaluation.score,
    signalConfidence: evaluation.confidence,
    minimumSignalScore,
    minimumSignalConfidence,
    minimumRiskReward,
    signalRiskReward: evaluation.riskReward,
    signalCoreConditionsMaintained: evaluation.coreConditionsMaintained,
    signalExpiresAt,
    lastSignalValidatedAt: now.toISOString(),
    signalWarnings: evaluation.warnings,
    signalInvalidationReason: evaluation.state === 'INVALIDATED' || evaluation.state === 'EXPIRED'
      ? evaluation.reasonCode
      : null,
    signalStateHistory: [event],
  };
}

export function applySignalValidation(
  plan: TradingPlan,
  validation: TradingSignalValidationInput,
  now = new Date(),
) {
  const evaluation = evaluateSignalLifecycle(plan, validation, now);
  const event: TradingSignalStateEvent = {
    fromState: plan.signalState,
    toState: evaluation.state,
    reason: evaluation.reasonCode,
    score: evaluation.score,
    confidence: evaluation.confidence,
    coreConditionsMaintained: evaluation.coreConditionsMaintained,
    riskReward: evaluation.riskReward,
    dataTimestamp: evaluation.dataTimestamp,
    createdAt: now.toISOString(),
  };
  plan.signalState = evaluation.state;
  plan.signalScore = evaluation.score;
  plan.signalConfidence = evaluation.confidence;
  plan.signalRiskReward = evaluation.riskReward;
  plan.signalCoreConditionsMaintained = evaluation.coreConditionsMaintained;
  plan.signalReasons = evaluation.reasons.length ? evaluation.reasons : plan.signalReasons;
  plan.signalWarnings = evaluation.warnings;
  plan.signalInvalidationReason = evaluation.state === 'INVALIDATED' || evaluation.state === 'EXPIRED'
    ? evaluation.reasonCode
    : null;
  plan.lastSignalValidatedAt = now.toISOString();
  plan.signalStateHistory = [...(plan.signalStateHistory ?? []), event].slice(-HISTORY_LIMIT);
  plan.updatedAt = now.toISOString();
  return { plan, evaluation };
}

export function approvalStatus(plan: TradingPlan, now = new Date()): TradingApprovalStatus {
  const approvalExpiry = plan.approvalExpiresAt ? Date.parse(plan.approvalExpiresAt) : Number.NaN;
  const signalExpiry = Date.parse(plan.signalExpiresAt);
  const lastValidation = Date.parse(plan.lastSignalValidatedAt);
  let reasonCode: string | null = null;

  if (plan.state !== 'APPROVAL_PENDING') reasonCode = 'PLAN_NOT_APPROVAL_PENDING';
  else if (plan.signalState !== 'READY_FOR_APPROVAL') reasonCode = `SIGNAL_${plan.signalState}`;
  else if (!Number.isFinite(approvalExpiry) || approvalExpiry <= now.getTime()) reasonCode = 'APPROVAL_EXPIRED';
  else if (!Number.isFinite(signalExpiry) || signalExpiry <= now.getTime()) reasonCode = 'SIGNAL_EXPIRED';
  else if (!Number.isFinite(lastValidation) || now.getTime() - lastValidation > SIGNAL_VALIDATION_MAX_AGE_MS) {
    reasonCode = 'SIGNAL_REVALIDATION_REQUIRED';
  }

  return {
    approvalEnabled: reasonCode == null,
    signalState: plan.signalState,
    planState: plan.state,
    reasonCode,
    expiresAt: plan.approvalExpiresAt,
    lastValidatedAt: plan.lastSignalValidatedAt,
  };
}
