import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  mergeLiquidityCalibrationBatch,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  analyzePublicForwardLiquidityDropQuality,
  PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY,
} from '../src/public-forward-liquidity-drop-diagnostics.mjs';

const COLLECTOR_SHA = '1'.repeat(40);

function reasonCounts(reasons) {
  const counts = new Map();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function observation(id, missingDataFlags = []) {
  return {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    observationId: `liquidity-observation:${id}`,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    collectorCodeSha: COLLECTOR_SHA,
    sourceDigest: id.padEnd(64, 'a').slice(0, 64),
    eventTimestampMs: 1_700_000_000_000 + id.length,
    missingDataFlags,
    causalMarketImpactClaim: false,
    executionCostEligible: false,
  };
}

function batch({ observations = [], reasons = [] } = {}) {
  return {
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-batch',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    observations,
    droppedEvents: reasons.map((reason, index) => ({
      publicExecutionId: `drop-${index}`,
      eventTimestampMs: 1_700_000_100_000 + index,
      reason,
    })),
    datasetProvenance: {
      rawSource: {
        provider: 'BITGET_PUBLIC_UTA_V3',
        endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
        privateApiUsed: false,
      },
      collectionPeriod: {
        startedAtMs: 1_700_000_000_000,
        completedAtMs: 1_700_000_200_000,
      },
      eventCount: observations.length,
      droppedCount: reasons.length,
      droppedReasons: reasonCounts(reasons),
      rawDigest: '2'.repeat(64),
      normalizedDigest: '3'.repeat(64),
      collectorCodeSha: COLLECTOR_SHA,
    },
    safety: {
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      liveTradingAllowed: false,
      realOrderAllowed: false,
    },
  };
}

function persistedDataset(sourceBatch) {
  return mergeLiquidityCalibrationBatch(null, sourceBatch).dataset;
}

test('explains accepted and dropped public-forward quality without tuning authority', () => {
  const report = analyzePublicForwardLiquidityDropQuality(batch({
    observations: [
      observation('one', ['POST_EVENT_PUBLIC_OBSERVATION_MISSING']),
      observation('two', [
        'VISIBLE_DEPTH_INSUFFICIENT_FOR_FLOW_QUANTITY',
        'POST_EVENT_PUBLIC_OBSERVATION_MISSING',
        'POST_EVENT_PUBLIC_OBSERVATION_MISSING',
      ]),
    ],
    reasons: [
      'EVENT_NOT_AFTER_PRE_EVENT_BOOK',
      'EVENT_NOT_AFTER_PRE_EVENT_BOOK',
      'AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO',
      'SOURCE_REASON_NEW',
    ],
  }));

  assert.equal(report.totalEvents, 6);
  assert.equal(report.acceptedEvents, 2);
  assert.equal(report.droppedEvents, 4);
  assert.equal(report.acceptanceRate, 2 / 6);
  assert.equal(report.dropRate, 4 / 6);
  assert.deepEqual(
    report.droppedReasons.map(({ reason, count }) => [reason, count]),
    [
      ['AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO', 1],
      ['EVENT_NOT_AFTER_PRE_EVENT_BOOK', 2],
      ['SOURCE_REASON_NEW', 1],
    ],
  );
  assert.deepEqual(report.dominantDropReason, {
    reason: 'EVENT_NOT_AFTER_PRE_EVENT_BOOK',
    count: 2,
    category: 'CHRONOLOGY_TIMING',
    shareOfDropped: 0.5,
    investigationTarget:
      'INSPECT_PUBLIC_ACQUISITION_ORDERING_CLOCK_ALIGNMENT_AND_EVENT_TIMESTAMPS_WITHOUT_RELAXING_GATES',
    tuningAuthority: false,
  });
  assert.equal(
    report.droppedReasons.find(({ reason }) => reason === 'SOURCE_REASON_NEW')?.category,
    'UNCLASSIFIED_SOURCE_REASON',
  );
  assert.deepEqual(
    report.acceptedMissingDataFlags.map(({ flag, count }) => [flag, count]),
    [
      ['POST_EVENT_PUBLIC_OBSERVATION_MISSING', 2],
      ['VISIBLE_DEPTH_INSUFFICIENT_FOR_FLOW_QUANTITY', 1],
    ],
  );
  assert.equal(report.perEventDropDetailAvailable, true);
  assert.equal(report.interpretation.causalClaimAuthorized, false);
  assert.equal(report.interpretation.thresholdOrWindowRelaxationAuthorized, false);
});

test('diagnoses a verified persisted dataset from aggregate drop provenance', () => {
  const dataset = persistedDataset(batch({
    observations: [observation('persisted')],
    reasons: [
      'AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO',
      'AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO',
    ],
  }));
  const report = analyzePublicForwardLiquidityDropQuality(dataset);

  assert.equal(report.sourceKind, 'public-forward-liquidity-calibration-dataset');
  assert.equal(report.acceptedEvents, 1);
  assert.equal(report.droppedEvents, 2);
  assert.equal(report.perEventDropDetailAvailable, false);
  assert.equal(report.dominantDropReason?.category, 'SIDE_VERIFICATION');
});

test('rejects a batch when dropped-event reasons disagree with provenance', () => {
  const source = batch({
    observations: [observation('mismatch')],
    reasons: ['EVENT_NOT_AFTER_PRE_EVENT_BOOK'],
  });
  source.datasetProvenance.droppedReasons = { AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO: 1 };

  assert.throws(
    () => analyzePublicForwardLiquidityDropQuality(source),
    /DROP_DIAGNOSTIC_DROP_REASON_COUNTS_MISMATCH/u,
  );
});

test('rejects aggregate dropped counts that do not reconcile', () => {
  const source = batch({ reasons: ['EVENT_NOT_AFTER_PRE_EVENT_BOOK'] });
  source.datasetProvenance.droppedCount = 2;

  assert.throws(
    () => analyzePublicForwardLiquidityDropQuality(source),
    /DROP_DIAGNOSTIC_DROP_REASON_SUM_MISMATCH/u,
  );
});

test('rejects private or non-canonical source provenance', () => {
  const privateSource = batch({ reasons: ['EVENT_NOT_AFTER_PRE_EVENT_BOOK'] });
  privateSource.datasetProvenance.rawSource.privateApiUsed = true;
  assert.throws(
    () => analyzePublicForwardLiquidityDropQuality(privateSource),
    /DROP_DIAGNOSTIC_PUBLIC_PROVENANCE_REQUIRED/u,
  );

  const missingOrderbook = batch({ reasons: ['EVENT_NOT_AFTER_PRE_EVENT_BOOK'] });
  missingOrderbook.datasetProvenance.rawSource.endpoints = ['/api/v3/market/fills'];
  assert.throws(
    () => analyzePublicForwardLiquidityDropQuality(missingOrderbook),
    /DROP_DIAGNOSTIC_PUBLIC_PROVENANCE_REQUIRED/u,
  );

  const missingFills = batch({ reasons: ['EVENT_NOT_AFTER_PRE_EVENT_BOOK'] });
  missingFills.datasetProvenance.rawSource.endpoints = ['/api/v3/market/orderbook'];
  assert.throws(
    () => analyzePublicForwardLiquidityDropQuality(missingFills),
    /DROP_DIAGNOSTIC_PUBLIC_PROVENANCE_REQUIRED/u,
  );
});

test('rejects a non-canonical source schema version', () => {
  const source = batch({ reasons: ['EVENT_NOT_AFTER_PRE_EVENT_BOOK'] });
  source.schemaVersion = 2;
  assert.throws(
    () => analyzePublicForwardLiquidityDropQuality(source),
    /DROP_DIAGNOSTIC_SOURCE_SCHEMA_INVALID/u,
  );
});

test('safety contract grants no sample, cost, Natural, Settlement, or trading credit', () => {
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.diagnosticOnly, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.tuningAuthorized, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.thresholdChangeAuthorized, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.eventWindowChangeAuthorized, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.sampleCreditDelta, 0);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.fullCostCredit, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.FULL_COST_READY, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.naturalEntryCredit, 0);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.settlementCredit, 0);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.privateTradingApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.liveTradingAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY.realOrderAllowed, false);
});
