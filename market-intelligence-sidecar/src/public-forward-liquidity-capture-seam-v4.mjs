import {
  FORWARD_NATURAL_SAMPLE,
  buildPublicLiquidityObservationBatch,
} from './public-forward-liquidity-calibration.mjs';
import {
  fetchBitgetPublicOrderBookFrame,
  fetchBitgetPublicTradesFrame,
} from './public-data.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL = Object.freeze({
  schemaVersion: 'public-forward-liquidity-technical-identity-proposal-v4',
  status: 'DRAFT_PENDING_SEPARATE_HUMAN_TECHNICAL_AUTHORITY',
  supersedesCollectorImplementationBlobSha: '8044d5cb136eb30a531608392c73a45be601e5ba',
  numericPolicyChanged: false,
  captureParameterPolicy: Object.freeze({
    eventObservationDelayMs: 2_000,
    postObservationDelaysMs: Object.freeze([1_000, 5_000]),
    maxPreEventBookAgeMs: 5_000,
  }),
  tradeFrameSelectionPolicy:
    'FIRST_PUBLIC_FRAME_CONTAINING_EVENT_STRICTLY_AFTER_PRE_EVENT_BOOK_WITHIN_EXISTING_FRESHNESS_WINDOW',
  maxTradeFrameFetchDerivation:
    'MAX_1_FLOOR_MAX_PRE_EVENT_BOOK_AGE_MS_DIV_EVENT_OBSERVATION_DELAY_MS',
  activationAllowed: false,
  prospectiveEconomicCreditAllowed: false,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
  publicDataOnly: true,
  privateTradingApiAllowed: false,
  liveTradingAllowed: false,
  autoTradingAllowed: false,
  realOrderAllowed: false,
  executionAuthority: 'NONE',
});

function finiteNonNegative(value, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function tradeFrameHasStrictPostBookEvent(preEventBook, tradeFrame, maxPreEventBookAgeMs) {
  const preBookMarketTimestampMs = Number(preEventBook?.marketTimestampMs);
  if (!Number.isFinite(preBookMarketTimestampMs)) {
    throw new Error('V4_PRE_EVENT_BOOK_MARKET_TIMESTAMP_INVALID');
  }
  if (!Array.isArray(tradeFrame?.trades)) return false;
  return tradeFrame.trades.some((trade) => {
    const eventTimestampMs = Number(trade?.eventTimestampMs);
    return Number.isFinite(eventTimestampMs)
      && eventTimestampMs > preBookMarketTimestampMs
      && eventTimestampMs - preBookMarketTimestampMs <= maxPreEventBookAgeMs;
  });
}

function deriveMaxTradeFrameFetchN(eventObservationDelayMs, maxPreEventBookAgeMs) {
  if (eventObservationDelayMs <= 0) return 1;
  return Math.max(1, Math.floor(maxPreEventBookAgeMs / eventObservationDelayMs));
}

export async function collectBitgetForwardLiquidityObservationBatchV4({
  symbol = 'BTCUSDT',
  collectorCodeSha,
  sampleClass = FORWARD_NATURAL_SAMPLE,
  eventObservationDelayMs =
    PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL.captureParameterPolicy
      .eventObservationDelayMs,
  postObservationDelaysMs = [
    ...PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL.captureParameterPolicy
      .postObservationDelaysMs,
  ],
  fetchOrderBookFrame = fetchBitgetPublicOrderBookFrame,
  fetchTradesFrame = fetchBitgetPublicTradesFrame,
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  maxPreEventBookAgeMs =
    PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL.captureParameterPolicy
      .maxPreEventBookAgeMs,
} = {}) {
  const eventDelay = finiteNonNegative(
    eventObservationDelayMs,
    'V4_EVENT_OBSERVATION_DELAY_INVALID',
  );
  const maxBookAge = finiteNonNegative(
    maxPreEventBookAgeMs,
    'V4_MAX_PRE_EVENT_BOOK_AGE_INVALID',
  );
  if (!Array.isArray(postObservationDelaysMs)) {
    throw new Error('V4_POST_OBSERVATION_DELAYS_INVALID');
  }

  const preEventBook = await fetchOrderBookFrame(symbol);
  const maxTradeFrameFetchN = deriveMaxTradeFrameFetchN(eventDelay, maxBookAge);

  let tradeFrame = null;
  let tradeFrameFetchN = 0;
  let selectedTradeFrameFetchIndex = null;

  for (let index = 0; index < maxTradeFrameFetchN; index += 1) {
    if (eventDelay > 0) await sleep(eventDelay);
    const candidate = await fetchTradesFrame(symbol);
    tradeFrame = candidate;
    tradeFrameFetchN += 1;
    if (tradeFrameHasStrictPostBookEvent(preEventBook, candidate, maxBookAge)) {
      selectedTradeFrameFetchIndex = index;
      break;
    }
  }

  if (!tradeFrame) throw new Error('V4_PUBLIC_TRADE_FRAME_MISSING');

  const postEventBooks = [];
  for (const rawDelay of postObservationDelaysMs) {
    const delayMs = finiteNonNegative(rawDelay, 'V4_POST_OBSERVATION_DELAY_INVALID');
    if (delayMs > 0) await sleep(delayMs);
    postEventBooks.push(await fetchOrderBookFrame(symbol));
  }

  const batch = buildPublicLiquidityObservationBatch({
    preEventBook,
    tradeFrame,
    postEventBooks,
    collectorCodeSha,
    sampleClass,
    maxPreEventBookAgeMs: maxBookAge,
  });

  return Object.freeze({
    ...batch,
    v4TechnicalSelection: Object.freeze({
      schemaVersion: 'public-forward-liquidity-v4-trade-frame-selection/v1',
      policy:
        PUBLIC_FORWARD_LIQUIDITY_V4_TECHNICAL_IDENTITY_PROPOSAL.tradeFrameSelectionPolicy,
      eventObservationDelayMs: eventDelay,
      maxPreEventBookAgeMs: maxBookAge,
      maxTradeFrameFetchN,
      tradeFrameFetchN,
      selectedTradeFrameFetchIndex,
      economicCreditAllowed: false,
      activationAllowed: false,
      outcomeInspectionUsed: false,
      executionAuthority: 'NONE',
    }),
  });
}
