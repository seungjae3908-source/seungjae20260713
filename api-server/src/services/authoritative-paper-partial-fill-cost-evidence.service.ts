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
  visibleCoverageRatio: number | null;
  visibleFilledQuantity: number | null;
  visibleUnfilledQuantity: number | null;
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
  snapshot: PublicDepthSnapshot;
  nowMs?: number;
  maximumAgeMs?: number;
}>;

const DEFAULT_MAXIMUM_AGE_MS = 30_000;

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
  diagnostics: Readonly<{
    visibleCoverageRatio?: number | null;
    visibleFilledQuantity?: number | null;
    visibleUnfilledQuantity?: number | null;
  }> = {},
): AuthoritativePaperPartialFillCostEvidenceResult {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA' as const,
    evidence: null,
    visibleCoverageRatio: diagnostics.visibleCoverageRatio ?? null,
    visibleFilledQuantity: diagnostics.visibleFilledQuantity ?? null,
    visibleUnfilledQuantity: diagnostics.visibleUnfilledQuantity ?? null,
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
  const blockers: string[] = [];

  if (input?.direction !== 'LONG' && input?.direction !== 'SHORT') blockers.push('PARTIAL_FILL_DIRECTION_INVALID');
  if (!positive(input?.targetQuantity)) blockers.push('PARTIAL_FILL_TARGET_QUANTITY_INVALID');
  if (!validSnapshot(input?.snapshot, nowMs, maximumAgeMs)) blockers.push('PARTIAL_FILL_PUBLIC_DEPTH_INVALID_OR_STALE');
  if (blockers.length > 0) return blocked(blockers);

  const direction = input.direction === 'LONG' ? 'BUY' : 'SELL';
  const bookWalk = walkOrderBook({
    direction,
    targetQty: input.targetQuantity,
    bids: input.snapshot.bids,
    asks: input.snapshot.asks,
  });
  if (bookWalk?.status === 'NOT_AVAILABLE') {
    return blocked(['PARTIAL_FILL_VISIBLE_COVERAGE_NOT_AVAILABLE']);
  }

  const visibleCoverageRatio = numeric(bookWalk?.coverageRatio);
  const visibleFilledQuantity = numeric(bookWalk?.filledQty);
  const visibleUnfilledQuantity = numeric(bookWalk?.unfilledQty);
  const diagnostics = {
    visibleCoverageRatio,
    visibleFilledQuantity,
    visibleUnfilledQuantity,
  } as const;

  if (!nonNegative(visibleCoverageRatio) || visibleCoverageRatio > 1
    || !nonNegative(visibleFilledQuantity) || !nonNegative(visibleUnfilledQuantity)) {
    return blocked(['PARTIAL_FILL_VISIBLE_COVERAGE_INVALID'], diagnostics);
  }

  if (visibleCoverageRatio !== 1 || visibleUnfilledQuantity !== 0) {
    return blocked([
      'PARTIAL_FILL_INDEPENDENT_COST_EVIDENCE_REQUIRED',
      'PARTIAL_FILL_BOOK_WALK_SLIPPAGE_REUSE_FORBIDDEN',
    ], diagnostics);
  }

  const evidence: PercentCostEvidence = Object.freeze({
    valuePercent: 0,
    quality: 'ESTIMATED',
    source: `PUBLIC_L2_FULL_VISIBLE_COVERAGE_NO_PARTIAL_FILL:${input.snapshot.snapshotId.trim()}:${input.snapshot.source.trim()}`,
    observedAtMs: input.snapshot.observedAtMs,
  });

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
    status: 'PRESENT' as const,
    evidence,
    ...diagnostics,
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

export const AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_VERSION,
  publicMarketDataOnly: true,
  simulatedExecutionOnly: true,
  fullVisibleCoverageMayProduceEstimatedZeroPartialFillCost: true,
  partialVisibleCoverageRequiresIndependentCostEvidence: true,
  bookWalkSlippageReusedAsPartialFillCost: false,
  interSnapshotPriceDriftCountedAsPartialFillCost: false,
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
