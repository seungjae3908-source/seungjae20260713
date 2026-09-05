import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  APPROVED_LIQUIDATION_RISK_MODEL_V1,
  CRYPTO_FUTURES_DERIVATIVES_REQUIRED_EVIDENCE,
  assertCryptoFuturesDerivativesEvidenceV1,
  assertCryptoFuturesLiquidationRiskAttestationV1,
  buildCryptoFuturesDerivativesRequiredDataV1,
  createCryptoFuturesDerivativesEvidenceV1,
} from "../src/crypto-futures-derivatives-evidence-contract-v1.js";

const STEP = 15 * 60_000;
const START = Date.UTC(2025, 0, 1, 0, 0, 0, 0);

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function row(timestamp, markPrice = 100, indexPrice = 99) {
  const basis = markPrice - indexPrice;
  return {
    timestamp,
    markPrice: { value: markPrice, observedAt: timestamp, source: "bitget-public" },
    indexPrice: { value: indexPrice, observedAt: timestamp, source: "bitget-public" },
    funding: { value: 0.0001, observedAt: timestamp, source: "bitget-public" },
    openInterest: { value: 1_000_000, observedAt: timestamp, source: "bitget-public" },
    basis: {
      value: basis,
      percent: basis / indexPrice * 100,
      observedAt: timestamp,
      source: "bitget-public",
    },
  };
}

function evidenceInput(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    timeframe: "15m",
    datasetIdentity: "bitget-btcusdt-15m-development-v1",
    datasetRole: "RESEARCH",
    rows: [row(START), row(START + STEP), row(START + STEP * 2)],
    ...overrides,
  };
}

function validButUnapprovedLiquidationAttestation() {
  const core = {
    schemaVersion: 1,
    contract: "canonical-futures-liquidation-risk/v1",
    modelId: "CANONICAL_FUTURES_LIQUIDATION_MODEL_V1",
    modelVersion: "1.0.0",
    modelSourceSha: "a".repeat(40),
    riskPolicyIdentity: "research-futures-risk-v1",
    contractRulesIdentity: "bitget-public-contract-rules-v1",
    maintenanceMarginTierEvidence: true,
    markPriceBased: true,
    feesIncluded: true,
    fundingIncluded: true,
    publicInputsOnly: true,
    privateAccountDataUsed: false,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
  };
  return { ...core, evidenceDigest: digest(core) };
}

test("futures derivative requirements stay exact and retain liquidation risk as a mandatory lane", () => {
  assert.deepEqual(CRYPTO_FUTURES_DERIVATIVES_REQUIRED_EVIDENCE, [
    "MARK_PRICE",
    "INDEX_PRICE",
    "FUNDING",
    "OPEN_INTEREST",
    "BASIS",
    "LIQUIDATION_RISK",
  ]);
  assert.equal(APPROVED_LIQUIDATION_RISK_MODEL_V1, null);
});

test("public mark/index/funding/OI/basis evidence is accepted but cannot bypass missing liquidation-risk model", () => {
  const evidence = createCryptoFuturesDerivativesEvidenceV1(evidenceInput());
  assert.equal(evidence.status, "BLOCKED_DERIVATIVES_EVIDENCE");
  assert.equal(evidence.formulaSeedEligible, false);
  assert.equal(evidence.tournamentEligible, false);
  assert.deepEqual(evidence.satisfiedEvidence, ["MARK_PRICE", "INDEX_PRICE", "FUNDING", "OPEN_INTEREST", "BASIS"]);
  assert.deepEqual(evidence.missingEvidence, ["LIQUIDATION_RISK"]);
  assert.deepEqual(evidence.blockers, ["CANONICAL_LIQUIDATION_RISK_MODEL_NOT_APPROVED"]);
  assert.equal(evidence.safety.executionAuthority, "NONE");
  assert.equal(evidence.safety.finalHoldoutAccessAllowed, false);
  assert.equal(evidence.safety.profitabilityClaimAllowed, false);
  assert.equal(assertCryptoFuturesDerivativesEvidenceV1(evidence), evidence);
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.rows));
});

test("a structurally valid but not repository-approved liquidation attestation cannot unlock futures formulas", () => {
  const attestation = validButUnapprovedLiquidationAttestation();
  const normalized = assertCryptoFuturesLiquidationRiskAttestationV1(attestation);
  assert.equal(normalized.evidenceDigest, attestation.evidenceDigest);

  const evidence = createCryptoFuturesDerivativesEvidenceV1(evidenceInput({
    liquidationRiskAttestation: attestation,
  }));
  assert.equal(evidence.status, "BLOCKED_DERIVATIVES_EVIDENCE");
  assert.deepEqual(evidence.missingEvidence, ["LIQUIDATION_RISK"]);
  assert.equal(evidence.formulaSeedEligible, false);
  assert.equal(evidence.tournamentEligible, false);
});

test("point-in-time derivative evidence rejects future leakage", () => {
  const rows = evidenceInput().rows.map((item) => structuredClone(item));
  rows[1].funding.observedAt = rows[1].timestamp + 1;
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ rows })),
    /DERIVATIVES_FUTURE_LEAKAGE/,
  );
});

test("basis must be recomputable from mark and index price instead of trusting provider text", () => {
  const rows = evidenceInput().rows.map((item) => structuredClone(item));
  rows[0].basis.value += 0.5;
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ rows })),
    /DERIVATIVES_BASIS_VALUE_MISMATCH/,
  );

  const rowsPercent = evidenceInput().rows.map((item) => structuredClone(item));
  rowsPercent[0].basis.percent += 1;
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ rows: rowsPercent })),
    /DERIVATIVES_BASIS_PERCENT_MISMATCH/,
  );
});

test("derivative evidence requires an exact contiguous research timeline", () => {
  const rows = [row(START), row(START + STEP * 2)];
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ rows })),
    /DERIVATIVES_TIMELINE_NOT_CONTIGUOUS/,
  );

  const duplicate = [row(START), row(START)];
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ rows: duplicate })),
    /DERIVATIVES_TIMELINE_NOT_CONTIGUOUS/,
  );
});

test("private or mismatched provider provenance is rejected", () => {
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({
      provider: {
        providerId: "bitget-public",
        host: "api.bitget.com",
        market: "CRYPTO_FUTURES",
        productType: "USDT-FUTURES",
        publicOnly: false,
      },
    })),
    /DERIVATIVES_PROVIDER_CONTRACT_INVALID/,
  );

  const rows = evidenceInput().rows.map((item) => structuredClone(item));
  rows[0].openInterest.source = "private-account";
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ rows })),
    /DERIVATIVES_OPEN_INTEREST_SOURCE_INVALID/,
  );
});

test("Final Holdout is not an allowed derivative-evidence dataset role", () => {
  assert.throws(
    () => createCryptoFuturesDerivativesEvidenceV1(evidenceInput({ datasetRole: "FINAL_HOLDOUT" })),
    /FINAL_HOLDOUT_DERIVATIVES_ACCESS_FORBIDDEN/,
  );
});

test("requiredData bridge exposes public derivative fields and a separate liquidation-risk provenance requirement", () => {
  const requiredData = buildCryptoFuturesDerivativesRequiredDataV1({ timeframe: "15m" });
  assert.equal(requiredData.length, 3);
  assert.ok(requiredData.every((entry) => entry.provenanceRequired === true));
  assert.deepEqual(
    new Set(requiredData.flatMap((entry) => entry.fields)),
    new Set([
      "open", "high", "low", "close", "volume",
      "mark_price", "index_price", "funding", "open_interest", "basis", "liquidation_risk",
    ]),
  );
  assert.equal(requiredData.find((entry) => entry.dataset === "CANONICAL_FUTURES_LIQUIDATION_RISK_MODEL")?.frequency, "per-signal");
});

test("liquidation attestation digest and safety are fail closed", () => {
  const invalidDigest = { ...validButUnapprovedLiquidationAttestation(), evidenceDigest: "0".repeat(64) };
  assert.throws(
    () => assertCryptoFuturesLiquidationRiskAttestationV1(invalidDigest),
    /LIQUIDATION_RISK_ATTESTATION_DIGEST_MISMATCH/,
  );

  const unsafeCore = validButUnapprovedLiquidationAttestation();
  const unsafe = {
    ...unsafeCore,
    privateAccountDataUsed: true,
  };
  const { evidenceDigest: _oldDigest, ...unsafeMaterial } = unsafe;
  assert.throws(
    () => assertCryptoFuturesLiquidationRiskAttestationV1({ ...unsafeMaterial, evidenceDigest: digest(unsafeMaterial) }),
    /LIQUIDATION_RISK_ATTESTATION_SAFETY_INVALID/,
  );
});
