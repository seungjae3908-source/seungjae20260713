import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-point-in-time-v2.js';
import {
  buildAdaptiveMultiEvidenceMarketFeaturesV2,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-market-features-v2.js';

const HOUR_MS = 60 * 60 * 1000;

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(label + ' must be finite');
  return number;
}
function iso(value, label) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(label + ' must be a valid timestamp');
  return new Date(parsed).toISOString();
}
function normalizedSide(value) {
  const side = String(value ?? '').trim().toUpperCase();
  if (side === 'BUY' || side === 'LONG') return side;
  if (side === 'SELL' || side === 'SHORT') return side;
  throw new TypeError('observation direction is invalid');
}
function normalizeCandle(row, index) {
  const timestamp = finite(row?.timestamp ?? row?.ts, 'candles[' + index + '].timestamp');
  const open = finite(row?.open, 'candles[' + index + '].open');
  const high = finite(row?.high, 'candles[' + index + '].high');
  const low = finite(row?.low, 'candles[' + index + '].low');
  const close = finite(row?.close, 'candles[' + index + '].close');
  const volume = finite(row?.volume ?? 0, 'candles[' + index + '].volume');
  if (!(timestamp > 0 && open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0)) {
    throw new RangeError('invalid forward feature candle at index ' + index);
  }
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new RangeError('inconsistent forward feature OHLC at index ' + index);
  }
  return { timestamp, open, high, low, close, volume };
}

export function buildMarketHypothesisForwardFeatureSnapshot({
  observation,
  candles,
  maxHistoryBars = 300,
  sourceId = 'yahoo-public-chart-60m',
} = {}) {
  if (!observation || typeof observation !== 'object') throw new TypeError('Forward observation is required');
  if (!Array.isArray(candles)) throw new TypeError('candles must be an array');
  if (!Number.isInteger(maxHistoryBars) || maxHistoryBars < 100 || maxHistoryBars > 2000) {
    throw new RangeError('maxHistoryBars must be 100..2000');
  }

  const identity = observation.identity;
  const signal = observation.snapshot;
  if (!identity || !signal) throw new TypeError('Forward observation identity and snapshot are required');
  if (identity.market !== 'KR_STOCK') throw new RangeError('only frozen KR_STOCK hypothesis is supported');
  if (String(identity.timeframe).toUpperCase() !== '60M') throw new RangeError('frozen KR hypothesis requires 60m Forward identity');
  const side = normalizedSide(identity.direction);
  const decisionTime = Date.parse(signal.timestamp);
  if (!Number.isFinite(decisionTime)) throw new TypeError('Forward signal timestamp is invalid');

  const normalized = candles.map(normalizeCandle).sort((left, right) => left.timestamp - right.timestamp);
  const byTimestamp = new Map();
  for (const row of normalized) byTimestamp.set(row.timestamp, row);

  const accepted = [...byTimestamp.values()]
    .filter((row) => row.timestamp + HOUR_MS <= decisionTime)
    .slice(-maxHistoryBars);

  if (accepted.length < 100) {
    return freeze({
      schemaVersion: 'move-hunter-market-hypothesis-forward-feature/v1',
      status: 'BLOCKED_DATA',
      reason: 'INSUFFICIENT_PAST_ONLY_60M_HISTORY',
      acceptedClosedCandleCount: accepted.length,
      maxHistoryBars,
      decisionTime: new Date(decisionTime).toISOString(),
      snapshot: null,
      economicSampleCredit: 0,
      executionAuthority: 'NONE',
    });
  }

  const canonicalCandles = accepted.map((row) => {
    const availableAt = row.timestamp + HOUR_MS;
    return {
      eventTime: new Date(row.timestamp).toISOString(),
      publishedAt: new Date(availableAt).toISOString(),
      availableAt: new Date(availableAt).toISOString(),
      observedAt: new Date(availableAt).toISOString(),
      isClosed: true,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    };
  });

  const snapshot = buildAdaptiveMultiEvidenceMarketFeaturesV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    side,
    decisionTime: new Date(decisionTime).toISOString(),
    candles: canonicalCandles,
    higherTimeframeEvidence: [],
    benchmark: null,
    source: {
      sourceId,
      originalSourceId: sourceId,
      sourceType: 'PUBLIC_MARKET_DATA',
      documentId: [
        'move-hunter-forward-feature',
        identity.market,
        identity.symbol,
        identity.timeframe,
        new Date(decisionTime).toISOString(),
      ].join(':'),
    },
  });

  if (!['READY_FOR_SPECIALIST_RESEARCH_ONLY', 'PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status)) {
    return freeze({
      schemaVersion: 'move-hunter-market-hypothesis-forward-feature/v1',
      status: 'BLOCKED_DATA',
      reason: 'CANONICAL_MARKET_FEATURE_BUILD_BLOCKED',
      acceptedClosedCandleCount: accepted.length,
      maxHistoryBars,
      decisionTime: new Date(decisionTime).toISOString(),
      canonicalBlockers: freeze([...(snapshot.blockers ?? [])]),
      snapshot: null,
      economicSampleCredit: 0,
      executionAuthority: 'NONE',
    });
  }

  return freeze({
    schemaVersion: 'move-hunter-market-hypothesis-forward-feature/v1',
    status: 'READY',
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    direction: identity.direction,
    decisionTime: new Date(decisionTime).toISOString(),
    acceptedClosedCandleCount: accepted.length,
    firstEventTime: canonicalCandles[0].eventTime,
    lastEventTime: canonicalCandles.at(-1).eventTime,
    lastAvailableAt: canonicalCandles.at(-1).availableAt,
    maxHistoryBars,
    futureOrUnclosedBorrowed: false,
    snapshot,
    economicSampleCredit: 0,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    executionAuthority: 'NONE',
  });
}
