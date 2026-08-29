import {
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  verifyLiquidityCalibrationDataset,
} from './public-forward-liquidity-calibration.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_SAMPLE_COVERAGE_DIAGNOSTICS_VERSION =
  'public-forward-liquidity-sample-coverage-diagnostics/v1';

export const PUBLIC_FORWARD_LIQUIDITY_SAMPLE_COVERAGE_SAFETY = Object.freeze({
  coverageDiagnosticOnly: true,
  populationBaselineAvailable: false,
  representativenessProven: false,
  sourceFrameIndependenceProven: false,
  effectiveIndependentSampleCountCredit: false,
  sampleSufficiencyCredit: false,
  calibrationCredit: false,
  oosCredit: false,
  fullCostCredit: false,
  FULL_COST_READY: false,
  naturalEntryCredit: 0,
  settlementCredit: 0,
  promotionCredit: false,
  championCredit: false,
  tuningAuthorized: false,
  thresholdChangeAuthorized: false,
  eventWindowChangeAuthorized: false,
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  liveTradingAllowed: false,
  realOrderAllowed: false,
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonNegativeInteger(value, code) {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
  return value;
}

function positiveFinite(value, code) {
  const parsed = Number(value);
  if (!(Number.isFinite(parsed) && parsed > 0)) throw new Error(code);
  return parsed;
}

function nonNegativeFinite(value, code) {
  const parsed = Number(value);
  if (!(Number.isFinite(parsed) && parsed >= 0)) throw new Error(code);
  return parsed;
}

function positiveTimestamp(value, code) {
  const parsed = positiveFinite(value, code);
  if (!Number.isInteger(parsed)) throw new Error(code);
  return parsed;
}

function exactSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function sortedCounts(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)))));
}

function numericSortedCounts(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([value, count]) => Object.freeze({ value, count })));
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const index = Math.floor((sortedValues.length - 1) * q);
  return sortedValues[index];
}

function distribution(values) {
  if (!values.length) {
    return Object.freeze({ count: 0, min: null, p50: null, p90: null, max: null });
  }
  const sorted = [...values].sort((left, right) => left - right);
  return Object.freeze({
    count: sorted.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  });
}

function validateSourceSafety(source) {
  const safety = object(source?.safety);
  if (
    safety?.executionAuthority !== 'NONE'
    || safety?.privateTradingApiAllowed !== false
    || safety?.liveTradingAllowed !== false
    || safety?.realOrderAllowed !== false
  ) throw new Error('COVERAGE_SOURCE_SAFETY_INVALID');
}

function validatePublicProvenance(provenance) {
  const root = object(provenance);
  const rawSource = object(root?.rawSource);
  if (
    rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || rawSource?.privateApiUsed !== false
    || !Array.isArray(rawSource?.endpoints)
    || !rawSource.endpoints.includes('/api/v3/market/orderbook')
    || !rawSource.endpoints.includes('/api/v3/market/fills')
  ) throw new Error('COVERAGE_PUBLIC_PROVENANCE_INVALID');

  nonNegativeInteger(root.eventCount, 'COVERAGE_EVENT_COUNT_INVALID');
  nonNegativeInteger(root.droppedCount, 'COVERAGE_DROPPED_COUNT_INVALID');
  exactSha(root.collectorCodeSha, 'COVERAGE_COLLECTOR_SHA_INVALID');
  exactDigest(root.rawDigest, 'COVERAGE_RAW_DIGEST_INVALID');
  exactDigest(root.normalizedDigest, 'COVERAGE_NORMALIZED_DIGEST_INVALID');
  return root;
}

function normalizedInput(payload) {
  const root = object(payload);
  if (!root || root.schemaVersion !== 1 || root.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT) {
    throw new Error('COVERAGE_INPUT_CONTRACT_INVALID');
  }
  validateSourceSafety(root);

  if (root.kind === 'public-forward-liquidity-calibration-dataset') {
    const verification = verifyLiquidityCalibrationDataset(root);
    if (!verification.valid) throw new Error(`COVERAGE_DATASET_INVALID:${verification.reason}`);
    const provenance = validatePublicProvenance(root.datasetProvenance);
    if (!Array.isArray(root.observations) || provenance.eventCount !== root.observations.length) {
      throw new Error('COVERAGE_EVENT_COUNT_MISMATCH');
    }
    return Object.freeze({ inputKind: 'DATASET', observations: root.observations, provenance });
  }

  if (root.kind === 'public-forward-liquidity-calibration-batch') {
    if (root.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true || !Array.isArray(root.observations)) {
      throw new Error('COVERAGE_BATCH_INVALID');
    }
    const provenance = validatePublicProvenance(root.datasetProvenance);
    if (provenance.eventCount !== root.observations.length) throw new Error('COVERAGE_EVENT_COUNT_MISMATCH');
    return Object.freeze({ inputKind: 'BATCH', observations: root.observations, provenance });
  }

  throw new Error('COVERAGE_INPUT_KIND_INVALID');
}

function sourceFrameIdentity(observation) {
  const provenance = object(observation?.rawSourceProvenance);
  const preEventBook = object(provenance?.preEventBook);
  const publicTrade = object(provenance?.publicTrade);
  const postEventBooks = provenance?.postEventBooks;
  if (!preEventBook || !publicTrade || !Array.isArray(postEventBooks)) {
    throw new Error('COVERAGE_SOURCE_FRAME_PROVENANCE_INVALID');
  }
  const preEventBookDigest = exactDigest(
    preEventBook.rawPayloadDigest,
    'COVERAGE_PRE_EVENT_BOOK_RAW_DIGEST_INVALID',
  );
  const publicTradeFrameDigest = exactDigest(
    publicTrade.rawFrameDigest,
    'COVERAGE_PUBLIC_TRADE_FRAME_DIGEST_INVALID',
  );
  const postEventBookDigests = postEventBooks.map((entry) => exactDigest(
    object(entry)?.rawPayloadDigest,
    'COVERAGE_POST_EVENT_BOOK_RAW_DIGEST_INVALID',
  ));
  return Object.freeze({
    preEventBookDigest,
    publicTradeFrameDigest,
    compositeSourceFrameGroup: `${preEventBookDigest}|${publicTradeFrameDigest}|${postEventBookDigests.join(',')}`,
  });
}

function validateObservation(observation, expectedCollectorSha, seenIds) {
  const item = object(observation);
  if (!item || item.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT) {
    throw new Error('COVERAGE_OBSERVATION_CONTRACT_INVALID');
  }
  const observationId = String(item.observationId ?? '').trim();
  if (!observationId) throw new Error('COVERAGE_OBSERVATION_ID_MISSING');
  if (seenIds.has(observationId)) throw new Error('COVERAGE_DUPLICATE_OBSERVATION_ID');
  seenIds.add(observationId);

  if (item.publicDataSource !== 'BITGET_PUBLIC_UTA_V3') throw new Error('COVERAGE_OBSERVATION_SOURCE_INVALID');
  if (exactSha(item.collectorCodeSha, 'COVERAGE_OBSERVATION_COLLECTOR_SHA_INVALID') !== expectedCollectorSha) {
    throw new Error('COVERAGE_OBSERVATION_COLLECTOR_SHA_MISMATCH');
  }
  if (!['BUY', 'SELL'].includes(item.aggressiveSide)) throw new Error('COVERAGE_AGGRESSIVE_SIDE_INVALID');

  const eventTimestampMs = positiveTimestamp(item.eventTimestampMs, 'COVERAGE_EVENT_TIMESTAMP_INVALID');
  const receiveTimestampMs = positiveTimestamp(item.receiveTimestampMs, 'COVERAGE_RECEIVE_TIMESTAMP_INVALID');
  if (receiveTimestampMs < eventTimestampMs) throw new Error('COVERAGE_RECEIVE_BEFORE_EVENT');

  const quantity = positiveFinite(item.tradeFlowQuantity, 'COVERAGE_QUANTITY_INVALID');
  const notional = positiveFinite(item.tradeFlowNotional, 'COVERAGE_NOTIONAL_INVALID');
  const spreadBps = positiveFinite(item.preEventSpreadBps, 'COVERAGE_SPREAD_BPS_INVALID');

  if (!Array.isArray(item.missingDataFlags)) throw new Error('COVERAGE_MISSING_FLAGS_INVALID');
  const missingDataFlags = item.missingDataFlags.map((flag) => String(flag ?? '').trim());
  if (missingDataFlags.some((flag) => !flag)) throw new Error('COVERAGE_MISSING_FLAG_EMPTY');
  if (new Set(missingDataFlags).size !== missingDataFlags.length) throw new Error('COVERAGE_DUPLICATE_MISSING_FLAG');

  if (!Array.isArray(item.subsequentPublicPriceDrift)) throw new Error('COVERAGE_POST_EVENT_DRIFT_INVALID');
  const horizons = item.subsequentPublicPriceDrift.map((entry) => nonNegativeFinite(
    entry?.horizonMs,
    'COVERAGE_POST_EVENT_HORIZON_INVALID',
  ));
  const sourceFrame = sourceFrameIdentity(item);

  return Object.freeze({
    observationId,
    market: String(item.market ?? '').trim(),
    symbol: String(item.symbol ?? '').trim(),
    aggressiveSide: item.aggressiveSide,
    eventTimestampMs,
    quantity,
    notional,
    spreadBps,
    missingDataFlags: Object.freeze([...missingDataFlags].sort()),
    horizons: Object.freeze([...horizons].sort((left, right) => left - right)),
    sourceFrame,
  });
}

function gapAssessment({
  acceptedSampleCount,
  uniqueTimestampCount,
  sideCounts,
  horizonCount,
  missingFlagObservationCount,
  largestSourceFrameGroupSize,
}) {
  const gaps = [];
  if (acceptedSampleCount === 0) gaps.push('NO_ACCEPTED_OBSERVATIONS');
  if (acceptedSampleCount > 0 && (sideCounts.BUY === 0 || sideCounts.SELL === 0)) gaps.push('SINGLE_AGGRESSIVE_SIDE_OBSERVED');
  if (acceptedSampleCount > 1 && uniqueTimestampCount <= 1) gaps.push('SINGLE_EVENT_TIMESTAMP_ONLY');
  if (acceptedSampleCount > 0 && horizonCount === 0) gaps.push('NO_POST_EVENT_HORIZON_OBSERVED');
  if (missingFlagObservationCount > 0) gaps.push('ACCEPTED_MISSING_DATA_FLAGS_PRESENT');
  if (largestSourceFrameGroupSize > 1) gaps.push('SOURCE_FRAME_CLUSTERING_OBSERVED');
  return Object.freeze(gaps.sort());
}

function investigationTargets(gaps) {
  const targets = [];
  if (gaps.includes('NO_ACCEPTED_OBSERVATIONS')) {
    targets.push('INSPECT_EXISTING_DROP_DIAGNOSTICS_AND_PUBLIC_SOURCE_TIMING_WITHOUT_RELAXING_GATES');
  }
  if (gaps.includes('SINGLE_AGGRESSIVE_SIDE_OBSERVED')) {
    targets.push('INSPECT_EMPIRICAL_SIDE_COVERAGE_OVER_ADDITIONAL_GENUINE_FORWARD_OBSERVATIONS');
  }
  if (gaps.includes('SINGLE_EVENT_TIMESTAMP_ONLY')) {
    targets.push('INSPECT_TEMPORAL_COVERAGE_OVER_ADDITIONAL_GENUINE_FORWARD_OBSERVATIONS');
  }
  if (gaps.includes('NO_POST_EVENT_HORIZON_OBSERVED')) {
    targets.push('INSPECT_POST_EVENT_PUBLIC_BOOK_OBSERVATION_AVAILABILITY_WITHOUT_CHANGING_EVENT_WINDOWS');
  }
  if (gaps.includes('ACCEPTED_MISSING_DATA_FLAGS_PRESENT')) {
    targets.push('INSPECT_EXACT_ACCEPTED_SAMPLE_MISSING_DATA_FLAGS_WITHOUT_GRANTING_COST_OR_CALIBRATION_CREDIT');
  }
  if (gaps.includes('SOURCE_FRAME_CLUSTERING_OBSERVED')) {
    targets.push('INSPECT_SOURCE_FRAME_CLUSTERING_OVER_ADDITIONAL_GENUINE_FORWARD_CAPTURES_WITHOUT_TREATING_GROUP_COUNT_AS_INDEPENDENT_N');
  }
  return Object.freeze(targets.sort());
}

export function analyzePublicForwardLiquiditySampleCoverage(payload) {
  const { inputKind, observations, provenance } = normalizedInput(payload);
  const expectedCollectorSha = exactSha(provenance.collectorCodeSha, 'COVERAGE_COLLECTOR_SHA_INVALID');
  const seenIds = new Set();
  const normalized = observations.map((observation) => validateObservation(observation, expectedCollectorSha, seenIds));

  const eventTimestamps = normalized.map((item) => item.eventTimestampMs).sort((left, right) => left - right);
  const eventGaps = [];
  for (let index = 1; index < eventTimestamps.length; index += 1) {
    eventGaps.push(eventTimestamps[index] - eventTimestamps[index - 1]);
  }

  const sideCounts = Object.freeze({
    BUY: normalized.filter((item) => item.aggressiveSide === 'BUY').length,
    SELL: normalized.filter((item) => item.aggressiveSide === 'SELL').length,
  });
  const quantities = normalized.map((item) => item.quantity);
  const notionals = normalized.map((item) => item.notional);
  const spreads = normalized.map((item) => item.spreadBps);
  const horizons = normalized.flatMap((item) => item.horizons);
  const missingFlags = normalized.flatMap((item) => item.missingDataFlags);
  const observationsWithMissingFlags = normalized.filter((item) => item.missingDataFlags.length > 0).length;
  const uniqueTimestampCount = new Set(eventTimestamps).size;
  const sourceFrameGroupCounts = Object.values(sortedCounts(
    normalized.map((item) => item.sourceFrame.compositeSourceFrameGroup),
  ));
  const largestSourceFrameGroupSize = sourceFrameGroupCounts.length
    ? Math.max(...sourceFrameGroupCounts)
    : 0;
  const observationsInClusteredSourceFrameGroups = sourceFrameGroupCounts
    .filter((count) => count > 1)
    .reduce((total, count) => total + count, 0);
  const gaps = gapAssessment({
    acceptedSampleCount: normalized.length,
    uniqueTimestampCount,
    sideCounts,
    horizonCount: horizons.length,
    missingFlagObservationCount: observationsWithMissingFlags,
    largestSourceFrameGroupSize,
  });

  return Object.freeze({
    schemaVersion: 1,
    kind: 'public-forward-liquidity-sample-coverage-diagnostic',
    version: PUBLIC_FORWARD_LIQUIDITY_SAMPLE_COVERAGE_DIAGNOSTICS_VERSION,
    inputKind,
    acceptedSampleCount: normalized.length,
    droppedSampleCountObservedInSource: provenance.droppedCount,
    identityCoverage: Object.freeze({
      uniqueObservationIdCount: seenIds.size,
      uniqueEventTimestampCount: uniqueTimestampCount,
    }),
    temporalCoverage: Object.freeze({
      firstEventTimestampMs: eventTimestamps[0] ?? null,
      lastEventTimestampMs: eventTimestamps.at(-1) ?? null,
      observedSpanMs: eventTimestamps.length ? eventTimestamps.at(-1) - eventTimestamps[0] : null,
      interEventGapMs: distribution(eventGaps),
    }),
    sideCoverage: Object.freeze({
      counts: sideCounts,
      shares: Object.freeze({
        BUY: normalized.length ? sideCounts.BUY / normalized.length : null,
        SELL: normalized.length ? sideCounts.SELL / normalized.length : null,
      }),
    }),
    marketCoverage: sortedCounts(normalized.map((item) => item.market)),
    symbolCoverage: sortedCounts(normalized.map((item) => item.symbol)),
    quantityCoverage: distribution(quantities),
    notionalCoverage: distribution(notionals),
    preEventSpreadBpsCoverage: distribution(spreads),
    postEventHorizonCoverage: Object.freeze({
      totalHorizonObservations: horizons.length,
      exactHorizonMsCounts: numericSortedCounts(horizons),
      observationsWithPostEventDrift: normalized.filter((item) => item.horizons.length > 0).length,
      observationsWithoutPostEventDrift: normalized.filter((item) => item.horizons.length === 0).length,
    }),
    sourceFrameCoverage: Object.freeze({
      uniquePreEventBookFrameCount: new Set(normalized.map((item) => item.sourceFrame.preEventBookDigest)).size,
      uniquePublicTradeFrameCount: new Set(normalized.map((item) => item.sourceFrame.publicTradeFrameDigest)).size,
      uniqueCompositeSourceFrameGroupCount: sourceFrameGroupCounts.length,
      compositeSourceFrameGroupSize: distribution(sourceFrameGroupCounts),
      observationsInClusteredSourceFrameGroups,
      shareOfAcceptedInClusteredSourceFrameGroups: normalized.length
        ? observationsInClusteredSourceFrameGroups / normalized.length
        : null,
      sourceFrameIndependenceProven: false,
      effectiveIndependentSampleCount: null,
    }),
    acceptedMissingDataCoverage: Object.freeze({
      observationsWithMissingDataFlags: observationsWithMissingFlags,
      observationsWithoutMissingDataFlags: normalized.length - observationsWithMissingFlags,
      flagCounts: sortedCounts(missingFlags),
    }),
    empiricalCoverageGaps: gaps,
    investigationTargets: investigationTargets(gaps),
    representativeness: Object.freeze({
      populationBaselineAvailable: false,
      representativenessProven: false,
      reason: 'EXTERNAL_POPULATION_BASELINE_NOT_PROVIDED',
    }),
    authority: Object.freeze({
      diagnosticOnly: true,
      sourceFrameIndependenceProven: false,
      effectiveIndependentSampleCountCredit: false,
      sampleSufficiencyCredit: false,
      calibrationCredit: false,
      oosCredit: false,
      fullCostCredit: false,
      naturalEntryCredit: 0,
      settlementCredit: 0,
      thresholdOrWindowRelaxationAuthorized: false,
      nextActionType: 'COLLECT_OR_INSPECT_GENUINE_FORWARD_EVIDENCE_ONLY',
    }),
    safety: PUBLIC_FORWARD_LIQUIDITY_SAMPLE_COVERAGE_SAFETY,
  });
}
