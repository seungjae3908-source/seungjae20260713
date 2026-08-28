import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION =
  'authoritative-paper-latency-cost-evidence-v1' as const;

export type LatencyDirection = 'LONG' | 'SHORT';

export type PublicMidpointObservation = Readonly<{
  midpoint: number;
  observedAtMs: number;
  source: string;
}>;

export type AuthoritativePaperLatencyCostEvidenceResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION;
  status: 'PRESENT' | 'BLOCKED_DATA';
  evidence: PercentCostEvidence | null;
  observedRoundTripMs: number | null;
  signedMidpointMovePercent: number | null;
  adverseMovePercent: number | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  realFillObserved: false;
  unknownCostIsZero: false;
}>;

type Input = Readonly<{
  direction: LatencyDirection;
  requestStartedAtMs: number;
  requestCompletedAtMs: number;
  preRequest: PublicMidpointObservation;
  postRequest: PublicMidpointObservation;
  nowMs?: number;
  maximumAgeMs?: number;
  maximumRequestDurationMs?: number;
}>;

const DEFAULT_MAXIMUM_AGE_MS = 30_000;
const DEFAULT_MAXIMUM_REQUEST_DURATION_MS = 30_000;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function blocked(blockers: readonly string[]): AuthoritativePaperLatencyCostEvidenceResult {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA' as const,
    evidence: null,
    observedRoundTripMs: null,
    signedMidpointMovePercent: null,
    adverseMovePercent: null,
    blockers: Object.freeze([...blockers]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    unknownCostIsZero: false as const,
  });
}

export function buildAuthoritativePaperLatencyCostEvidence(
  input: Input,
): AuthoritativePaperLatencyCostEvidenceResult {
  const nowMs = positive(input?.nowMs) ? input.nowMs : Date.now();
  const maximumAgeMs = positive(input?.maximumAgeMs) ? input.maximumAgeMs : DEFAULT_MAXIMUM_AGE_MS;
  const maximumRequestDurationMs = positive(input?.maximumRequestDurationMs)
    ? input.maximumRequestDurationMs
    : DEFAULT_MAXIMUM_REQUEST_DURATION_MS;
  const blockers: string[] = [];

  if (input?.direction !== 'LONG' && input?.direction !== 'SHORT') blockers.push('LATENCY_DIRECTION_INVALID');
  if (!positive(input?.requestStartedAtMs) || !positive(input?.requestCompletedAtMs)
    || input.requestCompletedAtMs < input.requestStartedAtMs) {
    blockers.push('LATENCY_REQUEST_TIMING_INVALID');
  }

  const roundTripMs = positive(input?.requestStartedAtMs) && positive(input?.requestCompletedAtMs)
    ? input.requestCompletedAtMs - input.requestStartedAtMs
    : null;
  if (roundTripMs != null && roundTripMs > maximumRequestDurationMs) {
    blockers.push('LATENCY_REQUEST_DURATION_EXCEEDS_POLICY');
  }

  const pre = input?.preRequest;
  const post = input?.postRequest;
  if (!positive(pre?.midpoint) || !positive(pre?.observedAtMs) || !nonEmpty(pre?.source)) {
    blockers.push('LATENCY_PRE_REQUEST_MIDPOINT_UNAVAILABLE');
  }
  if (!positive(post?.midpoint) || !positive(post?.observedAtMs) || !nonEmpty(post?.source)) {
    blockers.push('LATENCY_POST_REQUEST_MIDPOINT_UNAVAILABLE');
  }

  if (positive(pre?.observedAtMs) && positive(input?.requestStartedAtMs)
    && pre.observedAtMs > input.requestStartedAtMs) {
    blockers.push('LATENCY_PRE_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST');
  }
  if (positive(post?.observedAtMs) && positive(input?.requestCompletedAtMs)
    && post.observedAtMs < input.requestCompletedAtMs) {
    blockers.push('LATENCY_POST_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST');
  }
  if (positive(post?.observedAtMs) && post.observedAtMs > nowMs) {
    blockers.push('LATENCY_POST_REQUEST_EVIDENCE_FROM_FUTURE');
  } else if (positive(post?.observedAtMs) && nowMs - post.observedAtMs > maximumAgeMs) {
    blockers.push('LATENCY_POST_REQUEST_EVIDENCE_STALE');
  }
  if (positive(pre?.observedAtMs) && positive(post?.observedAtMs)
    && post.observedAtMs < pre.observedAtMs) {
    blockers.push('LATENCY_MIDPOINT_OBSERVATION_ORDER_INVALID');
  }

  if (blockers.length > 0) return blocked(blockers);

  const signedMovePercent = input.direction === 'LONG'
    ? ((post.midpoint - pre.midpoint) / pre.midpoint) * 100
    : ((pre.midpoint - post.midpoint) / pre.midpoint) * 100;
  const adverseMovePercent = Math.max(0, signedMovePercent);
  const observedAtMs = post.observedAtMs;
  const evidence: PercentCostEvidence = Object.freeze({
    valuePercent: adverseMovePercent,
    quality: 'ESTIMATED',
    source: `PUBLIC_MIDPOINT_ADVERSE_MOVE_OVER_OBSERVED_REQUEST_LATENCY:${pre.source.trim()}->${post.source.trim()}`,
    observedAtMs,
  });

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
    status: 'PRESENT' as const,
    evidence,
    observedRoundTripMs: roundTripMs,
    signedMidpointMovePercent: signedMovePercent,
    adverseMovePercent,
    blockers: Object.freeze([]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    unknownCostIsZero: false as const,
  });
}

export const AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
  publicMarketDataOnly: true,
  observedRequestDurationRequired: true,
  temporalBracketingRequired: true,
  favorableMoveMayProduceObservedZeroAdverseCost: true,
  missingDataMayProduceZeroCost: false,
  causalExecutionClaimAllowed: false,
  realFillObserved: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
});
