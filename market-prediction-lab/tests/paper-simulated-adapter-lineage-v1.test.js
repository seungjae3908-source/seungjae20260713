import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryPaperLearningStore,
  createSimulatedPaperLearningAdapter,
} from "../src/paper-simulated-adapters-v1.js";

const SHA = "a".repeat(40);
const T0 = 1_800_000_000_000;

function safety() {
  return {
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

test("signal learning record keeps Scanner strategy lineage instead of runtime driver lineage", async () => {
  const store = createMemoryPaperLearningStore();
  const adapter = createSimulatedPaperLearningAdapter({ learningStore: store });
  await adapter.persistSignal({
    cycle: { cycleId: "cycle-1", evaluatedAtMs: T0 },
    identity: {
      strategyId: "paper-forward-simulated-outcome-v1",
      strategyVersion: "1.0.0",
      parameterHash: "runtime-params",
      researchCodeSha: SHA,
    },
    sample: {
      identity: {
        signalId: "signal-1",
        market: "CRYPTO_SPOT",
        strategyId: "scanner-swing-v7",
        strategyVersion: "7.0.0",
        parameterHash: "scanner-params-v7",
        researchCodeSha: SHA.toUpperCase(),
      },
      ...safety(),
    },
  });

  const [record] = store.snapshot();
  assert.equal(record.value.strategyId, "scanner-swing-v7");
  assert.equal(record.value.strategyVersion, "7.0.0");
  assert.equal(record.value.parameterHash, "scanner-params-v7");
  assert.equal(record.value.researchCodeSha, SHA);
});
