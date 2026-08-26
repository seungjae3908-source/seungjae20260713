import { createHash } from "node:crypto";

export const CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID = "BITGET_CLASSIC_SINGLE_ASSET_ISOLATED_TIERED_V2025_11_10";
export const CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION = "1.0.0";
export const CRYPTO_FUTURES_ISOLATED_LIQUIDATION_CONTRACT = "canonical-futures-liquidation-risk/v1";
export const CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT = Date.UTC(2025, 10, 10, 8, 0, 0, 0);
export const CRYPTO_FUTURES_POSITION_TIER_PROVIDER = Object.freeze({
  providerId: "bitget-public",
  host: "api.bitget.com",
  path: "/api/v3/market/position-tier",
  category: "USDT-FUTURES",
  publicOnly: true,
});

const SHA40 = /^[0-9a-f]{40}$/u;
const SOURCE = "bitget-public-position-tier";
const FLOAT_EPSILON = 1e-10;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
}

function finite(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(code);
  return value;
}

function positive(value, code) {
  const result = finite(value, code);
  if (!(result > 0)) fail(code);
  return result;
}

function nonNegative(value, code) {
  const result = finite(value, code);
  if (result < 0) fail(code);
  return result;
}

function timestamp(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonical(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_NON_FINITE_NUMBER");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("CANONICAL_UNSUPPORTED_VALUE");
  if (stack.has(value)) fail("CANONICAL_CYCLE");
  stack.add(value);
  let normalized;
  if (Array.isArray(value)) normalized = value.map((entry) => canonical(entry, stack));
  else {
    plain(value, "CANONICAL_NON_PLAIN_OBJECT");
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail("CANONICAL_UNDEFINED_VALUE");
      normalized[key] = canonical(value[key], stack);
    }
  }
  stack.delete(value);
  return normalized;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function closeEnough(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * FLOAT_EPSILON;
}

function normalizeTier(raw, expectedTier) {
  plain(raw, "POSITION_TIER_SHAPE_INVALID");
  const allowed = new Set(["tier", "minTierValue", "maxTierValue", "leverage", "mmr"]);
  const keys = Object.keys(raw);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) fail("POSITION_TIER_SHAPE_INVALID");
  const tier = Number(raw.tier);
  const minTierValue = Number(raw.minTierValue);
  const maxTierValue = Number(raw.maxTierValue);
  const leverage = Number(raw.leverage);
  const mmr = Number(raw.mmr);
  if (!Number.isSafeInteger(tier) || tier !== expectedTier) fail("POSITION_TIER_SEQUENCE_INVALID", String(raw.tier));
  nonNegative(minTierValue, "POSITION_TIER_MIN_INVALID");
  positive(maxTierValue, "POSITION_TIER_MAX_INVALID");
  positive(leverage, "POSITION_TIER_LEVERAGE_INVALID");
  nonNegative(mmr, "POSITION_TIER_MMR_INVALID");
  if (maxTierValue <= minTierValue) fail("POSITION_TIER_RANGE_INVALID", String(tier));
  if (mmr >= 1) fail("POSITION_TIER_MMR_INVALID", String(tier));
  return { tier, minTierValue, maxTierValue, leverage, mmr };
}

export function normalizeCryptoFuturesPositionTiersV1({ rows, observedAt, asOf } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) fail("POSITION_TIERS_EMPTY");
  const normalizedObservedAt = timestamp(observedAt, "POSITION_TIERS_OBSERVED_AT_INVALID");
  const normalizedAsOf = timestamp(asOf, "POSITION_TIERS_AS_OF_INVALID");
  if (normalizedObservedAt > normalizedAsOf) fail("POSITION_TIERS_FUTURE_LEAKAGE");

  const tiers = rows.map((row, index) => normalizeTier(row, index + 1));
  if (tiers[0].minTierValue !== 0) fail("POSITION_TIER_FIRST_FLOOR_INVALID");
  let previousOffset = 0;
  let previousMmr = 0;
  const withOffsets = tiers.map((tier, index) => {
    if (index > 0) {
      const previous = tiers[index - 1];
      if (!closeEnough(tier.minTierValue, previous.maxTierValue)) fail("POSITION_TIER_RANGE_NOT_CONTIGUOUS", String(tier.tier));
      if (tier.mmr < previousMmr) fail("POSITION_TIER_MMR_NOT_MONOTONIC", String(tier.tier));
    }
    const preCalculatedOffset = index === 0
      ? 0
      : tier.minTierValue * (tier.mmr - previousMmr) + previousOffset;
    previousOffset = preCalculatedOffset;
    previousMmr = tier.mmr;
    return deepFreeze({ ...tier, preCalculatedOffset });
  });
  const tierDigest = digest({ observedAt: normalizedObservedAt, rows: withOffsets });
  return deepFreeze({
    provider: CRYPTO_FUTURES_POSITION_TIER_PROVIDER,
    source: SOURCE,
    observedAt: normalizedObservedAt,
    asOf: normalizedAsOf,
    rows: withOffsets,
    tierDigest,
    publicDataOnly: true,
    executionAuthority: "NONE",
  });
}

function selectTier(tiers, positionValue) {
  for (let index = 1; index < tiers.length; index += 1) {
    if (closeEnough(positionValue, tiers[index].minTierValue)) {
      fail("POSITION_VALUE_AT_TIER_BOUNDARY_AMBIGUOUS", String(positionValue));
    }
  }
  const selected = tiers.find((tier, index) => (
    positionValue >= tier.minTierValue
    && (index === tiers.length - 1 ? positionValue <= tier.maxTierValue : positionValue < tier.maxTierValue)
  ));
  if (!selected) fail("POSITION_VALUE_OUTSIDE_TIER_COVERAGE", String(positionValue));
  return selected;
}

function normalizeDirection(value) {
  const direction = text(value, "LIQUIDATION_DIRECTION_INVALID").toUpperCase();
  if (direction === "LONG") return { label: "LONG", sign: 1 };
  if (direction === "SHORT") return { label: "SHORT", sign: -1 };
  fail("LIQUIDATION_DIRECTION_INVALID", direction);
}

export function calculateCryptoFuturesIsolatedLiquidationRiskV1({
  direction,
  positionSize,
  averageEntryPrice,
  markPrice,
  positionMarginBeforeFunding,
  fundingNetCost,
  takerFeeRate,
  openedAt,
  asOf,
  positionTiers,
} = {}) {
  const normalizedDirection = normalizeDirection(direction);
  const size = positive(positionSize, "LIQUIDATION_POSITION_SIZE_INVALID");
  const entry = positive(averageEntryPrice, "LIQUIDATION_ENTRY_PRICE_INVALID");
  const mark = positive(markPrice, "LIQUIDATION_MARK_PRICE_INVALID");
  const marginBeforeFunding = positive(positionMarginBeforeFunding, "LIQUIDATION_POSITION_MARGIN_INVALID");
  const normalizedFundingNetCost = finite(fundingNetCost, "LIQUIDATION_FUNDING_NET_COST_INVALID");
  const effectivePositionMargin = marginBeforeFunding - normalizedFundingNetCost;
  if (!(effectivePositionMargin > 0) || !Number.isFinite(effectivePositionMargin)) fail("LIQUIDATION_EFFECTIVE_MARGIN_EXHAUSTED");
  const feeRate = nonNegative(takerFeeRate, "LIQUIDATION_TAKER_FEE_INVALID");
  if (feeRate >= 0.1) fail("LIQUIDATION_TAKER_FEE_INVALID");
  const normalizedOpenedAt = timestamp(openedAt, "LIQUIDATION_OPENED_AT_INVALID");
  const normalizedAsOf = timestamp(asOf, "LIQUIDATION_AS_OF_INVALID");
  if (normalizedOpenedAt < CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT) {
    fail("LIQUIDATION_RULE_HISTORY_UNSUPPORTED", String(normalizedOpenedAt));
  }
  if (normalizedOpenedAt > normalizedAsOf) fail("LIQUIDATION_OPENED_AT_FUTURE_LEAKAGE");
  plain(positionTiers, "LIQUIDATION_POSITION_TIERS_INVALID");
  if (positionTiers.publicDataOnly !== true || positionTiers.executionAuthority !== "NONE") fail("LIQUIDATION_POSITION_TIERS_UNSAFE");
  if (positionTiers.observedAt > normalizedAsOf) fail("LIQUIDATION_POSITION_TIERS_FUTURE_LEAKAGE");
  if (!Array.isArray(positionTiers.rows) || positionTiers.rows.length === 0) fail("LIQUIDATION_POSITION_TIERS_INVALID");

  const positionValue = size * mark;
  const entryNotional = size * entry;
  if (!Number.isFinite(positionValue) || !(positionValue > 0) || !Number.isFinite(entryNotional) || !(entryNotional > 0)) {
    fail("LIQUIDATION_POSITION_VALUE_INVALID");
  }
  const tier = selectTier(positionTiers.rows, positionValue);
  const impliedInitialLeverage = entryNotional / marginBeforeFunding;
  if (!Number.isFinite(impliedInitialLeverage) || impliedInitialLeverage > tier.leverage + FLOAT_EPSILON) {
    fail("LIQUIDATION_TIER_MAX_LEVERAGE_EXCEEDED", String(impliedInitialLeverage));
  }

  const denominator = size * (tier.mmr + feeRate - normalizedDirection.sign);
  if (!Number.isFinite(denominator) || denominator === 0) fail("LIQUIDATION_DENOMINATOR_INVALID");
  const numerator = effectivePositionMargin + tier.preCalculatedOffset - size * entry * normalizedDirection.sign;
  const liquidationPrice = numerator / denominator;
  if (!Number.isFinite(liquidationPrice) || liquidationPrice <= 0) fail("LIQUIDATION_PRICE_INVALID");

  const liquidationDistancePercent = normalizedDirection.sign === 1
    ? ((mark - liquidationPrice) / mark) * 100
    : ((liquidationPrice - mark) / mark) * 100;
  const liquidationBreached = normalizedDirection.sign === 1
    ? mark <= liquidationPrice
    : mark >= liquidationPrice;

  const resultCore = {
    modelId: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID,
    modelVersion: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION,
    rulesEffectiveAt: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT,
    direction: normalizedDirection.label,
    positionSize: size,
    averageEntryPrice: entry,
    markPrice: mark,
    positionMarginBeforeFunding: marginBeforeFunding,
    fundingNetCost: normalizedFundingNetCost,
    effectivePositionMargin,
    takerFeeRate: feeRate,
    openedAt: normalizedOpenedAt,
    asOf: normalizedAsOf,
    positionValue,
    entryNotional,
    impliedInitialLeverage,
    selectedTier: tier.tier,
    tierMaxLeverage: tier.leverage,
    maintenanceMarginRate: tier.mmr,
    preCalculatedOffset: tier.preCalculatedOffset,
    tierObservedAt: positionTiers.observedAt,
    tierDigest: positionTiers.tierDigest,
    liquidationPrice,
    liquidationDistancePercent,
    liquidationBreached,
    formula: "BITGET_CLASSIC_SINGLE_ASSET_ISOLATED_TIERED_2025_11_10",
  };
  return deepFreeze({
    ...resultCore,
    resultDigest: digest(resultCore),
    publicInputsOnly: true,
    privateAccountDataUsed: false,
    finalHoldoutUsed: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
}

export function buildCryptoFuturesLiquidationRiskAttestationV1({
  modelSourceSha,
  riskPolicyIdentity,
  contractRulesIdentity,
} = {}) {
  const normalizedSha = text(modelSourceSha, "LIQUIDATION_MODEL_SOURCE_SHA_INVALID").toLowerCase();
  if (!SHA40.test(normalizedSha)) fail("LIQUIDATION_MODEL_SOURCE_SHA_INVALID");
  const core = {
    schemaVersion: 1,
    contract: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_CONTRACT,
    modelId: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID,
    modelVersion: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION,
    modelSourceSha: normalizedSha,
    riskPolicyIdentity: text(riskPolicyIdentity, "LIQUIDATION_RISK_POLICY_IDENTITY_INVALID"),
    contractRulesIdentity: text(contractRulesIdentity, "LIQUIDATION_CONTRACT_RULES_IDENTITY_INVALID"),
    maintenanceMarginTierEvidence: true,
    markPriceBased: true,
    feesIncluded: true,
    fundingIncluded: true,
    publicInputsOnly: true,
    privateAccountDataUsed: false,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...core, evidenceDigest: digest(core) });
}

export function cryptoFuturesIsolatedLiquidationModelReadinessV1() {
  return deepFreeze({
    modelId: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID,
    modelVersion: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION,
    status: "CURRENT_RULE_FORMULA_READY_HISTORY_BLOCKED",
    currentRuleEffectiveAt: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT,
    historicalCoverageBeforeEffectiveAt: false,
    positionTierHistoryProvenanceReady: false,
    currentPublicPositionTierEndpointReady: true,
    fundingAppliedToEffectiveMargin: true,
    formulaTournamentUnblocked: false,
    blocker: "POINT_IN_TIME_POSITION_TIER_HISTORY_REQUIRED",
    finalHoldoutAccessAllowed: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
}
