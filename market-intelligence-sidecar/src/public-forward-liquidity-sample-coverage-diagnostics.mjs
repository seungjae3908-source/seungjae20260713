import {
  CALIBRATION_RESEARCH_SAMPLE,
  canonicalJson,
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  sha256,
  verifyLiquidityCalibrationDataset,
} from './public-forward-liquidity-calibration.mjs';
import { analyzePublicForwardLiquidityDropQuality } from './public-forward-liquidity-drop-diagnostics.mjs';

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

const SAMPLE_CLASSES = new Set([
  FORWARD_NATURAL_SAMPLE,
  CALIBRATION_RESEARCH_SAMPLE,
]);

const PUBLIC_ENDPOINTS = new Set([
  '/api/v3/market/orderbook',
  '/api/v3/market/fills',
]);

const PRODUCER_MISSING_FLAGS = new Set([
  'POST_EVENT_PUBLIC_OBSERVATION_MISSING',
  'VISIBLE_DEPTH_INSUFFICIENT_FOR_FLOW_QUANTITY',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function positiveFinite(value, code) {
  if (!(Number.isFinite(value) && value > 0)) throw new Error(code);
  return value;
}

function nonNegativeFinite(value, code) {
  if (!(Number.isFinite(value) && value >= 0)) throw new Error(code);
  return value;
}

function positiveTimestamp(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
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
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(code);
  return normalized;
}

function exactSampleClass(value) {
  if (!SAMPLE_CLASSES.has(value)) throw new Error('COVERAGE_SAMPLE_CLASS_INVALID');
  return value;
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
    safety?.publicDataOnly !== true
    || safety?.simulatedPaperOrderIsMarketImpactEvent !== false
    || safety?.postEventObservationIsExecutionCost !== false
    || safety?.historicalBackfillForwardCredit !== 0
    || safety?.executionAuthority !== 'NONE'
    || safety?.privateTradingApiAllowed !== false
    || safety?.liveTradingAllowed !== false
    || safety?.realOrderAllowed !== false
    || safety?.financialMutationAllowed !== false
  ) throw new Error('COVERAGE_SOURCE_SAFETY_INVALID');
}

function validatePublicProvenance(source, provenance) {
  const root = object(provenance);
  const rawSource = object(root?.rawSource);
  const endpoints = Array.isArray(rawSource?.endpoints) ? new Set(rawSource.endpoints) : null;
  if (
    rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || rawSource?.privateApiUsed !== false
    || !Array.isArray(rawSource?.endpoints)
    || rawSource.endpoints.length !== PUBLIC_ENDPOINTS.size
    || endpoints.size !== PUBLIC_ENDPOINTS.size
    || [...PUBLIC_ENDPOINTS].some((endpoint) => !endpoints.has(endpoint))
  ) throw new Error('COVERAGE_PUBLIC_PROVENANCE_INVALID');

  validateSourceSafety(source);
  const eventCount = nonNegativeInteger(root.eventCount, 'COVERAGE_EVENT_COUNT_INVALID');
  const droppedCount = nonNegativeInteger(root.droppedCount, 'COVERAGE_DROPPED_COUNT_INVALID');
  const collectorCodeSha = exactSha(root.collectorCodeSha, 'COVERAGE_COLLECTOR_SHA_INVALID');
  exactDigest(root.rawDigest, 'COVERAGE_RAW_DIGEST_INVALID');
  const normalizedDigest = exactDigest(root.normalizedDigest, 'COVERAGE_NORMALIZED_DIGEST_INVALID');
  let firstObservedAtMs = null;
  let lastObservedAtMs = null;
  if (eventCount === 0) {
    if (root.firstObservedAtMs !== null || root.lastObservedAtMs !== null) {
      throw new Error('COVERAGE_OBSERVED_PERIOD_INVALID');
    }
  } else {
    firstObservedAtMs = positiveTimestamp(root.firstObservedAtMs, 'COVERAGE_OBSERVED_PERIOD_INVALID');
    lastObservedAtMs = positiveTimestamp(root.lastObservedAtMs, 'COVERAGE_OBSERVED_PERIOD_INVALID');
    if (lastObservedAtMs < firstObservedAtMs) throw new Error('COVERAGE_OBSERVED_PERIOD_INVALID');
  }
  return Object.freeze({
    eventCount,
    droppedCount,
    collectorCodeSha,
    normalizedDigest,
    firstObservedAtMs,
    lastObservedAtMs,
  });
}

function normalizedInput(payload) {
  const root = object(payload);
  if (!root || root.schemaVersion !== 1 || root.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT) {
    throw new Error('COVERAGE_INPUT_CONTRACT_INVALID');
  }
  validateSourceSafety(root);
  const sampleClass = exactSampleClass(root.sampleClass);

  if (root.kind === 'public-forward-liquidity-calibration-dataset') {
    const verification = verifyLiquidityCalibrationDataset(root);
    if (!verification.valid) throw new Error(`COVERAGE_DATASET_INVALID:${verification.reason}`);
    const provenance = validatePublicProvenance(root, root.datasetProvenance);
    if (
      exactSha(root.collectorCodeSha, 'COVERAGE_DATASET_COLLECTOR_SHA_INVALID') !== provenance.collectorCodeSha
      || root.sampleClass !== sampleClass
    ) throw new Error('COVERAGE_DATASET_IDENTITY_MISMATCH');
    if (!Array.isArray(root.observations) || provenance.eventCount !== root.observations.length) {
      throw new Error('COVERAGE_EVENT_COUNT_MISMATCH');
    }
    return Object.freeze({ inputKind: 'DATASET', observations: root.observations, provenance, sampleClass });
  }

  if (root.kind === 'public-forward-liquidity-calibration-batch') {
    if (root.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true || !Array.isArray(root.observations)) {
      throw new Error('COVERAGE_BATCH_INVALID');
    }
    const provenance = validatePublicProvenance(root, root.datasetProvenance);
    if (provenance.eventCount !== root.observations.length) throw new Error('COVERAGE_EVENT_COUNT_MISMATCH');
    return Object.freeze({ inputKind: 'BATCH', observations: root.observations, provenance, sampleClass });
  }

  throw new Error('COVERAGE_INPUT_KIND_INVALID');
}

function validatePublicQuery(value, symbol, limit, code) {
  const query = new URLSearchParams(nonEmptyString(value, code));
  if (
    [...query].length !== 3
    || query.getAll('category').length !== 1
    || query.getAll('symbol').length !== 1
    || query.getAll('limit').length !== 1
    || query.get('category') !== 'USDT-FUTURES'
    || query.get('symbol') !== symbol
    || query.get('limit') !== limit
  ) throw new Error(code);
}

function sourceFrameIdentity(observation, symbol) {
  const provenance = object(observation?.rawSourceProvenance);
  const preEventBook = object(provenance?.preEventBook);
  const publicTrade = object(provenance?.publicTrade);
  const postEventBooks = provenance?.postEventBooks;
  if (
    !preEventBook
    || !publicTrade
    || !Array.isArray(postEventBooks)
    || preEventBook.provider !== 'BITGET_PUBLIC_UTA_V3'
    || preEventBook.endpoint !== '/api/v3/market/orderbook'
    || publicTrade.provider !== 'BITGET_PUBLIC_UTA_V3'
    || publicTrade.endpoint !== '/api/v3/market/fills'
    || postEventBooks.some((entry) => object(entry)?.endpoint !== '/api/v3/market/orderbook')
  ) {
    throw new Error('COVERAGE_SOURCE_FRAME_PROVENANCE_INVALID');
  }
  validatePublicQuery(preEventBook.query, symbol, '50', 'COVERAGE_PRE_EVENT_BOOK_QUERY_INVALID');
  validatePublicQuery(publicTrade.query, symbol, '100', 'COVERAGE_PUBLIC_TRADE_QUERY_INVALID');
  for (const entry of postEventBooks) {
    validatePublicQuery(object(entry)?.query, symbol, '50', 'COVERAGE_POST_EVENT_BOOK_QUERY_INVALID');
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
  const postEventBookFrames = postEventBooks.map((value, index) => {
    const entry = object(value);
    return Object.freeze({
      rawPayloadDigest: postEventBookDigests[index],
      marketTimestampMs: positiveTimestamp(entry.marketTimestampMs, 'COVERAGE_POST_EVENT_SOURCE_TIMESTAMP_INVALID'),
      receiveTimestampMs: positiveTimestamp(entry.receiveTimestampMs, 'COVERAGE_POST_EVENT_SOURCE_RECEIVE_TIMESTAMP_INVALID'),
    });
  });
  return Object.freeze({
    provenance,
    publicExecutionId: nonEmptyString(publicTrade.publicExecutionId, 'COVERAGE_PUBLIC_EXECUTION_ID_INVALID'),
    publicTradeReceiveTimestampMs: positiveTimestamp(
      publicTrade.receiveTimestampMs,
      'COVERAGE_PUBLIC_TRADE_RECEIVE_TIMESTAMP_INVALID',
    ),
    preEventBookDigest,
    publicTradeFrameDigest,
    postEventBookDigests: Object.freeze(postEventBookDigests),
    postEventBookFrames: Object.freeze(postEventBookFrames),
    compositeSourceFrameGroup: `${preEventBookDigest}|${publicTradeFrameDigest}|${postEventBookDigests.join(',')}`,
  });
}

function validatePostEventDrift(item, {
  observationId,
  eventTimestampMs,
  receiveTimestampMs,
  postEventBookFrames,
}) {
  if (!Array.isArray(item.subsequentPublicPriceDrift)) throw new Error('COVERAGE_POST_EVENT_DRIFT_INVALID');
  if (item.subsequentPublicPriceDrift.length !== postEventBookFrames.length) {
    throw new Error('COVERAGE_POST_EVENT_FRAME_COUNT_MISMATCH');
  }
  return item.subsequentPublicPriceDrift.map((value, index) => {
    const entry = object(value);
    if (
      !entry
      || entry.kind !== 'SUBSEQUENT_PUBLIC_PRICE_DRIFT'
      || entry.calibrationSourceOnly !== true
      || entry.executionCostEligible !== false
    ) throw new Error('COVERAGE_POST_EVENT_DRIFT_INVALID');
    const marketTimestampMs = positiveTimestamp(entry.marketTimestampMs, 'COVERAGE_POST_EVENT_TIMESTAMP_INVALID');
    const postReceiveTimestampMs = positiveTimestamp(entry.receiveTimestampMs, 'COVERAGE_POST_EVENT_RECEIVE_TIMESTAMP_INVALID');
    if (marketTimestampMs < eventTimestampMs || postReceiveTimestampMs < receiveTimestampMs) {
      throw new Error('COVERAGE_POST_EVENT_CHRONOLOGY_INVALID');
    }
    const horizonMs = nonNegativeFinite(entry.horizonMs, 'COVERAGE_POST_EVENT_HORIZON_INVALID');
    if (!Number.isSafeInteger(horizonMs) || horizonMs !== marketTimestampMs - eventTimestampMs) {
      throw new Error('COVERAGE_POST_EVENT_HORIZON_MISMATCH');
    }
    positiveFinite(entry.bestBid, 'COVERAGE_POST_EVENT_BOOK_INVALID');
    positiveFinite(entry.bestAsk, 'COVERAGE_POST_EVENT_BOOK_INVALID');
    positiveFinite(entry.mid, 'COVERAGE_POST_EVENT_BOOK_INVALID');
    nonNegativeFinite(entry.spread, 'COVERAGE_POST_EVENT_BOOK_INVALID');
    if (!Number.isFinite(entry.midDriftBps)) throw new Error('COVERAGE_POST_EVENT_DRIFT_INVALID');
    const bookDigest = exactDigest(entry.bookDigest, 'COVERAGE_POST_EVENT_BOOK_DIGEST_INVALID');
    const rawSourceDigest = exactDigest(entry.rawSourceDigest, 'COVERAGE_POST_EVENT_RAW_DIGEST_INVALID');
    const sourceFrame = postEventBookFrames[index];
    if (
      rawSourceDigest !== sourceFrame.rawPayloadDigest
      || marketTimestampMs !== sourceFrame.marketTimestampMs
      || postReceiveTimestampMs !== sourceFrame.receiveTimestampMs
    ) throw new Error('COVERAGE_POST_EVENT_SOURCE_FRAME_MISMATCH');
    const expectedIdentity = `post-drift:${sha256(canonicalJson({
      kind: 'SUBSEQUENT_PUBLIC_PRICE_DRIFT',
      observationId,
      eventTimestampMs,
      observedMarketTimestampMs: marketTimestampMs,
      observedBookDigest: bookDigest,
    }))}`;
    if (entry.identity !== expectedIdentity) throw new Error('COVERAGE_POST_EVENT_IDENTITY_MISMATCH');
    return horizonMs;
  });
}

function validateBookWalk(item, { observationId, aggressiveSide, quantity, preEventBookDigest }) {
  const bookWalk = object(item.instantaneousVisibleDepthBookWalk);
  if (
    !bookWalk
    || bookWalk.kind !== 'INSTANTANEOUS_VISIBLE_DEPTH_BOOK_WALK'
    || bookWalk.ownership !== 'SLIPPAGE_VISIBLE_L2_BOOK_WALK_ONLY'
    || bookWalk.calibrationSourceOnly !== true
    || bookWalk.liquidityImpactCoefficient !== null
    || bookWalk.permanentMarketImpactEstimated !== false
    || typeof bookWalk.completeWithinVisibleDepth !== 'boolean'
  ) throw new Error('COVERAGE_BOOK_WALK_INVALID');
  const requestedQuantity = positiveFinite(bookWalk.requestedQuantity, 'COVERAGE_BOOK_WALK_QUANTITY_INVALID');
  const visibleFilledQuantity = nonNegativeFinite(bookWalk.visibleFilledQuantity, 'COVERAGE_BOOK_WALK_QUANTITY_INVALID');
  const visibleUnfilledQuantity = nonNegativeFinite(bookWalk.visibleUnfilledQuantity, 'COVERAGE_BOOK_WALK_QUANTITY_INVALID');
  const accountedQuantityError = Math.abs((visibleFilledQuantity + visibleUnfilledQuantity) - requestedQuantity);
  const accountedQuantityTolerance = Number.EPSILON * Math.max(1, Math.abs(requestedQuantity)) * 8;
  if (
    requestedQuantity !== quantity
    || visibleFilledQuantity > requestedQuantity
    || accountedQuantityError > accountedQuantityTolerance
    || bookWalk.completeWithinVisibleDepth !== (visibleUnfilledQuantity === 0)
  ) throw new Error('COVERAGE_BOOK_WALK_QUANTITY_MISMATCH');
  const expectedIdentity = `book-walk:${sha256(canonicalJson({
    kind: 'INSTANTANEOUS_VISIBLE_DEPTH_BOOK_WALK',
    observationId,
    aggressiveSide,
    requestedQuantity,
    preEventBookDigest,
  }))}`;
  if (bookWalk.identity !== expectedIdentity) throw new Error('COVERAGE_BOOK_WALK_IDENTITY_MISMATCH');
  return bookWalk;
}

function validateObservation(observation, { expectedCollectorSha, expectedSampleClass, seenIds }) {
  const item = object(observation);
  if (!item || item.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT) {
    throw new Error('COVERAGE_OBSERVATION_CONTRACT_INVALID');
  }
  const observationId = String(item.observationId ?? '').trim();
  if (!observationId) throw new Error('COVERAGE_OBSERVATION_ID_MISSING');
  if (seenIds.has(observationId)) throw new Error('COVERAGE_DUPLICATE_OBSERVATION_ID');
  seenIds.add(observationId);

  if (
    item.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
    || item.sampleClass !== expectedSampleClass
    || item.forwardCalibrationSampleCredit !== (expectedSampleClass === FORWARD_NATURAL_SAMPLE ? 1 : 0)
    || item.historicalBackfillForwardCredit !== 0
    || item.calibrationSourceOnly !== true
    || item.executionCostEligible !== false
    || item.causalMarketImpactClaim !== false
    || item.paperOrderSourceAllowed !== false
  ) throw new Error('COVERAGE_OBSERVATION_SOURCE_INVALID');
  validateSourceSafety(item);
  if (exactSha(item.collectorCodeSha, 'COVERAGE_OBSERVATION_COLLECTOR_SHA_INVALID') !== expectedCollectorSha) {
    throw new Error('COVERAGE_OBSERVATION_COLLECTOR_SHA_MISMATCH');
  }
  if (!['BUY', 'SELL'].includes(item.aggressiveSide)) throw new Error('COVERAGE_AGGRESSIVE_SIDE_INVALID');
  if (item.aggressiveSideMethod !== 'BITGET_PUBLIC_TRADE_SIDE_VERIFIED_AT_PRE_EVENT_BBO') {
    throw new Error('COVERAGE_AGGRESSIVE_SIDE_METHOD_INVALID');
  }

  const eventTimestampMs = positiveTimestamp(item.eventTimestampMs, 'COVERAGE_EVENT_TIMESTAMP_INVALID');
  const receiveTimestampMs = positiveTimestamp(item.receiveTimestampMs, 'COVERAGE_RECEIVE_TIMESTAMP_INVALID');
  if (eventTimestampMs > receiveTimestampMs + 5_000) {
    throw new Error('COVERAGE_EVENT_TIMESTAMP_AFTER_LOCAL_RECEIVE');
  }

  const market = nonEmptyString(item.market, 'COVERAGE_MARKET_INVALID');
  const symbol = nonEmptyString(item.symbol, 'COVERAGE_SYMBOL_INVALID');
  if (market !== 'CRYPTO_FUTURES' || !/^[A-Z0-9]+$/u.test(symbol)) throw new Error('COVERAGE_MARKET_IDENTITY_INVALID');
  const quantity = positiveFinite(item.tradeFlowQuantity, 'COVERAGE_QUANTITY_INVALID');
  const notional = positiveFinite(item.tradeFlowNotional, 'COVERAGE_NOTIONAL_INVALID');
  const spreadBps = positiveFinite(item.preEventSpreadBps, 'COVERAGE_SPREAD_BPS_INVALID');
  const publicExecutionPrice = positiveFinite(item.publicExecutionPrice, 'COVERAGE_EXECUTION_PRICE_INVALID');
  const bestBid = positiveFinite(item.preEventBestBid, 'COVERAGE_PRE_EVENT_BOOK_INVALID');
  const bestAsk = positiveFinite(item.preEventBestAsk, 'COVERAGE_PRE_EVENT_BOOK_INVALID');
  const mid = positiveFinite(item.preEventMid, 'COVERAGE_PRE_EVENT_BOOK_INVALID');
  const spread = positiveFinite(item.preEventSpread, 'COVERAGE_PRE_EVENT_BOOK_INVALID');
  if (
    bestBid >= bestAsk
    || mid !== (bestBid + bestAsk) / 2
    || spread !== bestAsk - bestBid
    || spreadBps !== (spread / mid) * 10_000
    || notional !== quantity * publicExecutionPrice
  ) throw new Error('COVERAGE_OBSERVATION_NUMERIC_IDENTITY_MISMATCH');

  if (!Array.isArray(item.missingDataFlags)) throw new Error('COVERAGE_MISSING_FLAGS_INVALID');
  const missingDataFlags = item.missingDataFlags.map((flag) => String(flag ?? '').trim());
  if (missingDataFlags.some((flag) => !flag)) throw new Error('COVERAGE_MISSING_FLAG_EMPTY');
  if (new Set(missingDataFlags).size !== missingDataFlags.length) throw new Error('COVERAGE_DUPLICATE_MISSING_FLAG');
  if (missingDataFlags.some((flag) => !PRODUCER_MISSING_FLAGS.has(flag))) throw new Error('COVERAGE_MISSING_FLAG_INVALID');

  const sourceFrame = sourceFrameIdentity(item, symbol);
  if (sourceFrame.publicTradeReceiveTimestampMs !== receiveTimestampMs) {
    throw new Error('COVERAGE_PUBLIC_TRADE_RECEIVE_TIMESTAMP_MISMATCH');
  }
  const preEventBookDigest = exactDigest(item.preEventBookDigest, 'COVERAGE_PRE_EVENT_BOOK_DIGEST_INVALID');
  const identityInput = {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    publicDataSource: 'BITGET_PUBLIC_UTA_V3',
    market,
    symbol,
    publicExecutionId: sourceFrame.publicExecutionId,
    eventTimestampMs,
    preEventBookDigest,
  };
  const expectedObservationId = `liquidity-observation:${sha256(canonicalJson(identityInput))}`;
  if (observationId !== expectedObservationId) throw new Error('COVERAGE_OBSERVATION_IDENTITY_MISMATCH');
  const expectedSourceDigest = sha256(canonicalJson({
    identityInput,
    aggressiveSide: item.aggressiveSide,
    price: publicExecutionPrice,
    quantity,
    rawSourceProvenance: sourceFrame.provenance,
  }));
  if (exactDigest(item.sourceDigest, 'COVERAGE_OBSERVATION_SOURCE_DIGEST_INVALID') !== expectedSourceDigest) {
    throw new Error('COVERAGE_OBSERVATION_SOURCE_DIGEST_MISMATCH');
  }
  const horizons = validatePostEventDrift(item, {
    observationId,
    eventTimestampMs,
    receiveTimestampMs,
    postEventBookFrames: sourceFrame.postEventBookFrames,
  });
  const postMissing = missingDataFlags.includes('POST_EVENT_PUBLIC_OBSERVATION_MISSING');
  if (postMissing !== (horizons.length === 0)) throw new Error('COVERAGE_POST_EVENT_MISSING_FLAG_MISMATCH');
  const bookWalk = validateBookWalk(item, {
    observationId,
    aggressiveSide: item.aggressiveSide,
    quantity,
    preEventBookDigest,
  });
  const depthMissing = missingDataFlags.includes('VISIBLE_DEPTH_INSUFFICIENT_FOR_FLOW_QUANTITY');
  if (depthMissing === bookWalk.completeWithinVisibleDepth) throw new Error('COVERAGE_VISIBLE_DEPTH_MISSING_FLAG_MISMATCH');

  return Object.freeze({
    observationId,
    market,
    symbol,
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
  const { inputKind, observations, provenance, sampleClass } = normalizedInput(payload);
  const expectedCollectorSha = exactSha(provenance.collectorCodeSha, 'COVERAGE_COLLECTOR_SHA_INVALID');
  const seenIds = new Set();
  const normalized = observations.map((observation) => validateObservation(observation, {
    expectedCollectorSha,
    expectedSampleClass: sampleClass,
    seenIds,
  }));
  if (provenance.normalizedDigest !== sha256(canonicalJson(observations))) {
    throw new Error('COVERAGE_NORMALIZED_DIGEST_MISMATCH');
  }
  analyzePublicForwardLiquidityDropQuality(payload);

  const eventTimestamps = normalized.map((item) => item.eventTimestampMs).sort((left, right) => left - right);
  if (
    (eventTimestamps[0] ?? null) !== provenance.firstObservedAtMs
    || (eventTimestamps.at(-1) ?? null) !== provenance.lastObservedAtMs
  ) throw new Error('COVERAGE_OBSERVED_PERIOD_MISMATCH');
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
