import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY,
  buildAuthoritativePaperLatencyCostEvidence,
} from './authoritative-paper-latency-cost-evidence.service';

const nowMs = 2_000_000;

function baseInput() {
  return {
    direction: 'LONG' as const,
    requestStartedAtMs: nowMs - 500,
    requestCompletedAtMs: nowMs - 300,
    preRequest: {
      midpoint: 100,
      observedAtMs: nowMs - 550,
      source: 'BITGET_PUBLIC_PRE',
    },
    postRequest: {
      midpoint: 100.2,
      observedAtMs: nowMs - 250,
      source: 'BITGET_PUBLIC_POST',
    },
    nowMs,
    maximumAgeMs: 5_000,
    maximumRequestDurationMs: 5_000,
  };
}

test('LONG adverse midpoint movement becomes estimated latency cost', () => {
  const result = buildAuthoritativePaperLatencyCostEvidence(baseInput());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.observedRoundTripMs, 200);
  assert.ok(result.evidence);
  assert.equal(result.evidence.quality, 'ESTIMATED');
  assert.ok(Math.abs(result.evidence.valuePercent - 0.2) < 1e-12);
  assert.equal(result.unknownCostIsZero, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('SHORT adverse midpoint movement is direction-aware', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    direction: 'SHORT',
    postRequest: { ...input.postRequest, midpoint: 99.8 },
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.evidence);
  assert.ok(Math.abs(result.evidence.valuePercent - 0.2) < 1e-12);
});

test('favorable movement can produce a measured zero adverse cost without treating missing data as zero', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: { ...input.postRequest, midpoint: 99.8 },
  });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.evidence?.valuePercent, 0);
  assert.equal(result.unknownCostIsZero, false);
});

test('missing midpoint evidence fails closed instead of fabricating zero', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: { ...input.postRequest, midpoint: Number.NaN },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes('LATENCY_POST_REQUEST_MIDPOINT_UNAVAILABLE'));
});

test('stale evidence fails closed', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    postRequest: { ...input.postRequest, observedAtMs: nowMs - 20_000 },
    maximumAgeMs: 5_000,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.evidence, null);
});

test('temporal bracketing is required', () => {
  const input = baseInput();
  const result = buildAuthoritativePaperLatencyCostEvidence({
    ...input,
    preRequest: { ...input.preRequest, observedAtMs: input.requestStartedAtMs + 1 },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LATENCY_PRE_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST'));
});

test('safety contract remains simulation-only and public-data-only', () => {
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.publicMarketDataOnly, true);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.causalExecutionClaimAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.privateApiAllowed, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.liveTrading, false);
  assert.equal(AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY.orderSubmissionAllowed, false);
});
