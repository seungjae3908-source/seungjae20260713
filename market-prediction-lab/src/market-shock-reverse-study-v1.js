import { createHash } from "node:crypto";

export const MARKET_SHOCK_REVERSE_STUDY_CONTRACT_V1 = "market-shock-reverse-study/v1";

const FEATURE_NAMES = Object.freeze([
  "return5",
  "return15",
  "return30",
  "return60",
  "relativeVolume20",
  "quoteVolumeAcceleration5",
  "rangeCompression5To20",
  "breakoutDistance20",
  "vwapGap20",
]);
const UNAVAILABLE_WITH_OHLCV = Object.freeze([
  "ORDER_BOOK_IMBALANCE",
  "CVD",
  "TAKER_FLOW",
  "OPEN_INTEREST",
  "FUNDING",
  "NEWS_OR_THEME",
]);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function normalizeCandles(raw) {
  if (!Array.isArray(raw) || raw.length < 240) throw new Error("SHOCK_STUDY_MINIMUM_240_CANDLES_REQUIRED");
  let previous = -1;
  return raw.map((row, index) => {
    const timestamp = finite(row?.timestamp ?? row?.timestampMs, `candles[${index}].timestamp`);
    const open = finite(row?.open, `candles[${index}].open`);
    const high = finite(row?.high, `candles[${index}].high`);
    const low = finite(row?.low, `candles[${index}].low`);
    const close = finite(row?.close, `candles[${index}].close`);
    const volume = finite(row?.volume, `candles[${index}].volume`);
    const quoteVolume = row?.quoteVolume == null ? null : finite(row.quoteVolume, `candles[${index}].quoteVolume`);
    if (!Number.isSafeInteger(timestamp) || timestamp <= previous || open <= 0 || high <= 0 || low <= 0 || close <= 0
      || volume < 0 || (quoteVolume != null && quoteVolume < 0)
      || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error("SHOCK_STUDY_CANDLE_INVALID");
    }
    previous = timestamp;
    return Object.freeze({ timestamp, open, high, low, close, volume, quoteVolume });
  });
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function ratioChange(from, to) {
  return from > 0 ? (to / from) - 1 : null;
}

function featuresAt(candles, index) {
  const current = candles[index];
  const returnAt = (bars) => ratioChange(candles[index - bars].close, current.close);
  const prior20 = candles.slice(index - 20, index);
  const recent5 = candles.slice(index - 4, index + 1);
  const priorRange20 = candles.slice(index - 24, index - 4);
  const averageVolume = mean(prior20.map((row) => row.volume));
  const recentQuote = recent5.map((row) => row.quoteVolume);
  const priorQuote = candles.slice(index - 9, index - 4).map((row) => row.quoteVolume);
  const recentRanges = recent5.map((row) => (row.high - row.low) / row.open);
  const baselineRanges = priorRange20.map((row) => (row.high - row.low) / row.open);
  const priorHigh = Math.max(...prior20.map((row) => row.high));
  const weighted = candles.slice(index - 19, index + 1);
  const totalVolume = sum(weighted.map((row) => row.volume));
  const rollingVwap = totalVolume > 0
    ? sum(weighted.map((row) => ((row.high + row.low + row.close) / 3) * row.volume)) / totalVolume
    : null;
  return Object.freeze({
    return5: returnAt(5),
    return15: returnAt(15),
    return30: returnAt(30),
    return60: returnAt(60),
    relativeVolume20: averageVolume > 0 ? current.volume / averageVolume : null,
    quoteVolumeAcceleration5: recentQuote.every(Number.isFinite) && priorQuote.every(Number.isFinite) && sum(priorQuote) > 0
      ? (sum(recentQuote) / sum(priorQuote)) - 1 : null,
    rangeCompression5To20: mean(baselineRanges) > 0 ? mean(recentRanges) / mean(baselineRanges) : null,
    breakoutDistance20: priorHigh > 0 ? (current.close / priorHigh) - 1 : null,
    vwapGap20: rollingVwap > 0 ? (current.close / rollingVwap) - 1 : null,
  });
}

function normalizePolicy(raw = {}) {
  const policy = {
    horizonBars: Number(raw.horizonBars ?? 6),
    eventMoveFraction: Number(raw.eventMoveFraction ?? 0.04),
    neutralMoveFraction: Number(raw.neutralMoveFraction ?? 0.01),
    trainFraction: Number(raw.trainFraction ?? 0.7),
    minimumEventsPerDirectionPerSplit: Number(raw.minimumEventsPerDirectionPerSplit ?? 2),
  };
  if (!Number.isSafeInteger(policy.horizonBars) || policy.horizonBars < 1 || policy.horizonBars > 48
    || !Number.isFinite(policy.eventMoveFraction) || policy.eventMoveFraction <= 0 || policy.eventMoveFraction > 0.5
    || !Number.isFinite(policy.neutralMoveFraction) || policy.neutralMoveFraction < 0
    || policy.neutralMoveFraction >= policy.eventMoveFraction
    || !Number.isFinite(policy.trainFraction) || policy.trainFraction < 0.5 || policy.trainFraction > 0.9
    || !Number.isSafeInteger(policy.minimumEventsPerDirectionPerSplit)
    || policy.minimumEventsPerDirectionPerSplit < 1 || policy.minimumEventsPerDirectionPerSplit > 100) {
    throw new Error("SHOCK_STUDY_POLICY_INVALID");
  }
  return Object.freeze(policy);
}

function timeframeMs(timeframe) {
  const normalized = String(timeframe).trim().toLowerCase();
  const values = { '60m': 60 * 60 * 1_000, '1h': 60 * 60 * 1_000, '4h': 4 * 60 * 60 * 1_000, '1d': 24 * 60 * 60 * 1_000 };
  if (!values[normalized]) throw new Error("SHOCK_STUDY_TIMEFRAME_UNSUPPORTED");
  return values[normalized];
}

function contiguous(candles, start, end, intervalMs) {
  for (let index = start + 1; index <= end; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp !== intervalMs) return false;
  }
  return true;
}

function eventRows(candles, policy, intervalMs) {
  const rows = [];
  let nextEventIndex = 60;
  for (let index = 60; index + policy.horizonBars < candles.length; index += 1) {
    if (!contiguous(candles, index - 60, index + policy.horizonBars, intervalMs)) continue;
    const futureReturn = ratioChange(candles[index].close, candles[index + policy.horizonBars].close);
    let label = "OTHER";
    if (index >= nextEventIndex && futureReturn >= policy.eventMoveFraction) label = "SURGE";
    else if (index >= nextEventIndex && futureReturn <= -policy.eventMoveFraction) label = "DROP";
    else if (Math.abs(futureReturn) <= policy.neutralMoveFraction) label = "CONTROL";
    if (label === "OTHER") continue;
    if (label !== "CONTROL") nextEventIndex = index + policy.horizonBars + 1;
    rows.push(Object.freeze({
      eventId: digest({ label, anchorTimestamp: candles[index].timestamp, endTimestamp: candles[index + policy.horizonBars].timestamp }),
      label,
      anchorIndex: index,
      anchorTimestamp: candles[index].timestamp,
      labelWindowStart: candles[index + 1].timestamp,
      labelWindowEnd: candles[index + policy.horizonBars].timestamp,
      futureReturn,
      features: featuresAt(candles, index),
    }));
  }
  const eventAnchors = rows.filter((row) => row.label !== "CONTROL").map((row) => row.anchorIndex);
  return rows.filter((row) => row.label !== "CONTROL"
    || eventAnchors.every((anchor) => Math.abs(row.anchorIndex - anchor) > policy.horizonBars));
}

function splitRows(rows, splitTimestamp) {
  return rows.map((row) => Object.freeze({ ...row, split: row.anchorTimestamp < splitTimestamp ? "TRAIN" : "OOS" }));
}

function groupMean(rows, feature) {
  const values = rows.map((row) => row.features[feature]).filter(Number.isFinite);
  return mean(values);
}

function groupStd(rows, feature) {
  const values = rows.map((row) => row.features[feature]).filter(Number.isFinite);
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function descriptiveGroups(rows, direction, split) {
  const events = rows.filter((row) => row.label === direction && row.split === split);
  const controls = rows.filter((row) => row.label === "CONTROL" && row.split === split);
  return { events, controls };
}

function featureComparison(rows, direction, split) {
  const { events, controls } = descriptiveGroups(rows, direction, split);
  const comparisons = {};
  for (const feature of FEATURE_NAMES) {
    const eventMean = groupMean(events, feature);
    const controlMean = groupMean(controls, feature);
    const eventStd = groupStd(events, feature);
    const controlStd = groupStd(controls, feature);
    const pooledScale = Number.isFinite(eventStd) && Number.isFinite(controlStd)
      ? Math.sqrt((eventStd ** 2 + controlStd ** 2) / 2) : null;
    comparisons[feature] = Object.freeze({
      eventMean,
      controlMean,
      standardizedDifference: Number.isFinite(eventMean) && Number.isFinite(controlMean) && pooledScale > 0
        ? (eventMean - controlMean) / pooledScale : null,
      eventAvailableCount: events.filter((row) => Number.isFinite(row.features[feature])).length,
      controlAvailableCount: controls.filter((row) => Number.isFinite(row.features[feature])).length,
    });
  }
  return Object.freeze({ eventCount: events.length, controlCount: controls.length, features: Object.freeze(comparisons) });
}

function candidateFor(rows, direction, policy) {
  const train = featureComparison(rows, direction, "TRAIN");
  const oos = featureComparison(rows, direction, "OOS");
  if (train.eventCount < policy.minimumEventsPerDirectionPerSplit
    || oos.eventCount < policy.minimumEventsPerDirectionPerSplit
    || train.controlCount < policy.minimumEventsPerDirectionPerSplit
    || oos.controlCount < policy.minimumEventsPerDirectionPerSplit) {
    return Object.freeze({ direction, status: "INSUFFICIENT_EVENTS", train, oos, hypothesis: null });
  }
  const ranked = FEATURE_NAMES.map((feature) => ({ feature, ...train.features[feature] }))
    .filter((row) => Number.isFinite(row.standardizedDifference))
    .sort((left, right) => Math.abs(right.standardizedDifference) - Math.abs(left.standardizedDifference)
      || left.feature.localeCompare(right.feature));
  const selected = ranked[0];
  if (!selected) return Object.freeze({ direction, status: "INSUFFICIENT_FEATURE_DATA", train, oos, hypothesis: null });
  const operator = selected.eventMean >= selected.controlMean ? "GTE" : "LTE";
  const threshold = (selected.eventMean + selected.controlMean) / 2;
  const hit = (row) => Number.isFinite(row.features[selected.feature])
    && (operator === "GTE" ? row.features[selected.feature] >= threshold : row.features[selected.feature] <= threshold);
  const groups = descriptiveGroups(rows, direction, "OOS");
  const eventAvailable = groups.events.filter((row) => Number.isFinite(row.features[selected.feature]));
  const controlAvailable = groups.controls.filter((row) => Number.isFinite(row.features[selected.feature]));
  const eventHitRate = eventAvailable.length ? eventAvailable.filter(hit).length / eventAvailable.length : null;
  const controlHitRate = controlAvailable.length ? controlAvailable.filter(hit).length / controlAvailable.length : null;
  const oosDescriptiveLift = Number.isFinite(eventHitRate) && Number.isFinite(controlHitRate) ? eventHitRate - controlHitRate : null;
  return Object.freeze({
    direction,
    status: Number.isFinite(oosDescriptiveLift) && oosDescriptiveLift > 0
      ? "RESEARCH_HYPOTHESIS_ONLY" : "OOS_NOT_SUPPORTED",
    train,
    oos,
    hypothesis: Object.freeze({
      selectedFrom: "TRAIN_ONLY",
      feature: selected.feature,
      operator,
      threshold,
      oosEventHitRate: eventHitRate,
      oosControlHitRate: controlHitRate,
      oosDescriptiveLift,
      oosStatus: Number.isFinite(oosDescriptiveLift) && oosDescriptiveLift > 0
        ? "DESCRIPTIVE_SUPPORT" : "NOT_SUPPORTED",
      claim: "DESCRIPTIVE_ASSOCIATION_ONLY_NOT_A_TRADING_RULE",
      formulaCandidateGenerated: false,
      backtestRequired: true,
    }),
  });
}

export function analyzeMarketShockReverseStudyV1({
  market,
  symbol,
  timeframe,
  datasetIdentity,
  candles: rawCandles,
  policy: rawPolicy,
} = {}) {
  const scope = [market, symbol, timeframe, datasetIdentity].map((value) => String(value ?? "").trim());
  if (scope.some((value) => !value)) throw new Error("SHOCK_STUDY_SCOPE_REQUIRED");
  const candles = normalizeCandles(rawCandles);
  const policy = normalizePolicy(rawPolicy);
  const intervalMs = timeframeMs(scope[2]);
  const splitIndex = Math.max(61, Math.min(candles.length - policy.horizonBars - 1, Math.floor(candles.length * policy.trainFraction)));
  const splitTimestamp = candles[splitIndex].timestamp;
  const rows = splitRows(eventRows(candles, policy, intervalMs), splitTimestamp);
  const trainIds = new Set(rows.filter((row) => row.split === "TRAIN").map((row) => row.eventId));
  const overlap = rows.filter((row) => row.split === "OOS" && trainIds.has(row.eventId));
  if (overlap.length) throw new Error("SHOCK_STUDY_TRAIN_OOS_EVENT_OVERLAP");
  const studies = [candidateFor(rows, "SURGE", policy), candidateFor(rows, "DROP", policy)];
  const eventCounts = Object.freeze({
    trainSurge: rows.filter((row) => row.split === "TRAIN" && row.label === "SURGE").length,
    trainDrop: rows.filter((row) => row.split === "TRAIN" && row.label === "DROP").length,
    trainControl: rows.filter((row) => row.split === "TRAIN" && row.label === "CONTROL").length,
    oosSurge: rows.filter((row) => row.split === "OOS" && row.label === "SURGE").length,
    oosDrop: rows.filter((row) => row.split === "OOS" && row.label === "DROP").length,
    oosControl: rows.filter((row) => row.split === "OOS" && row.label === "CONTROL").length,
  });
  const core = {
    schemaVersion: 1,
    contract: MARKET_SHOCK_REVERSE_STUDY_CONTRACT_V1,
    market: scope[0], symbol: scope[1], timeframe: scope[2], datasetIdentity: scope[3],
    dataset: Object.freeze({ candleCount: candles.length, firstTimestamp: candles[0].timestamp,
      lastTimestamp: candles.at(-1).timestamp, datasetDigest: digest(candles) }),
    policy,
    split: Object.freeze({ method: "CHRONOLOGICAL_TRAIN_OOS", trainFraction: policy.trainFraction,
      splitTimestamp, trainOosEventOverlapCount: 0 }),
    eventCounts,
    events: Object.freeze(rows),
    studies: Object.freeze(studies),
    availableFeatures: FEATURE_NAMES,
    unavailableFeatures: UNAVAILABLE_WITH_OHLCV,
    limitations: Object.freeze([
      "Events use future bars only as labels; every feature is calculated at or before its anchor.",
      "Controls are non-events from the same instrument, but this is descriptive research and not causal proof.",
      "OHLCV cannot reconstruct historical order book, taker flow, open interest, funding, news, or theme state.",
      "A separate predeclared FormulaCandidate and cost-aware backtest are required before Paper consideration.",
    ]),
    futureLeakageAllowed: false,
    tradingPerformanceClaimed: false,
    formulaCandidateGenerated: false,
    paperRegistrationAllowed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApi: false,
    realOrder: false,
  };
  return freeze({ ...core, studyDigest: digest(core) });
}
