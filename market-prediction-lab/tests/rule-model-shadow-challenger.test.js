import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertForwardOnlyChallengerState,
  buildRuleModelShadowPair,
  evaluateRuleModelShadowChallenger,
  RULE_MODEL_1H_CHALLENGER_GROUP,
  verifyFrozenShadowChallengerModel,
} from "../src/rule-model-shadow-challenger.js";

const frozen = JSON.parse(readFileSync(
  new URL("../docs/rule-model-1h-shadow-model.json", import.meta.url),
  "utf8",
));

function metric({ sampleCount = 300, accuracy, macroF1, balancedAccuracy, logLoss, bullRecall, bearRecall }) {
  return Object.freeze({
    sampleCount,
    accuracy,
    macroF1,
    balancedAccuracy,
    logLoss,
    brier: 0.55,
    perClass: Object.freeze({
      bullish: Object.freeze({ support: Math.floor(sampleCount / 3), precision: 0.5, recall: bullRecall, f1: 0.5 }),
      neutral: Object.freeze({ support: Math.floor(sampleCount / 3), precision: 0.5, recall: 0.5, f1: 0.5 }),
      bearish: Object.freeze({ support: sampleCount - 2 * Math.floor(sampleCount / 3), precision: 0.5, recall: bearRecall, f1: 0.5 }),
    }),
  });
}

function goodSummary() {
  const reference = metric({ accuracy: 0.35, macroF1: 0.24, balancedAccuracy: 0.33, logLoss: 1.15, bullRecall: 0.05, bearRecall: 0.05 });
  const candidate = metric({ accuracy: 0.46, macroF1: 0.42, balancedAccuracy: 0.44, logLoss: 1.06, bullRecall: 0.55, bearRecall: 0.42 });
  const symbolReference = metric({ sampleCount: 150, accuracy: 0.35, macroF1: 0.25, balancedAccuracy: 0.34, logLoss: 1.15, bullRecall: 0.06, bearRecall: 0.05 });
  const symbolCandidate = metric({ sampleCount: 150, accuracy: 0.45, macroF1: 0.40, balancedAccuracy: 0.43, logLoss: 1.07, bullRecall: 0.52, bearRecall: 0.40 });
  const regimeReference = metric({ sampleCount: 80, accuracy: 0.34, macroF1: 0.24, balancedAccuracy: 0.33, logLoss: 1.16, bullRecall: 0.05, bearRecall: 0.05 });
  const regimeCandidate = metric({ sampleCount: 80, accuracy: 0.44, macroF1: 0.38, balancedAccuracy: 0.41, logLoss: 1.08, bullRecall: 0.48, bearRecall: 0.38 });
  return Object.freeze({
    settled: 300,
    firstAnchorTimestamp: 1_700_000_000_000,
    lastAnchorTimestamp: 1_700_000_000_000 + 29 * 24 * 60 * 60 * 1000,
    candidate,
    reference,
    bySymbol: Object.freeze({
      BTCUSDT: Object.freeze({ candidate: symbolCandidate, reference: symbolReference }),
      ETHUSDT: Object.freeze({ candidate: symbolCandidate, reference: symbolReference }),
    }),
    byRegime: Object.freeze({
      "bull_trend:normal_volatility": Object.freeze({ candidate: regimeCandidate, reference: regimeReference }),
      "range:low_volatility": Object.freeze({ candidate: regimeCandidate, reference: regimeReference }),
    }),
  });
}

test("frozen 1h challenger model is byte-semantically pinned by object SHA-256", () => {
  const verified = verifyFrozenShadowChallengerModel(frozen);
  assert.equal(verified.model.id, "tiny-softmax-crypto-futures-1h-v1-calibrated");
  assert.equal(verified.modelObjectSha256, "2dc12baf63d41fe5a098952fae151353b2f19744878f76e95381950e2eb60c31");
  assert.equal(frozen.provenance.sourceArtifactId, "9207808341");
  assert.equal(frozen.provenance.sourceArtifactSha256, "88f7190c96c9f2afd51cacfc350bf43f3d29a100617b6e4106a8b7423d08fbe1");
});

test("rule0 challenger and deployed65 reference use the same frozen model", () => {
  const { model } = verifyFrozenShadowChallengerModel(frozen);
  const pair = buildRuleModelShadowPair({
    features: Object.fromEntries(model.featureOrder.map((key) => [key, 0])),
    ruleScore: 0,
    model,
  });
  assert.equal(pair.challengerModelId, `${model.id}:rule-0.00`);
  assert.equal(pair.referenceModelId, `${model.id}:rule-0.65`);
  assert.notDeepEqual(pair.challengerProbabilities, pair.referenceProbabilities);
});

test("forward-only state rejects historical backfill and non-1h contamination", () => {
  const start = 1_800_000_000_000;
  assert.doesNotThrow(() => assertForwardOnlyChallengerState({
    challengerStartedAt: start,
    records: [{ modelGroup: RULE_MODEL_1H_CHALLENGER_GROUP, timeframe: "1h", anchorTimestamp: start }],
  }));
  assert.throws(() => assertForwardOnlyChallengerState({
    challengerStartedAt: start,
    records: [{ modelGroup: RULE_MODEL_1H_CHALLENGER_GROUP, timeframe: "1h", anchorTimestamp: start - 1 }],
  }), /backfill is forbidden/);
  assert.throws(() => assertForwardOnlyChallengerState({
    challengerStartedAt: start,
    records: [{ modelGroup: "crypto-futures-15m", timeframe: "15m", anchorTimestamp: start }],
  }), /unexpected model group or timeframe/);
});

test("forward Shadow challenger gate requires multi-metric improvement and coverage", () => {
  const result = evaluateRuleModelShadowChallenger(goodSummary());
  assert.equal(result.approved, true);
  assert.equal(result.status, "shadow_challenger_review_ready");
  assert.equal(result.safety.liveAuthority, false);
  assert.equal(result.safety.promotionAuthority, false);
  assert.equal(result.safety.actualOrders, 0);
});

test("forward Shadow challenger remains fail-closed on insufficient evidence", () => {
  const summary = { ...goodSummary(), settled: 20, lastAnchorTimestamp: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000 };
  const result = evaluateRuleModelShadowChallenger(summary);
  assert.equal(result.approved, false);
  assert.equal(result.status, "shadow_challenger_continue");
  assert.ok(result.reasons.includes("insufficient_settled_samples"));
  assert.ok(result.reasons.includes("insufficient_elapsed_shadow_period"));
});
