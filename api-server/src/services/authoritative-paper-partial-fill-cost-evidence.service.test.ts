import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY,
  buildAuthoritativePaperPartialFillCostEvidence,
} from './authoritative-paper-partial-fill-cost-evidence.service';

const nowMs = 2_000_000;

function fullCoverageInput() {
  return {
    direction: 'LONG' as const,
    targetQuantity: 10,
    snapshot: {
      snapshotId: 'FULL_VISIBLE_1',
      source: 'BITGET_PUBLIC_L2',
      observedAtMs: nowMs - 1_000,
      bids: [[99, 20]] as const,
      asks: [[100, 10], [100.1, 10]] as const,
    },
    nowMs,
    maximumAgeMs: 5_000,
  };
}

function partialCoverageInput() {
  return {
    direction: 'LONG' as const,
    targetQuantity: 10,
    snapshot: {
      snapshotId: 'PARTIAL_VISIBLE_1',
      source: 'BITGET_PUBLIC_L2',
      observedAtMs: nowMs - 1_000,
      bids: [[99, 20]] as const,
      asks: [[100, 6]] as const,
    },
    nowMs,
    maximumAgeMs: 5_000,
  };
}

test('full visible coverage produces explicit estimated zero partial-fill impact', () => {
  const result = buildAuthoritativePaperPartialFillCostEvidence(fullCoverageInput());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.visibleCoverageRatio, 1);
  assert.equal(result.visibleFilledQuantity, 10);
  assert.equal(result.visibleUnfilledQuantity, 0);
  assert.equal(result.partialFillImpactPercent, 0);
  assert.equal(result.evidence?.valuePercent, 0);
  assert.equal(result.evidence?.quality, 'ESTIMATED');
  assert.match(result.evidence?.source ?? '', /FULL_VISIBLE_COVERAGE_NO_PARTIAL_FILL/);
  assert.doesNotMatch(result.evidence?.source ?? '', /SLIPPAGE|RESIDUAL/);
  assert.equal(result.realFillObserved, false);
  assert.equal(result.unknownCostIsZero, false);
});

test('SHORT full visible coverage follows the same truth-safe zero rule', () => {
  const input = fullCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    direction: 'SHORT',
    snapshot: {
      ...input.snapshot,
      bids: [[100, 10], [99.9, 10]] as const,
      asks: [[101, 20]] as const,
    },
  });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.visibleCoverageRatio, 1);
  assert.equal(result.evidence?.valuePercent, 0);
});

test('partial visible coverage fails closed and never reuses book-walk slippage as partial-fill cost', () => {
  const result = buildAuthoritativePaperPartialFillCostEvidence(partialCoverageInput());
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.visibleCoverageRatio, 0.6);
  assert.equal(result.visibleFilledQuantity, 6);
  assert.equal(result.visibleUnfilledQuantity, 4);
  assert.equal(result.evidence, null);
  assert.equal(result.partialFillImpactPercent, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_INDEPENDENT_COST_EVIDENCE_REQUIRED'));
  assert.ok(result.blockers.includes('PARTIAL_FILL_BOOK_WALK_SLIPPAGE_REUSE_FORBIDDEN'));
  assert.equal(result.unknownCostIsZero, false);
});

test('empty executable book remains blocked data', () => {
  const input = fullCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    snapshot: { ...input.snapshot, asks: [] as const },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_VISIBLE_COVERAGE_NOT_AVAILABLE'));
});

test('stale public depth fails closed instead of fabricating zero', () => {
  const input = fullCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    snapshot: { ...input.snapshot, observedAtMs: nowMs - 20_000 },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_PUBLIC_DEPTH_INVALID_OR_STALE'));
});

test('invalid target quantity fails closed', () => {
  const input = fullCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({ ...input, targetQuantity: 0 });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_TARGET_QUANTITY_INVALID'));
});

test('safety contract keeps partial-fill ownership independent and simulation-only', () => {
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.publicMarketDataOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.simulatedExecutionOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.partialVisibleCoverageRequiresIndependentCostEvidence, true);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.bookWalkSlippageReusedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.interSnapshotPriceDriftCountedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.missingDataMayProduceZeroCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.privateApiAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.liveTrading, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.orderSubmissionAllowed, false);
});
