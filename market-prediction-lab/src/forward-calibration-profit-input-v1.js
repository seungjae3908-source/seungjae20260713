const FORWARD_SCHEMA = "forward-recommendation-profit-calibration-v2";
const FORWARD_SOURCE = "LIVE_RECOMMENDATION";
const MINIMUM_SAMPLE = 30;
const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const DIRECTIONS = new Set(["BUY", "SELL", "LONG", "SHORT"]);

function freeze(value) { return Object.freeze(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function integer(value) { return Number.isInteger(value) && value >= 0; }
function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
function immutableSha(value) { return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value); }
function closeEnough(left, right, tolerance = 1e-12) { return Math.abs(left - right) <= tolerance; }

function missingProfitInput(status = "INSUFFICIENT_SAMPLE", sampleSize = 0, tpFirstCount = 0) {
  return freeze({
    probabilities: freeze({ tp: null, sl: null, expire: null }),
    returns: freeze({ target: null, stop: null, expire: null }),
    costs: freeze({ status: "MISSING", components: freeze({}) }),
    calibration: freeze({ status, sampleSize, tpFirstCount }),
  });
}

function safeEnvelope(calibration) {
  return calibration?.executionAuthority === "NONE"
    && calibration?.financialMutationAllowed === false
    && calibration?.liveOrderAllowed === false
    && calibration?.privateTradingApiAllowed === false
    && calibration?.profitabilityClaimAllowed === false
    && calibration?.costAdjusted === false;
}

function safePaperCandidate(candidate) {
  return candidate?.executionAuthority === "NONE"
    && candidate?.liveOrderAllowed === false
    && candidate?.privateTradingApiAllowed === false
    && candidate?.orderSubmitted === false
    && candidate?.exchangeRequestSent === false;
}

function canonicalPaperIdentity(candidate) {
  const signal = candidate?.signal;
  const strategy = signal?.strategyIdentity;
  if (!signal || !strategy) return null;
  if (!nonEmpty(strategy.strategyId) || !nonEmpty(strategy.strategyVersion) || !nonEmpty(strategy.parameterHash)
    || !immutableSha(strategy.researchCodeSha) || !MARKETS.has(signal.market) || !nonEmpty(signal.symbol)
    || !nonEmpty(signal.timeframe) || !positiveInteger(signal.horizon) || !DIRECTIONS.has(signal.direction)
    || signal.signalDirection !== signal.direction || signal.style !== "SWING") return null;
  return freeze({
    strategyId: strategy.strategyId,
    strategyVersion: strategy.strategyVersion,
    parameterHash: strategy.parameterHash,
    researchCodeSha: strategy.researchCodeSha.toLowerCase(),
    market: signal.market,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    horizon: signal.horizon,
    direction: signal.direction,
  });
}

function validForwardIdentity(identity) {
  return identity && nonEmpty(identity.strategyId) && nonEmpty(identity.strategyVersion)
    && nonEmpty(identity.parameterHash) && immutableSha(identity.researchCodeSha)
    && MARKETS.has(identity.market) && nonEmpty(identity.symbol) && nonEmpty(identity.timeframe)
    && positiveInteger(identity.horizon) && DIRECTIONS.has(identity.direction);
}

const IDENTITY_FIELDS = freeze([
  ["strategyId", "FORWARD_CALIBRATION_STRATEGY_ID_MISMATCH"],
  ["strategyVersion", "FORWARD_CALIBRATION_STRATEGY_VERSION_MISMATCH"],
  ["parameterHash", "FORWARD_CALIBRATION_PARAMETER_HASH_MISMATCH"],
  ["researchCodeSha", "FORWARD_CALIBRATION_RESEARCH_SHA_MISMATCH"],
  ["market", "FORWARD_CALIBRATION_MARKET_MISMATCH"],
  ["symbol", "FORWARD_CALIBRATION_SYMBOL_MISMATCH"],
  ["timeframe", "FORWARD_CALIBRATION_TIMEFRAME_MISMATCH"],
  ["horizon", "FORWARD_CALIBRATION_HORIZON_MISMATCH"],
  ["direction", "FORWARD_CALIBRATION_DIRECTION_MISMATCH"],
]);

function compareIdentity(calibrationIdentity, paperIdentity) {
  const blockers = [];
  for (const [field, reason] of IDENTITY_FIELDS) {
    const left = field === "researchCodeSha" ? String(calibrationIdentity[field]).toLowerCase() : calibrationIdentity[field];
    const right = paperIdentity[field];
    if (left !== right) blockers.push(reason);
  }
  return blockers;
}

function validateReadyCalibration(calibration) {
  const blockers = [];
  const meta = calibration?.calibration;
  const counts = calibration?.counts;
  const probabilities = calibration?.probabilities;
  const returns = calibration?.returns;
  if (meta?.status !== "READY" || calibration?.status !== "READY") blockers.push("FORWARD_CALIBRATION_NOT_READY");
  if (!integer(meta?.sampleSize) || meta.sampleSize < MINIMUM_SAMPLE || !integer(meta?.tpFirstCount) || meta.tpFirstCount > meta.sampleSize) {
    blockers.push("FORWARD_CALIBRATION_SAMPLE_INVALID");
  }
  if (![counts?.tp, counts?.sl, counts?.expire, counts?.conservativeConflicts].every(integer)) {
    blockers.push("FORWARD_CALIBRATION_COUNTS_INVALID");
  } else if (integer(meta?.sampleSize) && (counts.tp + counts.sl + counts.expire !== meta.sampleSize || counts.tp !== meta.tpFirstCount
      || counts.tp === 0 || counts.sl === 0 || counts.expire === 0)) {
    blockers.push("FORWARD_CALIBRATION_COUNTS_INVALID");
  }
  if (![probabilities?.tp, probabilities?.sl, probabilities?.expire].every((value) => finite(value) && value >= 0 && value <= 1)) {
    blockers.push("FORWARD_CALIBRATION_PROBABILITY_INVALID");
  } else {
    const sum = probabilities.tp + probabilities.sl + probabilities.expire;
    if (!closeEnough(sum, 1, 1e-9)) blockers.push("FORWARD_CALIBRATION_PROBABILITY_INVALID");
    if (integer(meta?.sampleSize) && meta.sampleSize > 0 && [counts?.tp, counts?.sl, counts?.expire].every(integer)) {
      if (!closeEnough(probabilities.tp, counts.tp / meta.sampleSize)
        || !closeEnough(probabilities.sl, counts.sl / meta.sampleSize)
        || !closeEnough(probabilities.expire, counts.expire / meta.sampleSize)) {
        blockers.push("FORWARD_CALIBRATION_PROBABILITY_COUNT_MISMATCH");
      }
    }
  }
  if (!(finite(returns?.target) && returns.target > 0 && finite(returns?.stop) && returns.stop < 0 && finite(returns?.expire))) {
    blockers.push("FORWARD_CALIBRATION_RETURN_INVALID");
  }
  return [...new Set(blockers)];
}

function result(status, blockers, identity, profitInput) {
  return freeze({
    schemaVersion: "forward-calibration-profit-input-v1",
    status,
    blockers: freeze([...new Set(blockers)]),
    identity,
    profitInput,
    costEvidenceStatus: "MISSING",
    executionAuthority: "NONE",
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}

export function resolveForwardCalibrationProfitInput({ calibration, paperCandidate } = {}) {
  const blockers = [];
  if (calibration?.schemaVersion !== FORWARD_SCHEMA) blockers.push("FORWARD_CALIBRATION_SCHEMA_INVALID");
  if (calibration?.source !== FORWARD_SOURCE) blockers.push("FORWARD_CALIBRATION_SOURCE_INVALID");
  if (!safeEnvelope(calibration)) blockers.push("FORWARD_CALIBRATION_SAFETY_INVALID");
  if (!paperCandidate || !safePaperCandidate(paperCandidate)) blockers.push("CANONICAL_PAPER_CANDIDATE_REQUIRED");

  const paperIdentity = canonicalPaperIdentity(paperCandidate);
  if (!paperIdentity) blockers.push("CANONICAL_PAPER_IDENTITY_REQUIRED");
  const calibrationIdentity = calibration?.identity;
  if (!validForwardIdentity(calibrationIdentity)) blockers.push("FORWARD_CALIBRATION_IDENTITY_REQUIRED");
  if (paperIdentity && validForwardIdentity(calibrationIdentity)) blockers.push(...compareIdentity(calibrationIdentity, paperIdentity));

  if (calibration?.status !== "READY") {
    const meta = calibration?.calibration;
    const sampleSize = integer(meta?.sampleSize) ? meta.sampleSize : 0;
    const tpFirstCount = integer(meta?.tpFirstCount) && meta.tpFirstCount <= sampleSize ? meta.tpFirstCount : 0;
    const safeStatus = nonEmpty(meta?.status) && meta.status !== "READY" ? meta.status : "INSUFFICIENT_SAMPLE";
    blockers.push("FORWARD_CALIBRATION_NOT_READY");
    return result("NO_TRADE", blockers, paperIdentity, missingProfitInput(safeStatus, sampleSize, tpFirstCount));
  }

  blockers.push(...validateReadyCalibration(calibration));
  if (blockers.length > 0 || !paperIdentity) {
    return result("NO_TRADE", blockers, paperIdentity, missingProfitInput());
  }

  const profitInput = freeze({
    probabilities: freeze({ ...calibration.probabilities }),
    returns: freeze({ ...calibration.returns }),
    costs: freeze({ status: "MISSING", components: freeze({}) }),
    calibration: freeze({
      status: "READY",
      sampleSize: calibration.calibration.sampleSize,
      tpFirstCount: calibration.calibration.tpFirstCount,
    }),
  });
  return result("CALIBRATION_READY", [], paperIdentity, profitInput);
}
