import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  analyzePublicForwardLiquidityCrossCaptureStability,
  PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY,
} from '../src/public-forward-liquidity-cross-capture-stability-diagnostics.mjs';

const collectorSha = 'a'.repeat(40);
const digest = (char) => char.repeat(64);
const canonicalEndpoints = ['/api/v3/market/orderbook', '/api/v3/market/fills'];

function observation(id, {
  side = 'SELL',
  frame = '1',
  timestamp = 1_700_000_000_000,
} = {}) {
  return {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    observationId: id,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    forwardCalibrationSampleCredit: 1,
    historicalBackfillForwardCredit: 0,
    publicDataSource: 'BITGET_PUBLIC_UTA_V3',
    collectorCodeSha: collectorSha,
    sourceDigest: digest(id.charCodeAt(0).toString(16)[0] || 'f'),
    aggressiveSide: side,
    eventTimestampMs: timestamp,
    rawSourceProvenance: {
      preEventBook: {
        rawPayloadDigest: digest(frame),
      },
      publicTrade: {
        rawFrameDigest: digest(frame === 'f' ? 'e' : String.fromCharCode(frame.charCodeAt(0) + 1)),
      },
      postEventBooks: [{
        rawPayloadDigest: digest(frame === 'e' ? 'd' : String.fromCharCode(frame.charCodeAt(0) + 2)),
      }],
    },
  };
}

function reasonCounts(reasons) {
  const counts = {};
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

function capture({
  raw = 'b',
  normalized = 'c',
  observations = [],
  reasons = [],
} = {}) {
  return {
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-batch',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    observations,
    droppedEvents: reasons.map((reason, index) => ({
      publicExecutionId: `drop-${raw}-${index}`,
      reason,
    })),
    datasetProvenance: {
      rawSource: {
        provider: 'BITGET_PUBLIC_UTA_V3',
        endpoints: canonicalEndpoints,
        privateApiUsed: false,
      },
      eventCount: observations.length,
      droppedCount: reasons.length,
      droppedReasons: reasonCounts(reasons),
      rawDigest: digest(raw),
      normalizedDigest: digest(normalized),
      collectorCodeSha: collectorSha,
    },
    readiness: {
      LIQUIDITY_IMPACT_PRESENT: false,
      CALIBRATION_SAMPLE_SUFFICIENT: false,
      LIQUIDITY_IMPACT_STATUS: 'BLOCKED_DATA',
      FULL_COST_READY: false,
    },
    safety: {
      publicDataOnly: true,
      historicalBackfillForwardCredit: 0,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      liveTradingAllowed: false,
      realOrderAllowed: false,
      financialMutationAllowed: false,
    },
  };
}

test('reports descriptive cross-capture variability without grading stability or independent N', () => {
  const reports = analyzePublicForwardLiquidityCrossCaptureStability([
    capture({
      raw: '1',
      normalized: '4',
      observations: [
        observation('a-1', { frame: '1', timestamp: 1_000 }),
        observation('a-2', { frame: '1', timestamp: 1_001 }),
      ],
      reasons: Array(8).fill('EVENT_NOT_AFTER_PRE_EVENT_BOOK'),
    }),
    capture({
      raw: '2',
      normalized: '5',
      observations: Array.from({ length: 8 }, (_, index) => observation(
        `b-${index}`,
        { frame: '4', timestamp: 2_000 + index },
      )),
      reasons: Array(2).fill('AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO'),
    }),
    capture({
      raw: '3',
      normalized: '6',
      observations: [observation('c-1', { frame: '7', timestamp: 3_000 })],
      reasons: Array(9).fill('EVENT_NOT_AFTER_PRE_EVENT_BOOK'),
    }),
  ]);

  assert.equal(reports.captureCount, 3);
  assert.deepEqual(reports.perCapture.map(({ acceptanceRate }) => acceptanceRate), [0.2, 0.8, 0.1]);
  assert.ok(Math.abs(reports.captureVariability.acceptanceRate.range - 0.7) < 1e-12);
  assert.equal(reports.captureVariability.gradingStatus, 'NOT_GRADED_NO_PREDECLARED_POLICY');
  assert.equal(reports.captureVariability.stabilityPolicyAvailable, false);
  assert.equal(reports.captureVariability.stabilityProven, false);
  assert.equal(reports.aggregate.totalEvents, 30);
  assert.equal(reports.aggregate.acceptedEvents, 11);
  assert.deepEqual(reports.aggregate.sideCounts, { BUY: 0, SELL: 11 });
  assert.equal(reports.sourceFrameCoverage.uniqueCompositeSourceFrameGroupCount, 3);
  assert.equal(reports.sourceFrameCoverage.effectiveIndependentSampleCount, null);
  assert.ok(reports.empiricalGaps.includes('ACCEPTANCE_RATE_VARIABILITY_OBSERVED'));
  assert.ok(reports.empiricalGaps.includes('SINGLE_AGGRESSIVE_SIDE_ACROSS_ACCEPTED_CAPTURES'));
  assert.ok(reports.empiricalGaps.includes('WITHIN_CAPTURE_SOURCE_FRAME_CLUSTERING_OBSERVED'));
  assert.equal(reports.authority.thresholdOrWindowRelaxationAuthorized, false);
});

test('surfaces cross-capture duplicate observation identities without converting them to sample credit', () => {
  const report = analyzePublicForwardLiquidityCrossCaptureStability([
    capture({
      raw: '1',
      normalized: '4',
      observations: [observation('shared-id', { frame: '1' })],
    }),
    capture({
      raw: '2',
      normalized: '5',
      observations: [observation('shared-id', { frame: '4', timestamp: 2_000 })],
    }),
  ]);

  assert.equal(report.aggregate.crossCaptureDuplicateObservationIdCount, 1);
  assert.deepEqual(report.aggregate.crossCaptureDuplicateObservationIds, ['shared-id']);
  assert.ok(report.empiricalGaps.includes('CROSS_CAPTURE_DUPLICATE_OBSERVATION_IDS_OBSERVED'));
  assert.equal(report.sourceFrameCoverage.effectiveIndependentSampleCount, null);
  assert.equal(report.authority.sampleSufficiencyCredit, false);
});

test('surfaces repeated raw source-frame groups across different captures without independence claims', () => {
  const report = analyzePublicForwardLiquidityCrossCaptureStability([
    capture({
      raw: '1',
      normalized: '4',
      observations: [observation('a-1', { frame: '1' })],
    }),
    capture({
      raw: '2',
      normalized: '5',
      observations: [observation('b-1', { frame: '1', timestamp: 2_000 })],
    }),
  ]);

  assert.equal(report.sourceFrameCoverage.uniqueCompositeSourceFrameGroupCount, 1);
  assert.equal(report.sourceFrameCoverage.repeatedAcrossCapturesGroupCount, 1);
  assert.equal(report.sourceFrameCoverage.repeatedAcrossCapturesGroups[0].captureCount, 2);
  assert.ok(report.empiricalGaps.includes('CROSS_CAPTURE_SOURCE_FRAME_REUSE_OBSERVED'));
  assert.equal(report.safety.sourceFrameIndependenceProven, false);
});

test('rejects duplicate raw capture identity so the same immutable batch cannot inflate capture count', () => {
  const first = capture({ raw: '1', normalized: '4' });
  const second = capture({ raw: '1', normalized: '5' });
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([first, second]),
    /CROSS_CAPTURE_DUPLICATE_RAW_DIGEST/u,
  );
});

test('fails closed on private provenance, missing canonical endpoints, mutated safety, and count mismatch', () => {
  const privateCapture = capture({ raw: '1', normalized: '4' });
  privateCapture.datasetProvenance.rawSource.privateApiUsed = true;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      privateCapture,
      capture({ raw: '2', normalized: '5' }),
    ]),
    /CROSS_CAPTURE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const missingEndpoint = capture({ raw: '1', normalized: '4' });
  missingEndpoint.datasetProvenance.rawSource.endpoints = ['/api/v3/market/orderbook'];
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      missingEndpoint,
      capture({ raw: '2', normalized: '5' }),
    ]),
    /CROSS_CAPTURE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const unsafe = capture({ raw: '1', normalized: '4' });
  unsafe.safety.liveTradingAllowed = true;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      unsafe,
      capture({ raw: '2', normalized: '5' }),
    ]),
    /CROSS_CAPTURE_SOURCE_SAFETY_INVALID/u,
  );

  const mismatch = capture({
    raw: '1',
    normalized: '4',
    observations: [observation('a-1')],
  });
  mismatch.datasetProvenance.eventCount = 2;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      mismatch,
      capture({ raw: '2', normalized: '5' }),
    ]),
    /CROSS_CAPTURE_EVENT_COUNT_MISMATCH/u,
  );
});

test('requires at least two distinct captures', () => {
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      capture({ raw: '1', normalized: '4' }),
    ]),
    /CROSS_CAPTURE_AT_LEAST_TWO_CAPTURES_REQUIRED/u,
  );
});

test('safety contract grants no stability, sufficiency, cost, Natural, Settlement, Promotion, Champion, or trading credit', () => {
  const safety = PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY;
  assert.equal(safety.diagnosticOnly, true);
  assert.equal(safety.stabilityPolicyAvailable, false);
  assert.equal(safety.stabilityProven, false);
  assert.equal(safety.representativenessProven, false);
  assert.equal(safety.sourceFrameIndependenceProven, false);
  assert.equal(safety.effectiveIndependentSampleCountCredit, false);
  assert.equal(safety.sampleSufficiencyCredit, false);
  assert.equal(safety.calibrationCredit, false);
  assert.equal(safety.oosCredit, false);
  assert.equal(safety.fullCostCredit, false);
  assert.equal(safety.FULL_COST_READY, false);
  assert.equal(safety.naturalEntryCredit, 0);
  assert.equal(safety.settlementCredit, 0);
  assert.equal(safety.promotionCredit, false);
  assert.equal(safety.championCredit, false);
  assert.equal(safety.tuningAuthorized, false);
  assert.equal(safety.thresholdChangeAuthorized, false);
  assert.equal(safety.eventWindowChangeAuthorized, false);
  assert.equal(safety.executionAuthority, 'NONE');
  assert.equal(safety.privateTradingApiAllowed, false);
  assert.equal(safety.liveTradingAllowed, false);
  assert.equal(safety.realOrderAllowed, false);
});
