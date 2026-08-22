import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT,
  createNaturalFunnelObservedPaperRuntimeFromSourceWiring,
} from "../src/authoritative-paper-natural-funnel-v1.js";

const SHA = "a".repeat(40);
const NOW = 1_800_000_000_000;

function safety() {
  return {
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };
}

function response(cards, { totalCount = cards.length, completedCount = cards.length } = {}) {
  return Object.freeze({
    universe: Object.freeze({ totalCount }),
    execution: Object.freeze({ completedCount }),
    cards: Object.freeze(cards),
  });
}

function readyProducer() {
  return Object.freeze({
    status: "READY",
    bundle: Object.freeze({ schemaVersion: "scanner-paper-admission-evidence-bundle-v1", ...safety() }),
    blockers: Object.freeze([]),
    ...safety(),
  });
}

function blockedProducer(...blockers) {
  return Object.freeze({
    status: "BLOCKED",
    bundle: null,
    blockers: Object.freeze(blockers),
    ...safety(),
  });
}

function sourceWiring({ cards, totalCount, completedCount, producer }) {
  return Object.freeze({
    scanBatchForMarket: async () => async () => response(cards, { totalCount, completedCount }),
    createPaperAdmissionEvidenceProducer: () => async (context) => producer(context),
  });
}

function baseRuntimeFactory({ sourceWiring }, { invokeProducer = true, admissionReady = 0 } = {}) {
  return async (input) => {
    const scanBatch = await sourceWiring.scanBatchForMarket(input);
    const scanned = await scanBatch({ cursor: 0 });
    if (invokeProducer) {
      const producer = sourceWiring.createPaperAdmissionEvidenceProducer({});
      for (const card of scanned.cards) await producer({ card, market: input.market });
    }
    return Object.freeze({
      market: input.market,
      status: admissionReady > 0 ? "PAPER_CANDIDATES_READY" : "VALID_NO_TRADE",
      admissionBridgeReadyCandidates: admissionReady,
      ...safety(),
    });
  };
}

function cycle() {
  return Object.freeze({
    cycleId: "natural-cycle-1",
    identity: Object.freeze({ researchCodeSha: SHA }),
  });
}

test("contract exposes the exact twelve-stage natural funnel", () => {
  assert.deepEqual(AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT.stages, [
    "UNIVERSE", "SCANNER_EVALUATED", "CANDIDATE", "EVIDENCE_COMPLETE",
    "ADMISSION_PASS", "RISK_PASS", "COST_PASS", "ACCOUNT_READY",
    "PAPER_ENTRY", "POSITION", "SETTLEMENT", "OUTCOME",
  ]);
  assert.equal(AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT.unknownIsZero, false);
  assert.equal(AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT.replayCountsAsNatural, false);
});

test("Candidate is the first zero only after Universe and Scanner Evaluated are measured positive", async () => {
  const wiring = sourceWiring({ cards: [], totalCount: 100, completedCount: 20, producer: readyProducer });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory: (options) => baseRuntimeFactory(options, { invokeProducer: false }),
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.equal(result.universeCount, 100);
  assert.equal(result.scannerEvaluatedCount, 20);
  assert.equal(result.naturalFunnelMeasurements[2].count, 0);
  assert.equal(result.naturalFirstZeroStage, "CANDIDATE");
  assert.equal(result.naturalFirstZeroReason, "MEASURED_ZERO");
  assert.match(result.naturalEvidenceIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(result.naturalRuntimeSha, SHA);
});

test("Evidence Complete is measured zero when every evaluated candidate has authoritative source-missing evidence", async () => {
  const cards = [Object.freeze({ id: "c1" }), Object.freeze({ id: "c2" })];
  const wiring = sourceWiring({
    cards,
    totalCount: 50,
    completedCount: 10,
    producer: () => blockedProducer("P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory,
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.deepEqual(result.naturalFunnelMeasurements.slice(0, 4).map((row) => [row.stage, row.status, row.count]), [
    ["UNIVERSE", "MEASURED", 50],
    ["SCANNER_EVALUATED", "MEASURED", 10],
    ["CANDIDATE", "MEASURED", 2],
    ["EVIDENCE_COMPLETE", "MEASURED", 0],
  ]);
  assert.equal(result.naturalFirstZeroStage, "EVIDENCE_COMPLETE");
  assert.equal(result.naturalFunnelMeasurements[4].status, "UNKNOWN");
});

test("READY authoritative producers prove evidence/admission/risk/cost/account passes without inventing Entry", async () => {
  const cards = [Object.freeze({ id: "c1" }), Object.freeze({ id: "c2" })];
  const wiring = sourceWiring({ cards, totalCount: 30, completedCount: 12, producer: readyProducer });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory: (options) => baseRuntimeFactory(options, { admissionReady: 2 }),
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.deepEqual(result.naturalFunnelMeasurements.slice(3, 8).map((row) => row.count), [2, 2, 2, 2, 2]);
  assert.equal(result.naturalFunnelMeasurements[8].status, "UNKNOWN");
  assert.equal(result.naturalFirstZeroStage, "UNKNOWN");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveOrderAllowed, false);
});

test("missing Scanner metadata remains UNKNOWN and never becomes zero", async () => {
  const wiring = Object.freeze({
    scanBatchForMarket: async () => async () => Object.freeze({ cards: Object.freeze([]) }),
    createPaperAdmissionEvidenceProducer: () => async () => readyProducer(),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory: (options) => baseRuntimeFactory(options, { invokeProducer: false }),
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.equal(result.naturalFunnelMeasurements[0].status, "PARTIAL");
  assert.equal(result.naturalFunnelMeasurements[0].count, null);
  assert.equal(result.naturalFirstZeroStage, "UNKNOWN");
});

test("pre-evidence clock blockers do not masquerade as Evidence Complete zero", async () => {
  const wiring = sourceWiring({
    cards: [Object.freeze({ id: "c1" })],
    totalCount: 10,
    completedCount: 4,
    producer: () => blockedProducer("P0_C9_EVIDENCE_CLOCK_INVALID"),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory,
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.equal(result.naturalFunnelMeasurements[3].status, "PARTIAL");
  assert.equal(result.naturalFunnelMeasurements[3].count, null);
  assert.equal(result.naturalFirstZeroStage, "UNKNOWN");
});
