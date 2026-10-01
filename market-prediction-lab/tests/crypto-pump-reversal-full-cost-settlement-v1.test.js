import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPumpCanonicalSettlementBridgeV1,
  createPumpProspectiveFullCostSettlementOwnerV1,
} from "../src/crypto-pump-reversal-full-cost-settlement-v1.js";

const ENTRY = 1_800_000_000_000;
const TRIGGER = ENTRY + 60_000;
const OBSERVED = TRIGGER + 60_000 + 10_000;
const SHA = "a".repeat(40);
const PARAM = "b".repeat(64);
const CANDIDATE = "paper-candidate-v1:" + "c".repeat(64);

function record() {
  return {
    recordId: "d".repeat(64),
    status: "EXIT_TRIGGERED",
    observation: {
      candidateId: CANDIDATE,
      strategyVersion: "clean-v1",
      parameterHash: PARAM,
      researchCodeSha: SHA,
    },
    signal: {
      signalId: "e".repeat(64),
      strategyId: "CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1",
      symbol: "ALTUSDT",
    },
    position: {
      positionId: "f".repeat(64),
      entryTimestampMs: ENTRY,
    },
    riskSizingStatus: "READY",
    riskSizing: {
      evidenceDigest: "1".repeat(64),
      result: {
        prospectiveEntryExecution: {
          costPolicy: { version: "pump-cost-v1" },
          marketAdapterIdentity: { id: "crypto-futures-bitget-execution", version: "v2" },
          executionPolicy: {
            version: "crypto-pump-reversal-prospective-entry-execution-v1",
            fillModel: "DEPTH_PARTICIPATION",
            sameBarPolicy: "STOP_FIRST",
            allowPartialFill: false,
            maxParticipationRate: 1,
          },
          dataEvidence: {
            provider: "bitget",
            leverage: 2,
            maxLeverage: 20,
            marginMode: "ISOLATED",
            liquidationDistancePct: 30,
          },
        },
      },
    },
    prospectiveExecutionSampleStatus: "READY",
    prospectiveExecutionSample: {
      status: "OPEN",
      paperSampleId: "pump-paper-sample-1",
      parityFingerprint: "parity-1",
      identity: {
        candidateId: CANDIDATE,
        parameterHash: PARAM,
        parameterDigest: PARAM,
        researchCodeSha: SHA,
        executionDirection: "SHORT",
        evaluatedAtMs: ENTRY,
      },
      fill: {
        fillPrice: 99,
        filledQuantity: 0.1,
        notional: 9.9,
      },
      profitEvidence: {
        costPolicyId: "pump-cost-v1",
      },
    },
    exitTrigger: {
      exitTriggerId: "2".repeat(64),
      triggerTimestampMs: TRIGGER,
      bar: {
        timestampMs: TRIGGER,
        open: 100,
        high: 130,
        low: 99,
        close: 120,
      },
    },
  };
}

function component(name, valuePercent = 0.01) {
  return {
    status: "PRESENT",
    valuePercent,
    quality: name === "tax" ? "NOT_APPLICABLE" : "OBSERVED",
    source: "test-" + name,
    provenance: "test-full-cost",
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  };
}

function fullCostEvidence() {
  const components = Object.fromEntries(
    ["commission", "tax", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact"]
      .map((name) => [name, component(name, name === "tax" ? 0 : 0.01)]),
  );
  return {
    schemaVersion: "authoritative-paper-execution-cost-sources-v1",
    status: "PRESENT",
    fullCostReady: true,
    components,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
  };
}

test("bridge preserves Pump identity while creating a canonical trigger-bound position", () => {
  const row = record();
  const bridge = buildPumpCanonicalSettlementBridgeV1({
    record: row,
    observedAtMs: OBSERVED,
  });
  assert.equal(bridge.position.candidateId, CANDIDATE);
  assert.equal(bridge.position.parameterDigest, PARAM);
  assert.equal(bridge.position.parameterHash, PARAM);
  assert.equal(bridge.position.accountMode, "PAPER");
  assert.equal(bridge.position.paperSampleId, "pump-paper-sample-1");
  assert.equal(bridge.position.lifecycle.pendingExit, bridge.canonicalTrigger);
  assert.match(bridge.canonicalTrigger.exitTriggerId, /^[0-9a-f]{64}$/);
  assert.notEqual(bridge.canonicalTrigger.exitTriggerId, row.exitTrigger.exitTriggerId);
  assert.equal(bridge.pumpExitTriggerId, row.exitTrigger.exitTriggerId);
  assert.equal(bridge.captureDeadlineMs, TRIGGER + 90_000);
});

test("owner grants one economic sample only after canonical 8/8 Full Cost settlement", async () => {
  const row = record();
  let produced = 0;
  let adapted = 0;
  let settledCalls = 0;
  const owner = createPumpProspectiveFullCostSettlementOwnerV1({
    collectAuthoritativeEvidence: async () => {
      throw new Error("producer stub owns collection in this test");
    },
    clock: () => OBSERVED,
    producerFactory: () => async ({ position, evaluatedAtMs }) => {
      produced += 1;
      const trigger = position.lifecycle.pendingExit;
      return {
        status: "PRESENT",
        fullCostReady: true,
        evaluatedAtMs,
        observation: {
          settlementInput: {
            exitTriggerId: trigger.exitTriggerId,
            exitExecutionId: "canonical-exec-1",
            exitExecution: { costPolicy: { version: "pump-cost-v1" } },
            exitBar: { ...trigger.bar, timestampMs: trigger.triggeredAtMs },
            exitQuote: { bid: 119, ask: 120, last: 119.5, asOfMs: evaluatedAtMs, maxAgeMs: 30_000 },
            exitDepth: { bidSize: 100, askSize: 100 },
            pathBars: [],
            fundingEvidence: { complete: true, payments: [] },
          },
          settlementCostEvidence: fullCostEvidence(),
        },
      };
    },
    adaptFullCost: ({ observation }) => {
      adapted += 1;
      assert.equal(Object.keys(observation.settlementCostEvidence.components).length, 8);
      return {
        status: "PRESENT",
        fullCostReady: true,
        blockers: [],
      };
    },
    settleSample: ({ sample, exitTriggerId, exitExecutionId, evaluatedAtMs }) => {
      settledCalls += 1;
      return {
        status: "SETTLED",
        paperSampleId: sample.paperSampleId,
        exitTriggerId,
        exitExecutionId,
        settledAtMs: evaluatedAtMs,
        holdingMs: evaluatedAtMs - ENTRY,
        quantity: 0.1,
        entryFillPrice: 99,
        exitFillPrice: 120,
        grossPnl: -2.1,
        grossReturnPercent: -21.2121212121,
        netPnl: -2.2,
        netReturnPercent: -22.2222222222,
        totalExplicitCost: 0.1,
        entryCost: 0.02,
        exitCost: 0.08,
        fundingCost: 0,
        costPolicyVersion: "pump-cost-v1",
      };
    },
  });

  const result = await owner({ record: row, observedAtMs: OBSERVED });
  assert.equal(produced, 1);
  assert.equal(adapted, 1);
  assert.equal(settledCalls, 1);
  assert.equal(result.status, "SETTLED");
  assert.equal(result.exitTriggerId, row.exitTrigger.exitTriggerId);
  assert.match(result.canonicalExitTriggerId, /^[0-9a-f]{64}$/);
  assert.equal(result.economicSampleCredit, 1);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(Object.keys(result.fullCostEvidence.components).length, 8);
  assert.equal(result.executionAuthority, "NONE");
});

test("late exit evidence cannot reprice a historical trigger", async () => {
  let producerCalls = 0;
  const owner = createPumpProspectiveFullCostSettlementOwnerV1({
    collectAuthoritativeEvidence: async () => ({}),
    producerFactory: () => async () => {
      producerCalls += 1;
      return {};
    },
  });
  const result = await owner({
    record: record(),
    observedAtMs: TRIGGER + 60_000 + 30_001,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("PUMP_FULL_COST_EXIT_EVIDENCE_CAPTURE_WINDOW_EXPIRED"));
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(producerCalls, 0);
});

test("missing canonical Full Cost never receives economic sample credit", async () => {
  const owner = createPumpProspectiveFullCostSettlementOwnerV1({
    collectAuthoritativeEvidence: async () => ({}),
    producerFactory: () => async ({ evaluatedAtMs }) => ({
      status: "PRESENT",
      fullCostReady: true,
      evaluatedAtMs,
      observation: {
        settlementInput: {},
        settlementCostEvidence: fullCostEvidence(),
      },
    }),
    adaptFullCost: () => ({
      status: "BLOCKED_DATA",
      fullCostReady: false,
      blockers: ["PAPER_POSITION_SETTLEMENT_FUNDING_COST_EVIDENCE_MISSING"],
    }),
    settleSample: () => {
      throw new Error("MUST_NOT_SETTLE");
    },
  });
  const result = await owner({ record: record(), observedAtMs: OBSERVED });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.economicSampleCredit, 0);
  assert.ok(result.blockers.includes("PAPER_POSITION_SETTLEMENT_FUNDING_COST_EVIDENCE_MISSING"));
});
