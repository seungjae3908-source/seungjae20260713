import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1,
  buildAutonomousAlphaNaturalPaperObservationV1,
} from "../src/autonomous-alpha-natural-paper-runtime-bridge-v1.js";

const SHA = "a".repeat(40);

function paperSnapshot(overrides = {}) {
  return {
    schemaVersion: "paper-forward-schedule-snapshot-v1",
    scheduleActive: true,
    stateCycleCount: 3,
    positionCount: 1,
    settlementCount: 2,
    authoritativeAccount: null,
    runtimeStatus: { status: "ACTIVE" },
    lastInvocation: { status: "COMPLETE" },
    memberAutoTradingHandoff: {
      status: "BLOCKED",
      executionAuthority: "NONE",
    },
    privateRequestCount: 0,
    financialMutationCount: 0,
    liveTrading: false,
    orderAuthority: false,
    ...overrides,
  };
}

test("observer waits honestly when Alpha handoff is not present", () => {
  const result = buildAutonomousAlphaNaturalPaperObservationV1({
    paperSnapshot: paperSnapshot(),
    researchCodeSha: SHA,
    observedAtMs: 1,
  });
  assert.equal(result.schemaVersion, AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1);
  assert.equal(result.status, "WAITING_FOR_ALPHA_HANDOFF");
  assert.deepEqual(result.blockers, ["ALPHA_HANDOFF_MISSING"]);
  assert.equal(result.naturalPaper.stateCycleCount, 3);
  assert.equal(result.paperOnly, true);
  assert.equal(result.observerOnly, true);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.realOrderCount, 0);
  assert.equal(result.privateRequestCount, 0);
  assert.equal(result.profitabilityProven, false);
});

test("observer fails closed if Paper snapshot exposes authority", () => {
  const result = buildAutonomousAlphaNaturalPaperObservationV1({
    paperSnapshot: paperSnapshot({ liveTrading: true }),
    researchCodeSha: SHA,
    observedAtMs: 1,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("ALPHA_OBSERVER_PAPER_SNAPSHOT_INVALID"));
  assert.equal(result.executionAuthority, "NONE");
});

test("observer rejects unsafe Alpha handoff before lineage evaluation", () => {
  const result = buildAutonomousAlphaNaturalPaperObservationV1({
    paperSnapshot: paperSnapshot(),
    researchCodeSha: SHA,
    observedAtMs: 1,
    alphaHandoff: {
      schemaVersion: "autonomous-alpha-runtime-handoff-v1",
      sourceSha: SHA,
      executionAuthority: "LIVE",
    },
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.deepEqual(result.blockers, ["ALPHA_HANDOFF_INVALID_OR_UNSAFE"]);
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
});
