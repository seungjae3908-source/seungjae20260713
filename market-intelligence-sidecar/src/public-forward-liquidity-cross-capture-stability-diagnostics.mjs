import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
} from './public-forward-liquidity-calibration.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_VERSION =
  'public-forward-liquidity-cross-capture-stability-diagnostics/v1';

export const PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY = Object.freeze({
  diagnosticOnly: true,
  stabilityPolicyAvailable: false,
  stabilityProven: false,
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

const CANONICAL_ENDPOINTS = Object.freeze([
  '/api/v3/market/orderbook',
  '/api/v3/market/fills',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonNegativeInteger(value, code) {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
  return value;
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

function nonEmptyString(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCountObject(map) {
  return Object.freeze(Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))),
  ));
}

function distribution(values) {
  if (!values.length) {
    return Object.freeze({
      count: 0,
      min: null,
      max: null,
      mean: null,
      range: null,
    });
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return Object.freeze({
    count: values.length,
    min,
    max,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    range: max - min,
  });
}

function validateSourceAuthority(source) {
  const safety = object(source?.safety);
  if (
    safety?.publicDataOnly !== true
    || safety?.historicalBackfillForwardCredit !== 0
    || safety?.executionAuthority !== 'NONE'
    || safety?.privateTradingApiAllowed !== false
    || safety?.liveTradingAllowed !== false
    || safety?.realOrderAllowed !== false
    || safety?.financialMutationAllowed !== false
  ) {
    throw new Error('CROSS_CAPTURE_SOURCE_SAFETY_INVALID');
  }

  const readiness = object(source?.readiness);
  if (
    readiness?.LIQUIDITY_IMPACT_PRESENT !== false
    || readiness?.CALIBRATION_SAMPLE_SUFFICIENT !== false
    || readiness?.LIQUIDITY_IMPACT_STATUS !== 'BLOCKED_DATA'
    || readiness?.FULL_COST_READY !== false
  ) {
    throw new Error('CROSS_CAPTURE_SOURCE_READINESS_INVALID');
  }
}

function validateProvenance(source) {
  const provenance = object(source?.datasetProvenance);
  const rawSource = object(provenance?.rawSource);
  if (
    rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || rawSource?.privateApiUsed !== false
    || !Array.isArray(rawSource?.endpoints)
    || CANONICAL_ENDPOINTS.some((endpoint) => !rawSource.endpoints.includes(endpoint))
  ) {
    throw new Error('CROSS_CAPTURE_PUBLIC_PROVENANCE_INVALID');
  }

  const eventCount = nonNegativeInteger(
    provenance.eventCount,
    'CROSS_CAPTURE_EVENT_COUNT_INVALID',
  );
  const droppedCount = nonNegativeInteger(
    provenance.droppedCount,
    'CROSS_CAPTURE_DROPPED_COUNT_INVALID',
  );
  const collectorCodeSha = exactSha(
    provenance.collectorCodeSha,
    'CROSS_CAPTURE_COLLECTOR_SHA_INVALID',
  );
  const rawDigest = exactDigest(
    provenance.rawDigest,
    'CROSS_CAPTURE_RAW_DIGEST_INVALID',
  );
  const normalizedDigest = exactDigest(
    provenance.normalizedDigest,
    'CROSS_CAPTURE_NORMALIZED_DIGEST_INVALID',
  );

  return Object.freeze({
    provenance,
    eventCount,
    droppedCount,
    collectorCodeSha,
    rawDigest,
    normalizedDigest,
  });
}

function normalizedDropReasons(value) {
  const record = object(value);
  if (!record) throw new Error('CROSS_CAPTURE_DROP_REASONS_INVALID');
  const counts = new Map();
  for (const [rawReason, rawCount] of Object.entries(record)) {
    const reason = nonEmptyString(rawReason, 'CROSS_CAPTURE_DROP_REASON_INVALID');
    const count = nonNegativeInteger(rawCount, 'CROSS_CAPTURE_DROP_REASON_COUNT_INVALID');
    if (count > 0) counts.set(reason, count);
  }
  return counts;
}

function dropReasonsFromEvents(events) {
  const counts = new Map();
  for (const event of events) {
    const reason = nonEmptyString(
      object(event)?.reason,
      'CROSS_CAPTURE_DROPPED_EVENT_REASON_INVALID',
    );
    increment(counts, reason);
  }
  return counts;
}

function sameCountMap(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function sumCounts(counts) {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

function sourceFrameIdentity(observation) {
  const provenance = object(observation?.rawSourceProvenance);
  const preEventBook = object(provenance?.preEventBook);
  const publicTrade = object(provenance?.publicTrade);
  const postEventBooks = provenance?.postEventBooks;
  if (!preEventBook || !publicTrade || !Array.isArray(postEventBooks)) {
    throw new Error('CROSS_CAPTURE_SOURCE_FRAME_PROVENANCE_INVALID');
  }

  const preEventBookDigest = exactDigest(
    preEventBook.rawPayloadDigest,
    'CROSS_CAPTURE_PRE_EVENT_BOOK_DIGEST_INVALID',
  );
  const publicTradeFrameDigest = exactDigest(
    publicTrade.rawFrameDigest,
    'CROSS_CAPTURE_PUBLIC_TRADE_FRAME_DIGEST_INVALID',
  );
  const postEventBookDigests = postEventBooks.map((entry) => exactDigest(
    object(entry)?.rawPayloadDigest,
    'CROSS_CAPTURE_POST_EVENT_BOOK_DIGEST_INVALID',
  ));

  return Object.freeze({
    preEventBookDigest,
    publicTradeFrameDigest,
    postEventBookDigests: Object.freeze(postEventBookDigests),
    composite:
      `${preEventBookDigest}|${publicTradeFrameDigest}|${postEventBookDigests.join(',')}`,
  });
}

function normalizeObservation(observation, expectedCollectorSha, localSeen) {
  const item = object(observation);
  if (
    !item
    || item.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || item.sampleClass !== FORWARD_NATURAL_SAMPLE
    || item.forwardCalibrationSampleCredit !== 1
    || item.historicalBackfillForwardCredit !== 0
    || item.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
  ) {
    throw new Error('CROSS_CAPTURE_OBSERVATION_CONTRACT_INVALID');
  }

  const observationId = nonEmptyString(
    item.observationId,
    'CROSS_CAPTURE_OBSERVATION_ID_MISSING',
  );
  if (localSeen.has(observationId)) {
    throw new Error('CROSS_CAPTURE_INTRA_CAPTURE_DUPLICATE_OBSERVATION_ID');
  }
  localSeen.add(observationId);

  if (
    exactSha(
      item.collectorCodeSha,
      'CROSS_CAPTURE_OBSERVATION_COLLECTOR_SHA_INVALID',
    ) !== expectedCollectorSha
  ) {
    throw new Error('CROSS_CAPTURE_OBSERVATION_COLLECTOR_SHA_MISMATCH');
  }
  exactDigest(item.sourceDigest, 'CROSS_CAPTURE_OBSERVATION_SOURCE_DIGEST_INVALID');

  if (!['BUY', 'SELL'].includes(item.aggressiveSide)) {
    throw new Error('CROSS_CAPTURE_AGGRESSIVE_SIDE_INVALID');
  }

  const eventTimestampMs = Number(item.eventTimestampMs);
  if (!Number.isInteger(eventTimestampMs) || eventTimestampMs <= 0) {
    throw new Error('CROSS_CAPTURE_EVENT_TIMESTAMP_INVALID');
  }

  return Object.freeze({
    observationId,
    aggressiveSide: item.aggressiveSide,
    eventTimestampMs,
    sourceFrame: sourceFrameIdentity(item),
  });
}

function normalizeCapture(capture, index) {
  const source = object(capture);
  if (
    !source
    || source.schemaVersion !== 1
    || source.kind !== 'public-forward-liquidity-calibration-batch'
    || source.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || source.sampleClass !== FORWARD_NATURAL_SAMPLE
    || source.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true
    || !Array.isArray(source.observations)
    || !Array.isArray(source.droppedEvents)
  ) {
    throw new Error('CROSS_CAPTURE_INPUT_CONTRACT_INVALID');
  }

  validateSourceAuthority(source);
  const provenance = validateProvenance(source);

  if (source.observations.length !== provenance.eventCount) {
    throw new Error('CROSS_CAPTURE_EVENT_COUNT_MISMATCH');
  }
  if (source.droppedEvents.length !== provenance.droppedCount) {
    throw new Error('CROSS_CAPTURE_DROPPED_COUNT_MISMATCH');
  }

  const aggregateReasons = normalizedDropReasons(
    provenance.provenance.droppedReasons ?? {},
  );
  if (sumCounts(aggregateReasons) !== provenance.droppedCount) {
    throw new Error('CROSS_CAPTURE_DROP_REASON_SUM_MISMATCH');
  }
  const eventReasons = dropReasonsFromEvents(source.droppedEvents);
  if (!sameCountMap(aggregateReasons, eventReasons)) {
    throw new Error('CROSS_CAPTURE_DROP_REASON_COUNTS_MISMATCH');
  }

  const localSeen = new Set();
  const observations = source.observations.map((observation) => normalizeObservation(
    observation,
    provenance.collectorCodeSha,
    localSeen,
  ));

  const sideCounts = Object.freeze({
    BUY: observations.filter(({ aggressiveSide }) => aggressiveSide === 'BUY').length,
    SELL: observations.filter(({ aggressiveSide }) => aggressiveSide === 'SELL').length,
  });
  const sourceFrameCounts = new Map();
  for (const observation of observations) {
    increment(sourceFrameCounts, observation.sourceFrame.composite);
  }
  const frameSizes = [...sourceFrameCounts.values()];
  const largestSourceFrameGroupSize = frameSizes.length ? Math.max(...frameSizes) : 0;
  const totalEvents = provenance.eventCount + provenance.droppedCount;

  return Object.freeze({
    captureIndex: index,
    collectorCodeSha: provenance.collectorCodeSha,
    rawDigest: provenance.rawDigest,
    normalizedDigest: provenance.normalizedDigest,
    acceptedEvents: provenance.eventCount,
    droppedEvents: provenance.droppedCount,
    totalEvents,
    acceptanceRate: ratio(provenance.eventCount, totalEvents),
    dropRate: ratio(provenance.droppedCount, totalEvents),
    sideCounts,
    uniqueObservationIdCount: localSeen.size,
    uniqueEventTimestampCount: new Set(
      observations.map(({ eventTimestampMs }) => eventTimestampMs),
    ).size,
    sourceFrameGroupCount: sourceFrameCounts.size,
    largestSourceFrameGroupSize,
    dropReasons: sortedCountObject(eventReasons),
    observations,
  });
}

function gapAssessment({
  captureCount,
  totalAccepted,
  acceptanceRateRange,
  buyAccepted,
  sellAccepted,
  maxWithinCaptureFrameGroup,
  repeatedSourceFrameGroupCount,
  crossCaptureDuplicateObservationIdCount,
}) {
  const gaps = [];
  if (captureCount < 3) gaps.push('FEWER_THAN_THREE_CAPTURES_OBSERVED');
  if (totalAccepted === 0) gaps.push('NO_ACCEPTED_OBSERVATIONS');
  if (acceptanceRateRange > 0) gaps.push('ACCEPTANCE_RATE_VARIABILITY_OBSERVED');
  if (totalAccepted > 0 && (buyAccepted === 0 || sellAccepted === 0)) {
    gaps.push('SINGLE_AGGRESSIVE_SIDE_ACROSS_ACCEPTED_CAPTURES');
  }
  if (maxWithinCaptureFrameGroup > 1) {
    gaps.push('WITHIN_CAPTURE_SOURCE_FRAME_CLUSTERING_OBSERVED');
  }
  if (repeatedSourceFrameGroupCount > 0) {
    gaps.push('CROSS_CAPTURE_SOURCE_FRAME_REUSE_OBSERVED');
  }
  if (crossCaptureDuplicateObservationIdCount > 0) {
    gaps.push('CROSS_CAPTURE_DUPLICATE_OBSERVATION_IDS_OBSERVED');
  }
  return Object.freeze(gaps.sort());
}

function investigationTargets(gaps) {
  const targets = [];
  if (gaps.includes('FEWER_THAN_THREE_CAPTURES_OBSERVED')) {
    targets.push('COLLECT_MORE_GENUINE_FORWARD_CAPTURES_WITHOUT_RELAXING_GATES');
  }
  if (gaps.includes('ACCEPTANCE_RATE_VARIABILITY_OBSERVED')) {
    targets.push('INSPECT_CAPTURE_LEVEL_MICROSTATE_VARIABILITY_WITHOUT_TUNING_THRESHOLDS');
  }
  if (gaps.includes('SINGLE_AGGRESSIVE_SIDE_ACROSS_ACCEPTED_CAPTURES')) {
    targets.push('INSPECT_EMPIRICAL_SIDE_COVERAGE_OVER_ADDITIONAL_GENUINE_CAPTURES');
  }
  if (gaps.includes('WITHIN_CAPTURE_SOURCE_FRAME_CLUSTERING_OBSERVED')) {
    targets.push('INSPECT_WITHIN_CAPTURE_FRAME_CLUSTERING_WITHOUT_TREATING_ROWS_AS_INDEPENDENT_N');
  }
  if (gaps.includes('CROSS_CAPTURE_SOURCE_FRAME_REUSE_OBSERVED')) {
    targets.push('INSPECT_REPEATED_RAW_SOURCE_FRAMES_ACROSS_CAPTURES_WITHOUT_DUPLICATE_CREDIT');
  }
  if (gaps.includes('CROSS_CAPTURE_DUPLICATE_OBSERVATION_IDS_OBSERVED')) {
    targets.push('INSPECT_CROSS_CAPTURE_OBSERVATION_ID_DUPLICATION_WITHOUT_DUPLICATE_CREDIT');
  }
  return Object.freeze(targets.sort());
}

export function analyzePublicForwardLiquidityCrossCaptureStability(input) {
  const captures = Array.isArray(input) ? input : object(input)?.captures;
  if (!Array.isArray(captures) || captures.length < 2) {
    throw new Error('CROSS_CAPTURE_AT_LEAST_TWO_CAPTURES_REQUIRED');
  }

  const normalized = captures.map((capture, index) => normalizeCapture(capture, index));
  const rawDigests = new Set();
  for (const capture of normalized) {
    if (rawDigests.has(capture.rawDigest)) {
      throw new Error('CROSS_CAPTURE_DUPLICATE_RAW_DIGEST');
    }
    rawDigests.add(capture.rawDigest);
  }

  const acceptanceRates = normalized.map(({ acceptanceRate }) => acceptanceRate ?? 0);
  const dropRates = normalized.map(({ dropRate }) => dropRate ?? 0);
  const aggregateAccepted = normalized.reduce((sum, row) => sum + row.acceptedEvents, 0);
  const aggregateDropped = normalized.reduce((sum, row) => sum + row.droppedEvents, 0);
  const aggregateTotal = aggregateAccepted + aggregateDropped;
  const aggregateSideCounts = Object.freeze({
    BUY: normalized.reduce((sum, row) => sum + row.sideCounts.BUY, 0),
    SELL: normalized.reduce((sum, row) => sum + row.sideCounts.SELL, 0),
  });

  const observationCaptureSets = new Map();
  const frameCaptureSets = new Map();
  const frameRowCounts = new Map();
  let maxWithinCaptureFrameGroup = 0;
  for (const capture of normalized) {
    maxWithinCaptureFrameGroup = Math.max(
      maxWithinCaptureFrameGroup,
      capture.largestSourceFrameGroupSize,
    );
    for (const observation of capture.observations) {
      if (!observationCaptureSets.has(observation.observationId)) {
        observationCaptureSets.set(observation.observationId, new Set());
      }
      observationCaptureSets.get(observation.observationId).add(capture.captureIndex);

      const frame = observation.sourceFrame.composite;
      if (!frameCaptureSets.has(frame)) frameCaptureSets.set(frame, new Set());
      frameCaptureSets.get(frame).add(capture.captureIndex);
      increment(frameRowCounts, frame);
    }
  }

  const duplicateObservationIds = [...observationCaptureSets.entries()]
    .filter(([, captureSet]) => captureSet.size > 1)
    .map(([observationId]) => observationId)
    .sort();
  const repeatedSourceFrameGroups = [...frameCaptureSets.entries()]
    .filter(([, captureSet]) => captureSet.size > 1)
    .map(([frame, captureSet]) => Object.freeze({
      frameDigestComposite: frame,
      captureCount: captureSet.size,
      observationRowCount: frameRowCounts.get(frame) ?? 0,
    }))
    .sort((left, right) => left.frameDigestComposite.localeCompare(right.frameDigestComposite));

  const acceptanceRateStats = distribution(acceptanceRates);
  const gaps = gapAssessment({
    captureCount: normalized.length,
    totalAccepted: aggregateAccepted,
    acceptanceRateRange: acceptanceRateStats.range ?? 0,
    buyAccepted: aggregateSideCounts.BUY,
    sellAccepted: aggregateSideCounts.SELL,
    maxWithinCaptureFrameGroup,
    repeatedSourceFrameGroupCount: repeatedSourceFrameGroups.length,
    crossCaptureDuplicateObservationIdCount: duplicateObservationIds.length,
  });

  return Object.freeze({
    schemaVersion: 1,
    kind: 'public-forward-liquidity-cross-capture-stability-diagnostic',
    version: PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_VERSION,
    captureCount: normalized.length,
    perCapture: Object.freeze(normalized.map((capture) => Object.freeze({
      captureIndex: capture.captureIndex,
      collectorCodeSha: capture.collectorCodeSha,
      rawDigest: capture.rawDigest,
      normalizedDigest: capture.normalizedDigest,
      acceptedEvents: capture.acceptedEvents,
      droppedEvents: capture.droppedEvents,
      totalEvents: capture.totalEvents,
      acceptanceRate: capture.acceptanceRate,
      dropRate: capture.dropRate,
      sideCounts: capture.sideCounts,
      uniqueObservationIdCount: capture.uniqueObservationIdCount,
      uniqueEventTimestampCount: capture.uniqueEventTimestampCount,
      sourceFrameGroupCount: capture.sourceFrameGroupCount,
      largestSourceFrameGroupSize: capture.largestSourceFrameGroupSize,
      dropReasons: capture.dropReasons,
    }))),
    aggregate: Object.freeze({
      totalEvents: aggregateTotal,
      acceptedEvents: aggregateAccepted,
      droppedEvents: aggregateDropped,
      acceptanceRate: ratio(aggregateAccepted, aggregateTotal),
      dropRate: ratio(aggregateDropped, aggregateTotal),
      sideCounts: aggregateSideCounts,
      uniqueObservationIdCount: observationCaptureSets.size,
      crossCaptureDuplicateObservationIdCount: duplicateObservationIds.length,
      crossCaptureDuplicateObservationIds: Object.freeze(duplicateObservationIds),
    }),
    captureVariability: Object.freeze({
      acceptanceRate: acceptanceRateStats,
      dropRate: distribution(dropRates),
      gradingStatus: 'NOT_GRADED_NO_PREDECLARED_POLICY',
      stabilityPolicyAvailable: false,
      stabilityProven: false,
      causalClaimAuthorized: false,
    }),
    sourceFrameCoverage: Object.freeze({
      uniqueCompositeSourceFrameGroupCount: frameCaptureSets.size,
      largestWithinCaptureSourceFrameGroupSize: maxWithinCaptureFrameGroup,
      repeatedAcrossCapturesGroupCount: repeatedSourceFrameGroups.length,
      repeatedAcrossCapturesGroups: Object.freeze(repeatedSourceFrameGroups),
      sourceFrameIndependenceProven: false,
      effectiveIndependentSampleCount: null,
    }),
    empiricalGaps: gaps,
    investigationTargets: investigationTargets(gaps),
    authority: Object.freeze({
      descriptiveOnly: true,
      thresholdOrWindowRelaxationAuthorized: false,
      sampleSufficiencyCredit: false,
      calibrationCredit: false,
      oosCredit: false,
      fullCostCredit: false,
      naturalEntryCredit: 0,
      settlementCredit: 0,
      promotionCredit: false,
      championCredit: false,
      nextActionType: 'COLLECT_OR_INSPECT_GENUINE_FORWARD_EVIDENCE_ONLY',
    }),
    safety: PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY,
  });
}
