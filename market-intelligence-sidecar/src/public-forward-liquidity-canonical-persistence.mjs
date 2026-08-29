import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  canonicalJson as collectorCanonicalJson,
  sha256 as collectorSha256,
} from './public-forward-liquidity-calibration.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_CANONICAL_PERSISTENCE_VERSION =
  'public-forward-liquidity-canonical-persistence-v1';
export const PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT =
  'research-production-state-root/forward-liquidity-canonical-persistence-v1';
export const PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT_VERSION =
  'public-forward-liquidity-capture-receipt-v1';
export const PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ARTIFACT_RECEIPT_VERSION =
  'public-forward-liquidity-capture-artifact-receipt-v1';
export const PUBLIC_FORWARD_LIQUIDITY_CANONICAL_SPLIT_SOURCE_VERSION =
  'public-forward-liquidity-canonical-independent-split-source-v1';

export const PUBLIC_FORWARD_LIQUIDITY_CANONICAL_SAFETY = Object.freeze({
  rawGithubArtifactIsCanonicalState: false,
  crossBatchDedupRequired: true,
  sourceFrameIndependenceRequired: true,
  timestampOnlyDedupAllowed: false,
  randomSplitAllowed: false,
  splitAssignmentPerformed: false,
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

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;
const PROTECTED_APPLICATION_ROOTS = Object.freeze([
  '/opt/stock-app-data',
  '/srv/stock-app',
  '/var/lib/stock-app',
]);

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function text(value, code, maximumLength = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximumLength) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = text(value, code).replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function exactSha(value, code) {
  const normalized = text(value, code).toLowerCase();
  if (!COMMIT_SHA.test(normalized)) throw new Error(code);
  return normalized;
}

function decimalId(value, code) {
  const normalized = text(value, code);
  if (!DECIMAL_ID.test(normalized)) throw new Error(code);
  return normalized;
}

function positive(value, code) {
  const normalized = Number(value);
  if (!(Number.isFinite(normalized) && normalized > 0)) throw new Error(code);
  return normalized;
}

function timestamp(value, code) {
  return Math.trunc(positive(value, code));
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function canonicalLiquidityJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function computePublicForwardLiquidityCanonicalDigest(value) {
  return createHash('sha256').update(canonicalLiquidityJson(value)).digest('hex');
}

function withoutKey(value, omittedKey) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omittedKey));
}

function frozenArray(values) {
  return Object.freeze(values.map((value) => Object.freeze(value)));
}

function sameCanonical(left, right) {
  return canonicalLiquidityJson(left) === canonicalLiquidityJson(right);
}

function assertFalseTruthBoundary(value, prefix) {
  const falseFields = [
    'canonicalDatasetPersistencePerformed',
    'canonicalDatasetCreditApplied',
    'splitAssignmentPerformed',
    'oosValidationComplete',
    'calibrationArtifactProduced',
    'liquidityImpactPresent',
    'fullCostReady',
    'privateApiUsed',
    'liveTrading',
    'orderSubmitted',
  ];
  for (const field of falseFields) {
    if (value[field] !== false) throw new Error(`${prefix}_${field.toUpperCase()}_BOUNDARY_INVALID`);
  }
  if (value.executionAuthority !== 'NONE'
    || value.naturalEntryCredit !== 0
    || value.runtimeCostCredit !== 0) {
    throw new Error(`${prefix}_AUTHORITY_BOUNDARY_INVALID`);
  }
}

function normalizeArtifactIdentity(value, code) {
  const artifact = object(value, code);
  return Object.freeze({
    id: decimalId(artifact.id, `${code}_ID_INVALID`),
    name: text(artifact.name, `${code}_NAME_INVALID`),
    digest: exactDigest(artifact.digest, `${code}_DIGEST_INVALID`),
  });
}

function normalizeVisibleDepth(value) {
  const depth = object(value, 'OBSERVATION_VISIBLE_L2_MISSING');
  const normalizeSide = (levels, side) => {
    if (!Array.isArray(levels) || levels.length === 0) throw new Error(`OBSERVATION_VISIBLE_L2_${side}_MISSING`);
    return Object.freeze(levels.map((level) => Object.freeze({
      price: positive(level?.price, `OBSERVATION_VISIBLE_L2_${side}_PRICE_INVALID`),
      quantity: positive(level?.quantity, `OBSERVATION_VISIBLE_L2_${side}_QUANTITY_INVALID`),
    })));
  };
  const bids = normalizeSide(depth.bids, 'BID');
  const asks = normalizeSide(depth.asks, 'ASK');
  return Object.freeze({
    bids,
    asks,
    bidQuantity: positive(depth.bidQuantity, 'OBSERVATION_VISIBLE_L2_BID_TOTAL_INVALID'),
    askQuantity: positive(depth.askQuantity, 'OBSERVATION_VISIBLE_L2_ASK_TOTAL_INVALID'),
    bidNotional: positive(depth.bidNotional, 'OBSERVATION_VISIBLE_L2_BID_NOTIONAL_INVALID'),
    askNotional: positive(depth.askNotional, 'OBSERVATION_VISIBLE_L2_ASK_NOTIONAL_INVALID'),
  });
}

function normalizeObservation({ observation, captureRecord }) {
  const source = object(observation, 'CAPTURE_OBSERVATION_INVALID');
  if (source.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || source.sampleClass !== FORWARD_NATURAL_SAMPLE
    || source.forwardCalibrationSampleCredit !== 1
    || source.historicalBackfillForwardCredit !== 0) {
    throw new Error('CAPTURE_OBSERVATION_CLASS_INVALID');
  }
  if (source.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
    || source.calibrationSourceOnly !== true
    || source.executionCostEligible !== false
    || source.causalMarketImpactClaim !== false
    || source.paperOrderSourceAllowed !== false
    || source.liquidityImpactCoefficient !== null) {
    throw new Error('CAPTURE_OBSERVATION_AUTHORITY_INVALID');
  }
  if (source.safety?.publicDataOnly !== true
    || source.safety?.executionAuthority !== 'NONE'
    || source.safety?.privateTradingApiAllowed !== false
    || source.safety?.liveTradingAllowed !== false
    || source.safety?.realOrderAllowed !== false
    || source.safety?.financialMutationAllowed !== false) {
    throw new Error('CAPTURE_OBSERVATION_SAFETY_INVALID');
  }
  const collectorCodeSha = exactSha(source.collectorCodeSha, 'OBSERVATION_COLLECTOR_SHA_INVALID');
  if (collectorCodeSha !== captureRecord.collectorCodeSha) throw new Error('OBSERVATION_COLLECTOR_SHA_MISMATCH');
  const collectorObservationId = text(source.observationId, 'OBSERVATION_ID_INVALID');
  const market = text(source.market, 'OBSERVATION_MARKET_INVALID');
  if (market !== 'CRYPTO_FUTURES') throw new Error('OBSERVATION_MARKET_INVALID');
  const symbol = text(source.symbol, 'OBSERVATION_SYMBOL_INVALID').toUpperCase();
  const side = text(source.aggressiveSide, 'OBSERVATION_SIDE_INVALID').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) throw new Error('OBSERVATION_SIDE_INVALID');
  const eventTimestampMs = timestamp(source.eventTimestampMs, 'OBSERVATION_EVENT_TIMESTAMP_INVALID');
  const receiveTimestampMs = timestamp(source.receiveTimestampMs, 'OBSERVATION_RECEIVE_TIMESTAMP_INVALID');
  const publicExecutionPrice = positive(source.publicExecutionPrice, 'OBSERVATION_EXECUTION_PRICE_INVALID');
  const quantity = positive(source.tradeFlowQuantity, 'OBSERVATION_QUANTITY_INVALID');
  const notional = positive(source.tradeFlowNotional, 'OBSERVATION_NOTIONAL_INVALID');
  if (Math.abs(notional - (quantity * publicExecutionPrice)) > Math.max(1e-9, notional * 1e-10)) {
    throw new Error('OBSERVATION_NOTIONAL_MISMATCH');
  }
  const bestBid = positive(source.preEventBestBid, 'OBSERVATION_BEST_BID_INVALID');
  const bestAsk = positive(source.preEventBestAsk, 'OBSERVATION_BEST_ASK_INVALID');
  if (bestBid >= bestAsk) throw new Error('OBSERVATION_BBO_CROSSED');
  const mid = positive(source.preEventMid, 'OBSERVATION_MID_INVALID');
  const spread = positive(source.preEventSpread, 'OBSERVATION_SPREAD_INVALID');
  if (Math.abs(mid - ((bestBid + bestAsk) / 2)) > Math.max(1e-9, mid * 1e-10)
    || Math.abs(spread - (bestAsk - bestBid)) > Math.max(1e-9, spread * 1e-10)) {
    throw new Error('OBSERVATION_BBO_DERIVATION_MISMATCH');
  }
  const visibleL2 = normalizeVisibleDepth(source.preEventVisibleL2Depth);
  const preEventBookDigest = exactDigest(source.preEventBookDigest, 'OBSERVATION_PRE_BOOK_DIGEST_INVALID');
  const provenance = object(source.rawSourceProvenance, 'OBSERVATION_RAW_PROVENANCE_MISSING');
  const preEventBook = object(provenance.preEventBook, 'OBSERVATION_PRE_BOOK_PROVENANCE_MISSING');
  const publicTrade = object(provenance.publicTrade, 'OBSERVATION_PUBLIC_TRADE_PROVENANCE_MISSING');
  const publicExecutionId = text(publicTrade.publicExecutionId, 'OBSERVATION_PUBLIC_EXECUTION_ID_INVALID');
  const preEventBookTimestampMs = timestamp(preEventBook.marketTimestampMs, 'OBSERVATION_PRE_BOOK_TIMESTAMP_INVALID');
  const preEventBookReceiveTimestampMs = timestamp(preEventBook.receiveTimestampMs, 'OBSERVATION_PRE_BOOK_RECEIVE_INVALID');
  if (preEventBookTimestampMs >= eventTimestampMs || preEventBookReceiveTimestampMs > receiveTimestampMs) {
    throw new Error('OBSERVATION_PRE_EVENT_CHRONOLOGY_INVALID');
  }
  const rawTradeFrameDigest = exactDigest(publicTrade.rawFrameDigest, 'OBSERVATION_TRADE_FRAME_DIGEST_INVALID');
  const postEventBooks = Array.isArray(provenance.postEventBooks) ? provenance.postEventBooks : [];
  const postEventTimestampsMs = Object.freeze(postEventBooks.map((frame) => timestamp(
    frame?.marketTimestampMs,
    'OBSERVATION_POST_BOOK_TIMESTAMP_INVALID',
  )));
  const postEventReceiveTimestampsMs = Object.freeze(postEventBooks.map((frame) => timestamp(
    frame?.receiveTimestampMs,
    'OBSERVATION_POST_BOOK_RECEIVE_INVALID',
  )));
  const postEventBookDigests = Object.freeze(postEventBooks.map((frame) => exactDigest(
    frame?.rawPayloadDigest,
    'OBSERVATION_POST_BOOK_DIGEST_INVALID',
  )));
  if (postEventTimestampsMs.some((value) => value < eventTimestampMs)
    || postEventReceiveTimestampsMs.some((value) => value < receiveTimestampMs)) {
    throw new Error('OBSERVATION_POST_EVENT_CHRONOLOGY_INVALID');
  }
  const sourceDigest = exactDigest(source.sourceDigest, 'OBSERVATION_SOURCE_DIGEST_INVALID');
  const sourceObservation = deepFreeze(canonicalize(source));
  const rawDigest = computePublicForwardLiquidityCanonicalDigest(provenance);
  const eventIdentityInput = {
    provider: source.publicDataSource,
    market,
    symbol,
    publicExecutionId,
  };
  const eventPayloadInput = {
    side,
    eventTimestampMs,
    publicExecutionPrice,
    quantity,
    notional,
  };
  const sourceFrameInput = {
    provider: source.publicDataSource,
    market,
    symbol,
    preEventBookDigest,
    rawTradeFrameDigest,
    postEventBookDigests,
    preEventBookTimestampMs,
    postEventTimestampsMs,
  };
  const eventWindowInput = {
    market,
    symbol,
    preEventBookTimestampMs,
    eventTimestampMs,
    postEventTimestampsMs,
  };
  const normalizedPayload = {
    provider: source.publicDataSource,
    market,
    symbol,
    side,
    publicExecutionId,
    eventTimestampMs,
    receiveTimestampMs,
    preEventBookTimestampMs,
    preEventBookReceiveTimestampMs,
    postEventTimestampsMs,
    postEventReceiveTimestampsMs,
    bestBid,
    bestAsk,
    mid,
    spread,
    visibleL2,
    quantity,
    notional,
    publicExecutionPrice,
    preEventBookDigest,
    rawTradeFrameDigest,
    postEventBookDigests,
    rawDigest,
    sourceDigest,
    sourceObservation,
  };
  const eventIdentity = `public-event:${computePublicForwardLiquidityCanonicalDigest(eventIdentityInput)}`;
  const eventPayloadDigest = computePublicForwardLiquidityCanonicalDigest(eventPayloadInput);
  const sourceFrameIdentity = `source-frame:${computePublicForwardLiquidityCanonicalDigest(sourceFrameInput)}`;
  const eventWindowIdentity = `event-window:${computePublicForwardLiquidityCanonicalDigest(eventWindowInput)}`;
  const normalizedDigest = computePublicForwardLiquidityCanonicalDigest(normalizedPayload);
  const sourceFrameEndMs = Math.max(eventTimestampMs, ...postEventTimestampsMs);
  const correlatedDuplicateIdentity = `correlated-event:${computePublicForwardLiquidityCanonicalDigest({
    market,
    symbol,
    side,
    publicExecutionId,
    preEventBookDigest,
    eventWindowIdentity,
  })}`;
  return Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_PERSISTENCE_VERSION,
    captureBatchId: captureRecord.captureBatchId,
    batchIdentity: captureRecord.batchIdentity,
    observationIdentity: `canonical-observation:${normalizedDigest}`,
    collectorObservationId,
    eventIdentity,
    eventPayloadDigest,
    correlatedDuplicateIdentity,
    sourceFrameIdentity,
    eventWindowIdentity,
    publicDataSource: source.publicDataSource,
    market,
    symbol,
    side,
    publicExecutionId,
    eventTimestampMs,
    receiveTimestampMs,
    preEventBookTimestampMs,
    preEventBookReceiveTimestampMs,
    postEventTimestampsMs,
    postEventReceiveTimestampsMs,
    sourceFrameStartMs: preEventBookTimestampMs,
    sourceFrameEndMs,
    bbo: Object.freeze({ bestBid, bestAsk }),
    mid,
    spread,
    visibleL2,
    quantity,
    notional,
    publicExecutionPrice,
    preEventBookDigest,
    rawTradeFrameDigest,
    postEventBookDigests,
    rawDigest,
    normalizedDigest,
    sourceDigest,
    sourceObservation,
    producerCodeSha: captureRecord.producerCodeSha,
    collectorCodeSha,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    calibrationSourceOnly: true,
    executionCostEligible: false,
    historicalBackfillCredit: 0,
  });
}

function validateCaptureBundle(input, producerCodeSha) {
  const bundle = object(input, 'CAPTURE_BUNDLE_INVALID');
  const batch = object(bundle.batch, 'CAPTURE_BATCH_INVALID');
  const capture = object(bundle.captureReceipt, 'CAPTURE_RECEIPT_INVALID');
  const artifact = object(bundle.artifactReceipt, 'CAPTURE_ARTIFACT_RECEIPT_INVALID');
  const expectedRepository = text(bundle.expectedRepository, 'EXPECTED_REPOSITORY_INVALID');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepository)) throw new Error('EXPECTED_REPOSITORY_INVALID');
  const rawArtifact = normalizeArtifactIdentity(bundle.rawArtifact, 'RAW_ARTIFACT');
  const receiptArtifact = normalizeArtifactIdentity(bundle.receiptArtifact, 'RECEIPT_ARTIFACT');

  if (batch.kind !== 'public-forward-liquidity-calibration-batch'
    || batch.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || batch.sampleClass !== FORWARD_NATURAL_SAMPLE
    || batch.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true) {
    throw new Error('CAPTURE_BATCH_CONTRACT_INVALID');
  }
  if (!Array.isArray(batch.observations) || !Array.isArray(batch.droppedEvents)) {
    throw new Error('CAPTURE_BATCH_SHAPE_INVALID');
  }
  if (batch.datasetProvenance?.rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || batch.datasetProvenance?.rawSource?.privateApiUsed !== false
    || batch.readiness?.LIQUIDITY_IMPACT_PRESENT !== false
    || batch.readiness?.CALIBRATION_SAMPLE_SUFFICIENT !== false
    || batch.readiness?.LIQUIDITY_IMPACT_STATUS !== 'BLOCKED_DATA'
    || batch.readiness?.FULL_COST_READY !== false
    || batch.safety?.publicDataOnly !== true
    || batch.safety?.executionAuthority !== 'NONE'
    || batch.safety?.privateTradingApiAllowed !== false
    || batch.safety?.liveTradingAllowed !== false
    || batch.safety?.realOrderAllowed !== false
    || batch.safety?.financialMutationAllowed !== false) {
    throw new Error('CAPTURE_BATCH_SAFETY_INVALID');
  }
  const collectorCodeSha = exactSha(batch.datasetProvenance?.collectorCodeSha, 'CAPTURE_COLLECTOR_SHA_INVALID');
  const observationTimestamps = batch.observations.map((value) => timestamp(
    value?.eventTimestampMs,
    'CAPTURE_OBSERVATION_TIMESTAMP_INVALID',
  ));
  const expectedFirstObservedAtMs = observationTimestamps.length ? Math.min(...observationTimestamps) : null;
  const expectedLastObservedAtMs = observationTimestamps.length ? Math.max(...observationTimestamps) : null;
  const collectionStartedAtMs = timestamp(
    batch.datasetProvenance?.collectionPeriod?.startedAtMs,
    'CAPTURE_COLLECTION_START_INVALID',
  );
  const collectionCompletedAtMs = timestamp(
    batch.datasetProvenance?.collectionPeriod?.completedAtMs,
    'CAPTURE_COLLECTION_END_INVALID',
  );
  if (collectionStartedAtMs > collectionCompletedAtMs
    || batch.datasetProvenance.eventCount !== batch.observations.length
    || batch.datasetProvenance.droppedCount !== batch.droppedEvents.length
    || batch.datasetProvenance.firstObservedAtMs !== expectedFirstObservedAtMs
    || batch.datasetProvenance.lastObservedAtMs !== expectedLastObservedAtMs) {
    throw new Error('CAPTURE_BATCH_PROVENANCE_COUNT_OR_TIME_INVALID');
  }
  const rawBatchDigest = collectorSha256(collectorCanonicalJson(batch));
  if (capture.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT_VERSION
    || capture.evidenceClass !== 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT'
    || capture.triggerSource !== 'MANUAL_WORKFLOW_DISPATCH'
    || capture.repository !== expectedRepository
    || capture.sampleClass !== FORWARD_NATURAL_SAMPLE
    || capture.captureStatus !== (batch.observations.length > 0 ? 'PRESENT' : 'BLOCKED_DATA')) {
    throw new Error('CAPTURE_RECEIPT_CONTRACT_INVALID');
  }
  const runId = decimalId(capture.runId, 'CAPTURE_RUN_ID_INVALID');
  const runAttempt = decimalId(capture.runAttempt, 'CAPTURE_RUN_ATTEMPT_INVALID');
  if (exactSha(capture.exactMainSha, 'CAPTURE_MAIN_SHA_INVALID') !== collectorCodeSha
    || exactSha(capture.collectorCodeSha, 'CAPTURE_RECEIPT_COLLECTOR_SHA_INVALID') !== collectorCodeSha) {
    throw new Error('CAPTURE_SHA_BINDING_INVALID');
  }
  if (capture.prospectiveObservationCount !== batch.observations.length
    || capture.droppedObservationCount !== batch.droppedEvents.length
    || exactDigest(capture.rawBatchDigest, 'CAPTURE_RAW_BATCH_DIGEST_INVALID') !== rawBatchDigest
    || !sameCanonical(capture.datasetProvenance, batch.datasetProvenance)) {
    throw new Error('CAPTURE_RECEIPT_DATA_MISMATCH');
  }
  if (capture.duplicateCreditEvaluated !== false
    || capture.evidenceCompleteCredit !== 0
    || capture.realOrders !== 0) {
    throw new Error('CAPTURE_RECEIPT_CREDIT_BOUNDARY_INVALID');
  }
  assertFalseTruthBoundary(capture, 'CAPTURE_RECEIPT');

  if (artifact.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ARTIFACT_RECEIPT_VERSION
    || exactSha(artifact.exactMainSha, 'ARTIFACT_MAIN_SHA_INVALID') !== collectorCodeSha
    || exactSha(artifact.collectorCodeSha, 'ARTIFACT_COLLECTOR_SHA_INVALID') !== collectorCodeSha
    || artifact.captureStatus !== capture.captureStatus
    || exactDigest(artifact.rawBatchDigest, 'ARTIFACT_RAW_BATCH_DIGEST_INVALID') !== rawBatchDigest
    || artifact.prospectiveObservationCount !== batch.observations.length) {
    throw new Error('CAPTURE_ARTIFACT_RECEIPT_MISMATCH');
  }
  const artifactReceiptDigest = exactDigest(artifact.receiptDigest, 'ARTIFACT_RECEIPT_DIGEST_INVALID');
  if (artifactReceiptDigest !== computePublicForwardLiquidityCanonicalDigest(withoutKey(artifact, 'receiptDigest'))) {
    throw new Error('ARTIFACT_RECEIPT_DIGEST_MISMATCH');
  }
  if (decimalId(artifact.artifactId, 'ARTIFACT_ID_INVALID') !== rawArtifact.id
    || text(artifact.artifactName, 'ARTIFACT_NAME_INVALID') !== rawArtifact.name
    || exactDigest(artifact.artifactDigest, 'ARTIFACT_DIGEST_INVALID') !== rawArtifact.digest) {
    throw new Error('RAW_ARTIFACT_IDENTITY_MISMATCH');
  }
  const expectedRawName = `public-forward-liquidity-capture-${runId}-${runAttempt}`;
  const expectedReceiptName = `public-forward-liquidity-capture-receipt-${runId}-${runAttempt}`;
  const expectedReference = `https://github.com/${expectedRepository}/actions/runs/${runId}/artifacts/${rawArtifact.id}`;
  if (rawArtifact.name !== expectedRawName
    || receiptArtifact.name !== expectedReceiptName
    || artifact.artifactReference !== expectedReference) {
    throw new Error('ARTIFACT_LINEAGE_INVALID');
  }
  assertFalseTruthBoundary(artifact, 'ARTIFACT_RECEIPT');

  const captureBatchId = `github-actions:${expectedRepository}:${runId}:${runAttempt}:${rawArtifact.id}`;
  const batchIdentityInput = {
    captureBatchId,
    rawArtifact,
    receiptArtifact,
    rawBatchDigest,
    artifactReceiptDigest,
    collectorCodeSha,
  };
  const captureRecord = Object.freeze({
    captureBatchId,
    batchIdentity: `capture-batch:${computePublicForwardLiquidityCanonicalDigest(batchIdentityInput)}`,
    repository: expectedRepository,
    runId,
    runAttempt,
    symbol: text(capture.symbol, 'CAPTURE_SYMBOL_INVALID').toUpperCase(),
    collectorCodeSha,
    producerCodeSha,
    rawArtifact,
    receiptArtifact,
    rawBatchDigest,
    artifactReceiptDigest,
    rawAcceptedN: batch.observations.length,
    rawDroppedN: batch.droppedEvents.length,
    droppedReasons: Object.freeze({ ...(batch.datasetProvenance?.droppedReasons ?? {}) }),
    collectionPeriod: Object.freeze({ ...(batch.datasetProvenance?.collectionPeriod ?? {}) }),
  });
  const observations = batch.observations.map((observation) => normalizeObservation({ observation, captureRecord }));
  if (observations.some((observation) => observation.symbol !== captureRecord.symbol)) {
    throw new Error('CAPTURE_SYMBOL_BINDING_MISMATCH');
  }
  return Object.freeze({ captureRecord, observations: Object.freeze(observations) });
}

function observationOrder(left, right) {
  return left.eventTimestampMs - right.eventTimestampMs
    || left.eventIdentity.localeCompare(right.eventIdentity)
    || left.batchIdentity.localeCompare(right.batchIdentity)
    || left.observationIdentity.localeCompare(right.observationIdentity);
}

function groupBy(values, keyOf) {
  const grouped = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key) ?? [];
    bucket.push(value);
    grouped.set(key, bucket);
  }
  return grouped;
}

function correlationReasons(left, right) {
  const reasons = [];
  if (left.sourceFrameIdentity === right.sourceFrameIdentity) reasons.push('SAME_SOURCE_FRAME');
  if (left.preEventBookDigest === right.preEventBookDigest) reasons.push('SAME_BOOK_SNAPSHOT');
  if (left.publicExecutionId === right.publicExecutionId) reasons.push('SAME_PUBLIC_EVENT');
  if (left.eventWindowIdentity === right.eventWindowIdentity) reasons.push('SAME_EVENT_WINDOW');
  if (left.normalizedDigest === right.normalizedDigest) reasons.push('SAME_NORMALIZED_DIGEST');
  if (left.correlatedDuplicateIdentity === right.correlatedDuplicateIdentity) reasons.push('CORRELATED_DUPLICATE_IDENTITY');
  const sameMarket = left.market === right.market && left.symbol === right.symbol;
  if (sameMarket
    && left.sourceFrameStartMs <= right.sourceFrameEndMs
    && right.sourceFrameStartMs <= left.sourceFrameEndMs) {
    reasons.push('OVERLAPPING_OBSERVATION_WINDOW');
  }
  return reasons;
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value) {
    let current = value;
    while (this.parent[current] !== current) current = this.parent[current];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = current;
      value = next;
    }
    return current;
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

function classifyIndependence(canonicalObservations) {
  const ordered = [...canonicalObservations].sort(observationOrder);
  const sets = new DisjointSet(ordered.length);
  const reasonsByObservation = new Map(ordered.map((observation) => [observation.observationIdentity, new Set()]));
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const reasons = correlationReasons(ordered[leftIndex], ordered[rightIndex]);
      if (reasons.length === 0) continue;
      sets.union(leftIndex, rightIndex);
      for (const reason of reasons) {
        reasonsByObservation.get(ordered[leftIndex].observationIdentity).add(reason);
        reasonsByObservation.get(ordered[rightIndex].observationIdentity).add(reason);
      }
    }
  }
  const components = new Map();
  ordered.forEach((observation, index) => {
    const root = sets.find(index);
    const values = components.get(root) ?? [];
    values.push(observation);
    components.set(root, values);
  });
  const independent = [];
  const dependent = [];
  for (const values of components.values()) {
    values.sort(observationOrder);
    independent.push(values[0]);
    for (const value of values.slice(1)) {
      dependent.push(Object.freeze({
        observationIdentity: value.observationIdentity,
        eventIdentity: value.eventIdentity,
        captureBatchId: value.captureBatchId,
        representativeObservationIdentity: values[0].observationIdentity,
        reasons: Object.freeze([...reasonsByObservation.get(value.observationIdentity)].sort()),
      }));
    }
  }
  independent.sort(observationOrder);
  dependent.sort((left, right) => left.observationIdentity.localeCompare(right.observationIdentity));
  const sharedSourceFrames = [...groupBy(ordered, (value) => value.sourceFrameIdentity)]
    .filter(([, values]) => values.length > 1)
    .map(([sourceFrameIdentity, values]) => Object.freeze({
      sourceFrameIdentity,
      observationIdentities: Object.freeze(values.map((value) => value.observationIdentity).sort()),
    }))
    .sort((left, right) => left.sourceFrameIdentity.localeCompare(right.sourceFrameIdentity));
  return Object.freeze({
    independent: Object.freeze(independent),
    dependent: Object.freeze(dependent),
    sharedSourceFrames: Object.freeze(sharedSourceFrames),
  });
}

function buildDatasetCore(captureBatches, rawAcceptedObservations) {
  const orderedCaptures = [...captureBatches].sort((left, right) => left.batchIdentity.localeCompare(right.batchIdentity));
  const orderedRaw = [...rawAcceptedObservations].sort(observationOrder);
  const eventGroups = groupBy(orderedRaw, (value) => value.eventIdentity);
  const canonical = [];
  const duplicateRejections = [];
  const identityCollisions = [];
  let crossBatchDuplicateN = 0;
  let intraBatchDuplicateN = 0;
  for (const [eventIdentity, values] of [...eventGroups].sort(([left], [right]) => left.localeCompare(right))) {
    values.sort(observationOrder);
    const payloadGroups = groupBy(values, (value) => value.eventPayloadDigest);
    if (payloadGroups.size > 1) {
      identityCollisions.push(Object.freeze({
        eventIdentity,
        eventPayloadDigests: Object.freeze([...payloadGroups.keys()].sort()),
        observationIdentities: Object.freeze(values.map((value) => value.observationIdentity).sort()),
        captureBatchIds: Object.freeze([...new Set(values.map((value) => value.captureBatchId))].sort()),
      }));
      continue;
    }
    const representative = values[0];
    canonical.push(representative);
    for (const duplicate of values.slice(1)) {
      const crossBatch = duplicate.captureBatchId !== representative.captureBatchId;
      if (crossBatch) crossBatchDuplicateN += 1;
      else intraBatchDuplicateN += 1;
      duplicateRejections.push(Object.freeze({
        eventIdentity,
        observationIdentity: duplicate.observationIdentity,
        captureBatchId: duplicate.captureBatchId,
        representativeObservationIdentity: representative.observationIdentity,
        reason: crossBatch ? 'CROSS_BATCH_DUPLICATE_EVENT' : 'INTRA_BATCH_DUPLICATE_EVENT',
      }));
    }
  }
  canonical.sort(observationOrder);
  const independence = classifyIndependence(canonical);
  const rawDroppedN = orderedCaptures.reduce((sum, batch) => sum + batch.rawDroppedN, 0);
  const core = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_PERSISTENCE_VERSION,
    kind: 'public-forward-liquidity-canonical-dataset',
    storeContract: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    captureBatches: frozenArray(orderedCaptures),
    producerCodeShas: Object.freeze([...new Set(orderedCaptures.map((value) => value.producerCodeSha))].sort()),
    collectorCodeShas: Object.freeze([...new Set(orderedCaptures.map((value) => value.collectorCodeSha))].sort()),
    rawAcceptedObservations: Object.freeze(orderedRaw),
    canonicalObservations: Object.freeze(canonical),
    independentObservations: independence.independent,
    duplicateRejections: frozenArray(duplicateRejections.sort((left, right) => left.observationIdentity.localeCompare(right.observationIdentity))),
    identityCollisions: frozenArray(identityCollisions),
    dependentRejections: independence.dependent,
    sharedSourceFrames: independence.sharedSourceFrames,
    counts: Object.freeze({
      RAW_CAPTURE_N: orderedRaw.length + rawDroppedN,
      RAW_ACCEPTED_N: orderedRaw.length,
      RAW_DROPPED_N: rawDroppedN,
      UNIQUE_EVENT_N: eventGroups.size,
      CROSS_BATCH_DUPLICATE_N: crossBatchDuplicateN,
      INTRA_BATCH_DUPLICATE_N: intraBatchDuplicateN,
      IDENTITY_COLLISION_N: identityCollisions.length,
      CANONICAL_ACCEPTED_N: canonical.length,
      INDEPENDENT_N: independence.independent.length,
      DEPENDENT_REJECTED_N: independence.dependent.length,
      SOURCE_FRAME_COLLISION_N: independence.sharedSourceFrames.length,
    }),
    datasetProvenance: Object.freeze({
      rawDigest: computePublicForwardLiquidityCanonicalDigest(orderedRaw.map((value) => ({
        captureBatchId: value.captureBatchId,
        rawDigest: value.rawDigest,
      }))),
      normalizedDigest: computePublicForwardLiquidityCanonicalDigest(canonical.map((value) => value.normalizedDigest)),
      independentDigest: computePublicForwardLiquidityCanonicalDigest(
        independence.independent.map((value) => value.observationIdentity),
      ),
      batchDigest: computePublicForwardLiquidityCanonicalDigest(orderedCaptures.map((value) => value.batchIdentity)),
    }),
    split: Object.freeze({
      chronologicalRequired: true,
      randomSplitAllowed: false,
      callerFrozenPolicyRequired: true,
      splitAssignmentPerformed: false,
      trainN: 0,
      validationN: 0,
      oosN: 0,
      oosContamination: null,
    }),
    readiness: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_SAFETY,
  };
  return Object.freeze(core);
}

function withDatasetDigest(core) {
  return Object.freeze({
    ...core,
    datasetDigest: computePublicForwardLiquidityCanonicalDigest(core),
  });
}

export function verifyPublicForwardLiquidityCanonicalDataset(dataset) {
  try {
    if (dataset?.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CANONICAL_PERSISTENCE_VERSION
      || dataset?.kind !== 'public-forward-liquidity-canonical-dataset'
      || dataset?.storeContract !== PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT
      || dataset?.sampleClass !== FORWARD_NATURAL_SAMPLE
      || !Array.isArray(dataset.captureBatches)
      || !Array.isArray(dataset.rawAcceptedObservations)) {
      return Object.freeze({ valid: false, reason: 'CANONICAL_DATASET_CONTRACT_INVALID' });
    }
    const rebuilt = withDatasetDigest(buildDatasetCore(dataset.captureBatches, dataset.rawAcceptedObservations));
    if (!sameCanonical(dataset, rebuilt)) {
      return Object.freeze({ valid: false, reason: 'CANONICAL_DATASET_DIGEST_OR_DERIVATION_MISMATCH' });
    }
    return Object.freeze({ valid: true, reason: null });
  } catch (error) {
    return Object.freeze({ valid: false, reason: String(error?.message ?? 'CANONICAL_DATASET_INVALID') });
  }
}

export function buildPublicForwardLiquidityCanonicalSplitSource(dataset) {
  const verification = verifyPublicForwardLiquidityCanonicalDataset(dataset);
  if (!verification.valid) {
    throw new Error(`CANONICAL_LIQUIDITY_DATASET_INVALID:${verification.reason}`);
  }
  const observations = dataset.independentObservations.map((value) => Object.freeze({
    admission: Object.freeze({
      canonicalObservationIdentity: value.observationIdentity,
      captureBatchId: value.captureBatchId,
      batchIdentity: value.batchIdentity,
      eventIdentity: value.eventIdentity,
      eventPayloadDigest: value.eventPayloadDigest,
      sourceFrameIdentity: value.sourceFrameIdentity,
      eventWindowIdentity: value.eventWindowIdentity,
      rawDigest: value.rawDigest,
      normalizedDigest: value.normalizedDigest,
      sourceDigest: value.sourceDigest,
      producerCodeSha: value.producerCodeSha,
      collectorCodeSha: value.collectorCodeSha,
      independenceCredit: 1,
      duplicateCredit: 0,
      historicalBackfillCredit: 0,
    }),
    observation: value.sourceObservation,
  }));
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_SPLIT_SOURCE_VERSION,
    kind: 'public-forward-liquidity-canonical-independent-split-source',
    canonicalStoreContract: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
    canonicalDatasetDigest: dataset.datasetDigest,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    observationCount: observations.length,
    observations: Object.freeze(observations),
    counts: dataset.counts,
    split: Object.freeze({
      chronologicalRequired: true,
      randomSplitAllowed: false,
      frozenPolicyRequired: true,
      splitAssignmentPerformed: false,
      trainN: 0,
      validationN: 0,
      oosN: 0,
      oosContamination: null,
    }),
    readiness: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_SAFETY,
  };
  return Object.freeze({
    ...body,
    splitSourceDigest: computePublicForwardLiquidityCanonicalDigest(body),
  });
}

function isWithin(parent, child) {
  const result = relative(resolve(parent), resolve(child));
  return result === '' || (!result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result));
}

async function canonicalStoreDirectory({ stateRoot, researchRepoRoot, storeContract }) {
  if (storeContract !== PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT) throw new Error('BLOCKED_STORAGE:STORE_CONTRACT_INVALID');
  if (!isAbsolute(stateRoot)) throw new Error('BLOCKED_STORAGE:STATE_ROOT_MUST_BE_ABSOLUTE');
  if (!isAbsolute(researchRepoRoot)) throw new Error('BLOCKED_STORAGE:RESEARCH_REPO_ROOT_MUST_BE_ABSOLUTE');
  const requestedStateRoot = resolve(stateRoot);
  const requestedRepoRoot = resolve(researchRepoRoot);
  let state;
  try {
    state = await stat(requestedStateRoot);
  } catch {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_MUST_EXIST');
  }
  if (!state.isDirectory()) throw new Error('BLOCKED_STORAGE:STATE_ROOT_NOT_DIRECTORY');
  const [normalizedStateRoot, normalizedRepoRoot] = await Promise.all([
    realpath(requestedStateRoot),
    realpath(requestedRepoRoot),
  ]);
  if (isWithin(normalizedRepoRoot, normalizedStateRoot) || isWithin(normalizedStateRoot, normalizedRepoRoot)) {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT');
  }
  if (PROTECTED_APPLICATION_ROOTS.some((root) => (
    isWithin(root, normalizedStateRoot) || isWithin(normalizedStateRoot, root)
  ))) {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_PROTECTED_APPLICATION_STORAGE');
  }
  return join(normalizedStateRoot, 'forward', 'liquidity-canonical-persistence-v1');
}

function mergeCaptureRecords(previousDataset, validatedCaptures) {
  const captures = new Map((previousDataset?.captureBatches ?? []).map((value) => [value.captureBatchId, value]));
  const rawObservations = [...(previousDataset?.rawAcceptedObservations ?? [])];
  let insertedCaptureBatchN = 0;
  let duplicateCaptureBatchN = 0;
  for (const validated of validatedCaptures) {
    const existing = captures.get(validated.captureRecord.captureBatchId);
    if (existing) {
      if (!sameCanonical(existing, validated.captureRecord)) throw new Error('CAPTURE_BATCH_IDENTITY_COLLISION');
      duplicateCaptureBatchN += 1;
      continue;
    }
    captures.set(validated.captureRecord.captureBatchId, validated.captureRecord);
    rawObservations.push(...validated.observations);
    insertedCaptureBatchN += 1;
  }
  return Object.freeze({
    captureBatches: Object.freeze([...captures.values()]),
    rawAcceptedObservations: Object.freeze(rawObservations),
    insertedCaptureBatchN,
    duplicateCaptureBatchN,
  });
}

export async function persistPublicForwardLiquidityCanonicalCaptures({
  stateRoot,
  researchRepoRoot,
  storeContract,
  producerCodeSha,
  captures,
}) {
  const producerSha = exactSha(producerCodeSha, 'PRODUCER_CODE_SHA_INVALID');
  if (!Array.isArray(captures) || captures.length === 0) throw new Error('CAPTURE_BUNDLES_REQUIRED');
  const validatedCaptures = captures.map((capture) => validateCaptureBundle(capture, producerSha));
  const directory = await canonicalStoreDirectory({ stateRoot, researchRepoRoot, storeContract });
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const datasetPath = join(directory, 'dataset.json');
  const lockPath = join(directory, 'dataset.lock');
  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('CANONICAL_LIQUIDITY_STORE_LOCKED');
    throw error;
  }
  try {
    let previousDataset = null;
    try {
      previousDataset = JSON.parse(await readFile(datasetPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (previousDataset) {
      const verification = verifyPublicForwardLiquidityCanonicalDataset(previousDataset);
      if (!verification.valid) throw new Error(`CANONICAL_LIQUIDITY_DATASET_CHAIN_BROKEN:${verification.reason}`);
    }
    const merged = mergeCaptureRecords(previousDataset, validatedCaptures);
    const dataset = withDatasetDigest(buildDatasetCore(merged.captureBatches, merged.rawAcceptedObservations));
    const changed = previousDataset?.datasetDigest !== dataset.datasetDigest;
    if (changed) {
      const temporaryPath = join(directory, `dataset.${process.pid}.${Date.now()}.tmp`);
      const temporaryHandle = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporaryHandle.writeFile(`${canonicalLiquidityJson(dataset)}\n`, 'utf8');
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await rename(temporaryPath, datasetPath);
    }
    const reportBody = {
      schemaVersion: 'public-forward-liquidity-canonical-persistence-report-v1',
      datasetDigest: dataset.datasetDigest,
      previousDatasetDigest: previousDataset?.datasetDigest ?? null,
      changed,
      insertedCaptureBatchN: merged.insertedCaptureBatchN,
      duplicateCaptureBatchN: merged.duplicateCaptureBatchN,
      ...dataset.counts,
      TRAIN_N: 0,
      VALIDATION_N: 0,
      OOS_N: 0,
      OOS_CONTAMINATION: null,
      calibrationArtifactProduced: false,
      liquidityImpactStatus: 'BLOCKED_DATA',
      fullCostReady: false,
      evidenceComplete: 0,
      executionAuthority: 'NONE',
      privateApiUsed: false,
      liveTrading: false,
      orderSubmitted: false,
    };
    return Object.freeze({
      dataset,
      datasetPath,
      report: Object.freeze({
        ...reportBody,
        reportDigest: computePublicForwardLiquidityCanonicalDigest(reportBody),
      }),
    });
  } finally {
    await lockHandle?.close();
    await rm(lockPath, { force: true });
  }
}
