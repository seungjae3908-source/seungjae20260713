import { createHash } from 'node:crypto';

import { fetchPublicMarketJson } from './public-market-http';

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION =
  'public-forward-partial-fill-calibration-collector-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_SAFETY = Object.freeze({
  publicDataOnly: true,
  sourceType: 'PUBLIC_FORWARD_SIMULATION' as const,
  actualFillClaimAllowed: false,
  queuePriorityClaimAllowed: false,
  partialFillCostProduced: false,
  calibrationArtifactProduced: false,
  historicalBackfillCredit: 0,
  testFixtureCredit: 0,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
  fullCostReady: false,
});

export type PublicForwardPartialFillSide = 'LONG' | 'SHORT';
export type PublicForwardPartialFillSampleClass =
  | 'FORWARD_NATURAL_SAMPLE'
  | 'CALIBRATION_RESEARCH_SAMPLE';

type BookLevel = Readonly<{ price: number; quantity: number }>;
type BookFrame = Readonly<{
  provider: 'BITGET_PUBLIC_UTA_V3';
  market: 'CRYPTO_FUTURES';
  symbol: string;
  marketTimestampMs: number;
  receiveTimestampMs: number;
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  rawDigest: string;
  privateApiUsed: false;
}>;

type PublicTrade = Readonly<{
  execId: string;
  providerTradeSide: 'buy' | 'sell';
  price: number;
  quantity: number;
  eventTimestampMs: number;
}>;

type TradeFrame = Readonly<{
  provider: 'BITGET_PUBLIC_UTA_V3';
  market: 'CRYPTO_FUTURES';
  symbol: string;
  receiveTimestampMs: number;
  trades: readonly PublicTrade[];
  rawDigest: string;
  privateApiUsed: false;
}>;

export type PublicForwardPartialFillCalibrationObservation = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION;
  evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION';
  sourceType: 'PUBLIC_FORWARD_SIMULATION';
  sampleClass: PublicForwardPartialFillSampleClass;
  observationId: string;
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: PublicForwardPartialFillSide;
  quantityNotionalBucketIdentity: string;
  collectorCodeSha: string;
  windowStartMs: number;
  windowEndMs: number;
  observedAtMs: number;
  passiveLimitPrice: number;
  requestedQuantity: number;
  eligiblePublicTouchQuantityUpperBound: number;
  opportunityFillRatioUpperBound: number;
  eligiblePublicExecutionIds: readonly string[];
  actualFillFraction: null;
  actualFillObserved: false;
  queuePositionKnown: false;
  partialFillCostPercent: null;
  sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1';
  sourceDigest: string;
  sourceObservationLineageId: string;
  sourceObservationLineageDigest: string;
  preEventBookDigest: string;
  forwardPublicFillsDigest: string;
  postEventBookDigest: string;
  endpoints: readonly ['/api/v3/market/orderbook', '/api/v3/market/fills'];
  forwardCalibrationSampleCredit: 0 | 1;
  historicalBackfillCredit: 0;
  testFixtureCredit: 0;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
  calibrationArtifactProduced: false;
  durablePersistencePerformed: false;
  calibrationSampleSufficient: false;
  partialFillStatus: 'BLOCKED_DATA';
  fullCostReady: false;
  privateApiUsed: false;
  executionAuthority: 'NONE';
  liveTrading: false;
  orderSubmitted: false;
}>;

export type PublicForwardPartialFillCollectorResult = Readonly<{
  status: 'PRESENT' | 'BLOCKED_DATA';
  blockers: readonly string[];
  observation: PublicForwardPartialFillCalibrationObservation | null;
}>;

type BuildInput = Readonly<{
  preEventBook: BookFrame;
  forwardTrades: TradeFrame;
  postEventBook: BookFrame;
  side: PublicForwardPartialFillSide;
  requestedQuantity: number;
  quantityNotionalBucketIdentity: string;
  collectorCodeSha: string;
  sampleClass?: PublicForwardPartialFillSampleClass;
  testOnly?: boolean;
  forbiddenSourceDigests?: readonly string[];
  forbiddenObservationLineageIds?: readonly string[];
  forbiddenObservationLineageDigests?: readonly string[];
}>;

type FetchJson = typeof fetchPublicMarketJson;
type Sleep = (milliseconds: number) => Promise<void>;

const BITGET_BASE_URL = 'https://api.bitget.com';
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_BOOK_AGE_MS = 10_000;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function exactSha(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(normalized) ? normalized : null;
}

function cleanIdentity(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= 160 ? normalized : null;
}

function cleanSymbol(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4,30}$/u.test(normalized) ? normalized : null;
}

function bitgetData(payload: unknown): unknown | null {
  const outer = record(payload);
  if (!outer || String(outer.code ?? '') !== '00000') return null;
  return outer.data ?? null;
}

function normalizeLevels(value: unknown, side: 'BID' | 'ASK'): readonly BookLevel[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const levels: BookLevel[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) return null;
    const price = finitePositive(row[0]);
    const quantity = finitePositive(row[1]);
    if (price == null || quantity == null) return null;
    levels.push(Object.freeze({ price, quantity }));
  }
  for (let index = 1; index < levels.length; index += 1) {
    if (side === 'BID' && levels[index].price > levels[index - 1].price) return null;
    if (side === 'ASK' && levels[index].price < levels[index - 1].price) return null;
  }
  return Object.freeze(levels);
}

export function normalizePublicForwardPartialFillBookFrame(input: Readonly<{
  symbol: string;
  payload: unknown;
  receiveTimestampMs: number;
}>): BookFrame | null {
  const symbol = cleanSymbol(input.symbol);
  const data = record(bitgetData(input.payload));
  const receiveTimestampMs = Math.trunc(Number(input.receiveTimestampMs));
  const marketTimestampMs = Math.trunc(Number(data?.ts));
  const bids = normalizeLevels(data?.b, 'BID');
  const asks = normalizeLevels(data?.a, 'ASK');
  if (!symbol || !data || !bids || !asks) return null;
  if (!(receiveTimestampMs > 0 && marketTimestampMs > 0)) return null;
  if (marketTimestampMs > receiveTimestampMs + MAX_CLOCK_SKEW_MS) return null;
  if (receiveTimestampMs - marketTimestampMs > MAX_BOOK_AGE_MS) return null;
  if (bids[0].price >= asks[0].price) return null;
  return Object.freeze({
    provider: 'BITGET_PUBLIC_UTA_V3',
    market: 'CRYPTO_FUTURES',
    symbol,
    marketTimestampMs,
    receiveTimestampMs,
    bids,
    asks,
    rawDigest: digest(input.payload),
    privateApiUsed: false,
  });
}

export function normalizePublicForwardPartialFillTradeFrame(input: Readonly<{
  symbol: string;
  payload: unknown;
  receiveTimestampMs: number;
}>): TradeFrame | null {
  const symbol = cleanSymbol(input.symbol);
  const rows = bitgetData(input.payload);
  const receiveTimestampMs = Math.trunc(Number(input.receiveTimestampMs));
  if (!symbol || !Array.isArray(rows) || !(receiveTimestampMs > 0)) return null;
  const trades: PublicTrade[] = [];
  for (const rowValue of rows) {
    const row = record(rowValue);
    const execId = cleanIdentity(row?.execId);
    const providerTradeSide = String(row?.side ?? '').trim().toLowerCase();
    const price = finitePositive(row?.price);
    const quantity = finitePositive(row?.size);
    const eventTimestampMs = Math.trunc(Number(row?.ts));
    if (!row || !execId || !['buy', 'sell'].includes(providerTradeSide)) return null;
    if (price == null || quantity == null || !(eventTimestampMs > 0)) return null;
    if (eventTimestampMs > receiveTimestampMs + MAX_CLOCK_SKEW_MS) return null;
    trades.push(Object.freeze({
      execId,
      providerTradeSide: providerTradeSide as 'buy' | 'sell',
      price,
      quantity,
      eventTimestampMs,
    }));
  }
  return Object.freeze({
    provider: 'BITGET_PUBLIC_UTA_V3',
    market: 'CRYPTO_FUTURES',
    symbol,
    receiveTimestampMs,
    trades: Object.freeze(trades),
    rawDigest: digest(input.payload),
    privateApiUsed: false,
  });
}

function blocked(...blockers: string[]): PublicForwardPartialFillCollectorResult {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    observation: null,
  });
}

export function buildPublicForwardPartialFillCalibrationObservation(
  input: BuildInput,
): PublicForwardPartialFillCollectorResult {
  const codeSha = exactSha(input.collectorCodeSha);
  const bucket = cleanIdentity(input.quantityNotionalBucketIdentity);
  const requestedQuantity = finitePositive(input.requestedQuantity);
  if (!codeSha) return blocked('COLLECTOR_CODE_SHA_INVALID');
  if (!bucket) return blocked('QUANTITY_NOTIONAL_BUCKET_IDENTITY_INVALID');
  if (requestedQuantity == null) return blocked('REQUESTED_QUANTITY_INVALID');
  if (!['LONG', 'SHORT'].includes(input.side)) return blocked('SIDE_INVALID');
  if (input.testOnly === true) return blocked('PARTIAL_FILL_TEST_FIXTURE_RUNTIME_CREDIT_FORBIDDEN');
  if (input.preEventBook.privateApiUsed || input.forwardTrades.privateApiUsed || input.postEventBook.privateApiUsed) {
    return blocked('PRIVATE_API_EVIDENCE_FORBIDDEN');
  }
  if (
    input.preEventBook.symbol !== input.forwardTrades.symbol
    || input.preEventBook.symbol !== input.postEventBook.symbol
  ) return blocked('MARKET_IDENTITY_MISMATCH');
  if (!(input.forwardTrades.receiveTimestampMs > input.preEventBook.receiveTimestampMs)) {
    return blocked('FORWARD_WINDOW_NOT_OBSERVED');
  }
  if (!(input.postEventBook.receiveTimestampMs >= input.forwardTrades.receiveTimestampMs)) {
    return blocked('POST_EVENT_BOOK_TIMESTAMP_INVALID');
  }
  if (!(input.postEventBook.marketTimestampMs >= input.preEventBook.marketTimestampMs)) {
    return blocked('POST_EVENT_MARKET_TIMESTAMP_INVALID');
  }

  const sampleClass = input.sampleClass ?? 'FORWARD_NATURAL_SAMPLE';
  if (!['FORWARD_NATURAL_SAMPLE', 'CALIBRATION_RESEARCH_SAMPLE'].includes(sampleClass)) {
    return blocked('SAMPLE_CLASS_INVALID');
  }

  const passiveLimitPrice = input.side === 'LONG'
    ? input.preEventBook.bids[0].price
    : input.preEventBook.asks[0].price;
  const expectedPublicSide = input.side === 'LONG' ? 'sell' : 'buy';
  const eligible = input.forwardTrades.trades.filter((trade) => {
    if (trade.eventTimestampMs < input.preEventBook.receiveTimestampMs) return false;
    if (trade.eventTimestampMs > input.forwardTrades.receiveTimestampMs + MAX_CLOCK_SKEW_MS) return false;
    if (trade.providerTradeSide !== expectedPublicSide) return false;
    return input.side === 'LONG'
      ? trade.price <= passiveLimitPrice
      : trade.price >= passiveLimitPrice;
  });
  const eligibleQuantity = eligible.reduce((sum, trade) => sum + trade.quantity, 0);
  const opportunityFillRatioUpperBound = Math.min(1, eligibleQuantity / requestedQuantity);
  const sourceIdentity = 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1' as const;
  const lineageInput = {
    collectorCodeSha: codeSha,
    sourceIdentity,
    market: input.preEventBook.market,
    symbol: input.preEventBook.symbol,
    side: input.side,
    quantityNotionalBucketIdentity: bucket,
    preEventBookDigest: input.preEventBook.rawDigest,
    windowStartMs: input.preEventBook.receiveTimestampMs,
  };
  const sourceObservationLineageId = `partial-fill-forward:${digest(lineageInput)}`;
  const sourceObservationLineageDigest = digest({
    ...lineageInput,
    forwardPublicFillsDigest: input.forwardTrades.rawDigest,
    postEventBookDigest: input.postEventBook.rawDigest,
  });
  const sourceDigest = digest({
    sourceIdentity,
    lineage: sourceObservationLineageDigest,
    eligiblePublicExecutionIds: eligible.map((trade) => trade.execId),
  });

  if (input.forbiddenSourceDigests?.includes(sourceDigest)) {
    return blocked('PARTIAL_FILL_SOURCE_DIGEST_REUSED');
  }
  if (input.forbiddenObservationLineageIds?.includes(sourceObservationLineageId)) {
    return blocked('PARTIAL_FILL_SOURCE_OBSERVATION_LINEAGE_REUSED');
  }
  if (input.forbiddenObservationLineageDigests?.includes(sourceObservationLineageDigest)) {
    return blocked('PARTIAL_FILL_SOURCE_OBSERVATION_LINEAGE_DIGEST_REUSED');
  }

  const observationId = `partial-fill-observation:${digest({
    sourceObservationLineageDigest,
    requestedQuantity,
    passiveLimitPrice,
    eligibleQuantity,
  })}`;
  const observation = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION' as const,
    sourceType: 'PUBLIC_FORWARD_SIMULATION' as const,
    sampleClass,
    observationId,
    market: 'CRYPTO_FUTURES' as const,
    symbol: input.preEventBook.symbol,
    side: input.side,
    quantityNotionalBucketIdentity: bucket,
    collectorCodeSha: codeSha,
    windowStartMs: input.preEventBook.receiveTimestampMs,
    windowEndMs: input.forwardTrades.receiveTimestampMs,
    observedAtMs: input.postEventBook.receiveTimestampMs,
    passiveLimitPrice,
    requestedQuantity,
    eligiblePublicTouchQuantityUpperBound: eligibleQuantity,
    opportunityFillRatioUpperBound,
    eligiblePublicExecutionIds: Object.freeze(eligible.map((trade) => trade.execId)),
    actualFillFraction: null,
    actualFillObserved: false as const,
    queuePositionKnown: false as const,
    partialFillCostPercent: null,
    sourceIdentity,
    sourceDigest,
    sourceObservationLineageId,
    sourceObservationLineageDigest,
    preEventBookDigest: input.preEventBook.rawDigest,
    forwardPublicFillsDigest: input.forwardTrades.rawDigest,
    postEventBookDigest: input.postEventBook.rawDigest,
    endpoints: Object.freeze(['/api/v3/market/orderbook', '/api/v3/market/fills'] as const),
    forwardCalibrationSampleCredit: sampleClass === 'FORWARD_NATURAL_SAMPLE' ? 1 as const : 0 as const,
    historicalBackfillCredit: 0 as const,
    testFixtureCredit: 0 as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    calibrationArtifactProduced: false as const,
    durablePersistencePerformed: false as const,
    calibrationSampleSufficient: false as const,
    partialFillStatus: 'BLOCKED_DATA' as const,
    fullCostReady: false as const,
    privateApiUsed: false as const,
    executionAuthority: 'NONE' as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  });
  return Object.freeze({ status: 'PRESENT' as const, blockers: Object.freeze([] as string[]), observation });
}

export async function collectBitgetPublicForwardPartialFillCalibrationObservation(input: Readonly<{
  symbol: string;
  side: PublicForwardPartialFillSide;
  requestedQuantity: number;
  quantityNotionalBucketIdentity: string;
  collectorCodeSha: string;
  eventWindowMs?: number;
  sampleClass?: PublicForwardPartialFillSampleClass;
  forbiddenSourceDigests?: readonly string[];
  forbiddenObservationLineageIds?: readonly string[];
  forbiddenObservationLineageDigests?: readonly string[];
}>, dependencies: Readonly<{
  fetchJson?: FetchJson;
  now?: () => number;
  sleep?: Sleep;
}> = {}): Promise<PublicForwardPartialFillCollectorResult> {
  const symbol = cleanSymbol(input.symbol);
  const eventWindowMs = Math.trunc(Number(input.eventWindowMs ?? 2_000));
  if (!symbol) return blocked('SYMBOL_INVALID');
  if (!(eventWindowMs >= 250 && eventWindowMs <= 30_000)) return blocked('EVENT_WINDOW_INVALID');
  const fetchJson = dependencies.fetchJson ?? fetchPublicMarketJson;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const query = new URLSearchParams({ category: 'USDT-FUTURES', symbol, limit: '100' }).toString();
  const bookUrl = `${BITGET_BASE_URL}/api/v3/market/orderbook?${query}`;
  const fillsUrl = `${BITGET_BASE_URL}/api/v3/market/fills?${query}`;

  try {
    const prePayload = await fetchJson(bookUrl, { provider: 'BITGET_PUBLIC_PARTIAL_FILL_CALIBRATION' });
    const preReceivedAt = now();
    const preEventBook = normalizePublicForwardPartialFillBookFrame({
      symbol,
      payload: prePayload,
      receiveTimestampMs: preReceivedAt,
    });
    if (!preEventBook) return blocked('PRE_EVENT_PUBLIC_BOOK_INVALID');

    await sleep(eventWindowMs);

    const fillsPayload = await fetchJson(fillsUrl, { provider: 'BITGET_PUBLIC_PARTIAL_FILL_CALIBRATION' });
    const fillsReceivedAt = now();
    const forwardTrades = normalizePublicForwardPartialFillTradeFrame({
      symbol,
      payload: fillsPayload,
      receiveTimestampMs: fillsReceivedAt,
    });
    if (!forwardTrades) return blocked('FORWARD_PUBLIC_FILLS_INVALID');

    const postPayload = await fetchJson(bookUrl, { provider: 'BITGET_PUBLIC_PARTIAL_FILL_CALIBRATION' });
    const postReceivedAt = now();
    const postEventBook = normalizePublicForwardPartialFillBookFrame({
      symbol,
      payload: postPayload,
      receiveTimestampMs: postReceivedAt,
    });
    if (!postEventBook) return blocked('POST_EVENT_PUBLIC_BOOK_INVALID');

    return buildPublicForwardPartialFillCalibrationObservation({
      preEventBook,
      forwardTrades,
      postEventBook,
      side: input.side,
      requestedQuantity: input.requestedQuantity,
      quantityNotionalBucketIdentity: input.quantityNotionalBucketIdentity,
      collectorCodeSha: input.collectorCodeSha,
      sampleClass: input.sampleClass,
      forbiddenSourceDigests: input.forbiddenSourceDigests,
      forbiddenObservationLineageIds: input.forbiddenObservationLineageIds,
      forbiddenObservationLineageDigests: input.forbiddenObservationLineageDigests,
    });
  } catch {
    return blocked('PUBLIC_FORWARD_PARTIAL_FILL_COLLECTION_FAILED');
  }
}
