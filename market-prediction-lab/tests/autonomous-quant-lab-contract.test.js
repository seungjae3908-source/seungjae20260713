import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMOUS_QUANT_LAB_GROUPS,
  AUTONOMOUS_QUANT_LAB_STAGES,
  CHAMPION_EVIDENCE_REQUIREMENTS,
  buildAutonomousQuantLabContract,
} from "../src/autonomous-quant-lab-contract.js";

test("canonical Quant Lab includes every market and SCALPING SWING MID_LONG", () => {
  const contract = buildAutonomousQuantLabContract();
  assert.deepEqual(contract.markets, ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
  assert.deepEqual(contract.strategyTypes, ["SCALPING", "SWING", "MID_LONG"]);
  for (const market of contract.markets) {
    for (const strategyType of contract.strategyTypes) {
      assert.ok(AUTONOMOUS_QUANT_LAB_GROUPS.some((group) => group.market === market && group.strategyType === strategyType));
    }
  }
});

test("futures separates LONG and SHORT for every strategy type", () => {
  for (const strategyType of ["SCALPING", "SWING", "MID_LONG"]) {
    const directions = new Set(AUTONOMOUS_QUANT_LAB_GROUPS
      .filter((group) => group.market === "CRYPTO_FUTURES" && group.strategyType === strategyType)
      .map((group) => group.direction));
    assert.deepEqual([...directions].sort(), ["LONG", "SHORT"]);
  }
});

test("promotion stages require final holdout Paper and Shadow before Champion comparison", () => {
  assert.deepEqual(AUTONOMOUS_QUANT_LAB_STAGES, [
    "CHALLENGER",
    "HISTORICAL_BACKTEST",
    "OOS",
    "PURGED_WALK_FORWARD",
    "COST_STRESS",
    "REGIME_STRESS",
    "FINAL_HOLDOUT",
    "PAPER",
    "SHADOW",
    "CHAMPION_COMPARISON",
  ]);
  assert.deepEqual(CHAMPION_EVIDENCE_REQUIREMENTS, ["FINAL_HOLDOUT", "PAPER", "SHADOW"]);
  const contract = buildAutonomousQuantLabContract();
  assert.deepEqual(contract.championEvidenceRequirements, ["FINAL_HOLDOUT", "PAPER", "SHADOW"]);
  assert.equal(contract.currentValidatedChampion, "NONE");
  assert.equal(contract.championRule, "BACKTEST_ONLY_NEVER_PROMOTES");
  assert.equal(contract.liveExecution, false);
  assert.equal(contract.privateAccountRequestAllowed, false);
  assert.equal(contract.orderSubmitted, false);
});
