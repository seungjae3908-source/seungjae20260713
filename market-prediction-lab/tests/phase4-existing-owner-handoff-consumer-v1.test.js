import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1,
  consumePhase4ExistingOwnerHandoffsV1,
} from "../src/phase4-existing-owner-handoff-consumer-v1.js";

const D = (char) => char.repeat(64);
const SHA = "a".repeat(40);
const BOUNDARY = "2026-09-12T00:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const CANDIDATE_ID = `phase3-candidate:sha256:${D("c")}`;

function runtimeIdentity(overrides = {}) {
  return {
    strategyId: "phase4-runtime-strategy-v1",
    strategyFamily: "MOMENTUM_CROSS",
    strategyVersion: "1.0.0",
    parameterHash: D("b"),
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v1",
    executionPolicyVersion: "execution-v1",
    candidateId: CANDIDATE_ID,
    parameterDigest: D("b"),
    accountMode: "PAPER",
    ...overrides,
  };
}

function phase4Result(overrides = {}) {
  return {
    status: "PROSPECTIVE_ADMISSION_READY",
    challenger: {
      state: "FROZEN_CHALLENGER",
      candidateId: CANDIDATE_ID,
      prospectiveBoundary: BOUNDARY,
      prospectiveBoundaryMs: BOUNDARY_MS,
      strategyFamily: "MOMENTUM_CROSS",
      strategyVersion: "1.0.0",
      parameterDigest: D("b"),
      market: "CRYPTO_SPOT",
      timeframe: "15m",
      sidePolicy: "BUY",
      accountMode: "PAPER",
      ...overrides,
    },
  };
}

function ownerRoute(ownerTarget) {
  return {
    ownerTarget,
    candidateId: CANDIDATE_ID,
    status: "ROUTED_NON_ACTIVATING",
    activationAllowed: false,
    dispatchAllowed: false,
    economicCreditCreated: false,
    executionAuthority: "NONE",
  };
}

function routed(overrides = {}) {
  return {
    contract: "adaptive-tournament-phase4-owner-routing/v1",
    status: "BOUND_TO_EXISTING_OWNERS_NON_ACTIVATING",
    binding: {
      candidateId: CANDIDATE_ID,
      prospectiveBoundary: BOUNDARY,
      prospectiveBoundaryMs: BOUNDARY_MS,
      candidateStrategyIdentity: runtimeIdentity(),
    },
    ownerRoutes: {
      forward: ownerRoute("CANONICAL_FORWARD_OWNER_CHAIN"),
      shadow: ownerRoute("CANONICAL_SHADOW_OWNER"),
      paper: ownerRoute("CANONICAL_PAPER_OWNER_CHAIN"),
    },
    candidateIdentityPreserved: true,
    secondIdentityCreated: false,
    remapPerformed: false,
    rehashPerformed: false,
    fallbackIdentityUsed: false,
    runtimeActivationAllowed: false,
    dispatchAllowed: false,
    economicCreditCreated: false,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function strategyIdentity(overrides = {}) {
  return {
    strategyId: "phase4-runtime-strategy-v1",
    strategyFamily: "MOMENTUM_CROSS",
    strategyVersion: "1.0.0",
    market: "CRYPTO_SPOT",
    direction: "BUY",
    timeframe: "15m",
    formulaIdentity: { family: "MOMENTUM_CROSS", version: "1.0.0" },
    parameterHash: D("b"),
    researchCodeSha: SHA,
    datasetId: "phase4-prospective-dataset-v1",
    datasetDigest: D("d"),
    datasetStart: "2026-09-12T00:00:01.000Z",
    datasetEnd: "2026-09-12T00:15:01.000Z",
    costPolicyVersion: "cost-v1",
    riskPolicyVersion: "risk-v1",
    evidenceSchemaVersion: "phase4-existing-owner-evidence-v1",
    ...overrides,
  };
}

function baseEvidence(overrides = {}) {
  return {
    strategyIdentity: strategyIdentity(),
    researchSurvivorEvidence: {},
    observedAt: "2026-09-12T00:16:00.000Z",
    ...overrides,
  };
}

function fakeOwners({ paperIdentity = runtimeIdentity() } = {}) {
  return {
    shadowAdmission() {
      return {
        status: "PASS",
        admitted: true,
        shadowCandidate: {
          schemaVersion: "shadow-candidate-v1",
          status: "PASS",
          strategyIdentityDigest: D("e"),
        },
      };
    },
    forwardObservation() {
      return {
        status: "PASS",
        observation: {
          schemaVersion: "shadow-forward-observation-v1",
          observationId: "forward-1",
        },
      };
    },
    shadowSufficiency() {
      return {
        status: "PASS",
        sufficient: true,
        metrics: { totalN: 30 },
      };
    },
    paperAdmission() {
      return {
        status: "BRIDGE_READY",
        candidate: {
          signal: {
            strategyIdentity: paperIdentity,
          },
        },
      };
    },
  };
}

function fullEvidence() {
  return baseEvidence({
    forwardObservation: { observationId: "forward-1" },
    canonicalShadowHandoff: { schemaVersion: "prediction-lab-strategy-health-shadow-handoff-v1" },
    additionalShadowObservations: [],
    paperAdmissionBundle: { schemaVersion: "scanner-paper-admission-evidence-bundle-v1" },
  });
}

test("contract remains non-activating and grants no execution authority", () => {
  assert.equal(PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.runtimeActivationAllowed, false);
  assert.equal(PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.dispatchAllowed, false);
  assert.equal(PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.economicCreditCreated, false);
  assert.equal(PHASE4_EXISTING_OWNER_HANDOFF_CONSUMER_CONTRACT_V1.executionAuthority, "NONE");
});

test("invalid or identity-remapped Phase4 owner route fails closed before owner calls", () => {
  const result = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: phase4Result(),
    routed: routed({ remapPerformed: true }),
    ownerEvidence: baseEvidence(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.FIRST_ZERO, "PHASE4_EXISTING_OWNER_IDENTITY_CONTINUITY_INVALID");
  assert.equal(result.actualOwnerCalls, 0);
  assert.equal(result.economicCreditCreated, false);
});

test("canonical owner identity must exactly preserve Phase4 and runtime overlap", () => {
  const result = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: phase4Result(),
    routed: routed(),
    ownerEvidence: baseEvidence({ strategyIdentity: strategyIdentity({ parameterHash: D("f") }) }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.FIRST_ZERO, "PHASE4_EXISTING_OWNER_STRATEGY_IDENTITY_MISMATCH");
  assert.deepEqual(result.identityDetails.mismatchedFields, ["parameterHash"]);
  assert.equal(result.actualOwnerCalls, 0);
});

test("production default path actually calls the existing #708 Shadow owner and fails closed on missing evidence", () => {
  const result = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: phase4Result(),
    routed: routed(),
    ownerEvidence: baseEvidence(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.FIRST_ZERO, "PHASE4_SHADOW_OWNER_ADMISSION_BLOCKED");
  assert.equal(result.actualOwnerCalls, 1);
  assert.equal(result.ownerContractAcceptances, 0);
  assert.ok(Array.isArray(result.shadowAdmission.blockers));
  assert.ok(result.shadowAdmission.blockers.includes("NOT_RESEARCH_SURVIVOR"));
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.actualShadowHandoffs, 0);
});

test("owner function overrides are forbidden outside explicit test-only mode", () => {
  const result = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: phase4Result(),
    routed: routed(),
    ownerEvidence: fullEvidence(),
    ownerFunctions: fakeOwners(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.FIRST_ZERO, "PHASE4_EXISTING_OWNER_OVERRIDE_FORBIDDEN");
  assert.equal(result.actualOwnerCalls, 0);
});

test("test-only seam proves Forward Shadow and Paper owner contracts can be consumed without dispatch or credit", () => {
  const calls = [];
  const owners = fakeOwners();
  const wrapped = Object.fromEntries(Object.entries(owners).map(([key, fn]) => [key, (...args) => {
    calls.push(key);
    return fn(...args);
  }]));
  const result = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: phase4Result(),
    routed: routed(),
    ownerEvidence: fullEvidence(),
    ownerFunctions: wrapped,
    testOnly: true,
    paperNowMs: BOUNDARY_MS + 60_000,
  });
  assert.equal(result.status, "EXISTING_OWNERS_CONNECTED_NON_ACTIVATING");
  assert.equal(result.FIRST_ZERO, null);
  assert.deepEqual(calls, ["shadowAdmission", "forwardObservation", "shadowSufficiency", "paperAdmission"]);
  assert.equal(result.actualOwnerCalls, 4);
  assert.equal(result.ownerContractAcceptances, 4);
  assert.equal(result.ownerPreflightOnly, true);
  assert.equal(result.runtimeActivationAllowed, false);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.actualForwardHandoffs, 0);
  assert.equal(result.actualShadowHandoffs, 0);
  assert.equal(result.actualPaperHandoffs, 0);
  assert.equal(result.executionAuthority, "NONE");
});

test("Paper owner candidate identity cannot remap the frozen Phase3 candidate", () => {
  const result = consumePhase4ExistingOwnerHandoffsV1({
    phase4Result: phase4Result(),
    routed: routed(),
    ownerEvidence: fullEvidence(),
    ownerFunctions: fakeOwners({
      paperIdentity: runtimeIdentity({ candidateId: `phase3-candidate:sha256:${D("f")}` }),
    }),
    testOnly: true,
    paperNowMs: BOUNDARY_MS + 60_000,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.FIRST_ZERO, "PHASE4_PAPER_OWNER_IDENTITY_MISMATCH");
  assert.equal(result.actualOwnerCalls, 4);
  assert.equal(result.ownerContractAcceptances, 3);
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.actualPaperHandoffs, 0);
});
