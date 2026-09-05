import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
  bindNaturalPaperTriggerBoundSettlementEvidence,
  createNaturalPaperTriggerBoundSettlementCostProducer,
  validateNaturalPaperTriggerBoundSettlementEvidence,
} from "../src/natural-paper-trigger-bound-settlement-cost-producer-v1.js";

const T0 = 1_800_000_000_000;
const COMPONENTS = [
  "commission", "tax", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact",
];

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function fixture() {
  const position = {
    positionId: "position-1",
    paperSampleId: "sample-1",
    signalId: "signal-1",
    market: "CRYPTO_SPOT",
    symbol: "KRW-BTC",
    direction: "BUY",
    strategyId: "strategy-1",
    strategyVersion: "v1",
    parameterHash: "parameters-1",
    researchCodeSha: "a".repeat(40),
    costPolicyVersion: "cost-v1",
    lifecycle: {
      immutableContractDigest: "immutable-lifecycle-1",
      sampleEligibility: { provenanceClass: "NATURAL_FORWARD" },
    },
  };
  const triggerPayload = {
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    costPolicyVersion: position.costPolicyVersion,
    positionLifecycleDigest: position.lifecycle.immutableContractDigest,
    triggerObservationId: "trigger-observation-1",
    triggeredAtMs: T0,
    bar: { open: 100, high: 106, low: 99, close: 105 },
  };
  const trigger = { ...triggerPayload, exitTriggerId: sha(triggerPayload) };
  position.lifecycle.pendingExit = trigger;
  const sourceIdentity = "CANONICAL_PUBLIC_SETTLEMENT_AGGREGATOR_V1";
  const provenanceId = sha("canonical-settlement-provenance-1");
  const positionIdentity = {
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
  };
  const exitExecutionIdentity = {
    exitTriggerId: trigger.exitTriggerId,
    triggerObservationId: trigger.triggerObservationId,
    triggeredAtMs: trigger.triggeredAtMs,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    costPolicyVersion: position.costPolicyVersion,
    sourceIdentity,
    provenanceId,
    exitExecutionDigest: null,
  };
  const observedAtMs = T0 + 100;
  const maximumAgeMs = 60_000;
  const components = Object.fromEntries(COMPONENTS.map((name) => [name, {
    status: "PRESENT",
    valuePercent: name === "commission" ? 0.1 : 0,
    quality: name === "tax" || name === "funding" ? "NOT_APPLICABLE" : name === "commission" ? "DOCUMENTED" : "OBSERVED",
    source: `CANONICAL_${name.toUpperCase()}_SOURCE_V1`,
    provenance: `canonical ${name} evidence`,
    sourceIdentity: `CANONICAL_${name.toUpperCase()}_SOURCE_V1`,
    provenanceId: sha(`canonical-${name}-provenance`),
    positionIdentity,
    exitExecutionIdentity,
    freshness: { observedAtMs, maximumAgeMs },
    policyIdentity: { version: position.costPolicyVersion },
    observedAtMs,
    countsAsExecutionCost: true,
    unavailableIsZero: false,
    ...(name === "funding" ? { realized: false, projectedIsRealized: false } : {}),
  }]));
  const settlementInput = {
    exitTriggerId: trigger.exitTriggerId,
    exitExecution: {
      costPolicy: {
        version: position.costPolicyVersion,
        commissionRate: 0.001,
        taxRate: 0,
        spreadRate: 0,
        slippageRate: 0,
        fundingRate: 0,
        latencyRate: 0,
        liquidityImpactRate: 0,
        partialFillImpactRate: 0,
      },
    },
    exitBar: { ...trigger.bar, timestampMs: trigger.triggeredAtMs },
    exitQuote: { bid: 104, ask: 105, asOfMs: trigger.triggeredAtMs, maxAgeMs: maximumAgeMs },
    pathBars: [],
    fundingEvidence: { complete: true, payments: [] },
  };
  exitExecutionIdentity.exitExecutionDigest = sha(settlementInput.exitExecution);
  const settlementCostEvidence = {
    schemaVersion: "authoritative-paper-execution-cost-sources-v1",
    status: "PRESENT",
    fullCostReady: true,
    maximumAgeMs,
    sourceIdentity,
    provenanceId,
    positionIdentity,
    exitExecutionIdentity,
    exitTriggerId: trigger.exitTriggerId,
    components,
    costPolicyIdentity: { version: position.costPolicyVersion },
    projectedFundingRealized: false,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
  };
  const authoritativeEvidence = {
    schemaVersion: AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
    status: "PRESENT",
    fullCostReady: true,
    sourceIdentity,
    provenanceId,
    positionIdentity,
    exitExecutionIdentity,
    freshness: { observedAtMs, maximumAgeMs },
    settlementInput,
    settlementCostEvidence,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    synthetic: false,
    replay: false,
    backfill: false,
    duplicate: false,
    historical: false,
    testOnly: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
  const observation = {
    observationId: "later-public-observation",
    observedAtMs: T0 + 200,
    maxAgeMs: maximumAgeMs,
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD", synthetic: false, replay: false, backfill: false,
      duplicate: false, historical: false, testOnly: false,
    },
  };
  return { position, trigger, observation, authoritativeEvidence, evaluatedAtMs: T0 + 200 };
}

test("producer binds one authoritative Full Cost payload to the exact frozen exit trigger", async () => {
  const row = fixture();
  let collected = null;
  const producer = createNaturalPaperTriggerBoundSettlementCostProducer({
    async collectAuthoritativeEvidence(input) {
      collected = input;
      return row.authoritativeEvidence;
    },
  });
  const result = await producer(row);
  assert.equal(result.status, "PRESENT");
  assert.equal(result.exitTriggerId, row.trigger.exitTriggerId);
  assert.equal(result.observation.settlementInput.exitTriggerId, row.trigger.exitTriggerId);
  assert.equal(result.observation.triggerBoundSettlementEvidence.executionAuthority, "NONE");
  assert.equal(result.observation.triggerBoundSettlementEvidence.naturalSampleCredit, 0);
  assert.equal(Object.isFrozen(result.observation), true);
  assert.deepEqual(collected.exitTrigger, row.trigger);
  assert.equal(collected.executionAuthority, "NONE");
  assert.equal(validateNaturalPaperTriggerBoundSettlementEvidence({
    position: row.position,
    observation: result.observation,
    evaluatedAtMs: row.evaluatedAtMs,
  }).status, "PRESENT");
});

test("Futures accepts observed realized funding but never a projected component", () => {
  const row = fixture();
  row.position.market = "CRYPTO_FUTURES";
  row.authoritativeEvidence.positionIdentity.market = "CRYPTO_FUTURES";
  row.authoritativeEvidence.exitExecutionIdentity.market = "CRYPTO_FUTURES";
  const funding = row.authoritativeEvidence.settlementCostEvidence.components.funding;
  funding.quality = "OBSERVED";
  funding.realized = true;
  funding.projectedIsRealized = false;
  assert.equal(bindNaturalPaperTriggerBoundSettlementEvidence(row).status, "PRESENT");
  funding.evidenceClass = "PROJECTED_COMPONENT";
  assert.equal(bindNaturalPaperTriggerBoundSettlementEvidence(row).status, "BLOCKED_DATA");
});

for (const [name, mutate] of [
  ["rewritten trigger", (e) => { e.exitExecutionIdentity.exitTriggerId = "f".repeat(64); }],
  ["wrong Position", (e) => { e.positionIdentity.positionId = "other"; }],
  ["missing component source identity", (e) => { e.settlementCostEvidence.components.spread.sourceIdentity = ""; }],
  ["missing component provenance identity", (e) => { e.settlementCostEvidence.components.slippage.provenanceId = "missing"; }],
  ["wrong component Position identity", (e) => { e.settlementCostEvidence.components.latency.positionIdentity.positionId = "other"; }],
  ["wrong component execution identity", (e) => { e.settlementCostEvidence.components.commission.exitExecutionIdentity.triggeredAtMs += 1; }],
  ["stale component freshness", (e) => { e.settlementCostEvidence.components.liquidityImpact.freshness.maximumAgeMs = 1; }],
  ["unknown converted to zero", (e) => { e.unknownIsZero = true; }],
  ["backfill evidence", (e) => { e.backfill = true; }],
  ["missing partial-fill cost", (e) => { delete e.settlementCostEvidence.components.partialFillImpact; }],
  ["cyclic non-canonical payload", (e) => { e.settlementInput.self = e.settlementInput; }],
  ["projected funding promoted to realized", (e) => {
    e.settlementCostEvidence.components.funding.evidenceClass = "PROJECTED_COMPONENT";
    e.settlementCostEvidence.components.funding.realized = true;
  }],
]) {
  test(`${name} fails closed without a bound observation`, () => {
    const row = fixture();
    mutate(row.authoritativeEvidence);
    const result = bindNaturalPaperTriggerBoundSettlementEvidence(row);
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.fullCostReady, false);
    assert.equal(result.observation, undefined);
    assert.equal(result.unknownIsZero, false);
    assert.equal(result.executionAuthority, "NONE");
  });
}

test("collector failure is a stable BLOCKED_DATA result and cannot mutate the trigger", async () => {
  const row = fixture();
  const original = structuredClone(row.trigger);
  const producer = createNaturalPaperTriggerBoundSettlementCostProducer({
    async collectAuthoritativeEvidence() { throw new Error("source unavailable"); },
  });
  const result = await producer(row);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.deepEqual(row.position.lifecycle.pendingExit, original);
  assert.deepEqual(result.blockers, ["PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_COST_PRODUCER_FAILED"]);
});

test("post-binding payload tampering invalidates the canonical digest", () => {
  const row = fixture();
  const bound = bindNaturalPaperTriggerBoundSettlementEvidence(row);
  assert.equal(bound.status, "PRESENT");
  const tampered = structuredClone(bound.observation);
  tampered.settlementInput.exitQuote.bid -= 1;
  const validation = validateNaturalPaperTriggerBoundSettlementEvidence({
    position: row.position,
    observation: tampered,
    evaluatedAtMs: row.evaluatedAtMs,
  });
  assert.equal(validation.status, "BLOCKED_DATA");
  assert.equal(validation.blockers.includes("PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_PAYLOAD_DIGEST_MISMATCH"), true);
});

test("copying a valid-looking binding cannot bypass the canonical producer capability", () => {
  const row = fixture();
  const bound = bindNaturalPaperTriggerBoundSettlementEvidence(row);
  const copied = structuredClone(bound.observation);
  const validation = validateNaturalPaperTriggerBoundSettlementEvidence({
    position: row.position,
    observation: copied,
    evaluatedAtMs: row.evaluatedAtMs,
  });
  assert.equal(validation.status, "BLOCKED_DATA");
  assert.equal(validation.blockers.includes(
    "PAPER_POSITION_TRIGGER_BOUND_SETTLEMENT_CANONICAL_PRODUCER_REQUIRED",
  ), true);
});
