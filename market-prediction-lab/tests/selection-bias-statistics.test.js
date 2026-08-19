import test from "node:test";
import assert from "node:assert/strict";
import {
  appendResearchTrial,
  buildSelectedStrategyFingerprint,
  buildStrategyIdentity,
  createResearchTrialRegistry,
  selectionTrials,
  summarizeTrialRegistry,
} from "../src/research-trial-registry.js";
import {
  buildSelectionBiasEvidence,
  computeCscvPbo,
  computeDeflatedSharpeRatio,
} from "../src/selection-bias-statistics.js";

const identityInput = Object.freeze({
  strategyId: "fixture-strategy",
  strategyVersion: "v1",
  researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
  datasetSnapshotHash: "dataset-001",
  market: "CRYPTO_FUTURES",
  timeframe: "1h",
  direction: "LONG_SHORT",
});

function trial(trialId, candidateId, returnSeries, stage = "development", selectionEligible = true) {
  return Object.freeze({
    trialId,
    candidateId,
    stage,
    selectionEligible,
    parameterHash: `hash-${trialId}`,
    returnSeries: Object.freeze(returnSeries),
    metrics: Object.freeze({ source: "fixture" }),
  });
}

const consistent = Object.freeze([
  trial("a", "candidate-a", [0.020, 0.018, 0.022, 0.019, 0.021, 0.017, 0.023, 0.020, 0.019, 0.022, 0.018, 0.021, 0.020, 0.019, 0.023, 0.018]),
  trial("b", "candidate-b", [0.008, 0.010, 0.007, 0.009, 0.011, 0.006, 0.010, 0.008, 0.009, 0.007, 0.010, 0.008, 0.006, 0.011, 0.009, 0.007]),
  trial("c", "candidate-c", [-0.004, 0.001, -0.002, 0.000, -0.003, 0.002, -0.001, -0.004, 0.001, -0.002, 0.000, -0.003, 0.002, -0.001, -0.004, 0.001]),
]);

test("strategy family identity and registry are deterministic and immutable", () => {
  const first = buildStrategyIdentity(identityInput);
  const second = buildStrategyIdentity({ ...identityInput });
  assert.deepEqual(first, second);
  assert.equal(typeof first.familyFingerprint, "string");
  assert.equal(first.familyFingerprint.length, 64);

  let registry = createResearchTrialRegistry({ experimentId: "exp-1", identity: identityInput });
  registry = appendResearchTrial(registry, consistent[0]);
  registry = appendResearchTrial(registry, consistent[1]);
  registry = appendResearchTrial(registry, consistent[2]);
  assert.equal(selectionTrials(registry).length, 3);
  const summary = summarizeTrialRegistry(registry);
  assert.equal(summary.selectionContamination, false);
  assert.equal(summary.strategyFamilyFingerprint, registry.strategyIdentity.familyFingerprint);
  assert.throws(() => appendResearchTrial(registry, consistent[0]), /duplicate trialId/);
});

test("different parameter trials share one family but produce different selected strategy fingerprints", () => {
  let registry = createResearchTrialRegistry({ experimentId: "exp-identities", identity: identityInput });
  registry = appendResearchTrial(registry, consistent[0]);
  registry = appendResearchTrial(registry, consistent[1]);
  assert.equal(registry.strategyIdentity.familyFingerprint.length, 64);
  const first = buildSelectedStrategyFingerprint(registry, registry.trials[0]);
  const second = buildSelectedStrategyFingerprint(registry, registry.trials[1]);
  assert.notEqual(first, second);
});

test("forward evidence cannot silently enter candidate selection", () => {
  const registry = createResearchTrialRegistry({ experimentId: "exp-forward-guard", identity: identityInput });
  assert.throws(() => appendResearchTrial(registry, trial(
    "paper-1",
    "candidate-a",
    [0.01, -0.01, 0.02, -0.005],
    "paper",
    true,
  )), /cannot be used for candidate selection/);
});

test("CSCV PBO is low for a candidate that dominates every block", () => {
  const result = computeCscvPbo(consistent, { blockCount: 4 });
  assert.equal(result.method, "CSCV_PBO");
  assert.equal(result.trialCount, 3);
  assert.equal(result.pbo, 0);
  assert.ok(result.combinationCount > 0);
});

test("CSCV PBO detects unstable in-sample winners that reverse out of sample", () => {
  const overfit = [
    trial("oa", "oa", [0.12, 0.10, 0.11, 0.09, -0.12, -0.10, -0.11, -0.09]),
    trial("ob", "ob", [-0.12, -0.10, -0.11, -0.09, 0.12, 0.10, 0.11, 0.09]),
    trial("oc", "oc", [0.08, 0.07, -0.08, -0.07, 0.08, 0.07, -0.08, -0.07]),
    trial("od", "od", [-0.08, -0.07, 0.08, 0.07, -0.08, -0.07, 0.08, 0.07]),
  ];
  const result = computeCscvPbo(overfit, { blockCount: 4 });
  assert.ok(result.pbo >= 0.5, JSON.stringify(result));
});

test("Deflated Sharpe accounts for multiple tested trials and non-normal moments", () => {
  const result = computeDeflatedSharpeRatio(
    consistent[0].returnSeries,
    consistent.map((row) => row.returnSeries),
  );
  assert.equal(result.method, "DEFLATED_SHARPE_RATIO");
  assert.equal(result.trialCount, 3);
  assert.ok(result.probability >= 0 && result.probability <= 1);
  assert.ok(Number.isFinite(result.expectedMaxSharpe));
  assert.ok(Number.isFinite(result.skewness));
  assert.ok(Number.isFinite(result.kurtosis));
});

test("selection bias bundle is tied to registry digest and selected parameter trial", () => {
  let registry = createResearchTrialRegistry({ experimentId: "exp-bundle", identity: identityInput });
  for (const row of consistent) registry = appendResearchTrial(registry, row);
  const evidence = buildSelectionBiasEvidence(registry, "a", { blockCount: 4 });
  assert.equal(evidence.strategyFamilyFingerprint, registry.strategyIdentity.familyFingerprint);
  assert.equal(evidence.strategyFingerprint, buildSelectedStrategyFingerprint(registry, registry.trials[0]));
  assert.equal(evidence.registryDigest, registry.registryDigest);
  assert.equal(evidence.selectedTrialId, "a");
  assert.equal(evidence.selectedParameterHash, "hash-a");
  assert.equal(evidence.policyPass, null);
});
