import assert from "node:assert/strict";
import test from "node:test";
import { ProviderHealthCircuit } from "../src/provider-health.mjs";

test("v0.5 provider circuit opens after bounded consecutive failures and recovers through half-open", () => {
  const health = new ProviderHealthCircuit({
    provider: "bitget",
    failureThreshold: 2,
    openMs: 1_000,
    minConnectIntervalMs: 100,
    maxClockSkewMs: 500,
    staleAfterMs: 1_000,
  });
  health.recordFailure("FAIL_ONE", 1_000);
  health.recordFailure("FAIL_TWO", 1_100);
  assert.equal(health.snapshot(1_100).circuitState, "OPEN");
  assert.equal(health.snapshot(1_100).lastFailureCode, "FAIL_TWO");
  assert.throws(() => health.beforeConnect(1_500), (error) => error.code === "PROVIDER_CIRCUIT_OPEN");

  health.beforeConnect(2_101);
  assert.equal(health.snapshot(2_101).circuitState, "HALF_OPEN");
  health.recordConnected(2_101);
  health.recordMessage(2_101, 2_101);
  const recovered = health.snapshot(2_101);
  assert.equal(recovered.circuitState, "CLOSED");
  assert.equal(recovered.readyForPaperDecisionSupport, true);
  assert.equal(recovered.liveExecutionEligible, false);
});

test("v0.5 disconnect does not overwrite the actionable provider root failure", () => {
  const health = new ProviderHealthCircuit({ provider: "upbit" });
  health.recordFailure("PROVIDER_CLOCK_SKEW_EXCEEDED", 5_000);
  health.recordDisconnected();
  const state = health.snapshot(5_000);
  assert.equal(state.lastFailureCode, "PROVIDER_CLOCK_SKEW_EXCEEDED");
  assert.equal(state.connected, false);
  assert.equal(state.liveExecutionEligible, false);
});
