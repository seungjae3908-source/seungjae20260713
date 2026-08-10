import test from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_REGISTRY_GROUPS,
  SCALPING_COMPATIBILITY,
  buildStrategyRegistryContract,
  createStrategyRegistryEntry,
  transitionStrategyRegistryEntry,
} from "../src/strategy-registry.js";

const SHA = "a".repeat(40);

test("registry exposes all market style direction groups and blocks live promotion", () => {
  const contract = buildStrategyRegistryContract({ researchCodeSha: SHA });
  assert.deepEqual(contract.groups, STRATEGY_REGISTRY_GROUPS);
  assert.equal(contract.automaticLivePromotion, false);
  assert.equal(contract.finalHoldoutExecutionAllowed, false);
  assert.equal(contract.productionMutationAllowed, false);
  assert.equal(contract.privateApiAllowed, false);
  assert.equal(contract.orderSubmissionAllowed, false);
});

test("V2 through V6 are not silently relabelled as scalping compatible", () => {
  assert.equal(SCALPING_COMPATIBILITY.V1.verdict, "SCALPING_COMPATIBLE");
  for (const version of ["V2", "V3", "V4", "V5", "V6"]) assert.equal(SCALPING_COMPATIBILITY[version].verdict, "NEEDS_SCALPING_ADAPTER");
});

test("freeze requires selection readiness and cannot read final holdout", () => {
  const entry = createStrategyRegistryEntry({
    id: "binance-btc-v1-long",
    group: "BINANCE_FUTURES_SCALPING_LONG",
    state: "candidate",
    strategyVersion: "V1",
    market: "CRYPTO_FUTURES",
    style: "SCALPING",
    direction: "LONG",
    venue: "BINANCE_USDM",
    researchCodeSha: SHA,
    selectionDataStatus: "DATA_READY",
  });
  assert.throws(() => transitionStrategyRegistryEntry(entry, "frozen", { selectionDataStatus: "BLOCKED_PROVIDER_COVERAGE", candidateDefinitionFrozen: true, finalHoldoutRead: false }), /FREEZE_REQUIRES_SELECTION_DATA_READY/u);
  assert.throws(() => transitionStrategyRegistryEntry(entry, "frozen", { selectionDataStatus: "DATA_READY", candidateDefinitionFrozen: true, finalHoldoutRead: true }), /FREEZE_CANNOT_USE_FINAL_HOLDOUT/u);
  const frozen = transitionStrategyRegistryEntry(entry, "frozen", { selectionDataStatus: "DATA_READY", candidateDefinitionFrozen: true, finalHoldoutRead: false });
  assert.equal(frozen.state, "frozen");
  assert.equal(frozen.livePromotionAllowed, false);
  assert.throws(() => transitionStrategyRegistryEntry(frozen, "final_holdout_passed", { finalHoldoutVerdict: "FAILED" }), /FINAL_HOLDOUT_PASS_REQUIRED/u);
});

test("rejected strategies cannot be revived by registry transition", () => {
  const rejected = createStrategyRegistryEntry({ id: "spot-v1-rejected", group: "CRYPTO_SPOT_SCALPING", state: "rejected", strategyVersion: "V1", market: "CRYPTO_SPOT", style: "SCALPING", direction: "LONG", researchCodeSha: SHA });
  assert.throws(() => transitionStrategyRegistryEntry(rejected, "candidate"), /INVALID_STRATEGY_REGISTRY_TRANSITION/u);
});
