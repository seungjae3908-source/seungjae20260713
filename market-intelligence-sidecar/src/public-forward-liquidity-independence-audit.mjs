import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  canonicalJson,
  sha256,
  verifyLiquidityCalibrationDataset,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION,
  auditPublicForwardLiquidityCalibrationSplits,
} from './public-forward-liquidity-calibration-split-audit.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_AUDIT_VERSION =
  'public-forward-liquidity-independence-audit-v1';
export const PUBLIC_FORWARD_LIQUIDITY_INDEPENDENT_PROJECTION_VERSION =
  'public-forward-liquidity-independent-projection-v1';

export const PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_SAFETY = Object.freeze({
  singleRawDatasetSsotRequired: true,
  rawAcceptedNDescriptiveOnly: true,
  crossEventDedupRequired: true,
  sourceFrameIndependenceRequired: true,
  overlappingObservationWindowCreditAllowed: false,
  effectiveIndependentSampleCreditOwnedHere: true,
  independenceFilteredBeforeSplit: true,
  splitPolicyStillExternallyFrozen: true,
  splitAssignmentOwnedByCanonicalSplitAuditor: true,
  oosValidationComplete: false,
  calibrationArtifactProduced: false,
  liquidityImpactPresent: false,
  liquidityImpactStatus: 'BLOCKED_DATA',
  fullCostReady: false,
  evidenceCompleteCredit: 0,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE',
  privateApiUsed: false,
  liveTrading: false,
  orderSubmitted: false,
});

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function text(value, code) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(code);
  return normalized;
}

function positive(value, code) {
  const normalized = Number(value);
  if (!(Number.isFinite(normalized) && normalized > 0)) throw new Error(code);
  return normalized;
}

function eventOrder(left, right) {
  return left.eventTimestampMs - right.eventTimestampMs
    || left.eventIdentity.localeCompare(right.eventIdentity)
    || left.observationId.localeCompare(right.observationId);
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const bucket = groups.get(key) ?? [];
    bucket.push(value);
    groups.set(key, bucket);
  }
  return groups;
}

function digest(value) {
  return sha256(canonicalJson(value));
}

function normalizeObservation(observation) {
  const source = object(observation, 'INDEPENDENCE_OBSERVATION_INVALID');
  if (source.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || source.sampleClass !== FORWARD_NATURAL_SAMPLE
    || source.forwardCalibrationSampleCredit !== 1
    || source.historicalBackfillForwardCredit !== 0) {
    throw new Error('INDEPENDENCE_OBSERVATION_CLASS_INVALID');
  }
  if (source.executionCostEligible !== false
    || source.liquidityImpactCoefficient !== null
    || source.causalMarketImpactClaim !== false
    || source.paperOrderSourceAllowed !== false) {
    throw new Error('INDEPENDENCE_OBSERVATION_AUTHORITY_INVALID');
  }
  const provenance = object(source.rawSourceProvenance, 'INDEPENDENCE_RAW_PROVENANCE_MISSING');
  const pre = object(provenance.preEventBook, 'INDEPENDENCE_PRE_EVENT_BOOK_MISSING');
  const trade = object(provenance.publicTrade, 'INDEPENDENCE_PUBLIC_TRADE_MISSING');
  const posts = Array.isArray(provenance.postEventBooks) ? provenance.postEventBooks : [];
  const provider = text(source.publicDataSource, 'INDEPENDENCE_PROVIDER_INVALID');
  if (provider !== 'BITGET_PUBLIC_UTA_V3') throw new Error('INDEPENDENCE_PROVIDER_INVALID');
  const market = text(source.market, 'INDEPENDENCE_MARKET_INVALID');
  const symbol = text(source.symbol, 'INDEPENDENCE_SYMBOL_INVALID').toUpperCase();
  const aggressiveSide = text(source.aggressiveSide, 'INDEPENDENCE_SIDE_INVALID').toUpperCase();
  if (!['BUY', 'SELL'].includes(aggressiveSide)) throw new Error('INDEPENDENCE_SIDE_INVALID');
  const observationId = text(source.observationId, 'INDEPENDENCE_OBSERVATION_ID_INVALID');
  const sourceDigest = text(source.sourceDigest, 'INDEPENDENCE_SOURCE_DIGEST_INVALID');
  const publicExecutionId = text(trade.publicExecutionId, 'INDEPENDENCE_PUBLIC_EXECUTION_ID_INVALID');
  const eventTimestampMs = Math.trunc(positive(source.eventTimestampMs, 'INDEPENDENCE_EVENT_TIMESTAMP_INVALID'));
  const preEventBookTimestampMs = Math.trunc(positive(pre.marketTimestampMs, 'INDEPENDENCE_PRE_EVENT_TIMESTAMP_INVALID'));
  if (preEventBookTimestampMs >= eventTimestampMs) throw new Error('INDEPENDENCE_PRE_EVENT_CHRONOLOGY_INVALID');
  const postEventTimestampsMs = posts.map((item) => Math.trunc(positive(
    item?.marketTimestampMs,
    'INDEPENDENCE_POST_EVENT_TIMESTAMP_INVALID',
  )));
  if (postEventTimestampsMs.some((value) => value < eventTimestampMs)) {
    throw new Error('INDEPENDENCE_POST_EVENT_CHRONOLOGY_INVALID');
  }
  const preEventBookDigest = text(source.preEventBookDigest, 'INDEPENDENCE_PRE_BOOK_DIGEST_INVALID');
  const rawTradeFrameDigest = text(trade.rawFrameDigest, 'INDEPENDENCE_TRADE_FRAME_DIGEST_INVALID');
  const postEventBookDigests = posts.map((item) => text(
    item?.rawPayloadDigest,
    'INDEPENDENCE_POST_BOOK_DIGEST_INVALID',
  ));
  const eventIdentity = `public-event:${digest({ provider, market, symbol, publicExecutionId })}`;
  const eventPayloadDigest = digest({
    aggressiveSide,
    eventTimestampMs,
    publicExecutionPrice: positive(source.publicExecutionPrice, 'INDEPENDENCE_PRICE_INVALID'),
    tradeFlowQuantity: positive(source.tradeFlowQuantity, 'INDEPENDENCE_QUANTITY_INVALID'),
    tradeFlowNotional: positive(source.tradeFlowNotional, 'INDEPENDENCE_NOTIONAL_INVALID'),
  });
  const sourceFrameIdentity = `source-frame:${digest({
    provider,
    market,
    symbol,
    preEventBookTimestampMs,
    preEventBookDigest,
    rawTradeFrameDigest,
    postEventTimestampsMs,
    postEventBookDigests,
  })}`;
  const eventWindowIdentity = `event-window:${digest({
    market,
    symbol,
    preEventBookTimestampMs,
    eventTimestampMs,
    postEventTimestampsMs,
  })}`;
  return Object.freeze({
    observationId,
    sourceDigest,
    eventIdentity,
    eventPayloadDigest,
    sourceFrameIdentity,
    eventWindowIdentity,
    publicExecutionId,
    market,
    symbol,
    aggressiveSide,
    eventTimestampMs,
    preEventBookTimestampMs,
    sourceFrameEndMs: Math.max(eventTimestampMs, ...postEventTimestampsMs),
    preEventBookDigest,
    rawTradeFrameDigest,
    normalizedDigest: digest(source),
  });
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value) {
    let cursor = value;
    while (this.parent[cursor] !== cursor) cursor = this.parent[cursor];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = cursor;
      value = next;
    }
    return cursor;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const root = Math.min(leftRoot, rightRoot);
    this.parent[leftRoot] = root;
    this.parent[rightRoot] = root;
  }
}

function correlationReasons(left, right) {
  const reasons = [];
  if (left.sourceFrameIdentity === right.sourceFrameIdentity) reasons.push('SAME_SOURCE_FRAME');
  if (left.preEventBookDigest === right.preEventBookDigest) reasons.push('SAME_PRE_EVENT_BOOK');
  if (left.rawTradeFrameDigest === right.rawTradeFrameDigest) reasons.push('SAME_PUBLIC_TRADE_FRAME');
  if (left.eventWindowIdentity === right.eventWindowIdentity) reasons.push('SAME_EVENT_WINDOW');
  if (left.sourceDigest === right.sourceDigest) reasons.push('SAME_SOURCE_DIGEST');
  if (left.normalizedDigest === right.normalizedDigest) reasons.push('SAME_NORMALIZED_OBSERVATION');
  if (left.market === right.market
    && left.symbol === right.symbol
    && left.preEventBookTimestampMs <= right.sourceFrameEndMs
    && right.preEventBookTimestampMs <= left.sourceFrameEndMs) {
    reasons.push('OVERLAPPING_OBSERVATION_WINDOW');
  }
  return reasons;
}

function blocked(blockers, audit = null) {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    audit,
    safety: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_SAFETY,
  });
}

export function classifyPublicForwardLiquidityIndependence(dataset) {
  const verification = verifyLiquidityCalibrationDataset(dataset);
  if (!verification.valid) return blocked(['RAW_CANONICAL_DATASET_INVALID', verification.reason]);
  if (dataset.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || dataset.storeContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT
    || dataset.sampleClass !== FORWARD_NATURAL_SAMPLE) {
    return blocked(['RAW_CANONICAL_DATASET_CONTRACT_INVALID']);
  }
  if (!Array.isArray(dataset.observations) || dataset.observations.length === 0) {
    return blocked(['RAW_CANONICAL_DATASET_EMPTY']);
  }

  let normalized;
  try {
    normalized = dataset.observations.map(normalizeObservation).sort(eventOrder);
  } catch (error) {
    return blocked([String(error?.message ?? 'INDEPENDENCE_NORMALIZATION_FAILED')]);
  }

  const eventGroups = groupBy(normalized, (value) => value.eventIdentity);
  const canonical = [];
  const duplicateEvents = [];
  const identityCollisions = [];
  for (const [eventIdentity, values] of [...eventGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    values.sort(eventOrder);
    const payloadGroups = groupBy(values, (value) => value.eventPayloadDigest);
    if (payloadGroups.size > 1) {
      identityCollisions.push(Object.freeze({
        eventIdentity,
        observationIds: Object.freeze(values.map((value) => value.observationId).sort()),
        eventPayloadDigests: Object.freeze([...payloadGroups.keys()].sort()),
      }));
      continue;
    }
    canonical.push(values[0]);
    for (const duplicate of values.slice(1)) {
      duplicateEvents.push(Object.freeze({
        observationId: duplicate.observationId,
        representativeObservationId: values[0].observationId,
        eventIdentity,
        reason: 'DUPLICATE_PUBLIC_EVENT_SPLIT_CREDIT_FORBIDDEN',
      }));
    }
  }
  canonical.sort(eventOrder);

  const sets = new DisjointSet(canonical.length);
  const pairReasons = new Map(canonical.map((value) => [value.observationId, new Set()]));
  for (let leftIndex = 0; leftIndex < canonical.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < canonical.length; rightIndex += 1) {
      const reasons = correlationReasons(canonical[leftIndex], canonical[rightIndex]);
      if (reasons.length === 0) continue;
      sets.union(leftIndex, rightIndex);
      for (const reason of reasons) {
        pairReasons.get(canonical[leftIndex].observationId).add(reason);
        pairReasons.get(canonical[rightIndex].observationId).add(reason);
      }
    }
  }
  const components = new Map();
  canonical.forEach((value, index) => {
    const root = sets.find(index);
    const bucket = components.get(root) ?? [];
    bucket.push(value);
    components.set(root, bucket);
  });
  const independent = [];
  const dependent = [];
  for (const values of components.values()) {
    values.sort(eventOrder);
    independent.push(values[0]);
    for (const value of values.slice(1)) {
      dependent.push(Object.freeze({
        observationId: value.observationId,
        representativeObservationId: values[0].observationId,
        eventIdentity: value.eventIdentity,
        reasons: Object.freeze([...pairReasons.get(value.observationId)].sort()),
      }));
    }
  }
  independent.sort(eventOrder);
  dependent.sort((left, right) => left.observationId.localeCompare(right.observationId));

  const sharedSourceFrameN = [...groupBy(canonical, (value) => value.sourceFrameIdentity).values()]
    .filter((values) => values.length > 1).length;
  const overlappingWindowRejectedN = dependent
    .filter((value) => value.reasons.includes('OVERLAPPING_OBSERVATION_WINDOW')).length;
  const sideCounts = { BUY: 0, SELL: 0 };
  for (const value of independent) sideCounts[value.aggressiveSide] += 1;
  const counts = Object.freeze({
    RAW_ACCEPTED_N: normalized.length,
    UNIQUE_EVENT_N: eventGroups.size,
    DUPLICATE_PUBLIC_EVENT_N: duplicateEvents.length,
    IDENTITY_COLLISION_N: identityCollisions.length,
    CANONICAL_EVENT_N: canonical.length,
    INDEPENDENT_N: independent.length,
    DEPENDENT_REJECTED_N: dependent.length,
    SOURCE_FRAME_COLLISION_N: sharedSourceFrameN,
    OVERLAPPING_WINDOW_REJECTED_N: overlappingWindowRejectedN,
    INDEPENDENT_BUY_N: sideCounts.BUY,
    INDEPENDENT_SELL_N: sideCounts.SELL,
  });
  const auditBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_AUDIT_VERSION,
    rawCanonicalDatasetDigest: dataset.datasetDigest,
    datasetContract: dataset.contract,
    datasetStoreContract: dataset.storeContract,
    collectorCodeSha: dataset.collectorCodeSha,
    sampleClass: dataset.sampleClass,
    counts,
    independentObservationIds: Object.freeze(independent.map((value) => value.observationId)),
    duplicateEvents: Object.freeze(duplicateEvents),
    dependentRejections: Object.freeze(dependent),
    identityCollisions: Object.freeze(identityCollisions),
    rawAcceptedNDescriptiveOnly: true,
    effectiveIndependentSampleCreditOwnedHere: true,
    independenceFilteredBeforeSplit: true,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const audit = Object.freeze({ ...auditBody, auditDigest: digest(auditBody) });
  if (identityCollisions.length > 0) return blocked(['PUBLIC_EVENT_IDENTITY_COLLISION'], audit);
  if (independent.length === 0) return blocked(['INDEPENDENT_SAMPLE_EMPTY'], audit);
  return Object.freeze({
    status: 'PRESENT',
    blockers: Object.freeze([]),
    audit,
    safety: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_SAFETY,
  });
}

function projectionCore(dataset, independenceAudit) {
  const independentIds = new Set(independenceAudit.independentObservationIds);
  const observations = dataset.observations
    .filter((value) => independentIds.has(value.observationId))
    .sort((left, right) => left.eventTimestampMs - right.eventTimestampMs || left.observationId.localeCompare(right.observationId));
  const dependentAttempts = independenceAudit.dependentRejections.map((value) => {
    const observation = dataset.observations.find((item) => item.observationId === value.observationId);
    return Object.freeze({
      observationId: value.observationId,
      sourceDigest: observation?.sourceDigest ?? null,
      sampleCountDelta: 0,
      representativeObservationId: value.representativeObservationId,
      reasons: value.reasons,
      reason: 'DEPENDENT_OBSERVATION_SPLIT_CREDIT_FORBIDDEN',
    });
  });
  const duplicateEventAttempts = independenceAudit.duplicateEvents.map((value) => {
    const observation = dataset.observations.find((item) => item.observationId === value.observationId);
    return Object.freeze({
      observationId: value.observationId,
      sourceDigest: observation?.sourceDigest ?? null,
      sampleCountDelta: 0,
      representativeObservationId: value.representativeObservationId,
      reason: value.reason,
    });
  });
  const duplicateAttempts = Object.freeze([
    ...(dataset.duplicateAttempts ?? []),
    ...duplicateEventAttempts,
    ...dependentAttempts,
  ]);
  const batchProvenance = Object.freeze([...(dataset.batchProvenance ?? [])]);
  const aggregateDroppedReasons = {};
  for (const provenance of batchProvenance) {
    for (const [reason, count] of Object.entries(provenance.droppedReasons ?? {})) {
      aggregateDroppedReasons[reason] = (aggregateDroppedReasons[reason] ?? 0) + Number(count);
    }
  }
  const datasetProvenance = Object.freeze({
    rawSource: Object.freeze({
      provider: 'BITGET_PUBLIC_UTA_V3',
      endpoints: Object.freeze(['/api/v3/market/orderbook', '/api/v3/market/fills']),
      privateApiUsed: false,
    }),
    collectionPeriod: Object.freeze({
      startedAtMs: batchProvenance.length
        ? Math.min(...batchProvenance.map((item) => item.collectionPeriod.startedAtMs))
        : null,
      completedAtMs: batchProvenance.length
        ? Math.max(...batchProvenance.map((item) => item.collectionPeriod.completedAtMs))
        : null,
    }),
    firstObservedAtMs: observations.length ? Math.min(...observations.map((item) => item.eventTimestampMs)) : null,
    lastObservedAtMs: observations.length ? Math.max(...observations.map((item) => item.eventTimestampMs)) : null,
    eventCount: observations.length,
    droppedCount: batchProvenance.reduce((sum, item) => sum + item.droppedCount, 0),
    droppedReasons: Object.freeze(Object.fromEntries(
      Object.entries(aggregateDroppedReasons).sort(([left], [right]) => left.localeCompare(right)),
    )),
    rawDigest: sha256(canonicalJson(batchProvenance.map((item) => item.rawDigest).sort())),
    normalizedDigest: sha256(canonicalJson(observations)),
    collectorCodeSha: dataset.collectorCodeSha,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-dataset',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    collectorCodeSha: dataset.collectorCodeSha,
    sampleClass: dataset.sampleClass,
    predecessorDigest: dataset.datasetDigest,
    observations: Object.freeze(observations),
    batchProvenance,
    duplicateAttempts,
    datasetProvenance,
    readiness: dataset.readiness,
    safety: dataset.safety,
  });
}

export function buildPublicForwardLiquidityIndependentProjection(dataset, independenceAudit) {
  if (independenceAudit?.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_AUDIT_VERSION
    || independenceAudit?.rawCanonicalDatasetDigest !== dataset?.datasetDigest
    || independenceAudit?.auditDigest !== digest(Object.fromEntries(
      Object.entries(independenceAudit).filter(([key]) => key !== 'auditDigest'),
    ))) {
    throw new Error('INDEPENDENCE_AUDIT_INVALID');
  }
  if (independenceAudit.identityCollisions.length > 0) throw new Error('INDEPENDENCE_IDENTITY_COLLISION_BLOCKED');
  const core = projectionCore(dataset, independenceAudit);
  const projection = Object.freeze({ ...core, datasetDigest: sha256(canonicalJson(core)) });
  const verification = verifyLiquidityCalibrationDataset(projection);
  if (!verification.valid) throw new Error(`INDEPENDENT_PROJECTION_INVALID:${verification.reason}`);
  return projection;
}

function extendSplitAudit(splitAudit, dataset, independenceAudit, projection) {
  if (!splitAudit) return null;
  if (splitAudit.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_SPLIT_AUDIT_VERSION) {
    throw new Error('CANONICAL_SPLIT_AUDIT_VERSION_INVALID');
  }
  const base = Object.fromEntries(Object.entries(splitAudit).filter(([key]) => key !== 'auditDigest'));
  const body = {
    ...base,
    rawCanonicalDatasetDigest: dataset.datasetDigest,
    independentProjectionVersion: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENT_PROJECTION_VERSION,
    independentProjectionDatasetDigest: projection.datasetDigest,
    independenceAuditVersion: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_AUDIT_VERSION,
    independenceAuditDigest: independenceAudit.auditDigest,
    rawAcceptedObservationCount: independenceAudit.counts.RAW_ACCEPTED_N,
    effectiveIndependentObservationCount: independenceAudit.counts.INDEPENDENT_N,
    dependentRejectedObservationCount: independenceAudit.counts.DEPENDENT_REJECTED_N,
    duplicatePublicEventCount: independenceAudit.counts.DUPLICATE_PUBLIC_EVENT_N,
    sourceFrameCollisionCount: independenceAudit.counts.SOURCE_FRAME_COLLISION_N,
    overlappingWindowRejectedCount: independenceAudit.counts.OVERLAPPING_WINDOW_REJECTED_N,
    independentBuyCount: independenceAudit.counts.INDEPENDENT_BUY_N,
    independentSellCount: independenceAudit.counts.INDEPENDENT_SELL_N,
    rawAcceptedNDescriptiveOnly: true,
    independenceFilteredBeforeSplit: true,
    effectiveIndependentSampleCreditOwnedHere: true,
  };
  return Object.freeze({ ...body, auditDigest: digest(body) });
}

export function auditPublicForwardLiquidityIndependentSplits({
  dataset,
  scopeBindings = [],
  regimeBindings = [],
  policy,
} = {}) {
  const classified = classifyPublicForwardLiquidityIndependence(dataset);
  if (classified.status !== 'PRESENT') return classified;
  let projection;
  try {
    projection = buildPublicForwardLiquidityIndependentProjection(dataset, classified.audit);
  } catch (error) {
    return blocked([String(error?.message ?? 'INDEPENDENT_PROJECTION_FAILED')], classified.audit);
  }
  const admitted = new Set(projection.observations.map((value) => value.observationId));
  const splitResult = auditPublicForwardLiquidityCalibrationSplits({
    dataset: projection,
    scopeBindings: scopeBindings.filter((value) => admitted.has(value?.observationId)),
    regimeBindings: regimeBindings.filter((value) => admitted.has(value?.observationId)),
    policy,
  });
  let extendedAudit = null;
  try {
    extendedAudit = extendSplitAudit(splitResult.audit, dataset, classified.audit, projection);
  } catch (error) {
    return blocked([String(error?.message ?? 'INDEPENDENCE_SPLIT_AUDIT_EXTENSION_FAILED')], classified.audit);
  }
  return Object.freeze({
    status: splitResult.status,
    blockers: splitResult.blockers,
    audit: extendedAudit,
    independenceAudit: classified.audit,
    projectionDataset: projection,
    safety: PUBLIC_FORWARD_LIQUIDITY_INDEPENDENCE_SAFETY,
  });
}
