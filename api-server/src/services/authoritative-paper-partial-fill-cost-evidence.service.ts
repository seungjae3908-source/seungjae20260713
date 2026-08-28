import { walkOrderBook } from '../../../market-intelligence-sidecar/src/execution-quality.mjs';
import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION =
  'authoritative-paper-partial-fill-cost-evidence-v1' as const;

export type PartialFillDirection = 'LONG' | 'SHORT';

type DepthLevel = readonly [number | string, number | string] | Readonly<{
  price: number | string;
  size?: number | string;
  qty?: number | string;
  quantity?: number | string;
}>;

export type PublicDepthSnapshot = Readonly<{
  snapshotId: string;
  source: string;
  observedAtMs: number;
  bids: readonly DepthLevel[];
  asks: readonly DepthLevel[];
}>;

export type AuthoritativePaperPartialFillCostEvidenceResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION;
  status: 'PRESENT' | 'BLOCKED_DATA';
  evidence: PercentCostEvidence | null;
  initialVisibleCoverageRatio: number | null;
  initialVisibleFilledQuantity: number | null;
  initialVisibleUnfilledQuantity: number | null;
  residualVisibleCoverageRatio: number | null;
  residualBookWalkSlippagePercent: number | null;
  partialFillImpactPercent: number | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  realFillObserved: false;
  publicDepthIsRealFillProof: false;
  unknownCostIsZero: false;
}>;

type Input = Readonly<{
  direction: PartialFillDirection;
  targetQuantity: number;
  initial: PublicDepthSnapshot;
  residual?: PublicDepthSnapshot | null;
  nowMs?: number;
  maximumAgeMs?: number;
  minimumResidualDelayMs?: number;
  maximumResidualDelayMs?: number;
}>;

const DEFAULT_MAXIMUM_AGE_MS = 30_000;
const DEFAULT_MINIMUM_RESIDUAL_DELAY_MS = 1;
const DEFAULT_MAXIMUM_RESIDUAL_DELAY_MS = 30_000;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validSnapshot(
  snapshot: PublicDepthSnapshot | null | undefined,
  nowMs: number,
  maximumAgeMs: number,
): snapshot is PublicDepthSnapshot {
  return Boolean(
    snapshot
      && nonEmpty(snapshot.snapshotId)
      && nonEmpty(snapshot.source)
      && positive(snapshot.observedAtMs)
      && snapshot.observedAtMs <= nowMs
      && nowMs - snapshot.observedAtMs <= maximumAgeMs
      && Array.isArray(snapshot.bids)
      && Array.isArray(snapshot.asks),
  );
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blocked(
  blockers: readonly string[],
  diagnostics: Partial<Pick<
    AuthoritativePaperPartialFillCostEvidenceResult,
    | 'initialVisibleCoverageRatio'
    | 'initialVisibleFilledQuantity'
    | 'initialVisibleUnfilledQuantity'
    | 'residualVisibleCoverageRatio'
    | 'residualBookWalkSlippagePercent'
  >> = {},
): AuthoritativePaperPartialFillCostEvidenceResult {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA' as const,
    evidence: null,
    initialVisibleCoverageRatio: diagnostics.initialVisibleCoverageRatio ?? null,
    initialVisibleFilledQuantity: diagnostics.initialVisibleFilledQuantity ?? null,
    initialVisibleUnfilledQuantity: diagnostics.initialVisibleUnfilledQuantity ?? null,
    residualVisibleCoverageRatio: diagnostics.residualVisibleCoverageRatio ?? null,
    residualBookWalkSlippagePercent: diagnostics.residualBookWalkSlippagePercent ?? null,
    partialFillImpactPercent: null,
    blockers: Object.freeze([...new Set(blockers)]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    publicDepthIsRealFillProof: false as const,
    unknownCostIsZero: false as const,
  });
}

export function buildAuthoritativePaperPartialFillCostEvidence(
  input: Input,
): AuthoritativePaperPartialFillCostEvidenceResult {
  const nowMs = positive(input?.nowMs) ? input.nowMs : Date.now();
  const maximumAgeMs = positive(input?.maximumAgeMs) ? input.maximumAgeMs : DEFAULT_MAXIMUM_AGE_MS;
  const minimumResidualDelayMs = nonNegative(input?.minimumResidualDelayMs)
    ? input.minimumResidualDelayMs
    : DEFAULT_MINIMUM_RESIDUAL_DELAY_MS;
  const maximumResidualDelayMs = positive(input?.maximumResidualDelayMs)
    ? input.maximumResidualDelayMs
    : DEFAULT_MAXIMUM_RESIDUAL_DELAY_MS;
  const blockers: string[] = [];

  if (input?.direction !== 'LONG' && input?.direction !== 'SHORT') blockers.push('PARTIAL_FILL_DIRECTION_INVALID');
  if (!positive(input?.targetQuantity)) blockers.push('PARTIAL_FILL_TARGET_QUANTITY_INVALID');
  if (!validSnapshot(input?.initial, nowMs, maximumAgeMs)) blockers.push('PARTIAL_FILL_INITIAL_PUBLIC_DEPTH_INVALID_OR_STALE');
  if (maximumResidualDelayMs < minimumResidualDelayMs) blockers.push('PARTIAL_FILL_RESIDUAL_DELAY_POLICY_INVALID');
  if (blockers.length > 0) return blocked(blockers);

  const direction = input.direction === 'LONG' ? 'BUY' : 'SELL';
  const initialWalk = walkOrderBook({
    direction,
    targetQty: input.targetQuantity,
    bids: input.initial.bids,
    asks: input.initial.asks,
  });
  if (initialWalk?.status === 'NOT_AVAILABLE') {
    return blocked(['PARTIAL_FILL_INITIAL_BOOK_WALK_NOT_AVAILABLE']);
  }

  const initialCoverage = numeric(initialWalk?.coverageRatio);
  const initialFilled = numeric(initialWalk?.filledQty);
  const initialUnfilled = numeric(initialWalk?.unfilledQty);
  if (!nonNegative(initialCoverage) || initialCoverage > 1
    || !nonNegative(initialFilled) || !nonNegative(initialUnfilled)) {
    return blocked(['PARTIAL_FILL_INITIAL_BOOK_WALK_INVALID']);
  }

  const diagnostics = {
    initialVisibleCoverageRatio: initialCoverage,
    initialVisibleFilledQuantity: initialFilled,
    initialVisibleUnfilledQuantity: initialUnfilled,
  } as const;

  if (initialUnfilled === 0 && initialCoverage === 1) {
    const evidence: PercentCostEvidence = Object.freeze({
      valuePercent: 0,
      quality: 'ESTIMATED',
      source: `PUBLIC_L2_FULL_VISIBLE_COVERAGE_NO_PARTIAL_FILL:${input.initial.snapshotId.trim()}:${input.initial.source.trim()}`,
      observedAtMs: input.initial.observedAtMs,
    });
    return Object.freeze({
      schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
      status: 'PRESENT' as const,
      evidence,
      ...diagnostics,
      residualVisibleCoverageRatio: null,
      residualBookWalkSlippagePercent: null,
      partialFillImpactPercent: 0,
      blockers: Object.freeze([]),
      executionAuthority: 'NONE' as const,
      privateApiUsed: false as const,
      liveTrading: false as const,
      realFillObserved: false as const,
      publicDepthIsRealFillProof: false as const,
      unknownCostIsZero: false as const,
    });
  }

  const residual = input.residual;
  if (!validSnapshot(residual, nowMs, maximumAgeMs)) {
    return blocked(['PARTIAL_FILL_RESIDUAL_PUBLIC_DEPTH_REQUIRED'], diagnostics);
  }
  if (residual.snapshotId.trim() === input.initial.snapshotId.trim()) {
    return blocked(['PARTIAL_FILL_RESIDUAL_SNAPSHOT_ID_MUST_BE_DISTINCT'], diagnostics);
  }
  if (residual.observedAtMs <= input.initial.observedAtMs) {
    return blocked(['PARTIAL_FILL_RESIDUAL_TIMESTAMP_MUST_FOLLOW_INITIAL'], diagnostics);
  }
  const residualDelayMs = residual.observedAtMs - input.initial.observedAtMs;
  if (residualDelayMs < minimumResidualDelayMs || residualDelayMs > maximumResidualDelayMs) {
    return blocked(['PARTIAL_FILL_RESIDUAL_DELAY_OUTSIDE_POLICY'], diagnostics);
  }

  const residualWalk = walkOrderBook({
    direction,
    targetQty: initialUnfilled,
    bids: residual.bids,
    asks: residual.asks,
  });
  if (residualWalk?.status === 'NOT_AVAILABLE') {
    return blocked(['PARTIAL_FILL_RESIDUAL_BOOK_WALK_NOT_AVAILABLE'], diagnostics);
  }

  const residualCoverage = numeric(residualWalk?.coverageRatio);
  const residualSlippageBps = numeric(residualWalk?.slippageBps);
  const residualSlippagePercent = residualSlippageBps == null ? null : residualSlippageBps / 100;
  const residualDiagnostics = {
    ...diagnostics,
    residualVisibleCoverageRatio: residualCoverage,
    residualBookWalkSlippagePercent: residualSlippagePercent,
  } as const;
  if (!nonNegative(residualCoverage) || residualCoverage < 1) {
    return blocked(['PARTIAL_FILL_RESIDUAL_VISIBLE_DEPTH_INCOMPLETE'], residualDiagnostics);
  }
  if (!nonNegative(residualSlippagePercent)) {
    return blocked(['PARTIAL_FILL_RESIDUAL_SLIPPAGE_INVALID'], residualDiagnostics);
  }

  const residualRatio = initialUnfilled / input.targetQuantity;
  if (!(residualRatio > 0 && residualRatio <= 1)) {
    return blocked(['PARTIAL_FILL_RESIDUAL_RATIO_INVALID'], residualDiagnostics);
  }
  const partialFillImpactPercent = residualRatio * residualSlippagePercent;
  const evidence: PercentCostEvidence = Object.freeze({
    valuePercent: partialFillImpactPercent,
    quality: 'ESTIMATED',
    source: `PUBLIC_L2_DISTINCT_RESIDUAL_BOOK_WALK_PARTIAL_FILL:${input.initial.snapshotId.trim()}->${residual.snapshotId.trim()}:${residual.source.trim()}`,
    observedAtMs: residual.observedAtMs,
  });

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
    status: 'PRESENT' as const,
    evidence,
    ...residualDiagnostics,
    partialFillImpactPercent,
    blockers: Object.freeze([]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    publicDepthIsRealFillProof: false as const,
    unknownCostIsZero: false as const,
  });
}

export const AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
  publicMarketDataOnly: true,
  simulatedExecutionOnly: true,
  distinctResidualSnapshotRequiredWhenInitialCoverageIsPartial: true,
  fullResidualVisibleCoverageRequired: true,
  interSnapshotPriceDriftCountedAsPartialFillCost: false,
  initialSlippageReusedAsPartialFillCost: false,
  fullVisibleCoverageMayProduceEstimatedZeroPartialFillCost: true,
  missingDataMayProduceZeroCost: false,
  publicDepthIsRealFillProof: false,
  causalRealFillClaimAllowed: false,
  realFillObserved: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
});
