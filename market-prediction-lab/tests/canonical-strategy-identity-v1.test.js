import assert from "node:assert/strict";
import test from "node:test";
import { compareCanonicalStrategyIdentities, resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function identity(overrides = {}) {
  return {
    strategyId: "us-regime-router-long",
    strategyFamily: "regime_router",
    strategyVersion: "v1",
    market: "US_STOCK",
    direction: "BUY",
    timeframe: "1D",
    formulaIdentity: { entry: "trend_pullback", exit: "atr_stop" },
    parameterHash: HASH_A,
    researchCodeSha: "1".repeat(40),
    datasetId: "us-stock-daily-v1",
    datasetDigest: HASH_B,
    datasetStart: "2020-01-01T00:00:00.000Z",
    datasetEnd: "2025-01-01T00:00:00.000Z",
    costPolicyVersion: "US_EQUITY_COST_V1",
    riskPolicyVersion: "CANONICAL_RISK_V1",
    evidenceSchemaVersion: "strategy-evidence-envelope-v1",
    ...overrides,
  };
}

test("canonical identity digest is deterministic and field-order independent", () => {
  const first = resolveCanonicalStrategyIdentity(identity());
  const reversed = Object.fromEntries(Object.entries(identity()).reverse());
  const second = resolveCanonicalStrategyIdentity(reversed);
  assert.equal(first.status, "IDENTITY_COMPLETE");
  assert.equal(second.status, "IDENTITY_COMPLETE");
  assert.equal(first.strategyIdentityDigest, second.strategyIdentityDigest);
  assert.equal(compareCanonicalStrategyIdentities(identity(), reversed).status, "IDENTITY_COMPLETE");
});

test("parameter, dataset and cost policy mismatches never loosely match", () => {
  for (const [field, value] of [["parameterHash", HASH_B], ["datasetDigest", HASH_A], ["costPolicyVersion", "US_EQUITY_COST_V2"]]) {
    const result = compareCanonicalStrategyIdentities(identity(), identity({ [field]: value }));
    assert.equal(result.status, "IDENTITY_MISMATCH");
    assert.ok(result.mismatchedFields.includes(field));
  }
});

test("missing mandatory identity and self-attestation fail closed", () => {
  const missing = resolveCanonicalStrategyIdentity(identity({ datasetId: "" }));
  assert.equal(missing.status, "IDENTITY_INCOMPLETE");
  assert.ok(missing.missingFields.includes("datasetId"));
  const fake = resolveCanonicalStrategyIdentity(identity({ validated: true }));
  assert.equal(fake.status, "IDENTITY_INCOMPLETE");
  assert.ok(fake.blockers.includes("SELF_ATTESTATION_FORBIDDEN:validated"));
  assert.equal(resolveCanonicalStrategyIdentity(identity({ formulaIdentity: "" })).status, "IDENTITY_INCOMPLETE");
  assert.equal(resolveCanonicalStrategyIdentity(identity({ datasetId: "UNKNOWN" })).status, "IDENTITY_INCOMPLETE");
});
