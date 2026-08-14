import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateRuleWeightSnapshotStability } from "../src/rule-model-blend-stability.js";

const evidence = JSON.parse(readFileSync(
  new URL("../docs/rule-model-blend-stability-evidence.json", import.meta.url),
  "utf8",
));

function snapshotWeights(group) {
  return evidence.snapshots.map((snapshot) => ({
    id: snapshot.id,
    ruleWeight: snapshot.selectedRuleWeights[group],
  }));
}

test("15m is held because validation-selected rule weight moved across exact artifacts", () => {
  const result = evaluateRuleWeightSnapshotStability(snapshotWeights("crypto-futures-15m"));
  assert.equal(result.stable, false);
  assert.equal(result.status, "research_hold");
  assert.equal(result.reason, "validation_selected_rule_weight_unstable_across_snapshots");
  assert.deepEqual(result.selectedWeights, [0.05, 0.3]);
  assert.deepEqual(evidence.verdicts["crypto-futures-15m"].selectedWeights, [0.05, 0.3]);
  assert.equal(evidence.verdicts["crypto-futures-15m"].status, "research_hold");
});

test("1h remains eligible only because both independent snapshots select exactly zero Rule weight", () => {
  const result = evaluateRuleWeightSnapshotStability(snapshotWeights("crypto-futures-1h"));
  assert.equal(result.stable, true);
  assert.equal(result.status, "stable_shadow_challenger_candidate");
  assert.equal(result.selectedRuleWeight, 0);
  assert.deepEqual(result.selectedWeights, [0, 0]);
  assert.equal(evidence.verdicts["crypto-futures-1h"].status, "stable_shadow_challenger_candidate");
});

test("fresh 1h evidence improves multiple metrics on both BTCUSDT and ETHUSDT", () => {
  const group = evidence.snapshots[1].untouchedTest["crypto-futures-1h"];
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const delta = group.bySymbol[symbol];
    assert.ok(delta.accuracyDelta > 0);
    assert.ok(delta.balancedAccuracyDelta > 0);
    assert.ok(delta.macroF1Delta > 0);
    assert.ok(delta.logLossImprovement > 0);
  }
});

test("stability evidence never changes runtime or grants promotion authority", () => {
  assert.equal(evidence.safety.exactGridAgreementRequired, true);
  assert.equal(evidence.safety.toleranceIntroducedAfterObservation, false);
  assert.equal(evidence.safety.runtimeChanged, false);
  assert.equal(evidence.safety.thresholdChanged, false);
  assert.equal(evidence.safety.classWeightChanged, false);
  assert.equal(evidence.safety.labelChanged, false);
  assert.equal(evidence.safety.finalHoldoutUsed, false);
  assert.equal(evidence.safety.paperUsed, false);
  assert.equal(evidence.safety.shadowUsedForSelection, false);
  assert.equal(evidence.safety.liveAuthority, false);
  assert.equal(evidence.safety.promotionAuthority, false);
});

test("stability checker fails closed on insufficient snapshots and invalid weights", () => {
  assert.throws(() => evaluateRuleWeightSnapshotStability([{ id: "one", ruleWeight: 0 }]), /at least 2 snapshots/);
  assert.throws(() => evaluateRuleWeightSnapshotStability([
    { id: "a", ruleWeight: 0 },
    { id: "b", ruleWeight: 0.7 },
  ]), /must be in \[0, 0.65\]/);
});
