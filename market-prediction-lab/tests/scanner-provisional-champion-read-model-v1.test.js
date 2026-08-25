import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import { resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";
import { buildStrategyEvidenceEnvelope } from "../src/strategy-evidence-envelope-v1.js";
import { PROVISIONAL_CHAMPION_POLICY_V1, selectProvisionalChampion } from "../src/provisional-champion-selector-v1.js";
import { consumeProvisionalChampionForScanner } from "../src/scanner-provisional-champion-read-model-v1.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function identity(overrides = {}) {
  return { strategyId: "candidate-a", strategyFamily: "regime", strategyVersion: "v1", market: "US_STOCK", direction: "BUY", timeframe: "1D", formulaIdentity: "formula-v1", parameterHash: HASH_A, researchCodeSha: "1".repeat(40), datasetId: "dataset-v1", datasetDigest: HASH_B, datasetStart: "2020-01-01T00:00:00.000Z", datasetEnd: "2025-01-01T00:00:00.000Z", costPolicyVersion: "cost-v1", riskPolicyVersion: "risk-v1", evidenceSchemaVersion: "strategy-evidence-envelope-v1", ...overrides };
}

function evidence(evidenceStage, strategyIdentity = identity()) {
  const resolved = resolveCanonicalStrategyIdentity(strategyIdentity);
  const payload = { evidenceStage };
  return buildStrategyEvidenceEnvelope({ strategyIdentity, strategyIdentityDigest: resolved.strategyIdentityDigest, evidenceType: "CANONICAL", evidenceStage, source: "owner", sourceSha: "2".repeat(40), artifactId: evidenceStage, artifactDigest: sha256Canonical(payload), artifactPayload: payload, measuredAt: "2026-08-25T00:00:00.000Z", datasetIdentity: { datasetId: strategyIdentity.datasetId, datasetDigest: strategyIdentity.datasetDigest, datasetStart: strategyIdentity.datasetStart, datasetEnd: strategyIdentity.datasetEnd }, sample: { sampleN: 60, tradeN: 60, settledN: null }, metrics: { expectancy: 0.02, profitFactor: 1.4, mdd: 0.18, positiveWindowRatio: 0.75, costAdjustedReturn: 0.02, dsr: 0.8, pbo: 0.2 }, costs: evidenceStage === "COST_STRESS" ? { costPolicyVersion: "cost-v1" } : null, validation: { datasetIntegrity: true, noFutureLeakage: true, noSameBarLeakage: true, parameterStability: "PASS", costStressSurvived: true, mddAcceptable: true, overfitVerdict: "PASS" } });
}

function registry(identityOverrides = {}) {
  const strategyIdentity = identity(identityOverrides); const resolved = resolveCanonicalStrategyIdentity(strategyIdentity);
  return selectProvisionalChampion({ candidates: [{ strategyIdentity, strategyIdentityDigest: resolved.strategyIdentityDigest, evidenceEnvelopes: [evidence("OOS", strategyIdentity), evidence("WALK_FORWARD", strategyIdentity), evidence("COST_STRESS", strategyIdentity), evidence("STATISTICAL_FIREWALL", strategyIdentity)], testOnly: true }], policy: { ...PROVISIONAL_CHAMPION_POLICY_V1, environment: "TEST_ONLY" } });
}

function card(overrides = {}) {
  const digest = resolveCanonicalStrategyIdentity(identity()).strategyIdentityDigest;
  return { symbol: "AAPL", market: "US_STOCK", direction: "BUY", timeframe: "1D", strategyIdentityDigest: digest, observedAt: "2026-08-25T00:00:00.000Z", expiresAt: "2026-08-26T00:00:00.000Z", providerAvailable: true, dataCompleteness: "COMPLETE", liquidity: 1_000_000, riskEvidence: { status: "PASS" }, entry: 100, stop: 95, target: 110, riskReward: 2, ...overrides };
}

const CONTEXT = Object.freeze({ now: "2026-08-25T12:00:00.000Z", providerAvailable: true, minimumLiquidity: 1000, minimumRiskReward: 1.5 });

test("Champion NONE preserves existing Scanner behavior", () => {
  const cards = [card()];
  const none = selectProvisionalChampion({ candidates: [] });
  const result = consumeProvisionalChampionForScanner({ registry: none, cards, context: CONTEXT });
  assert.equal(result.status, "LEGACY_UNCHANGED");
  assert.equal(result.cards, cards);
});

test("exact Provisional identity produces advisory metadata without trade authority", () => {
  const result = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card()], context: CONTEXT });
  assert.equal(result.status, "ADVISORY_CANDIDATES");
  assert.equal(result.cards[0].championState, "PROVISIONAL");
  assert.equal(result.cards[0].advisoryState, "ADVISORY");
  assert.equal(result.cards[0].riskReward, 2);
  assert.equal(result.cards[0].safety.executionAuthority, "NONE");
  assert.equal(result.cards[0].safety.orderSubmitted, false);
});

test("identity mismatch, stale data, provider failure and missing risk fail closed as NO_TRADE", () => {
  for (const [overrides, context, blocker] of [
    [{ strategyIdentityDigest: HASH_B }, CONTEXT, "STRATEGY_IDENTITY_MISMATCH"],
    [{ expiresAt: "2026-08-25T11:00:00.000Z" }, CONTEXT, "STALE_MANDATORY_DATA"],
    [{ providerAvailable: false }, CONTEXT, "PROVIDER_UNAVAILABLE"],
    [{ riskEvidence: null }, CONTEXT, "INVALID_RISK_EVIDENCE"],
  ]) {
    const result = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card(overrides)], context });
    assert.equal(result.status, "NO_TRADE");
    assert.ok(result.decisions[0].blockers.includes(blocker));
  }
});

test("missing liquidity or RR policy fails closed instead of inventing thresholds", () => {
  const missingLiquidity = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card()], context: { ...CONTEXT, minimumLiquidity: undefined } });
  assert.equal(missingLiquidity.status, "NO_TRADE");
  assert.ok(missingLiquidity.decisions[0].blockers.includes("LIQUIDITY_POLICY_MISSING"));

  const missingRr = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card()], context: { ...CONTEXT, minimumRiskReward: undefined } });
  assert.equal(missingRr.status, "NO_TRADE");
  assert.ok(missingRr.decisions[0].blockers.includes("RISK_REWARD_POLICY_MISSING"));
});

test("RR is derived from Entry/Stop/Target and invalid geometry or spoofed RR fails closed", () => {
  const invalidGeometry = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card({ stop: 105 })], context: CONTEXT });
  assert.equal(invalidGeometry.status, "NO_TRADE");
  assert.ok(invalidGeometry.decisions[0].blockers.includes("INVALID_ENTRY_STOP_TARGET_GEOMETRY"));

  const spoofedRr = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card({ riskReward: 9 })], context: CONTEXT });
  assert.equal(spoofedRr.status, "NO_TRADE");
  assert.ok(spoofedRr.decisions[0].blockers.includes("RISK_REWARD_MISMATCH"));

  const shortRegistry = registry({ direction: "SHORT" });
  const shortDigest = shortRegistry.currentProvisionalChampion.strategyIdentityDigest;
  const shortResult = consumeProvisionalChampionForScanner({ registry: shortRegistry, cards: [card({ direction: "SHORT", strategyIdentityDigest: shortDigest, entry: 100, stop: 105, target: 90, riskReward: 2 })], context: CONTEXT });
  assert.equal(shortResult.status, "ADVISORY_CANDIDATES");
  assert.equal(shortResult.cards[0].riskReward, 2);
});

test("registry unavailable is NO_TRADE and zero matching symbols is a valid empty result", () => {
  const unavailable = consumeProvisionalChampionForScanner({ registry: null, cards: [card()], context: CONTEXT });
  assert.equal(unavailable.status, "NO_TRADE");
  assert.ok(unavailable.blockers.includes("CHAMPION_REGISTRY_UNAVAILABLE"));
  const empty = consumeProvisionalChampionForScanner({ registry: registry(), cards: [], context: CONTEXT });
  assert.equal(empty.status, "VALID_EMPTY");
  assert.deepEqual(empty.cards, []);
});
