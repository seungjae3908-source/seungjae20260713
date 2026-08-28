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
    initial: {
      snapshotId: 'INITIAL_FULL_1',
      source: 'BITGET_PUBLIC_L2_INITIAL',
      observedAtMs: nowMs - 1_000,
      bids: [[99, 20]] as const,
      asks: [[100, 10], [100.1, 10]] as const,
    },
    nowMs,
    maximumAgeMs: 5_000,
    minimumResidualDelayMs: 1,
    maximumResidualDelayMs: 2_000,
  };
}

function partialCoverageInput() {
  return {
    direction: 'LONG' as const,
    targetQuantity: 10,
    initial: {
      snapshotId: 'INITIAL_PARTIAL_1',
      source: 'BITGET_PUBLIC_L2_INITIAL',
      observedAtMs: nowMs - 1_000,
      bids: [[99, 20]] as const,
      asks: [[100, 6]] as const,
    },
    residual: {
      snapshotId: 'RESIDUAL_1',
      source: 'BITGET_PUBLIC_L2_RESIDUAL',
      observedAtMs: nowMs - 500,
      bids: [[99.5, 20]] as const,
      asks: [[100, 2], [101, 2]] as const,
    },
    nowMs,
    maximumAgeMs: 5_000,
    minimumResidualDelayMs: 100,
    maximumResidualDelayMs: 2_000,
  };
}

test('full visible initial coverage produces explicit estimated zero partial-fill impact', () => {
  const result = buildAuthoritativePaperPartialFillCostEvidence(fullCoverageInput());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.initialVisibleCoverageRatio, 1);
  assert.equal(result.initialVisibleUnfilledQuantity, 0);
  assert.equal(result.partialFillImpactPercent, 0);
  assert.equal(result.evidence?.valuePercent, 0);
  assert.equal(result.evidence?.quality, 'ESTIMATED');
  assert.match(result.evidence?.source ?? '', /FULL_VISIBLE_COVERAGE_NO_PARTIAL_FILL/);
  assert.equal(result.realFillObserved, false);
  assert.equal(result.unknownCostIsZero, false);
});

test('partial initial coverage uses only distinct residual book-walk slippage weighted by residual quantity', () => {
  const result = buildAuthoritativePaperPartialFillCostEvidence(partialCoverageInput());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.initialVisibleCoverageRatio, 0.6);
  assert.equal(result.initialVisibleFilledQuantity, 6);
  assert.equal(result.initialVisibleUnfilledQuantity, 4);
  assert.equal(result.residualVisibleCoverageRatio, 1);
  assert.ok(result.residualBookWalkSlippagePercent != null);
  assert.ok(Math.abs(result.residualBookWalkSlippagePercent - 0.5) < 1e-12);
  assert.ok(result.partialFillImpactPercent != null);
  assert.ok(Math.abs(result.partialFillImpactPercent - 0.2) < 1e-12);
  assert.ok(Math.abs((result.evidence?.valuePercent ?? -1) - 0.2) < 1e-12);
  assert.match(result.evidence?.source ?? '', /INITIAL_PARTIAL_1->RESIDUAL_1/);
  assert.equal(result.publicDepthIsRealFillProof, false);
});

test('partial coverage without residual public depth fails closed instead of fabricating zero', () => {
  const input = partialCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({ ...input, residual: null });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_RESIDUAL_PUBLIC_DEPTH_REQUIRED'));
  assert.equal(result.unknownCostIsZero, false);
});

test('residual snapshot identity must be distinct from the initial slippage snapshot', () => {
  const input = partialCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    residual: { ...input.residual, snapshotId: input.initial.snapshotId },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL_RESIDUAL_SNAPSHOT_ID_MUST_BE_DISTINCT'));
});

test('residual snapshot must occur inside the bounded partial-fill observation window', () => {
  const input = partialCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    residual: { ...input.residual, observedAtMs: input.initial.observedAtMs + 50 },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL_RESIDUAL_DELAY_OUTSIDE_POLICY'));
});

test('incomplete residual visible depth remains blocked data', () => {
  const input = partialCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    residual: { ...input.residual, asks: [[100, 2]] as const },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_RESIDUAL_VISIBLE_DEPTH_INCOMPLETE'));
});

test('stale initial snapshot fails closed', () => {
  const input = fullCoverageInput();
  const result = buildAuthoritativePaperPartialFillCostEvidence({
    ...input,
    initial: { ...input.initial, observedAtMs: nowMs - 20_000 },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL_INITIAL_PUBLIC_DEPTH_INVALID_OR_STALE'));
});

test('safety contract forbids real-fill claims, private API, live trading, and missing-data zero', () => {
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.publicMarketDataOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.simulatedExecutionOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.initialSlippageReusedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.interSnapshotPriceDriftCountedAsPartialFillCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.missingDataMayProduceZeroCost, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.privateApiAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.liveTrading, false);
  assert.equal(AUTHORITATIVE_PAPER_PARTIAL_FILL_COST_EVIDENCE_SAFETY.orderSubmissionAllowed, false);
});
