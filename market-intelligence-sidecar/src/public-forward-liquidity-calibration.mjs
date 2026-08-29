import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  fetchBitgetPublicOrderBookFrame,
  fetchBitgetPublicTradesFrame,
} from './public-data.mjs';

export const PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT =
  'public-forward-liquidity-calibration-observation/v1';
export const PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT =
  'research-production-state-root/forward-liquidity-calibration-v1';
export const FORWARD_NATURAL_SAMPLE = 'FORWARD_NATURAL_SAMPLE';
export const CALIBRATION_RESEARCH_SAMPLE = 'CALIBRATION_RESEARCH_SAMPLE';

const SAMPLE_CLASSES = new Set([FORWARD_NATURAL_SAMPLE, CALIBRATION_RESEARCH_SAMPLE]);
const SAFETY = Object.freeze({
  publicDataOnly: true,
  simulatedPaperOrderIsMarketImpactEvent: false,
  postEventObservationIsExecutionCost: false,
  historicalBackfillForwardCredit: 0,
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  liveTradingAllowed: false,
  realOrderAllowed: false,
  financialMutationAllowed: false,
});
const READINESS = Object.freeze({
  LIQUIDITY_CALIBRATION_DATA_COLLECTOR_READY: true,
  LIQUIDITY_IMPACT_PRESENT: false,
  CALIBRATION_SAMPLE_SUFFICIENT: false,
  LIQUIDITY_IMPACT_STATUS: 'BLOCKED_DATA',
  FULL_COST_READY: false,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

function exactSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error('COLLECTOR_CODE_SHA_INVALID');
  return normalized;
}

function positive(value, code) {
  if (value == null || value === '') throw new Error(code);
  const parsed = Number(value);
  if (!(Number.isFinite(parsed) && parsed > 0)) throw new Error(code);
  return parsed;
}

function timestamp(value, code) {
  return Math.trunc(positive(value, code));
}

function normalizeSampleClass(value) {
  const normalized = String(value ?? FORWARD_NATURAL_SAMPLE).trim().toUpperCase();
  if (!SAMPLE_CLASSES.has(normalized)) throw new Error('CALIBRATION_SAMPLE_CLASS_INVALID');
  return normalized;
}

function rawFrameDigest(frame) {
  return sha256(canonicalJson(frame?.rawPayload ?? null));
}

function assertSameMarketIdentity(preEventBook, tradeFrame) {
  if (
    preEventBook?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || tradeFrame?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || preEventBook?.privateApiUsed !== false
    || tradeFrame?.privateApiUsed !== false
  ) throw new Error('PUBLIC_CALIBRATION_PROVIDER_INVALID');
  if (
    preEventBook.market !== tradeFrame.market
    || preEventBook.symbol !== tradeFrame.symbol
  ) throw new Error('PUBLIC_CALIBRATION_MARKET_IDENTITY_MISMATCH');
}

function validateBookFrame(frame, { previousFrame = null } = {}) {
  const receivedAt = timestamp(frame?.receiveTimestampMs, 'PUBLIC_BOOK_RECEIVE_TIMESTAMP_MISSING');
  const marketAt = timestamp(frame?.marketTimestampMs, 'PUBLIC_BOOK_MARKET_TIMESTAMP_MISSING');
  if (marketAt > receivedAt + 5_000) throw new Error('PUBLIC_BOOK_FUTURE_TIMESTAMP');
  if (!Array.isArray(frame?.bids) || !Array.isArray(frame?.asks) || !frame.bids.length || !frame.asks.length) {
    throw new Error('PUBLIC_BOOK_LEVELS_MISSING');
  }
  const bids = frame.bids.map((level) => ({
    price: positive(level?.price, 'PUBLIC_BOOK_BID_PRICE_INVALID'),
    quantity: positive(level?.quantity, 'PUBLIC_BOOK_BID_QUANTITY_INVALID'),
  }));
  const asks = frame.asks.map((level) => ({
    price: positive(level?.price, 'PUBLIC_BOOK_ASK_PRICE_INVALID'),
    quantity: positive(level?.quantity, 'PUBLIC_BOOK_ASK_QUANTITY_INVALID'),
  }));
  for (let index = 1; index < bids.length; index += 1) {
    if (bids[index].price > bids[index - 1].price) throw new Error('PUBLIC_BOOK_BID_ORDER_INVALID');
  }
  for (let index = 1; index < asks.length; index += 1) {
    if (asks[index].price < asks[index - 1].price) throw new Error('PUBLIC_BOOK_ASK_ORDER_INVALID');
  }
  if (bids[0].price >= asks[0].price) throw new Error('PUBLIC_BOOK_CROSSED');
  if (previousFrame) {
    if (receivedAt < previousFrame.receiveTimestampMs || marketAt < previousFrame.marketTimestampMs) {
      throw new Error('POST_EVENT_BOOK_OUT_OF_ORDER');
    }
  }
  return { receivedAt, marketAt, bids, asks };
}

export function assessPublicCalibrationCapability({ orderBookFrame, tradeFrame }) {
  const fields = {
    timestampedTrades: false,
    tradeQuantity: false,
    tradeNotionalDerivable: false,
    tradePrice: false,
    aggressiveSideVerifiable: false,
    l2BookSnapshot: false,
    bestBidAsk: false,
    visibleDepth: false,
    marketTimestamp: false,
    localReceiveTimestamp: false,
  };
  try {
    assertSameMarketIdentity(orderBookFrame, tradeFrame);
    const book = validateBookFrame(orderBookFrame);
    fields.l2BookSnapshot = book.bids.length > 0 && book.asks.length > 0;
    fields.bestBidAsk = book.bids[0].price > 0 && book.asks[0].price > book.bids[0].price;
    fields.visibleDepth = book.bids.every((level) => level.quantity > 0)
      && book.asks.every((level) => level.quantity > 0);
    fields.marketTimestamp = book.marketAt > 0;
    fields.localReceiveTimestamp = book.receivedAt > 0
      && timestamp(tradeFrame.receiveTimestampMs, 'PUBLIC_TRADE_RECEIVE_TIMESTAMP_MISSING') > 0;
    if (!Array.isArray(tradeFrame.trades) || !tradeFrame.trades.length) throw new Error('PUBLIC_TRADES_MISSING');
    fields.timestampedTrades = tradeFrame.trades.every((trade) => Number.isFinite(Number(trade.eventTimestampMs)));
    fields.tradeQuantity = tradeFrame.trades.every((trade) => Number(trade.quantity) > 0);
    fields.tradePrice = tradeFrame.trades.every((trade) => Number(trade.price) > 0);
    fields.tradeNotionalDerivable = fields.tradeQuantity && fields.tradePrice;
    fields.aggressiveSideVerifiable = tradeFrame.trades.every((trade) => ['buy', 'sell'].includes(trade.providerTradeSide));
  } catch {
    // The field matrix below remains explicit and fail-closed.
  }
  const blockers = Object.entries(fields).filter(([, ready]) => !ready).map(([field]) => `MISSING_${field.toUpperCase()}`);
  return Object.freeze({
    PUBLIC_CALIBRATION_DATA_CAPABLE: blockers.length === 0,
    status: blockers.length === 0 ? 'CAPABLE' : 'BLOCKED_DATA',
    fields: Object.freeze(fields),
    blockers: Object.freeze(blockers),
    publicDataSource: 'BITGET_PUBLIC_UTA_V3',
    privateApiUsed: false,
  });
}

function bookProjection(frame) {
  const book = validateBookFrame(frame);
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const bidQuantity = book.bids.reduce((sum, level) => sum + level.quantity, 0);
  const askQuantity = book.asks.reduce((sum, level) => sum + level.quantity, 0);
  const levels = {
    bids: book.bids,
    asks: book.asks,
  };
  return Object.freeze({
    marketTimestampMs: book.marketAt,
    receiveTimestampMs: book.receivedAt,
    bestBid,
    bestAsk,
    mid,
    spread: bestAsk - bestBid,
    spreadBps: ((bestAsk - bestBid) / mid) * 10_000,
    visibleDepth: Object.freeze({
      bids: Object.freeze(book.bids),
      asks: Object.freeze(book.asks),
      bidQuantity,
      askQuantity,
      bidNotional: book.bids.reduce((sum, level) => sum + level.price * level.quantity, 0),
      askNotional: book.asks.reduce((sum, level) => sum + level.price * level.quantity, 0),
    }),
    bookDigest: sha256(canonicalJson({
      marketTimestampMs: book.marketAt,
      bids: levels.bids,
      asks: levels.asks,
    })),
  });
}

function aggressiveSideAtPreEventTouch(trade, preBook) {
  if (trade.providerTradeSide === 'buy' && trade.price >= preBook.bestAsk) return 'BUY';
  if (trade.providerTradeSide === 'sell' && trade.price <= preBook.bestBid) return 'SELL';
  return null;
}

function walkVisibleDepth({ observationId, aggressiveSide, quantity, preBook }) {
  const levels = aggressiveSide === 'BUY' ? preBook.visibleDepth.asks : preBook.visibleDepth.bids;
  const referencePrice = aggressiveSide === 'BUY' ? preBook.bestAsk : preBook.bestBid;
  let remaining = quantity;
  let filled = 0;
  let notional = 0;
  let terminalPrice = null;
  for (const level of levels) {
    if (remaining <= 0) break;
    const consumed = Math.min(remaining, level.quantity);
    filled += consumed;
    notional += consumed * level.price;
    remaining -= consumed;
    terminalPrice = level.price;
  }
  const averagePrice = filled > 0 ? notional / filled : null;
  const signedWalkBps = averagePrice == null ? null : aggressiveSide === 'BUY'
    ? ((averagePrice - referencePrice) / referencePrice) * 10_000
    : ((referencePrice - averagePrice) / referencePrice) * 10_000;
  const identityInput = {
    kind: 'INSTANTANEOUS_VISIBLE_DEPTH_BOOK_WALK',
    observationId,
    aggressiveSide,
    requestedQuantity: quantity,
    preEventBookDigest: preBook.bookDigest,
  };
  return Object.freeze({
    identity: `book-walk:${sha256(canonicalJson(identityInput))}`,
    kind: identityInput.kind,
    ownership: 'SLIPPAGE_VISIBLE_L2_BOOK_WALK_ONLY',
    calibrationSourceOnly: true,
    liquidityImpactCoefficient: null,
    permanentMarketImpactEstimated: false,
    requestedQuantity: quantity,
    visibleFilledQuantity: filled,
    visibleUnfilledQuantity: Math.max(0, remaining),
    referencePrice,
    averageWalkPrice: averagePrice,
    terminalPrice,
    signedWalkBps,
    completeWithinVisibleDepth: remaining <= 0,
  });
}

function postEventObservations({ observationId, eventTimestampMs, eventReceiveTimestampMs, preBook, frames }) {
  const observations = [];
  let previous = null;
  for (const frame of frames) {
    if (frame.provider !== 'BITGET_PUBLIC_UTA_V3' || frame.market !== 'CRYPTO_FUTURES') {
      throw new Error('POST_EVENT_PUBLIC_SOURCE_INVALID');
    }
    const book = validateBookFrame(frame, { previousFrame: previous });
    if (book.marketAt < eventTimestampMs || book.receivedAt < eventReceiveTimestampMs) {
      throw new Error('POST_EVENT_CHRONOLOGY_INVALID');
    }
    const projection = bookProjection(frame);
    const identityInput = {
      kind: 'SUBSEQUENT_PUBLIC_PRICE_DRIFT',
      observationId,
      eventTimestampMs,
      observedMarketTimestampMs: projection.marketTimestampMs,
      observedBookDigest: projection.bookDigest,
    };
    observations.push(Object.freeze({
      identity: `post-drift:${sha256(canonicalJson(identityInput))}`,
      kind: identityInput.kind,
      calibrationSourceOnly: true,
      executionCostEligible: false,
      horizonMs: projection.marketTimestampMs - eventTimestampMs,
      marketTimestampMs: projection.marketTimestampMs,
      receiveTimestampMs: projection.receiveTimestampMs,
      bestBid: projection.bestBid,
      bestAsk: projection.bestAsk,
      mid: projection.mid,
      spread: projection.spread,
      midDriftBps: ((projection.mid - preBook.mid) / preBook.mid) * 10_000,
      bookDigest: projection.bookDigest,
      rawSourceDigest: rawFrameDigest(frame),
    }));
    previous = frame;
  }
  return Object.freeze(observations);
}

function droppedReasonCounts(droppedEvents) {
  const counts = {};
  for (const dropped of droppedEvents) counts[dropped.reason] = (counts[dropped.reason] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));
}

export function buildPublicLiquidityObservationBatch({
  preEventBook,
  tradeFrame,
  postEventBooks = [],
  collectorCodeSha,
  sampleClass = FORWARD_NATURAL_SAMPLE,
  maxPreEventBookAgeMs = 5_000,
}) {
  const codeSha = exactSha(collectorCodeSha);
  const normalizedSampleClass = normalizeSampleClass(sampleClass);
  assertSameMarketIdentity(preEventBook, tradeFrame);
  const capability = assessPublicCalibrationCapability({ orderBookFrame: preEventBook, tradeFrame });
  if (!capability.PUBLIC_CALIBRATION_DATA_CAPABLE) {
    const error = new Error('PUBLIC_CALIBRATION_DATA_CAPABLE_FALSE');
    error.blockers = capability.blockers;
    throw error;
  }
  const preBook = bookProjection(preEventBook);
  const eventReceiveTimestampMs = timestamp(tradeFrame.receiveTimestampMs, 'PUBLIC_TRADE_RECEIVE_TIMESTAMP_MISSING');
  if (preBook.receiveTimestampMs > eventReceiveTimestampMs) throw new Error('PRE_EVENT_BOOK_RECEIVED_AFTER_TRADES');
  const rawBookDigest = rawFrameDigest(preEventBook);
  const rawTradeFrameDigest = rawFrameDigest(tradeFrame);
  const rawPostDigests = postEventBooks.map(rawFrameDigest);
  const observations = [];
  const droppedEvents = [];
  const seenIds = new Set();

  for (const trade of [...tradeFrame.trades].sort((left, right) => left.eventTimestampMs - right.eventTimestampMs || left.execId.localeCompare(right.execId))) {
    let reason = null;
    if (trade.eventTimestampMs <= preBook.marketTimestampMs) reason = 'EVENT_NOT_AFTER_PRE_EVENT_BOOK';
    else if (trade.eventTimestampMs - preBook.marketTimestampMs > maxPreEventBookAgeMs) reason = 'PRE_EVENT_BOOK_STALE_FOR_EVENT';
    else if (trade.eventTimestampMs > eventReceiveTimestampMs + 5_000) reason = 'EVENT_TIMESTAMP_AFTER_LOCAL_RECEIVE';
    const aggressiveSide = reason ? null : aggressiveSideAtPreEventTouch(trade, preBook);
    if (!reason && !aggressiveSide) reason = 'AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO';
    if (reason) {
      droppedEvents.push(Object.freeze({
        publicExecutionId: trade.execId,
        eventTimestampMs: trade.eventTimestampMs,
        reason,
      }));
      continue;
    }

    const identityInput = {
      contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
      publicDataSource: 'BITGET_PUBLIC_UTA_V3',
      market: preEventBook.market,
      symbol: preEventBook.symbol,
      publicExecutionId: trade.execId,
      eventTimestampMs: trade.eventTimestampMs,
      preEventBookDigest: preBook.bookDigest,
    };
    const observationId = `liquidity-observation:${sha256(canonicalJson(identityInput))}`;
    if (seenIds.has(observationId)) {
      droppedEvents.push(Object.freeze({
        publicExecutionId: trade.execId,
        eventTimestampMs: trade.eventTimestampMs,
        reason: 'DUPLICATE_OBSERVATION_ID',
      }));
      continue;
    }
    seenIds.add(observationId);

    let postObservations;
    try {
      postObservations = postEventObservations({
        observationId,
        eventTimestampMs: trade.eventTimestampMs,
        eventReceiveTimestampMs,
        preBook,
        frames: postEventBooks,
      });
    } catch (error) {
      droppedEvents.push(Object.freeze({
        publicExecutionId: trade.execId,
        eventTimestampMs: trade.eventTimestampMs,
        reason: String(error?.message ?? 'POST_EVENT_OBSERVATION_INVALID'),
      }));
      continue;
    }

    const missingDataFlags = [];
    if (!postObservations.length) missingDataFlags.push('POST_EVENT_PUBLIC_OBSERVATION_MISSING');
    const bookWalk = walkVisibleDepth({
      observationId,
      aggressiveSide,
      quantity: trade.quantity,
      preBook,
    });
    if (!bookWalk.completeWithinVisibleDepth) missingDataFlags.push('VISIBLE_DEPTH_INSUFFICIENT_FOR_FLOW_QUANTITY');
    const rawTradeDigest = sha256(canonicalJson(trade.raw));
    const rawSourceProvenance = Object.freeze({
      preEventBook: Object.freeze({
        provider: preEventBook.provider,
        endpoint: preEventBook.endpoint,
        query: preEventBook.query,
        marketTimestampMs: preBook.marketTimestampMs,
        receiveTimestampMs: preBook.receiveTimestampMs,
        rawPayloadDigest: rawBookDigest,
      }),
      publicTrade: Object.freeze({
        provider: tradeFrame.provider,
        endpoint: tradeFrame.endpoint,
        query: tradeFrame.query,
        publicExecutionId: trade.execId,
        publicExecutionLinkId: trade.execLinkId,
        receiveTimestampMs: eventReceiveTimestampMs,
        rawFrameDigest: rawTradeFrameDigest,
        rawTradeDigest,
      }),
      postEventBooks: Object.freeze(postEventBooks.map((frame, index) => Object.freeze({
        endpoint: frame.endpoint,
        query: frame.query,
        marketTimestampMs: frame.marketTimestampMs,
        receiveTimestampMs: frame.receiveTimestampMs,
        rawPayloadDigest: rawPostDigests[index],
      }))),
    });
    const sourceDigest = sha256(canonicalJson({
      identityInput,
      aggressiveSide,
      price: trade.price,
      quantity: trade.quantity,
      rawSourceProvenance,
    }));
    observations.push(Object.freeze({
      contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
      observationId,
      sampleClass: normalizedSampleClass,
      forwardCalibrationSampleCredit: normalizedSampleClass === FORWARD_NATURAL_SAMPLE ? 1 : 0,
      historicalBackfillForwardCredit: 0,
      market: preEventBook.market,
      symbol: preEventBook.symbol,
      eventTimestampMs: trade.eventTimestampMs,
      receiveTimestampMs: eventReceiveTimestampMs,
      aggressiveSide,
      aggressiveSideMethod: 'BITGET_PUBLIC_TRADE_SIDE_VERIFIED_AT_PRE_EVENT_BBO',
      tradeFlowQuantity: trade.quantity,
      tradeFlowNotional: trade.quantity * trade.price,
      publicExecutionPrice: trade.price,
      preEventBestBid: preBook.bestBid,
      preEventBestAsk: preBook.bestAsk,
      preEventMid: preBook.mid,
      preEventSpread: preBook.spread,
      preEventSpreadBps: preBook.spreadBps,
      preEventVisibleL2Depth: preBook.visibleDepth,
      preEventBookDigest: preBook.bookDigest,
      instantaneousVisibleDepthBookWalk: bookWalk,
      subsequentPublicPriceDrift: postObservations,
      publicDataSource: 'BITGET_PUBLIC_UTA_V3',
      rawSourceProvenance,
      sourceDigest,
      collectorCodeSha: codeSha,
      missingDataFlags: Object.freeze(missingDataFlags.sort()),
      calibrationSourceOnly: true,
      executionCostEligible: false,
      liquidityImpactCoefficient: null,
      causalMarketImpactClaim: false,
      paperOrderSourceAllowed: false,
      safety: SAFETY,
    }));
  }

  const collectionStartedAtMs = Math.min(
    preEventBook.requestStartedAtMs,
    tradeFrame.requestStartedAtMs,
    ...postEventBooks.map((frame) => frame.requestStartedAtMs),
  );
  const collectionCompletedAtMs = Math.max(
    preEventBook.receiveTimestampMs,
    tradeFrame.receiveTimestampMs,
    ...postEventBooks.map((frame) => frame.receiveTimestampMs),
  );
  const rawDigest = sha256(canonicalJson({ rawBookDigest, rawTradeFrameDigest, rawPostDigests }));
  const normalizedDigest = sha256(canonicalJson(observations));
  const datasetProvenance = Object.freeze({
    rawSource: Object.freeze({
      provider: 'BITGET_PUBLIC_UTA_V3',
      endpoints: Object.freeze(['/api/v3/market/orderbook', '/api/v3/market/fills']),
      privateApiUsed: false,
    }),
    collectionPeriod: Object.freeze({
      startedAtMs: collectionStartedAtMs,
      completedAtMs: collectionCompletedAtMs,
    }),
    firstObservedAtMs: observations.length ? Math.min(...observations.map((item) => item.eventTimestampMs)) : null,
    lastObservedAtMs: observations.length ? Math.max(...observations.map((item) => item.eventTimestampMs)) : null,
    eventCount: observations.length,
    droppedCount: droppedEvents.length,
    droppedReasons: droppedReasonCounts(droppedEvents),
    rawDigest,
    normalizedDigest,
    collectorCodeSha: codeSha,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-batch',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    sampleClass: normalizedSampleClass,
    capability,
    observations: Object.freeze(observations),
    droppedEvents: Object.freeze(droppedEvents),
    datasetProvenance,
    readiness: READINESS,
    safety: SAFETY,
  });
}

export async function probeBitgetPublicCalibrationCapability({
  symbol = 'BTCUSDT',
  fetchOrderBookFrame = fetchBitgetPublicOrderBookFrame,
  fetchTradesFrame = fetchBitgetPublicTradesFrame,
} = {}) {
  const [orderBookFrame, tradeFrame] = await Promise.all([
    fetchOrderBookFrame(symbol),
    fetchTradesFrame(symbol),
  ]);
  return assessPublicCalibrationCapability({ orderBookFrame, tradeFrame });
}

export async function collectBitgetForwardLiquidityObservationBatch({
  symbol = 'BTCUSDT',
  collectorCodeSha,
  sampleClass = FORWARD_NATURAL_SAMPLE,
  eventObservationDelayMs = 2_000,
  postObservationDelaysMs = [1_000, 5_000],
  fetchOrderBookFrame = fetchBitgetPublicOrderBookFrame,
  fetchTradesFrame = fetchBitgetPublicTradesFrame,
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  maxPreEventBookAgeMs = 5_000,
} = {}) {
  const preEventBook = await fetchOrderBookFrame(symbol);
  if (!(Number.isFinite(Number(eventObservationDelayMs)) && Number(eventObservationDelayMs) >= 0)) {
    throw new Error('EVENT_OBSERVATION_DELAY_INVALID');
  }
  if (Number(eventObservationDelayMs) > 0) await sleep(Number(eventObservationDelayMs));
  const tradeFrame = await fetchTradesFrame(symbol);
  const postEventBooks = [];
  for (const delayMs of postObservationDelaysMs) {
    if (!(Number.isFinite(Number(delayMs)) && Number(delayMs) >= 0)) throw new Error('POST_OBSERVATION_DELAY_INVALID');
    if (Number(delayMs) > 0) await sleep(Number(delayMs));
    postEventBooks.push(await fetchOrderBookFrame(symbol));
  }
  return buildPublicLiquidityObservationBatch({
    preEventBook,
    tradeFrame,
    postEventBooks,
    collectorCodeSha,
    sampleClass,
    maxPreEventBookAgeMs,
  });
}

function datasetCore({ collectorCodeSha, sampleClass, predecessorDigest, observations, batchProvenance, duplicateAttempts }) {
  const rawDigest = sha256(canonicalJson(batchProvenance.map((item) => item.rawDigest).sort()));
  const normalizedDigest = sha256(canonicalJson(observations));
  const aggregateDroppedReasons = {};
  for (const provenance of batchProvenance) {
    for (const [reason, count] of Object.entries(provenance.droppedReasons ?? {})) {
      aggregateDroppedReasons[reason] = (aggregateDroppedReasons[reason] ?? 0) + Number(count);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-dataset',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    collectorCodeSha,
    sampleClass,
    predecessorDigest,
    observations: Object.freeze(observations),
    batchProvenance: Object.freeze(batchProvenance),
    duplicateAttempts: Object.freeze(duplicateAttempts),
    datasetProvenance: Object.freeze({
      rawSource: Object.freeze({
        provider: 'BITGET_PUBLIC_UTA_V3',
        endpoints: Object.freeze(['/api/v3/market/orderbook', '/api/v3/market/fills']),
        privateApiUsed: false,
      }),
      collectionPeriod: Object.freeze({
        startedAtMs: batchProvenance.length ? Math.min(...batchProvenance.map((item) => item.collectionPeriod.startedAtMs)) : null,
        completedAtMs: batchProvenance.length ? Math.max(...batchProvenance.map((item) => item.collectionPeriod.completedAtMs)) : null,
      }),
      firstObservedAtMs: observations.length ? Math.min(...observations.map((item) => item.eventTimestampMs)) : null,
      lastObservedAtMs: observations.length ? Math.max(...observations.map((item) => item.eventTimestampMs)) : null,
      eventCount: observations.length,
      droppedCount: batchProvenance.reduce((sum, item) => sum + item.droppedCount, 0),
      droppedReasons: Object.freeze(Object.fromEntries(
        Object.entries(aggregateDroppedReasons).sort(([left], [right]) => left.localeCompare(right)),
      )),
      rawDigest,
      normalizedDigest,
      collectorCodeSha,
    }),
    readiness: READINESS,
    safety: SAFETY,
  });
}

function withDatasetDigest(core) {
  return Object.freeze({ ...core, datasetDigest: sha256(canonicalJson(core)) });
}

export function verifyLiquidityCalibrationDataset(dataset) {
  try {
    if (
      dataset?.schemaVersion !== 1
      || dataset?.kind !== 'public-forward-liquidity-calibration-dataset'
      || dataset?.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
      || dataset?.storeContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT
    ) return Object.freeze({ valid: false, reason: 'DATASET_CONTRACT_INVALID' });
    exactSha(dataset.collectorCodeSha);
    normalizeSampleClass(dataset.sampleClass);
    if (!Array.isArray(dataset.observations) || !Array.isArray(dataset.batchProvenance) || !Array.isArray(dataset.duplicateAttempts)) {
      return Object.freeze({ valid: false, reason: 'DATASET_SHAPE_INVALID' });
    }
    const ids = new Set();
    for (const observation of dataset.observations) {
      if (ids.has(observation.observationId)) return Object.freeze({ valid: false, reason: 'DATASET_DUPLICATE_OBSERVATION' });
      ids.add(observation.observationId);
      if (observation.collectorCodeSha !== dataset.collectorCodeSha || observation.sampleClass !== dataset.sampleClass) {
        return Object.freeze({ valid: false, reason: 'DATASET_IDENTITY_MIXING_FORBIDDEN' });
      }
      if (observation.causalMarketImpactClaim !== false || observation.executionCostEligible !== false) {
        return Object.freeze({ valid: false, reason: 'DATASET_AUTHORITY_ESCALATION' });
      }
    }
    const core = datasetCore({
      collectorCodeSha: dataset.collectorCodeSha,
      sampleClass: dataset.sampleClass,
      predecessorDigest: dataset.predecessorDigest ?? null,
      observations: dataset.observations,
      batchProvenance: dataset.batchProvenance,
      duplicateAttempts: dataset.duplicateAttempts,
    });
    if (dataset.datasetDigest !== sha256(canonicalJson(core))) {
      return Object.freeze({ valid: false, reason: 'DATASET_DIGEST_MISMATCH' });
    }
    return Object.freeze({ valid: true, reason: null });
  } catch (error) {
    return Object.freeze({ valid: false, reason: String(error?.message ?? 'DATASET_INVALID') });
  }
}

export function mergeLiquidityCalibrationBatch(previousDataset, batch) {
  const collectorCodeSha = exactSha(batch?.datasetProvenance?.collectorCodeSha);
  const sampleClass = normalizeSampleClass(batch?.sampleClass);
  if (batch?.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT || batch?.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true) {
    throw new Error('CALIBRATION_BATCH_INVALID');
  }
  if (previousDataset) {
    const verification = verifyLiquidityCalibrationDataset(previousDataset);
    if (!verification.valid) throw new Error(`CALIBRATION_DATASET_CHAIN_BROKEN:${verification.reason}`);
    if (previousDataset.collectorCodeSha !== collectorCodeSha || previousDataset.sampleClass !== sampleClass) {
      throw new Error('CALIBRATION_DATASET_IDENTITY_MIXING_FORBIDDEN');
    }
  }
  const existing = new Map((previousDataset?.observations ?? []).map((item) => [item.observationId, item]));
  const duplicates = [...(previousDataset?.duplicateAttempts ?? [])];
  let insertedObservationCount = 0;
  for (const observation of batch.observations) {
    const found = existing.get(observation.observationId);
    if (!found) {
      existing.set(observation.observationId, observation);
      insertedObservationCount += 1;
      continue;
    }
    if (found.sourceDigest !== observation.sourceDigest || canonicalJson(found) !== canonicalJson(observation)) {
      throw new Error('CALIBRATION_OBSERVATION_ID_COLLISION');
    }
    duplicates.push(Object.freeze({
      observationId: observation.observationId,
      sourceDigest: observation.sourceDigest,
      sampleCountDelta: 0,
      reason: 'DUPLICATE_OBSERVATION_CREDIT_FORBIDDEN',
    }));
  }
  const observations = [...existing.values()].sort((left, right) => left.eventTimestampMs - right.eventTimestampMs || left.observationId.localeCompare(right.observationId));
  const batchProvenance = [...(previousDataset?.batchProvenance ?? []), batch.datasetProvenance];
  const core = datasetCore({
    collectorCodeSha,
    sampleClass,
    predecessorDigest: previousDataset?.datasetDigest ?? null,
    observations,
    batchProvenance,
    duplicateAttempts: duplicates,
  });
  return Object.freeze({
    dataset: withDatasetDigest(core),
    insertedObservationCount,
    duplicateObservationCount: batch.observations.length - insertedObservationCount,
    forwardNaturalSampleCreditDelta: sampleClass === FORWARD_NATURAL_SAMPLE ? insertedObservationCount : 0,
    historicalBackfillForwardCreditDelta: 0,
  });
}

function canonicalStoreDirectory({ stateRoot, storeContract, collectorCodeSha, sampleClass }) {
  if (storeContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT) throw new Error('BLOCKED_STORAGE');
  if (!stateRoot || !isAbsolute(stateRoot)) throw new Error('BLOCKED_STORAGE');
  const normalizedRoot = resolve(stateRoot);
  const lowerRoot = normalizedRoot.toLowerCase();
  if (lowerRoot.includes('stock-app-data') || lowerRoot.includes(`${join('api-server', 'supabase')}`.toLowerCase())) {
    throw new Error('BLOCKED_STORAGE');
  }
  return join(
    normalizedRoot,
    'forward',
    'liquidity-calibration-v1',
    normalizeSampleClass(sampleClass).toLowerCase(),
    exactSha(collectorCodeSha),
  );
}

export async function persistLiquidityCalibrationBatch({
  stateRoot,
  storeContract,
  batch,
}) {
  const directory = canonicalStoreDirectory({
    stateRoot,
    storeContract,
    collectorCodeSha: batch?.datasetProvenance?.collectorCodeSha,
    sampleClass: batch?.sampleClass,
  });
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const datasetPath = join(directory, 'dataset.json');
  const lockPath = join(directory, 'dataset.lock');
  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('CALIBRATION_STORE_LOCKED');
    throw error;
  }
  try {
    let previousDataset = null;
    try {
      previousDataset = JSON.parse(await readFile(datasetPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const merged = mergeLiquidityCalibrationBatch(previousDataset, batch);
    const temporaryPath = join(directory, `dataset.${process.pid}.${Date.now()}.tmp`);
    const serialized = `${canonicalJson(merged.dataset)}\n`;
    const temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    try {
      await temporaryHandle.writeFile(serialized, 'utf8');
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporaryPath, datasetPath);
    return Object.freeze({
      ...merged,
      datasetPath,
      storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
      durableStoreReused: true,
    });
  } finally {
    await lockHandle?.close();
    await rm(lockPath, { force: true });
  }
}

export const PUBLIC_LIQUIDITY_CALIBRATION_SAFETY = SAFETY;
export const PUBLIC_LIQUIDITY_CALIBRATION_READINESS = READINESS;
