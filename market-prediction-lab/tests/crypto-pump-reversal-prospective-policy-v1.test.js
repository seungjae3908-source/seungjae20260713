import assert from "node:assert/strict";
import test from "node:test";

import {
  admitPumpProspectiveSignalV1,
  buildPumpProspectivePolicyV1,
  pumpProspectiveStageForCounts,
  verifyPumpProspectivePolicyV1,
} from "../src/crypto-pump-reversal-prospective-policy-v1.js";
import {
  CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
  CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
  CRYPTO_PUMP_REVERSAL_VERSION,
} from "../src/crypto-pump-reversal-clean-v1.js";

const DAY = 24 * 60 * 60 * 1000;
const FROZEN = Date.parse("2026-10-01T00:00:00.000Z");
const ELIGIBLE = FROZEN + DAY;
const SHA = "a".repeat(40);

function signal(symbol, offset = 1) {
  const confirmed = ELIGIBLE + offset * 60_000;
  return Object.freeze({
    schemaVersion: "crypto-pump-reversal-clean-signal-v1",
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyFamily: "EVENT_SPECIALIST",
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    symbol,
    signalId: String(offset).padStart(64, "a").slice(-64),
    signalConfirmedAtMs: confirmed,
    nextBarOpenTimestampMs: confirmed,
    eligibleForProspectiveResearchSample: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
  });
}

test("policy freezes one strategy-level candidate while allowing dynamic event symbols", () => {
  const policy = buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: ELIGIBLE,
  });
  const verdict = verifyPumpProspectivePolicyV1(policy);
  assert.equal(verdict.valid, true);
  assert.equal(policy.candidate.symbolBinding, "DYNAMIC_EVENT_SYMBOL");
  assert.equal(policy.candidate.strategyId, CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1);
  assert.match(policy.candidate.candidateId, /^paper-candidate-v1:[0-9a-f]{64}$/);

  const one = admitPumpProspectiveSignalV1(policy, signal("ALT1USDT", 1), {
    observedAtMs: ELIGIBLE + 2 * 60_000,
  });
  const two = admitPumpProspectiveSignalV1(policy, signal("ALT2USDT", 3), {
    observedAtMs: ELIGIBLE + 4 * 60_000,
  });
  assert.equal(one.observation.candidateId, two.observation.candidateId);
  assert.notEqual(one.observation.symbol, two.observation.symbol);
  assert.equal(one.profitabilityCredit, 0);
  assert.equal(two.canonicalProfitAdmissionEligible, false);
});

test("minimum 24h future boundary is immutable", () => {
  assert.throws(
    () => buildPumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      eligibleAfterMs: FROZEN + DAY - 1,
    }),
    /PUMP_PROSPECTIVE_FUTURE_BUFFER_LT_24H/,
  );
});

test("prospective admission rejects pre-boundary and outcome-aware signals", () => {
  const policy = buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: ELIGIBLE,
  });
  assert.throws(
    () => admitPumpProspectiveSignalV1(policy, signal("ALTUSDT", 1), {
      observedAtMs: ELIGIBLE - 1,
    }),
    /PUMP_PROSPECTIVE_PRE_BOUNDARY_SIGNAL_FORBIDDEN/,
  );
  assert.throws(
    () => admitPumpProspectiveSignalV1(policy, { ...signal("ALTUSDT", 1), futureReturn: 10 }, {
      observedAtMs: ELIGIBLE + 2 * 60_000,
    }),
    /PUMP_PROSPECTIVE_OUTCOME_AWARE_SIGNAL_FORBIDDEN/,
  );
});

test("replay backfill synthetic manual and test samples cannot enter the genuine cohort", () => {
  const policy = buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: ELIGIBLE,
  });
  for (const flag of ["synthetic", "replay", "backfill", "historical", "manual", "testOnly"]) {
    assert.throws(
      () => admitPumpProspectiveSignalV1(policy, signal("ALTUSDT", 1), {
        observedAtMs: ELIGIBLE + 2 * 60_000,
        [flag]: true,
      }),
      /PUMP_PROSPECTIVE_NON_GENUINE_SIGNAL_FORBIDDEN/,
    );
  }
});

test("10/30/50/100 review stages use full-cost settled N, never raw N", () => {
  assert.equal(pumpProspectiveStageForCounts({ rawSettledN: 100, fullCostSettledN: 9 }).stage, "COLLECTING");
  assert.equal(pumpProspectiveStageForCounts({ rawSettledN: 100, fullCostSettledN: 10 }).stage, "FUNCTIONAL_CHECK");
  assert.equal(pumpProspectiveStageForCounts({ rawSettledN: 100, fullCostSettledN: 30 }).stage, "FIRST_ECONOMIC_REVIEW");
  assert.equal(pumpProspectiveStageForCounts({ rawSettledN: 100, fullCostSettledN: 50 }).stage, "REGIME_REVIEW");
  const hundred = pumpProspectiveStageForCounts({ rawSettledN: 100, fullCostSettledN: 100 });
  assert.equal(hundred.stage, "FULL_VALIDATION_REVIEW");
  assert.equal(hundred.passAllowed, false);
  assert.equal(hundred.profitabilityProven, false);
  assert.equal(hundred.currentValidatedChampion, "NONE");
});
