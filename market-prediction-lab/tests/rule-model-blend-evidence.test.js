import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const evidence = JSON.parse(readFileSync(
  new URL("../docs/rule-model-blend-challenger-evidence.json", import.meta.url),
  "utf8",
));

function assertGroup(group, expectedRuleWeight) {
  assert.equal(group.status, "shadow_challenger_candidate");
  assert.equal(group.deployedRuleWeight, 0.65);
  assert.equal(group.candidateRuleWeight, expectedRuleWeight);
  assert.equal(group.selection.source, "validation_only");
  assert.equal(group.selection.testUsedForSelection, false);
  assert.ok(group.untouchedTest.comparison.macroF1Delta >= 0.05);
  assert.ok(group.untouchedTest.comparison.balancedAccuracyDelta >= 0.03);
  assert.ok(group.untouchedTest.comparison.directionalRecallAverageDelta >= 0.03);
  assert.ok(group.untouchedTest.comparison.accuracyDelta >= -0.02);
  assert.ok(group.untouchedTest.comparison.logLossImprovement >= -0.01);
}

test("challenger evidence is pinned to the exact parent suite artifact", () => {
  assert.equal(evidence.provenance.sourceRunId, "31768554408");
  assert.equal(evidence.provenance.sourceArtifactId, "9207316364");
  assert.equal(evidence.provenance.sourceArtifactSha256, "89a0611f4a5e1239e0168e98be2db46c2427709e5eabf7b3038bf92af51bd64d");
  assert.equal(evidence.provenance.sourceHeadSha, "c12c7291ecc601d2dc20c6e874fc86f9ccd9f7bb");
});

test("15m and 1h evidence satisfy preregistered untouched-test challenger gates", () => {
  assertGroup(evidence.groups["crypto-futures-15m"], 0.05);
  assertGroup(evidence.groups["crypto-futures-1h"], 0.0);
});

test("evidence never grants production or promotion authority", () => {
  assert.equal(evidence.safety.validationOnlySelection, true);
  assert.equal(evidence.safety.untouchedTestGate, true);
  assert.equal(evidence.safety.finalHoldoutUsed, false);
  assert.equal(evidence.safety.paperUsed, false);
  assert.equal(evidence.safety.shadowUsedForSelection, false);
  assert.equal(evidence.safety.runtimeChanged, false);
  assert.equal(evidence.safety.thresholdChanged, false);
  assert.equal(evidence.safety.classWeightChanged, false);
  assert.equal(evidence.safety.labelChanged, false);
  assert.equal(evidence.safety.liveAuthority, false);
  assert.equal(evidence.safety.promotionAuthority, false);
});
