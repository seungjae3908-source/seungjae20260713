import { createHash } from "node:crypto";

export const CRYPTO_FUTURES_DERIVATIVES_EVIDENCE_SCHEMA_VERSION = 1;
export const CRYPTO_FUTURES_DERIVATIVES_EVIDENCE_CONTRACT = "crypto-futures-derivatives-evidence/v1";
export const CRYPTO_FUTURES_DERIVATIVES_REQUIRED_EVIDENCE = Object.freeze([
  "MARK_PRICE",
  "INDEX_PRICE",
  "FUNDING",
  "OPEN_INTEREST",
  "BASIS",
  "LIQUIDATION_RISK",
]);

export const CRYPTO_FUTURES_DERIVATIVES_PUBLIC_FIELDS = Object.freeze([
  "mark_price",
  "index_price",
  "funding",
  "open_interest",
  "basis",
]);

export const APPROVED_LIQUIDATION_RISK_MODEL_V1 = null;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SYMBOL = /^[A-Z0-9]{2,16}USDT$/u;
const DATASET_ROLES = new Set(["RESEARCH", "TRAIN", "VALIDATION"]);
const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
});
const PROVIDER = Object.freeze({
  providerId: "bitget-public",
  host: "api.bitget.com",
  market: "CRYPTO_FUTURES",
  productType: "USDT-FUTURES",
  publicOnly: true,
});

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exact(value, keys, code) {
  plain(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function text(value, code) {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
}

function finite(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(code);
  return value;
}

function timestamp(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
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
  let result;
  if (Array.isArray(value)) result = value.map((entry) => canonical(entry, stack));
  else {
    plain(value, "CANONICAL_NON_PLAIN_OBJECT");
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail("CANONICAL_UNDEFINED_VALUE");
      result[key] = canonical(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function closeEnough(actual, expected) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= scale * 1e-10;
}

function normalizeObservation(raw, field, { positive = false, nonNegative = false } = {}) {
  exact(raw, ["value", "observedAt", "source"], `DERIVATIVES_${field}_OBSERVATION_SHAPE_INVALID`);
  const value = finite(raw.value, `DERIVATIVES_${field}_VALUE_INVALID`);
  if (positive && !(value > 0)) fail(`DERIVATIVES_${field}_VALUE_INVALID`);
  if (nonNegative && value < 0) fail(`DERIVATIVES_${field}_VALUE_INVALID`);
  const observedAt = timestamp(raw.observedAt, `DERIVATIVES_${field}_OBSERVED_AT_INVALID`);
  const source = text(raw.source, `DERIVATIVES_${field}_SOURCE_INVALID`);
  if (source !== PROVIDER.providerId) fail(`DERIVATIVES_${field}_SOURCE_INVALID`, source);
  return deepFreeze({ value, observedAt, source });
}

function normalizeBasis(raw) {
  exact(raw, ["value", "percent", "observedAt", "source"], "DERIVATIVES_BASIS_OBSERVATION_SHAPE_INVALID");
  const value = finite(raw.value, "DERIVATIVES_BASIS_VALUE_INVALID");
  const percent = finite(raw.percent, "DERIVATIVES_BASIS_PERCENT_INVALID");
  const observedAt = timestamp(raw.observedAt, "DERIVATIVES_BASIS_OBSERVED_AT_INVALID");
  const source = text(raw.source, "DERIVATIVES_BASIS_SOURCE_INVALID");
  if (source !== PROVIDER.providerId) fail("DERIVATIVES_BASIS_SOURCE_INVALID", source);
  return deepFreeze({ value, percent, observedAt, source });
}

function normalizeRow(raw, timeframe, previousTimestamp) {
  exact(raw, [
    "timestamp",
    "markPrice",
    "indexPrice",
    "funding",
    "openInterest",
    "basis",
  ], "DERIVATIVES_ROW_SHAPE_INVALID");
  const rowTimestamp = timestamp(raw.timestamp, "DERIVATIVES_ROW_TIMESTAMP_INVALID");
  if (previousTimestamp !== null && rowTimestamp - previousTimestamp !== TIMEFRAME_MS[timeframe]) {
    fail("DERIVATIVES_TIMELINE_NOT_CONTIGUOUS", `${previousTimestamp}->${rowTimestamp}`);
  }
  const markPrice = normalizeObservation(raw.markPrice, "MARK_PRICE", { positive: true });
  const indexPrice = normalizeObservation(raw.indexPrice, "INDEX_PRICE", { positive: true });
  const funding = normalizeObservation(raw.funding, "FUNDING");
  const openInterest = normalizeObservation(raw.openInterest, "OPEN_INTEREST", { nonNegative: true });
  const basis = normalizeBasis(raw.basis);

  for (const observation of [markPrice, indexPrice, funding, openInterest, basis]) {
    if (observation.observedAt > rowTimestamp) fail("DERIVATIVES_FUTURE_LEAKAGE", String(rowTimestamp));
  }
  if (Math.abs(funding.value) > 1) fail("DERIVATIVES_FUNDING_RATE_OUT_OF_BOUNDS");

  const expectedBasis = markPrice.value - indexPrice.value;
  const expectedBasisPercent = (expectedBasis / indexPrice.value) * 100;
  if (!closeEnough(basis.value, expectedBasis)) fail("DERIVATIVES_BASIS_VALUE_MISMATCH");
  if (!closeEnough(basis.percent, expectedBasisPercent)) fail("DERIVATIVES_BASIS_PERCENT_MISMATCH");

  return deepFreeze({
    timestamp: rowTimestamp,
    markPrice,
    indexPrice,
    funding,
    openInterest,
    basis,
  });
}

function liquidationAttestationCore(raw) {
  return {
    schemaVersion: raw.schemaVersion,
    contract: raw.contract,
    modelId: raw.modelId,
    modelVersion: raw.modelVersion,
    modelSourceSha: raw.modelSourceSha,
    riskPolicyIdentity: raw.riskPolicyIdentity,
    contractRulesIdentity: raw.contractRulesIdentity,
    maintenanceMarginTierEvidence: raw.maintenanceMarginTierEvidence,
    markPriceBased: raw.markPriceBased,
    feesIncluded: raw.feesIncluded,
    fundingIncluded: raw.fundingIncluded,
    publicInputsOnly: raw.publicInputsOnly,
    privateAccountDataUsed: raw.privateAccountDataUsed,
    finalHoldoutUsed: raw.finalHoldoutUsed,
    executionAuthority: raw.executionAuthority,
  };
}

export function assertCryptoFuturesLiquidationRiskAttestationV1(raw) {
  exact(raw, [
    "schemaVersion",
    "contract",
    "modelId",
    "modelVersion",
    "modelSourceSha",
    "riskPolicyIdentity",
    "contractRulesIdentity",
    "maintenanceMarginTierEvidence",
    "markPriceBased",
    "feesIncluded",
    "fundingIncluded",
    "publicInputsOnly",
    "privateAccountDataUsed",
    "finalHoldoutUsed",
    "executionAuthority",
    "evidenceDigest",
  ], "LIQUIDATION_RISK_ATTESTATION_SHAPE_INVALID");
  if (raw.schemaVersion !== 1 || raw.contract !== "canonical-futures-liquidation-risk/v1") fail("LIQUIDATION_RISK_ATTESTATION_CONTRACT_INVALID");
  const modelId = text(raw.modelId, "LIQUIDATION_RISK_MODEL_ID_INVALID");
  const modelVersion = text(raw.modelVersion, "LIQUIDATION_RISK_MODEL_VERSION_INVALID");
  const modelSourceSha = text(raw.modelSourceSha, "LIQUIDATION_RISK_MODEL_SOURCE_SHA_INVALID").toLowerCase();
  if (!SHA40.test(modelSourceSha)) fail("LIQUIDATION_RISK_MODEL_SOURCE_SHA_INVALID");
  const riskPolicyIdentity = text(raw.riskPolicyIdentity, "LIQUIDATION_RISK_POLICY_IDENTITY_INVALID");
  const contractRulesIdentity = text(raw.contractRulesIdentity, "LIQUIDATION_CONTRACT_RULES_IDENTITY_INVALID");
  if (raw.maintenanceMarginTierEvidence !== true
    || raw.markPriceBased !== true
    || raw.feesIncluded !== true
    || raw.fundingIncluded !== true
    || raw.publicInputsOnly !== true
    || raw.privateAccountDataUsed !== false
    || raw.finalHoldoutUsed !== false
    || raw.executionAuthority !== "NONE") {
    fail("LIQUIDATION_RISK_ATTESTATION_SAFETY_INVALID");
  }
  const normalized = deepFreeze({
    schemaVersion: 1,
    contract: "canonical-futures-liquidation-risk/v1",
    modelId,
    modelVersion,
    modelSourceSha,
    riskPolicyIdentity,
    contractRulesIdentity,
    maintenanceMarginTierEvidence: true,
    markPriceBased: true,
    feesIncluded: true,
    fundingIncluded: true,
    publicInputsOnly: true,
    privateAccountDataUsed: false,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
  });
  if (!SHA256.test(raw.evidenceDigest) || raw.evidenceDigest !== digest(normalized)) fail("LIQUIDATION_RISK_ATTESTATION_DIGEST_MISMATCH");
  return deepFreeze({ ...normalized, evidenceDigest: raw.evidenceDigest });
}

function evidenceSafety() {
  return deepFreeze({
    researchOnly: true,
    publicDataOnly: true,
    finalHoldoutAccessAllowed: false,
    profitabilityClaimAllowed: false,
    formulaPassed: false,
    scannerRuntimeMutationAllowed: false,
    championPromotionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

function providerContract(raw) {
  exact(raw, ["providerId", "host", "market", "productType", "publicOnly"], "DERIVATIVES_PROVIDER_SHAPE_INVALID");
  if (raw.providerId !== PROVIDER.providerId
    || raw.host !== PROVIDER.host
    || raw.market !== PROVIDER.market
    || raw.productType !== PROVIDER.productType
    || raw.publicOnly !== true) {
    fail("DERIVATIVES_PROVIDER_CONTRACT_INVALID");
  }
  return PROVIDER;
}

export function buildCryptoFuturesDerivativesRequiredDataV1({ timeframe = "15m" } = {}) {
  const normalizedTimeframe = text(timeframe, "DERIVATIVES_TIMEFRAME_INVALID").toLowerCase();
  if (!TIMEFRAME_MS[normalizedTimeframe]) fail("DERIVATIVES_TIMEFRAME_INVALID", normalizedTimeframe);
  return deepFreeze([
    {
      dataset: "BITGET_PUBLIC_FUTURES_OHLCV",
      fields: ["close", "high", "low", "open", "volume"],
      frequency: normalizedTimeframe,
      provenanceRequired: true,
      licenseRequired: false,
    },
    {
      dataset: "BITGET_PUBLIC_FUTURES_DERIVATIVES",
      fields: [...CRYPTO_FUTURES_DERIVATIVES_PUBLIC_FIELDS],
      frequency: normalizedTimeframe,
      provenanceRequired: true,
      licenseRequired: false,
    },
    {
      dataset: "CANONICAL_FUTURES_LIQUIDATION_RISK_MODEL",
      fields: ["liquidation_risk"],
      frequency: "per-signal",
      provenanceRequired: true,
      licenseRequired: false,
    },
  ]);
}

export function createCryptoFuturesDerivativesEvidenceV1({
  symbol,
  timeframe,
  datasetIdentity,
  datasetRole,
  provider = PROVIDER,
  rows,
  liquidationRiskAttestation = null,
} = {}) {
  const normalizedSymbol = text(symbol, "DERIVATIVES_SYMBOL_INVALID").toUpperCase();
  if (!SYMBOL.test(normalizedSymbol)) fail("DERIVATIVES_SYMBOL_INVALID", normalizedSymbol);
  const normalizedTimeframe = text(timeframe, "DERIVATIVES_TIMEFRAME_INVALID").toLowerCase();
  if (!TIMEFRAME_MS[normalizedTimeframe]) fail("DERIVATIVES_TIMEFRAME_INVALID", normalizedTimeframe);
  const normalizedDatasetIdentity = text(datasetIdentity, "DERIVATIVES_DATASET_IDENTITY_INVALID");
  const normalizedDatasetRole = text(datasetRole, "DERIVATIVES_DATASET_ROLE_INVALID").toUpperCase();
  if (!DATASET_ROLES.has(normalizedDatasetRole)) fail("FINAL_HOLDOUT_DERIVATIVES_ACCESS_FORBIDDEN");
  const normalizedProvider = providerContract(provider);
  if (!Array.isArray(rows) || rows.length < 2) fail("DERIVATIVES_ROWS_INSUFFICIENT");

  let previousTimestamp = null;
  const normalizedRows = rows.map((row) => {
    const normalized = normalizeRow(row, normalizedTimeframe, previousTimestamp);
    previousTimestamp = normalized.timestamp;
    return normalized;
  });
  const rowDigest = digest(normalizedRows);

  let attestation = null;
  if (liquidationRiskAttestation !== null) {
    attestation = assertCryptoFuturesLiquidationRiskAttestationV1(liquidationRiskAttestation);
  }
  const approvedLiquidationModel = APPROVED_LIQUIDATION_RISK_MODEL_V1;
  const liquidationRiskSatisfied = Boolean(
    approvedLiquidationModel
    && attestation
    && attestation.modelId === approvedLiquidationModel.modelId
    && attestation.modelVersion === approvedLiquidationModel.modelVersion
    && attestation.modelSourceSha === approvedLiquidationModel.modelSourceSha,
  );

  const satisfiedEvidence = ["MARK_PRICE", "INDEX_PRICE", "FUNDING", "OPEN_INTEREST", "BASIS"];
  if (liquidationRiskSatisfied) satisfiedEvidence.push("LIQUIDATION_RISK");
  const missingEvidence = CRYPTO_FUTURES_DERIVATIVES_REQUIRED_EVIDENCE.filter((item) => !satisfiedEvidence.includes(item));
  const blockers = [];
  if (!liquidationRiskSatisfied) blockers.push("CANONICAL_LIQUIDATION_RISK_MODEL_NOT_APPROVED");

  const core = {
    schemaVersion: CRYPTO_FUTURES_DERIVATIVES_EVIDENCE_SCHEMA_VERSION,
    contract: CRYPTO_FUTURES_DERIVATIVES_EVIDENCE_CONTRACT,
    market: "CRYPTO_FUTURES",
    symbol: normalizedSymbol,
    timeframe: normalizedTimeframe,
    datasetIdentity: normalizedDatasetIdentity,
    datasetRole: normalizedDatasetRole,
    provider: normalizedProvider,
    rowCount: normalizedRows.length,
    firstTimestamp: normalizedRows[0].timestamp,
    lastTimestamp: normalizedRows.at(-1).timestamp,
    rowDigest,
    requiredEvidence: CRYPTO_FUTURES_DERIVATIVES_REQUIRED_EVIDENCE,
    satisfiedEvidence,
    missingEvidence,
    liquidationRiskAttestation: attestation,
    blockers,
  };
  const evidenceDigest = digest(core);
  const ready = missingEvidence.length === 0 && blockers.length === 0;
  return deepFreeze({
    ...core,
    evidenceDigest,
    status: ready ? "READY" : "BLOCKED_DERIVATIVES_EVIDENCE",
    formulaSeedEligible: ready,
    tournamentEligible: ready,
    rows: normalizedRows,
    safety: evidenceSafety(),
  });
}

export function assertCryptoFuturesDerivativesEvidenceV1(evidence) {
  exact(evidence, [
    "schemaVersion", "contract", "market", "symbol", "timeframe", "datasetIdentity", "datasetRole", "provider",
    "rowCount", "firstTimestamp", "lastTimestamp", "rowDigest", "requiredEvidence", "satisfiedEvidence", "missingEvidence",
    "liquidationRiskAttestation", "blockers", "evidenceDigest", "status", "formulaSeedEligible", "tournamentEligible", "rows", "safety",
  ], "DERIVATIVES_EVIDENCE_SHAPE_INVALID");
  const rebuilt = createCryptoFuturesDerivativesEvidenceV1({
    symbol: evidence.symbol,
    timeframe: evidence.timeframe,
    datasetIdentity: evidence.datasetIdentity,
    datasetRole: evidence.datasetRole,
    provider: evidence.provider,
    rows: evidence.rows,
    liquidationRiskAttestation: evidence.liquidationRiskAttestation,
  });
  if (rebuilt.evidenceDigest !== evidence.evidenceDigest
    || rebuilt.rowDigest !== evidence.rowDigest
    || JSON.stringify(rebuilt.requiredEvidence) !== JSON.stringify(evidence.requiredEvidence)
    || JSON.stringify(rebuilt.satisfiedEvidence) !== JSON.stringify(evidence.satisfiedEvidence)
    || JSON.stringify(rebuilt.missingEvidence) !== JSON.stringify(evidence.missingEvidence)
    || JSON.stringify(rebuilt.blockers) !== JSON.stringify(evidence.blockers)
    || rebuilt.status !== evidence.status
    || rebuilt.formulaSeedEligible !== evidence.formulaSeedEligible
    || rebuilt.tournamentEligible !== evidence.tournamentEligible) {
    fail("DERIVATIVES_EVIDENCE_INTEGRITY_MISMATCH");
  }
  if (evidence.safety?.executionAuthority !== "NONE"
    || evidence.safety?.publicDataOnly !== true
    || evidence.safety?.finalHoldoutAccessAllowed !== false
    || evidence.safety?.profitabilityClaimAllowed !== false) {
    fail("DERIVATIVES_EVIDENCE_SAFETY_INVALID");
  }
  return evidence;
}
