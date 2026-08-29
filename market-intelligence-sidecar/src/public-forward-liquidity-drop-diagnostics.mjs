import {
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  verifyLiquidityCalibrationDataset,
} from './public-forward-liquidity-calibration.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_VERSION =
  'public-forward-liquidity-drop-diagnostics/v1';

export const PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY = Object.freeze({
  diagnosticOnly: true,
  tuningAuthorized: false,
  thresholdChangeAuthorized: false,
  eventWindowChangeAuthorized: false,
  sampleCreditDelta: 0,
  fullCostCredit: false,
  FULL_COST_READY: false,
  naturalEntryCredit: 0,
  settlementCredit: 0,
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  liveTradingAllowed: false,
  realOrderAllowed: false,
});

const DROP_CATEGORY_BY_REASON = new Map([
  ['EVENT_NOT_AFTER_PRE_EVENT_BOOK', 'CHRONOLOGY_TIMING'],
  ['PRE_EVENT_BOOK_STALE_FOR_EVENT', 'CHRONOLOGY_TIMING'],
  ['EVENT_TIMESTAMP_AFTER_LOCAL_RECEIVE', 'CHRONOLOGY_TIMING'],
  ['POST_EVENT_CHRONOLOGY_INVALID', 'CHRONOLOGY_TIMING'],
  ['AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO', 'SIDE_VERIFICATION'],
  ['DUPLICATE_OBSERVATION_ID', 'IDENTITY_DEDUP'],
]);

const INVESTIGATION_TARGET_BY_CATEGORY = Object.freeze({
  CHRONOLOGY_TIMING:
    'INSPECT_PUBLIC_ACQUISITION_ORDERING_CLOCK_ALIGNMENT_AND_EVENT_TIMESTAMPS_WITHOUT_RELAXING_GATES',
  SIDE_VERIFICATION:
    'INSPECT_PUBLIC_TRADE_SIDE_AND_PRE_EVENT_BBO_TOUCH_VERIFICATION_WITHOUT_RELAXING_GATES',
  IDENTITY_DEDUP:
    'INSPECT_OBSERVATION_IDENTITY_AND_SOURCE_DEDUPLICATION_WITHOUT_GRANTING_DUPLICATE_CREDIT',
  UNCLASSIFIED_SOURCE_REASON:
    'INSPECT_EXACT_SOURCE_REASON_WITHOUT_POLICY_OR_THRESHOLD_RELAXATION',
});

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

function sourceContract(value) {
  if (value !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT) {
    throw new Error('DROP_DIAGNOSTIC_SOURCE_CONTRACT_INVALID');
  }
  return value;
}

function exactReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > 240) throw new Error('DROP_DIAGNOSTIC_REASON_INVALID');
  return reason;
}

function ratio(count, denominator) {
  return denominator > 0 ? count / denominator : 0;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function validatePublicProvenance(source, provenance) {
  const rawSource = object(provenance.rawSource);
  if (
    rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || rawSource?.privateApiUsed !== false
    || source?.safety?.executionAuthority !== 'NONE'
    || source?.safety?.privateTradingApiAllowed !== false
    || source?.safety?.liveTradingAllowed !== false
    || source?.safety?.realOrderAllowed !== false
  ) {
    throw new Error('DROP_DIAGNOSTIC_PUBLIC_PROVENANCE_REQUIRED');
  }
  exactSha(provenance.collectorCodeSha, 'DROP_DIAGNOSTIC_COLLECTOR_SHA_INVALID');
  exactDigest(provenance.rawDigest, 'DROP_DIAGNOSTIC_RAW_DIGEST_INVALID');
  exactDigest(provenance.normalizedDigest, 'DROP_DIAGNOSTIC_NORMALIZED_DIGEST_INVALID');
}

function normalizeReasonRecord(value) {
  const record = object(value);
  if (!record) throw new Error('DROP_DIAGNOSTIC_REASON_RECORD_INVALID');
  const normalized = new Map();
  for (const [rawReason, rawCount] of Object.entries(record)) {
    const reason = exactReason(rawReason);
    const count = nonNegativeInteger(rawCount, 'DROP_DIAGNOSTIC_REASON_COUNT_INVALID');
    if (count > 0) normalized.set(reason, count);
  }
  return normalized;
}

function reasonRecordFromDroppedEvents(droppedEvents) {
  const counts = new Map();
  for (const event of droppedEvents) {
    const reason = exactReason(object(event)?.reason);
    increment(counts, reason);
  }
  return counts;
}

function sameCountMap(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

function sumCounts(map) {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}

function categoryForReason(reason) {
  return DROP_CATEGORY_BY_REASON.get(reason) ?? 'UNCLASSIFIED_SOURCE_REASON';
}

function normalizeObservations(value) {
  if (!Array.isArray(value)) throw new Error('DROP_DIAGNOSTIC_OBSERVATIONS_REQUIRED');
  return value;
}

function aggregateMissingFlags(observations) {
  const counts = new Map();
  for (const observation of observations) {
    const flags = object(observation)?.missingDataFlags;
    if (flags == null) continue;
    if (!Array.isArray(flags)) throw new Error('DROP_DIAGNOSTIC_MISSING_FLAGS_INVALID');
    const unique = new Set();
    for (const rawFlag of flags) unique.add(exactReason(rawFlag));
    for (const flag of unique) increment(counts, flag);
  }
  return counts;
}

function normalizeSource(input) {
  const source = object(input);
  if (!source) throw new Error('DROP_DIAGNOSTIC_SOURCE_REQUIRED');
  sourceContract(source.contract);
  const observations = normalizeObservations(source.observations);
  const provenance = object(source.datasetProvenance);
  if (!provenance) throw new Error('DROP_DIAGNOSTIC_PROVENANCE_REQUIRED');
  validatePublicProvenance(source, provenance);

  const accepted = nonNegativeInteger(
    provenance.eventCount,
    'DROP_DIAGNOSTIC_ACCEPTED_COUNT_INVALID',
  );
  const dropped = nonNegativeInteger(
    provenance.droppedCount,
    'DROP_DIAGNOSTIC_DROPPED_COUNT_INVALID',
  );
  if (accepted !== observations.length) {
    throw new Error('DROP_DIAGNOSTIC_ACCEPTED_COUNT_MISMATCH');
  }

  const provenanceReasons = normalizeReasonRecord(provenance.droppedReasons ?? {});
  if (sumCounts(provenanceReasons) !== dropped) {
    throw new Error('DROP_DIAGNOSTIC_DROP_REASON_SUM_MISMATCH');
  }

  if (source.kind === 'public-forward-liquidity-calibration-batch') {
    if (source.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true) {
      throw new Error('DROP_DIAGNOSTIC_BATCH_CAPABILITY_INVALID');
    }
    if (!Array.isArray(source.droppedEvents)) {
      throw new Error('DROP_DIAGNOSTIC_DROPPED_EVENTS_REQUIRED');
    }
    if (source.droppedEvents.length !== dropped) {
      throw new Error('DROP_DIAGNOSTIC_DROPPED_COUNT_MISMATCH');
    }
    const eventReasons = reasonRecordFromDroppedEvents(source.droppedEvents);
    if (!sameCountMap(eventReasons, provenanceReasons)) {
      throw new Error('DROP_DIAGNOSTIC_DROP_REASON_COUNTS_MISMATCH');
    }
    return {
      sourceKind: source.kind,
      sampleClass: String(source.sampleClass ?? ''),
      observations,
      accepted,
      dropped,
      reasonCounts: eventReasons,
      perEventDropDetailAvailable: true,
    };
  }

  if (source.kind === 'public-forward-liquidity-calibration-dataset') {
    const verification = verifyLiquidityCalibrationDataset(source);
    if (!verification.valid) {
      throw new Error(`DROP_DIAGNOSTIC_DATASET_INVALID:${verification.reason}`);
    }
    return {
      sourceKind: source.kind,
      sampleClass: String(source.sampleClass ?? ''),
      observations,
      accepted,
      dropped,
      reasonCounts: provenanceReasons,
      perEventDropDetailAvailable: false,
    };
  }

  throw new Error('DROP_DIAGNOSTIC_SOURCE_KIND_INVALID');
}

function buildReasonRows(reasonCounts, dropped, totalEvents) {
  return [...reasonCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => {
      const category = categoryForReason(reason);
      return Object.freeze({
        reason,
        count,
        shareOfDropped: ratio(count, dropped),
        shareOfTotalEvents: ratio(count, totalEvents),
        category,
        investigationTarget: INVESTIGATION_TARGET_BY_CATEGORY[category],
        tuningAuthority: false,
      });
    });
}

function buildCategoryRows(reasonRows, dropped, totalEvents) {
  const counts = new Map();
  for (const row of reasonRows) increment(counts, row.category, row.count);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => Object.freeze({
      category,
      count,
      shareOfDropped: ratio(count, dropped),
      shareOfTotalEvents: ratio(count, totalEvents),
      investigationTarget: INVESTIGATION_TARGET_BY_CATEGORY[category],
      tuningAuthority: false,
    }));
}

function dominantReason(reasonRows) {
  if (reasonRows.length === 0) return null;
  const [winner] = [...reasonRows].sort(
    (left, right) => right.count - left.count || left.reason.localeCompare(right.reason),
  );
  return Object.freeze({
    reason: winner.reason,
    count: winner.count,
    category: winner.category,
    shareOfDropped: winner.shareOfDropped,
    investigationTarget: winner.investigationTarget,
    tuningAuthority: false,
  });
}

function buildMissingFlagRows(observations) {
  const counts = aggregateMissingFlags(observations);
  const accepted = observations.length;
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([flag, count]) => Object.freeze({
      flag,
      count,
      shareOfAccepted: ratio(count, accepted),
      evidenceCreditDelta: 0,
    }));
}

export function analyzePublicForwardLiquidityDropQuality(input) {
  const source = normalizeSource(input);
  const totalEvents = source.accepted + source.dropped;
  const reasonRows = buildReasonRows(source.reasonCounts, source.dropped, totalEvents);
  const categoryRows = buildCategoryRows(reasonRows, source.dropped, totalEvents);
  const missingFlagRows = buildMissingFlagRows(source.observations);

  return Object.freeze({
    kind: 'public-forward-liquidity-drop-diagnostics',
    diagnosticsVersion: PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_VERSION,
    sourceKind: source.sourceKind,
    sampleClass: source.sampleClass,
    totalEvents,
    acceptedEvents: source.accepted,
    droppedEvents: source.dropped,
    acceptanceRate: ratio(source.accepted, totalEvents),
    dropRate: ratio(source.dropped, totalEvents),
    droppedReasons: Object.freeze(reasonRows),
    dropCategories: Object.freeze(categoryRows),
    dominantDropReason: dominantReason(reasonRows),
    acceptedMissingDataFlags: Object.freeze(missingFlagRows),
    perEventDropDetailAvailable: source.perEventDropDetailAvailable,
    interpretation: Object.freeze({
      descriptiveOnly: true,
      causalClaimAuthorized: false,
      thresholdOrWindowRelaxationAuthorized: false,
      nextActionType: 'INVESTIGATE_SOURCE_EVIDENCE_ONLY',
    }),
    safety: PUBLIC_FORWARD_LIQUIDITY_DROP_DIAGNOSTICS_SAFETY,
  });
}
