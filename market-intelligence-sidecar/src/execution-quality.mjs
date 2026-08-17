const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);
const BUY_DIRECTIONS = new Set(['BUY', 'LONG']);
const SELL_DIRECTIONS = new Set(['SELL', 'SHORT']);

export const DEFAULT_EXECUTION_QUALITY_POLICY = Object.freeze({
  version: 'MIS_EXECUTION_QUALITY_V1',
  enforcement: 'OBSERVE_ONLY',
  minBookCoverageRatio: 1,
  maxBookWalkSlippageBps: 30,
  minFillModelSamples: 500,
  minFillProbability: 0.65,
  maxFillModelBrierScore: 0.25,
  maxFillModelCalibrationError: 0.10,
  maxFillModelAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxObservedImplementationShortfallBps: 50,
});

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvePolicy(policy = {}) {
  const merged = { ...DEFAULT_EXECUTION_QUALITY_POLICY, ...(policy ?? {}) };
  if (typeof merged.version !== 'string' || !merged.version.trim()) throw new Error('EXECUTION_POLICY_VERSION_REQUIRED');
  merged.enforcement = String(merged.enforcement ?? '').toUpperCase();
  if (!ENFORCEMENT_MODES.has(merged.enforcement)) throw new Error('EXECUTION_POLICY_ENFORCEMENT_INVALID');
  for (const key of Object.keys(DEFAULT_EXECUTION_QUALITY_POLICY).filter((key) => key !== 'version' && key !== 'enforcement')) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value)) throw new Error(`EXECUTION_POLICY_FIELD_INVALID:${key}`);
    merged[key] = value;
  }
  if (!(merged.minBookCoverageRatio > 0 && merged.minBookCoverageRatio <= 1)) throw new Error('BOOK_COVERAGE_POLICY_INVALID');
  if (!(merged.minFillProbability >= 0 && merged.minFillProbability <= 1)) throw new Error('FILL_PROBABILITY_POLICY_INVALID');
  return merged;
}

function normalizeDirection(direction) {
  const normalized = String(direction ?? '').toUpperCase();
  if (BUY_DIRECTIONS.has(normalized)) return 'BUY';
  if (SELL_DIRECTIONS.has(normalized)) return 'SELL';
  throw new Error('EXECUTION_DIRECTION_INVALID');
}

function normalizeLevels(levels, ascending) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => Array.isArray(level)
      ? { price: finite(level[0]), size: finite(level[1]) }
      : { price: finite(level?.price), size: finite(level?.size ?? level?.qty ?? level?.quantity) })
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
}

export function walkOrderBook(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const side = normalizeDirection(raw.direction);
  const targetQty = finite(raw.targetQty);
  if (!(targetQty > 0)) return { status: 'NOT_AVAILABLE', reason: 'TARGET_QTY_REQUIRED' };
  const levels = side === 'BUY'
    ? normalizeLevels(raw.asks, true)
    : normalizeLevels(raw.bids, false);
  if (!levels.length) return { status: 'NOT_AVAILABLE', reason: 'EXECUTABLE_BOOK_NOT_AVAILABLE' };

  const arrivalPrice = finite(raw.arrivalPrice, levels[0].price);
  if (!(arrivalPrice > 0)) return { status: 'NOT_AVAILABLE', reason: 'ARRIVAL_PRICE_INVALID' };

  let remaining = targetQty;
  let filledQty = 0;
  let notional = 0;
  let levelsConsumed = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    remaining -= take;
    filledQty += take;
    notional += take * level.price;
    levelsConsumed += 1;
  }

  const coverageRatio = clamp(filledQty / targetQty, 0, 1);
  const vwap = filledQty > 0 ? notional / filledQty : null;
  const rawSlippageBps = vwap == null ? null : side === 'BUY'
    ? ((vwap - arrivalPrice) / arrivalPrice) * 10_000
    : ((arrivalPrice - vwap) / arrivalPrice) * 10_000;
  const slippageBps = rawSlippageBps == null ? null : Math.max(0, rawSlippageBps);
  const reasons = [];
  if (coverageRatio < policy.minBookCoverageRatio) reasons.push('INSUFFICIENT_VISIBLE_DEPTH');
  if (slippageBps != null && slippageBps > policy.maxBookWalkSlippageBps) reasons.push('BOOK_WALK_SLIPPAGE_TOO_HIGH');

  return {
    status: reasons.length ? 'VETO' : 'PASS',
    reasons,
    side,
    targetQty,
    filledQty,
    unfilledQty: Math.max(0, remaining),
    coverageRatio,
    vwap,
    arrivalPrice,
    slippageBps,
    levelsConsumed,
    model: 'VISIBLE_L2_BOOK_WALK_ONLY',
    permanentMarketImpactEstimated: false,
  };
}

export function evaluateQueueEvidence(raw = {}) {
  if (raw.queueEvidenceVerified !== true) {
    return { status: 'NOT_AVAILABLE', reason: 'VERIFIED_QUEUE_EVIDENCE_REQUIRED' };
  }
  const queueAheadQty = finite(raw.queueAheadQty);
  const ownOrderQty = finite(raw.ownOrderQty);
  const marketableQtyAtLevel = finite(raw.marketableQtyAtLevel);
  const cancellationsAheadQty = finite(raw.cancellationsAheadQty, 0);
  if (![queueAheadQty, ownOrderQty, marketableQtyAtLevel, cancellationsAheadQty].every((value) => value != null && value >= 0) || ownOrderQty <= 0) {
    return { status: 'NOT_AVAILABLE', reason: 'QUEUE_EVIDENCE_INVALID' };
  }

  const progressAhead = Math.max(0, marketableQtyAtLevel + cancellationsAheadQty);
  const clearedAheadQty = Math.min(queueAheadQty, progressAhead);
  const residualFlowAfterQueue = Math.max(0, progressAhead - queueAheadQty);
  const executableOwnQty = Math.min(ownOrderQty, residualFlowAfterQueue);
  const observedFillFraction = clamp(executableOwnQty / ownOrderQty, 0, 1);
  return {
    status: 'OBSERVED_ONLY',
    queueAheadQty,
    clearedAheadQty,
    ownOrderQty,
    executableOwnQty,
    observedFillFraction,
    probabilityEstimated: false,
    note: 'QUEUE_POSITION_REQUIRES_VERIFIED_ORDER_LEVEL_EVIDENCE',
  };
}

export function evaluateCalibratedFillModel(raw = {}, policyInput = {}, nowInput = Date.now()) {
  const policy = resolvePolicy(policyInput);
  const modelId = String(raw.modelId ?? '').trim();
  const fillProbability = finite(raw.fillProbability);
  const evaluationSamples = Math.max(0, finite(raw.evaluationSamples, 0));
  const brierScore = finite(raw.brierScore);
  const calibrationError = finite(raw.calibrationError);
  const evaluatedAt = finite(raw.evaluatedAt);
  const now = finite(nowInput, Date.now());
  const ageMs = evaluatedAt == null ? null : Math.max(0, now - evaluatedAt);

  if (!modelId || fillProbability == null || brierScore == null || calibrationError == null || evaluatedAt == null) {
    return { status: 'NOT_AVAILABLE', reason: 'CALIBRATED_FILL_MODEL_EVIDENCE_MISSING' };
  }
  if (!(fillProbability >= 0 && fillProbability <= 1)) return { status: 'NOT_AVAILABLE', reason: 'FILL_PROBABILITY_INVALID' };
  if (evaluationSamples < policy.minFillModelSamples) {
    return { status: 'NOT_AVAILABLE', reason: 'FILL_MODEL_SAMPLE_INSUFFICIENT', evaluationSamples, minimumSamples: policy.minFillModelSamples };
  }
  if (ageMs > policy.maxFillModelAgeMs) return { status: 'NOT_AVAILABLE', reason: 'FILL_MODEL_EVIDENCE_STALE', ageMs };
  if (brierScore > policy.maxFillModelBrierScore || calibrationError > policy.maxFillModelCalibrationError) {
    return { status: 'NOT_AVAILABLE', reason: 'FILL_MODEL_CALIBRATION_QUALITY_INSUFFICIENT', brierScore, calibrationError };
  }
  return {
    status: fillProbability >= policy.minFillProbability ? 'PASS' : 'VETO',
    reason: fillProbability >= policy.minFillProbability ? null : 'FILL_PROBABILITY_TOO_LOW',
    modelId,
    fillProbability,
    threshold: policy.minFillProbability,
    evaluationSamples,
    brierScore,
    calibrationError,
    evaluatedAt,
    ageMs,
  };
}

export function calculateRealizedTca(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const side = normalizeDirection(raw.direction);
  const decisionPrice = finite(raw.decisionPrice);
  const arrivalPrice = finite(raw.arrivalPrice);
  const fillVwap = finite(raw.fillVwap);
  const feesBps = Math.max(0, finite(raw.feesBps, 0));
  if (![decisionPrice, arrivalPrice, fillVwap].every((value) => value != null && value > 0)) {
    return { status: 'NOT_AVAILABLE', reason: 'REALIZED_TCA_PRICES_REQUIRED' };
  }

  const signedBps = (from, to) => side === 'BUY'
    ? ((to - from) / from) * 10_000
    : ((from - to) / from) * 10_000;
  const delayCostBps = signedBps(decisionPrice, arrivalPrice);
  const executionCostBps = signedBps(arrivalPrice, fillVwap);
  const implementationShortfallBps = signedBps(decisionPrice, fillVwap) + feesBps;
  return {
    status: implementationShortfallBps > policy.maxObservedImplementationShortfallBps ? 'VETO' : 'OBSERVED',
    reason: implementationShortfallBps > policy.maxObservedImplementationShortfallBps ? 'IMPLEMENTATION_SHORTFALL_TOO_HIGH' : null,
    side,
    decisionPrice,
    arrivalPrice,
    fillVwap,
    delayCostBps,
    executionCostBps,
    feesBps,
    implementationShortfallBps,
    realizedOnly: true,
  };
}

export function evaluateExecutionQuality(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now, Date.now());
  const bookWalk = walkOrderBook(raw.bookWalk ?? {}, policy);
  const queue = evaluateQueueEvidence(raw.queue ?? {});
  const fillModel = evaluateCalibratedFillModel(raw.fillModel ?? {}, policy, now);
  const tca = raw.realizedTca ? calculateRealizedTca(raw.realizedTca, policy) : { status: 'NOT_AVAILABLE', reason: 'NO_REALIZED_EXECUTION_YET' };

  const vetoReasons = [];
  if (bookWalk.status === 'VETO') vetoReasons.push(...bookWalk.reasons);
  if (fillModel.status === 'VETO') vetoReasons.push(fillModel.reason);
  if (tca.status === 'VETO') vetoReasons.push(tca.reason);
  const missingRequired = policy.enforcement === 'REQUIRED_FOR_PARENT_GATE'
    && [bookWalk.status, fillModel.status].some((status) => status === 'NOT_AVAILABLE');
  const state = vetoReasons.length ? 'VETO' : missingRequired ? 'INSUFFICIENT_EVIDENCE' : 'PASS';

  return {
    contract: 'market-intelligence-execution-quality/v1',
    policy,
    bookWalk,
    queue,
    fillModel,
    tca,
    scanner: {
      mode: 'OBSERVE_ONLY',
      candidateDeletionAllowed: false,
    },
    autoTrading: {
      state,
      reasons: vetoReasons,
      insufficientEvidence: missingRequired,
      parentGateStillRequired: true,
      orderAllowed: false,
      executionAuthority: 'NONE',
    },
    safety: {
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      orderSubmissionAllowed: false,
    },
  };
}
