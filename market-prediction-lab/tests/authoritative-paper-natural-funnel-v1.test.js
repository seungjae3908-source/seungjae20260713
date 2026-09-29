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

function observedProducer(id, { qualityPassed, riskPassed, reasons = [] }) {
  return Object.freeze({
    ...readyProducer(),
    gateObservability: Object.freeze({
      schemaVersion: "scanner-crypto-futures-paper-gate-observability-v1",
      qualityGate: Object.freeze({
        status: "MEASURED",
        evaluated: true,
        passed: qualityPassed,
        decision: qualityPassed ? "PASS" : "BLOCKED",
        provenance: "quality-fixture",
        observedAt: NOW,
        observationId: id,
        sourceCodes: Object.freeze([]),
      }),
      riskGate: Object.freeze({
        status: "MEASURED",
        evaluated: qualityPassed,
        passed: riskPassed,
        decision: qualityPassed ? (riskPassed ? "PASS" : "BLOCKED") : "NOT_REACHED",
        provenance: "risk-fixture",
        observedAt: NOW,
        observationId: id,
        sourceCodes: Object.freeze([]),
      }),
      reasonObservations: Object.freeze(reasons),
    }),
  });
}

function sourceBlockedProducer(
  id,
  sourceCodes,
  genericBlocker = "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING",
) {
  const unknownGate = (provenance) => Object.freeze({
    status: "UNKNOWN",
    evaluated: false,
    passed: null,
    decision: "UNKNOWN",
    provenance,
    observedAt: NOW,
    observationId: id,
    sourceCodes: Object.freeze([]),
  });
  return Object.freeze({
    ...blockedProducer(genericBlocker),
    gateObservability: Object.freeze({
      schemaVersion: "scanner-crypto-futures-paper-gate-observability-v1",
      qualityGate: unknownGate("quality-not-reached-source-fixture"),
      riskGate: unknownGate("risk-not-reached-source-fixture"),
      reasonObservations: Object.freeze(sourceCodes.map((sourceCode) => Object.freeze({
        sourceStage: "EVIDENCE_SOURCE",
        sourceCode,
        sourceReason: sourceCode,
        canonicalReason: genericBlocker.endsWith("_MISSING") ? "DATA_MISSING" : "UNKNOWN",
        lossless: true,
        provenance: "source-fixture",
        observedAt: NOW,
        identity: Object.freeze({ observationId: id }),
        naturalCredit: 0,
        replayCredit: 0,
        duplicateCredit: 0,
      }))),
    }),
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
  assert.deepEqual(result.authoritativeFirstZeroReasonEvidenceByStage, {});
  assert.equal(result.canonicalNaturalStageEvidence.stageCounts.signalCandidate.count, 0);
  assert.equal(result.canonicalNaturalStageEvidence.reasonObservations[0].canonicalReason, "NO_SIGNAL");
  assert.equal(result.canonicalNaturalStageEvidence.stageCounts.qualityPassed.provenance.includes("qualityGate"), true);
});

test("direct Quality and Risk counts remain independent instead of aliasing producer READY", async () => {
  const cards = [Object.freeze({ id: "c1" }), Object.freeze({ id: "c2" })];
  const wiring = sourceWiring({
    cards,
    totalCount: 20,
    completedCount: 2,
    producer: ({ card }) => observedProducer(card.id, {
      qualityPassed: true,
      riskPassed: card.id === "c1",
      reasons: card.id === "c2" ? [Object.freeze({
        sourceStage: "RISK_GATE",
        sourceCode: "RISK_BLOCKED_FIXTURE",
        sourceReason: "RISK_BLOCKED_FIXTURE",
        canonicalReason: "RISK_GATE",
        lossless: true,
        provenance: "risk-fixture",
        observedAt: NOW,
        identity: Object.freeze({ observationId: card.id }),
        naturalCredit: 0,
        replayCredit: 0,
        duplicateCredit: 0,
      })] : [],
    }),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory: (options) => baseRuntimeFactory(options, { admissionReady: 2 }),
  });

  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  const stages = result.canonicalNaturalStageEvidence.stageCounts;
  assert.equal(stages.signalCandidate.count, 2);
  assert.equal(stages.qualityPassed.count, 2);
  assert.equal(stages.riskPassed.count, 1);
  assert.notEqual(stages.qualityPassed.provenance, stages.riskPassed.provenance);
  assert.equal(result.canonicalNaturalStageEvidence.reasonObservations[0].sourceCode, "RISK_BLOCKED_FIXTURE");
});

test("natural dataset identity is stable across read-only re-observation time", async () => {
  const wiring = sourceWiring({ cards: [], totalCount: 100, completedCount: 20, producer: readyProducer });
  const firstRuntime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory: (options) => baseRuntimeFactory(options, { invokeProducer: false }),
  });
  const secondRuntime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW + 60_000,
    baseRuntimeFactory: (options) => baseRuntimeFactory(options, { invokeProducer: false }),
  });
  const first = await firstRuntime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  const second = await secondRuntime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.notEqual(first.naturalFunnelMeasurements[0].measuredAtMs, second.naturalFunnelMeasurements[0].measuredAtMs);
  assert.equal(first.naturalEvidenceIdentity, second.naturalEvidenceIdentity);
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
  const reason = result.authoritativeFirstZeroReasonEvidenceByStage.EVIDENCE_COMPLETE;
  assert.equal(reason.authoritative, true);
  assert.equal(reason.freshness, "FRESH");
  assert.equal(reason.reasonCode, "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING");
  assert.deepEqual(reason.sourceCodes, []);
  assert.equal(reason.strategySha, SHA);
  assert.equal(reason.runtimeSha, SHA);
  assert.equal(reason.datasetIdentity, result.naturalEvidenceIdentity);
  assert.equal(reason.synthetic, false);
  assert.equal(reason.historical, false);
  assert.equal(reason.replay, false);
  assert.equal(reason.duplicateReplay, false);
  assert.equal(reason.futureTimeCompression, false);
});

test("identical lossless source sets are preserved in the authoritative Evidence Complete reason", async () => {
  const cards = [Object.freeze({ id: "c1" }), Object.freeze({ id: "c2" })];
  const sourceCodes = [
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:paperState",
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:executionObservation",
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:supplementalCostEvidence",
  ];
  const wiring = sourceWiring({
    cards,
    totalCount: 50,
    completedCount: 10,
    producer: ({ card }) => sourceBlockedProducer(card.id, sourceCodes),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory,
  });

  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  const reason = result.authoritativeFirstZeroReasonEvidenceByStage.EVIDENCE_COMPLETE;
  assert.equal(result.naturalFirstZeroStage, "EVIDENCE_COMPLETE");
  assert.equal(
    reason.reasonCode,
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING_EXECUTION_OBSERVATION_AND_P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING_PAPER_STATE_AND_P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING_SUPPLEMENTAL_COST_EVIDENCE",
  );
  assert.deepEqual(reason.sourceCodes, [
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:executionObservation",
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:paperState",
    "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:supplementalCostEvidence",
  ]);
  assert.equal(result.canonicalNaturalStageEvidence.reasonObservations.length, 6);
  assert.equal(result.canonicalNaturalStageEvidence.reasonObservations.every((row) => row.naturalCredit === 0), true);
  assert.equal(result.canonicalNaturalStageEvidence.reasonObservations.every((row) => row.replayCredit === 0), true);
  assert.equal(result.canonicalNaturalStageEvidence.reasonObservations.every((row) => row.duplicateCredit === 0), true);
});

test("heterogeneous exact source sets fall back to the generic reason instead of fabricating one root cause", async () => {
  const cards = [Object.freeze({ id: "c1" }), Object.freeze({ id: "c2" })];
  const wiring = sourceWiring({
    cards,
    totalCount: 50,
    completedCount: 10,
    producer: ({ card }) => sourceBlockedProducer(card.id, [
      card.id === "c1"
        ? "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:paperState"
        : "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING:executionObservation",
    ]),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory,
  });

  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  const reason = result.authoritativeFirstZeroReasonEvidenceByStage.EVIDENCE_COMPLETE;
  assert.equal(result.naturalFirstZeroStage, "EVIDENCE_COMPLETE");
  assert.equal(reason.reasonCode, "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING");
  assert.deepEqual(reason.sourceCodes, []);
});

test("mixed direct source blockers remain UNKNOWN instead of fabricating one FIRST_ZERO reason", async () => {
  const cards = [Object.freeze({ id: "c1" }), Object.freeze({ id: "c2" })];
  const wiring = sourceWiring({
    cards,
    totalCount: 50,
    completedCount: 10,
    producer: ({ card }) => blockedProducer(
      card.id === "c1"
        ? "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"
        : "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED",
    ),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory,
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.equal(result.naturalFirstZeroStage, "EVIDENCE_COMPLETE");
  assert.deepEqual(result.authoritativeFirstZeroReasonEvidenceByStage, {});
});

test("multiple blocker codes on one producer attempt are not promoted to an authoritative FIRST_ZERO reason", async () => {
  const wiring = sourceWiring({
    cards: [Object.freeze({ id: "c1" })],
    totalCount: 10,
    completedCount: 4,
    producer: () => blockedProducer(
      "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING",
      "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED",
    ),
  });
  const runtime = createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
    sourceWiring: wiring,
    now: () => NOW,
    baseRuntimeFactory,
  });
  const result = await runtime({ market: "CRYPTO_FUTURES", cycle: cycle() });
  assert.equal(result.naturalFirstZeroStage, "EVIDENCE_COMPLETE");
  assert.deepEqual(result.authoritativeFirstZeroReasonEvidenceByStage, {});
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
  assert.deepEqual(result.authoritativeFirstZeroReasonEvidenceByStage, {});
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.privateTradingApiAllowed, false);
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
  assert.deepEqual(result.authoritativeFirstZeroReasonEvidenceByStage, {});
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
  assert.deepEqual(result.authoritativeFirstZeroReasonEvidenceByStage, {});
});
