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
  return buildStrategyEvidenceEnvelope({ strategyIdentity, strategyIdentityDigest: resolved.strategyIdentityDigest, evidenceType: "CANONICAL", evidenceStage, source: "owner", sourceSha: "2".repeat(40), artifactId: evidenceStage, artifactDigest: sha256Canonical(payload), artifactPayload: payload, measuredAt: "2026-08-25T00:00:00.000Z", datasetIdentity: { datasetId: strategyIdentity.datasetId, datasetDigest: strategyIdentity.datasetDigest, datasetStart: strategyIdentity.datasetStart, datasetEnd: strategyIdentity.datasetEnd }, sample: { sampleN: 60, tradeN: 60, settledN: null }, metrics: { expectancy: 0.02, profitFactor: 1.4, netReturn: 0.3, mdd: 0.18, positiveWindowRatio: 0.75, costAdjustedReturn: 0.02, dsr: 0.8, pbo: 0.2 }, costs: evidenceStage === "COST_STRESS" ? { costPolicyVersion: "cost-v1" } : null, validation: { datasetIntegrity: true, noFutureLeakage: true, noSameBarLeakage: true, parameterStability: "PASS", costStressSurvived: true, mddAcceptable: true, overfitVerdict: "PASS" } });
}

function registry(identityOverrides = {}) {
  const strategyIdentity = identity(identityOverrides); const resolved = resolveCanonicalStrategyIdentity(strategyIdentity);
  return selectProvisionalChampion({ candidates: [{ strategyIdentity, strategyIdentityDigest: resolved.strategyIdentityDigest, evidenceEnvelopes: [evidence("OOS", strategyIdentity), evidence("WALK_FORWARD", strategyIdentity), evidence("COST_STRESS", strategyIdentity), evidence("STATISTICAL_FIREWALL", strategyIdentity)], testOnly: true }], policy: { ...PROVISIONAL_CHAMPION_POLICY_V1, environment: "TEST_ONLY" } });
}

function card(overrides = {}) {
  const digest = overrides.strategyIdentityDigest ?? resolveCanonicalStrategyIdentity(identity()).strategyIdentityDigest;
  const boundPass = { status: "PASS", strategyIdentityDigest: digest, executionAuthority: "NONE" };
  return {
    symbol: "AAPL", market: "US_STOCK", direction: "BUY", timeframe: "1D", strategyIdentityDigest: digest,
    observedAt: "2026-08-25T00:00:00.000Z", expiresAt: "2026-08-26T00:00:00.000Z",
    providerAvailable: true, dataCompleteness: "COMPLETE", liquidity: 1_000_000,
    riskEvidence: { ...boundPass },
    costEvidence: { ...boundPass, costPolicyVersion: "cost-v1" },
    strategyHealthEvidence: { ...boundPass },
    regimeCompatibility: { ...boundPass },
    executionCapability: {
      ...boundPass, mode: "PAPER_ONLY", market: overrides.market ?? "US_STOCK", direction: overrides.direction ?? "BUY",
      timeframe: overrides.timeframe ?? "1D", LIVE_TRADING: false, AUTO_TRADING: false, REAL_ORDER_ENABLED: false,
      PRIVATE_TRADING_API_ALLOWED: false, orderSubmitted: false,
    },
    entry: 100, stop: 95, target: 110, riskReward: 2, ...overrides,
  };
}

const CONTEXT = Object.freeze({ environment: "TEST_ONLY", now: "2026-08-25T12:00:00.000Z", providerAvailable: true, minimumLiquidity: 1000, minimumRiskReward: 1.5 });

test("Champion NONE is NO_TRADE and never falls back to legacy cards", () => {
  const cards = [card()];
  const none = selectProvisionalChampion({ candidates: [] });
  const result = consumeProvisionalChampionForScanner({ registry: none, cards, context: CONTEXT });
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.championState, "NONE");
  assert.deepEqual(result.cards, []);
  assert.ok(result.blockers.includes("NO_PROVISIONAL_CHAMPION"));
  const forgedNone = consumeProvisionalChampionForScanner({ registry: { status: "NONE", currentProvisionalChampion: "NONE" }, cards, context: CONTEXT });
  assert.equal(forgedNone.status, "NO_TRADE");
  assert.ok(forgedNone.blockers.includes("CHAMPION_REGISTRY_SAFETY_INVALID"));
});

test("exact Provisional identity produces advisory metadata with evidence lineage but no trade authority in TEST_ONLY context", () => {
  const source = registry();
  const result = consumeProvisionalChampionForScanner({ registry: source, cards: [card()], context: CONTEXT });
  assert.equal(result.status, "ADVISORY_CANDIDATES");
  assert.equal(result.cards[0].championState, "PROVISIONAL");
  assert.equal(result.cards[0].advisoryState, "ADVISORY");
  assert.equal(result.cards[0].riskReward, 2);
  assert.equal(result.cards[0].costEvidenceStatus, "PASS");
  assert.equal(result.cards[0].strategyHealthStatus, "PASS");
  assert.equal(result.cards[0].regimeCompatibilityStatus, "PASS");
  assert.equal(result.cards[0].executionCapabilityStatus, "PASS");
  assert.equal(result.cards[0].evidenceDigest, source.evidenceDigest);
  assert.equal(result.cards[0].safety.executionAuthority, "NONE");
  assert.equal(result.cards[0].safety.orderSubmitted, false);
  assert.equal(result.cards[0].safety.LIVE_TRADING, false);
  assert.equal(result.cards[0].safety.AUTO_TRADING, false);
  assert.equal(result.cards[0].safety.REAL_ORDER_ENABLED, false);
  assert.equal(result.cards[0].safety.PRIVATE_TRADING_API_ALLOWED, false);
});

test("registry identity and evidence lineage are revalidated before Scanner consumption", () => {
  const source = registry();
  const tamperedIdentity = {
    ...source,
    currentProvisionalChampion: { ...source.currentProvisionalChampion, strategyIdentityDigest: HASH_B },
  };
  const identityResult = consumeProvisionalChampionForScanner({ registry: tamperedIdentity, cards: [card()], context: CONTEXT });
  assert.equal(identityResult.status, "NO_TRADE");
  assert.ok(identityResult.blockers.includes("CHAMPION_REGISTRY_SAFETY_INVALID"));

  const tamperedEvidence = {
    ...source,
    currentProvisionalChampion: { ...source.currentProvisionalChampion, evidenceDigest: HASH_A },
  };
  const evidenceResult = consumeProvisionalChampionForScanner({ registry: tamperedEvidence, cards: [card()], context: CONTEXT });
  assert.equal(evidenceResult.status, "NO_TRADE");
  assert.ok(evidenceResult.blockers.includes("CHAMPION_REGISTRY_SAFETY_INVALID"));
});

test("TEST_ONLY champion is forbidden in production Scanner context", () => {
  const result = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card()], context: { ...CONTEXT, environment: "PRODUCTION" } });
  assert.equal(result.status, "NO_TRADE");
  assert.ok(result.blockers.includes("TEST_ONLY_CHAMPION_FORBIDDEN"));
});

test("a TEST_ONLY registry cannot be relabeled as canonical without adapter lineage", () => {
  const source = registry();
  const canonicalLooking = {
    ...source,
    currentProvisionalChampion: { ...source.currentProvisionalChampion, evidenceClass: "CANONICAL" },
  };
  const result = consumeProvisionalChampionForScanner({ registry: canonicalLooking, cards: [card()], context: { ...CONTEXT, environment: "PRODUCTION" } });
  assert.equal(result.status, "NO_TRADE");
  assert.ok(result.blockers.includes("CHAMPION_REGISTRY_SAFETY_INVALID"));
});

test("identity mismatch, stale data, provider failure and missing risk fail closed as NO_TRADE", () => {
  for (const [overrides, context, blocker] of [
    [{ strategyIdentityDigest: HASH_B }, CONTEXT, "STRATEGY_IDENTITY_MISMATCH"],
    [{ expiresAt: "2026-08-25T11:00:00.000Z" }, CONTEXT, "STALE_MANDATORY_DATA"],
    [{ providerAvailable: false }, CONTEXT, "PROVIDER_UNAVAILABLE"],
    [{ riskEvidence: null }, CONTEXT, "RISK_EVIDENCE_INVALID"],
  ]) {
    const result = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card(overrides)], context });
    assert.equal(result.status, "NO_TRADE");
    assert.ok(result.decisions[0].blockers.includes(blocker));
    assert.deepEqual(result.cards, []);
  }
});

test("market, direction, timeframe, completeness and card liquidity mismatches fail closed", () => {
  for (const [overrides, blocker] of [
    [{ market: "KR_STOCK" }, "MARKET_MISMATCH"],
    [{ direction: "SHORT", entry: 100, stop: 105, target: 90 }, "DIRECTION_MISMATCH"],
    [{ timeframe: "1H" }, "TIMEFRAME_MISMATCH"],
    [{ dataCompleteness: "PARTIAL" }, "MANDATORY_DATA_INCOMPLETE"],
    [{ liquidity: 999 }, "INVALID_LIQUIDITY"],
  ]) {
    const result = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card(overrides)], context: CONTEXT });
    assert.equal(result.status, "NO_TRADE");
    assert.ok(result.decisions[0].blockers.includes(blocker), blocker);
    assert.deepEqual(result.cards, []);
  }
});

test("cost, Strategy Health, regime compatibility and execution capability are mandatory bound hard gates", () => {
  for (const [overrides, blocker] of [
    [{ costEvidence: null }, "COST_EVIDENCE_INVALID"],
    [{ costEvidence: { status: "FAIL", strategyIdentityDigest: resolveCanonicalStrategyIdentity(identity()).strategyIdentityDigest, executionAuthority: "NONE", costPolicyVersion: "cost-v1" } }, "COST_EVIDENCE_INVALID"],
    [{ strategyHealthEvidence: null }, "STRATEGY_HEALTH_EVIDENCE_INVALID"],
    [{ regimeCompatibility: { status: "UNKNOWN", strategyIdentityDigest: resolveCanonicalStrategyIdentity(identity()).strategyIdentityDigest, executionAuthority: "NONE" } }, "REGIME_COMPATIBILITY_EVIDENCE_INVALID"],
    [{ executionCapability: null }, "EXECUTION_CAPABILITY_EVIDENCE_INVALID"],
  ]) {
    const result = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card(overrides)], context: CONTEXT });
    assert.equal(result.status, "NO_TRADE");
    assert.ok(result.decisions[0].blockers.includes(blocker), blocker);
    assert.deepEqual(result.cards, []);
  }

  const liveCapable = card().executionCapability;
  const liveResult = consumeProvisionalChampionForScanner({
    registry: registry(),
    cards: [card({ executionCapability: { ...liveCapable, mode: "LIVE", LIVE_TRADING: true } })],
    context: CONTEXT,
  });
  assert.equal(liveResult.status, "NO_TRADE");
  assert.ok(liveResult.decisions[0].blockers.includes("EXECUTION_CAPABILITY_INVALID"));

  const badCostPolicy = consumeProvisionalChampionForScanner({
    registry: registry(),
    cards: [card({ costEvidence: { ...card().costEvidence, costPolicyVersion: "other-cost" } })],
    context: CONTEXT,
  });
  assert.equal(badCostPolicy.status, "NO_TRADE");
  assert.ok(badCostPolicy.decisions[0].blockers.includes("COST_POLICY_IDENTITY_MISMATCH"));
});

test("a provider failure clears otherwise advisory cards at scan level", () => {
  const result = consumeProvisionalChampionForScanner({
    registry: registry(),
    cards: [card(), card({ symbol: "MSFT", providerAvailable: false })],
    context: CONTEXT,
  });
  assert.equal(result.status, "NO_TRADE");
  assert.deepEqual(result.cards, []);
  assert.ok(result.blockers.includes("PROVIDER_UNAVAILABLE"));
});

test("missing liquidity or RR policy fails closed instead of inventing thresholds", () => {
  const missingLiquidity = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card()], context: { ...CONTEXT, minimumLiquidity: undefined } });
  assert.equal(missingLiquidity.status, "NO_TRADE");
  assert.ok(missingLiquidity.decisions[0].blockers.includes("LIQUIDITY_POLICY_MISSING"));

  const missingRr = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card()], context: { ...CONTEXT, minimumRiskReward: undefined } });
  assert.equal(missingRr.status, "NO_TRADE");
  assert.ok(missingRr.decisions[0].blockers.includes("RISK_REWARD_POLICY_MISSING"));
});

test("RR is derived from positive Entry/Stop/Target and invalid geometry or spoofed RR fails closed", () => {
  const invalidGeometry = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card({ stop: 105 })], context: CONTEXT });
  assert.equal(invalidGeometry.status, "NO_TRADE");
  assert.ok(invalidGeometry.decisions[0].blockers.includes("INVALID_ENTRY_STOP_TARGET_GEOMETRY"));

  const nonPositivePrices = consumeProvisionalChampionForScanner({ registry: registry(), cards: [card({ entry: -100, stop: -105, target: -90 })], context: CONTEXT });
  assert.equal(nonPositivePrices.status, "NO_TRADE");
  assert.ok(nonPositivePrices.decisions[0].blockers.includes("INVALID_ENTRY_STOP_TARGET_GEOMETRY"));

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
