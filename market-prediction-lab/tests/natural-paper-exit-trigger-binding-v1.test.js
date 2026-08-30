import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  advanceNaturalPaperPositionLifecycle,
  createNaturalPaperPositionLifecycle,
} from "../src/natural-paper-position-settlement-lifecycle-v1.js";

const T0 = 1_800_000_000_000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const SHA = "b".repeat(40);
const COST_POLICY = "cost-v1";
const RISK_POLICY = Object.freeze({
  policyId: "paper-risk-v1",
  policyVersion: "2026-08-31",
  source: "canonical-risk-policy-record",
  researchCodeSha: SHA,
});

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function jsonDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("frozen exit trigger binds observation, position, entry, cycle, account, risk and cost identities", () => {
  const sample = {
    status: "OPEN",
    paperSampleId: "paper-sample-trigger-binding",
    identity: {
      signalId: "signal-trigger-binding",
      market: "CRYPTO_SPOT",
      symbol: "CRYPTO_SPOT:BTC",
      style: "SWING",
      timeframe: "4h",
      horizon: 2,
      executionDirection: "BUY",
      strategyId: "natural-trigger-binding",
      strategyVersion: "v1",
      parameterHash: "parameter-hash-v1",
      researchCodeSha: SHA,
      evaluatedAtMs: T0,
    },
    fill: {
      status: "FILLED",
      fillPrice: 100,
      filledQuantity: 1,
      notional: 100,
      costs: { immediateCost: 0.1 },
    },
    entryEvidenceProvenance: {
      schemaVersion: "paper-evidence-provenance-v1",
      evidenceSnapshotDigest: "a".repeat(64),
      provenanceDigest: "c".repeat(64),
    },
  };
  const positionBase = {
    positionId: "position-trigger-binding",
    paperSampleId: sample.paperSampleId,
    signalId: sample.identity.signalId,
    market: sample.identity.market,
    symbol: sample.identity.symbol,
    direction: sample.identity.executionDirection,
    strategyId: sample.identity.strategyId,
    strategyVersion: sample.identity.strategyVersion,
    parameterHash: sample.identity.parameterHash,
    researchCodeSha: SHA,
    costPolicyVersion: COST_POLICY,
    entryTimestampMs: T0,
    quantity: 1,
    entryFillPrice: 100,
    lifecycleState: "OPEN",
    sample,
  };
  const candidate = {
    testOnly: false,
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
      observationId: "entry-observation",
      source: "upbit-public-candles",
      provenance: "prospective-public-fixture-credit-zero",
      observedAtMs: T0 - 1,
    },
    riskPolicyIdentity: RISK_POLICY,
    signal: {
      expiresAtMs: T0 + (2 * FOUR_HOURS),
      learningSnapshot: { stopLoss: 95, target1: 105, target2: 110 },
    },
    execution: { executionPolicy: { sameBarPolicy: "STOP_FIRST" } },
  };
  const position = Object.freeze({
    ...positionBase,
    lifecycle: createNaturalPaperPositionLifecycle({ position: positionBase, sample, candidate }),
  });

  const now = T0 + FOUR_HOURS;
  const cycleId = "cycle-trigger-binding";
  const identityFingerprint = "paper-loop-identity-fingerprint";
  const cycleIdentity = {
    cycleId,
    identityFingerprint,
    scheduledAtMs: now,
    startedAtMs: now,
  };
  cycleIdentity.identityDigest = jsonDigest(cycleIdentity);

  const accountId = "paper-account";
  const accountIdentity = {
    publisherAccountIdSha256: "d".repeat(64),
    sourceSha: SHA,
    accountIdSha256: createHash("sha256").update(accountId).digest("hex"),
  };
  accountIdentity.identityDigest = jsonDigest(accountIdentity);
  const riskPolicyIdentity = { ...RISK_POLICY, identityDigest: jsonDigest(RISK_POLICY) };

  const bar = { open: 100, high: 106, low: 99, close: 105 };
  const source = "upbit-public-candles";
  const sourceDigest = hash({
    provider: source,
    market: position.market,
    symbol: position.symbol,
    timeframe: "4h",
    sourceObservedAtMs: now,
    ...bar,
  });
  const observationId = "trigger-observation";
  const naturalEvidence = {
    provenanceClass: "NATURAL_FORWARD",
    synthetic: false,
    replay: false,
    testOnly: false,
    backfill: false,
    historical: false,
    duplicate: false,
    observationId,
    source,
    provenance: "prospective-public-position-observation-credit-zero",
    observedAtMs: now,
  };
  const observation = {
    observationId,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    signalTimeframe: position.sample.identity.timeframe,
    horizon: position.sample.identity.horizon,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    publicOnly: true,
    source,
    provenance: naturalEvidence.provenance,
    observedAtMs: now,
    maxAgeMs: 2 * FOUR_HOURS,
    timeframe: "4h",
    sourceDigest,
    closedFrame: {
      openAtMs: T0,
      closeAtMs: now,
      intervalMs: FOUR_HOURS,
      closeOffsetMs: FOUR_HOURS,
      provider: source,
      timeframe: "4h",
      sourceDigest,
    },
    bar,
    naturalEvidence,
    cycleIdentityDigest: cycleIdentity.identityDigest,
    accountIdentityDigest: accountIdentity.identityDigest,
    entryEvidenceDigest: sample.entryEvidenceProvenance.evidenceSnapshotDigest,
    riskPolicyIdentityDigest: riskPolicyIdentity.identityDigest,
    costPolicyIdentity: { version: COST_POLICY },
    schedulerHandoff: {
      schemaVersion: "paper-scheduler-position-observation-handoff-v1",
      cycleIdentity,
      accountIdentity,
      positionIdentity: { ...position.lifecycle.identity },
      entryProvenance: structuredClone(sample.entryEvidenceProvenance),
      riskPolicyIdentity,
      costPolicyIdentity: { version: COST_POLICY },
      naturalSampleCreditAuthority: "IDENTITY_GATES_PASSED",
      executionAuthority: "NONE",
    },
    settlementCostEvidence: null,
    settlementInput: {
      exitBar: { ...bar, timestampMs: now },
      exitQuote: null,
      exitDepth: null,
      exitExecution: {
        dataEvidence: { provider: source, publicOnly: true, dataQuality: "READY", provenance: naturalEvidence.provenance, asOfMs: now },
        costPolicy: { version: COST_POLICY },
      },
      fundingEvidence: { complete: true, payments: [] },
      pathBars: [],
    },
  };
  const state = {
    identityFingerprint,
    ledger: {
      accountBinding: {
        accountId,
        publisherAccountIdSha256: accountIdentity.publisherAccountIdSha256,
        sourceSha: SHA,
      },
      reservations: [{ status: "OPEN", positionId: position.positionId, paperSampleId: position.paperSampleId }],
    },
  };
  const result = advanceNaturalPaperPositionLifecycle({
    position,
    observation,
    evaluatedAtMs: now,
    state,
    cycle: { cycleId, evaluatedAtMs: now },
  });

  assert.equal(result.status, "BLOCKED_SETTLEMENT_EVIDENCE");
  const trigger = result.position.lifecycle.pendingExit;
  assert.equal(trigger.triggerObservationId, observationId);
  assert.equal(trigger.positionId, position.positionId);
  assert.equal(trigger.entryId, position.paperSampleId);
  assert.equal(trigger.cycleId, cycleId);
  assert.equal(trigger.accountIdSha256, accountIdentity.accountIdSha256);
  assert.equal(trigger.strategyId, position.strategyId);
  assert.equal(trigger.costPolicyId, COST_POLICY);
  assert.equal(trigger.riskPolicyId, RISK_POLICY.policyId);
  assert.equal(trigger.cycleIdentityDigest, cycleIdentity.identityDigest);
  assert.equal(trigger.accountIdentityDigest, accountIdentity.identityDigest);
  assert.equal(trigger.entryEvidenceDigest, sample.entryEvidenceProvenance.evidenceSnapshotDigest);
  assert.equal(trigger.riskPolicyIdentityDigest, riskPolicyIdentity.identityDigest);
  assert.equal(trigger.schedulerHandoffDigest, hash(observation.schedulerHandoff));
  const { exitTriggerId, ...payload } = trigger;
  assert.equal(exitTriggerId, hash(payload));
  assert.equal(result.position.lifecycle.pathBars.length, 1);
  assert.equal(result.position.lifecycle.pathBars[0].timestampMs, now);
});
