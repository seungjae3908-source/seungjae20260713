import { createHash } from "node:crypto";
import { buildFourMarketPaperSample } from "./four-market-paper-sampler-v1.js";
import {
  settleFourMarketPaperSample,
  summarizeSettledPaperSamples,
} from "./four-market-paper-settlement-v1.js";
import {
  AUTHORITATIVE_NATURAL_PAPER_ENTRY_ACCOUNTING_EVIDENCE_VERSION,
  authoritativeNaturalPaperAccountingSummary,
  isAuthoritativeNaturalPaperAccountError,
  isAuthoritativeNaturalPaperLedger,
  validateAuthoritativeNaturalPaperLedger,
} from "./authoritative-natural-paper-accounting-v1.js";

const MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const MARKET_SET = new Set(MARKETS);

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

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function safetyEnvelope() {
  return Object.freeze({
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function directLoopStage(field, count, observationIds, provenance, observedAt) {
  const measured = Number.isInteger(count) && count >= 0;
  return Object.freeze({
    field,
    status: measured ? "MEASURED" : "UNKNOWN",
    count: measured ? count : null,
    blocker: measured ? null : `UNMEASURED_${field.toUpperCase()}`,
    provenance: measured ? provenance : null,
    observedAt: finite(observedAt) && observedAt > 0 ? observedAt : null,
    observationIds: Object.freeze(measured ? [...observationIds] : []),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function canonicalReasonForLoopCode(code) {
  if (typeof code !== "string" || code.length === 0) return "UNKNOWN";
  if (code === "STALE_DATA_FORBIDDEN") return "DATA_STALE";
  if (code === "DATA_TIMESTAMP_REQUIRED") return "DATA_MISSING";
  if (code === "RISK_EVIDENCE_NOT_APPROVED") return "RISK_GATE";
  if (["STRATEGY_RESEARCH_SHA_MISMATCH", "STRATEGY_IDENTITY_REQUIRED", "PAPER_LOOP_EXIT_POSITION_NOT_FOUND"].includes(code)) {
    return "IDENTITY_MISMATCH";
  }
  if (code.startsWith("PAPER_ACCOUNT_") || code.startsWith("PAPER_LEDGER_")) return "ACCOUNT_STATE_BLOCK";
  if (code.startsWith("DUPLICATE_")) return "DUPLICATE";
  if (code === "REPLAYED_CYCLE") return "REPLAY_ONLY";
  if (code === "COOLDOWN") return "COOLDOWN";
  return "UNKNOWN";
}

function loopReasonObservation({ sourceStage, sourceCode, provenance, observedAt, identity, observationId }) {
  const canonicalReason = canonicalReasonForLoopCode(sourceCode);
  return Object.freeze({
    sourceStage,
    sourceCode,
    sourceReason: sourceCode,
    canonicalReason,
    lossless: canonicalReason !== "UNKNOWN",
    provenance,
    observedAt,
    identity: Object.freeze({
      cycleId: identity?.cycleId ?? null,
      strategySha: identity?.researchCodeSha ?? null,
      runtimeSha: identity?.researchCodeSha ?? null,
      datasetIdentity: null,
      observationId: observationId ?? null,
    }),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function recurringLoopStageEvidence({
  cycle,
  entryEligibleIds = [],
  entryIds = [],
  positionIds = [],
  settlementIds = [],
  reasonObservations = [],
  replayed = false,
} = {}) {
  const count = (ids) => replayed ? null : ids.length;
  const at = cycle?.evaluatedAtMs ?? null;
  return Object.freeze({
    schemaVersion: "canonical-natural-paper-loop-stage-evidence-v1",
    identity: Object.freeze({
      cycleId: cycle?.cycleId ?? null,
      strategySha: cycle?.identity?.researchCodeSha ?? null,
      runtimeSha: cycle?.identity?.researchCodeSha ?? null,
      datasetIdentity: null,
    }),
    stageCounts: Object.freeze({
      entryEligible: directLoopStage("entryEligible", count(entryEligibleIds), entryEligibleIds, "recurring-paper-loop-v1 immediately before ledgerAdapter.applyEntry", at),
      entry: directLoopStage("entry", count(entryIds), entryIds, "recurring-paper-loop-v1 completed ledger apply and signal persistence", at),
      position: directLoopStage("position", count(positionIds), positionIds, "recurring-paper-loop-v1 positions.push completion", at),
      settlement: directLoopStage("settlement", count(settlementIds), settlementIds, "recurring-paper-loop-v1 accepted settlement state insertion", at),
    }),
    reasonObservations: Object.freeze(reasonObservations),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
    replayed,
  });
}

function validateIdentity(identity) {
  if (!nonEmpty(identity?.strategyId)) throw new Error("PAPER_LOOP_STRATEGY_ID_REQUIRED");
  if (!nonEmpty(identity?.strategyVersion)) throw new Error("PAPER_LOOP_STRATEGY_VERSION_REQUIRED");
  if (!nonEmpty(identity?.parameterHash)) throw new Error("PAPER_LOOP_PARAMETER_HASH_REQUIRED");
  if (!immutableSha(identity?.researchCodeSha)) throw new Error("PAPER_LOOP_RESEARCH_SHA_REQUIRED");
  if (!nonEmpty(identity?.costPolicyVersion)) throw new Error("PAPER_LOOP_COST_POLICY_REQUIRED");
  if (!nonEmpty(identity?.executionPolicyVersion)) throw new Error("PAPER_LOOP_EXECUTION_POLICY_REQUIRED");
}

function identityFingerprint(identity) {
  validateIdentity(identity);
  return hash({ ...identity, researchCodeSha: identity.researchCodeSha.toLowerCase() });
}

function candidateStrategyBlockers(strategyIdentity, runtimeIdentity) {
  if (!nonEmpty(strategyIdentity?.strategyId)
    || !nonEmpty(strategyIdentity?.strategyVersion)
    || !nonEmpty(strategyIdentity?.parameterHash)
    || !immutableSha(strategyIdentity?.researchCodeSha)) {
    return ["STRATEGY_IDENTITY_REQUIRED"];
  }
  if (strategyIdentity.researchCodeSha.toLowerCase() !== runtimeIdentity.researchCodeSha.toLowerCase()) {
    return ["STRATEGY_RESEARCH_SHA_MISMATCH"];
  }
  return [];
}

function assertSafety(value, code) {
  if (value?.simulatedOnly !== true
    || value?.liveOrderAllowed !== false
    || value?.privateTradingApiAllowed !== false
    || value?.orderSubmitted !== false
    || value?.exchangeRequestSent !== false) throw new Error(code);
}

function validateLegacyLedgerSnapshot(ledger) {
  if (!ledger || !["READY", "PARTIAL"].includes(ledger.status)) throw new Error("PAPER_LOOP_LEDGER_NOT_USABLE");
  if (ledger.initialCapitalKrw !== 1_000_000 || ledger.baseCurrency !== "KRW") throw new Error("PAPER_LOOP_CAPITAL_CONTRACT_MISMATCH");
  if (ledger.status !== "READY" && ledger.totalEquityKrw != null) throw new Error("PAPER_LOOP_PARTIAL_EQUITY_FABRICATED");
  assertSafety(ledger, "PAPER_LOOP_LEDGER_SAFETY_VIOLATION");
}

function validateLedgerSnapshot(ledger) {
  if (isAuthoritativeNaturalPaperLedger(ledger)) {
    validateAuthoritativeNaturalPaperLedger(ledger);
    assertSafety(ledger, "PAPER_LOOP_LEDGER_SAFETY_VIOLATION");
    return;
  }
  validateLegacyLedgerSnapshot(ledger);
}

function validateState(state) {
  if (state?.schemaVersion !== "recurring-paper-loop-v1") throw new Error("PAPER_LOOP_STATE_SCHEMA_UNSUPPORTED");
  validateIdentity(state.identity);
  if (state.identityFingerprint !== identityFingerprint(state.identity)) throw new Error("PAPER_LOOP_IDENTITY_FINGERPRINT_MISMATCH");
  if (!Array.isArray(state.cycles) || !Array.isArray(state.samples) || !Array.isArray(state.positions) || !Array.isArray(state.settlements)) {
    throw new Error("PAPER_LOOP_STATE_COLLECTION_INVALID");
  }
  validateLedgerSnapshot(state.ledger);
  assertSafety(state, "PAPER_LOOP_STATE_SAFETY_VIOLATION");
}

export function createRecurringPaperLoopState({ identity, ledger, createdAtMs } = {}) {
  if (!finite(createdAtMs)) throw new Error("PAPER_LOOP_CREATED_AT_REQUIRED");
  validateIdentity(identity);
  validateLedgerSnapshot(ledger);
  return Object.freeze({
    schemaVersion: "recurring-paper-loop-v1",
    identity: Object.freeze({ ...identity, researchCodeSha: identity.researchCodeSha.toLowerCase() }),
    identityFingerprint: identityFingerprint(identity),
    createdAtMs,
    updatedAtMs: createdAtMs,
    cycles: Object.freeze([]),
    samples: Object.freeze([]),
    positions: Object.freeze([]),
    settlements: Object.freeze([]),
    ledger: structuredClone(ledger),
    ...safetyEnvelope(),
  });
}

export function restoreRecurringPaperLoopState(serialized, expectedIdentity) {
  const state = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized);
  validateState(state);
  if (state.identityFingerprint !== identityFingerprint(expectedIdentity)) throw new Error("PAPER_LOOP_PREDECESSOR_IDENTITY_MISMATCH");
  return Object.freeze(structuredClone(state));
}

export function serializeRecurringPaperLoopState(state) {
  validateState(state);
  return `${stableSerialize(state)}\n`;
}

function validateCycle(cycle, state) {
  if (!nonEmpty(cycle?.cycleId)) throw new Error("PAPER_LOOP_CYCLE_ID_REQUIRED");
  if (!finite(cycle?.evaluatedAtMs) || cycle.evaluatedAtMs < state.updatedAtMs) throw new Error("PAPER_LOOP_CYCLE_TIME_INVALID");
  if (identityFingerprint(cycle.identity) !== state.identityFingerprint) throw new Error("PAPER_LOOP_CYCLE_IDENTITY_MISMATCH");
}

function evidenceBlockers(candidate, evaluatedAtMs, runtimeIdentity) {
  const evidence = candidate?.execution?.dataEvidence;
  const blockers = [];
  if (!nonEmpty(candidate?.signal?.signalId)) blockers.push("SIGNAL_ID_REQUIRED");
  if (!nonEmpty(candidate?.signal?.symbol)) blockers.push("SYMBOL_REQUIRED");
  if (!finite(candidate?.signal?.timestampMs)) blockers.push("SIGNAL_TIMESTAMP_REQUIRED");
  else if (candidate.signal.timestampMs > evaluatedAtMs) blockers.push("FUTURE_SIGNAL_FORBIDDEN");
  blockers.push(...candidateStrategyBlockers(candidate?.signal?.strategyIdentity, runtimeIdentity));
  if (candidate?.profitGate?.decision === "ELIGIBLE") {
    if (!nonEmpty(candidate?.profitEvidence?.costPolicyId) || !nonEmpty(candidate?.execution?.costPolicy?.version)) {
      blockers.push("PAPER_COST_POLICY_VERSION_REQUIRED");
    } else if (candidate.profitEvidence.costPolicyId !== candidate.execution.costPolicy.version) {
      blockers.push("PAPER_COST_POLICY_VERSION_MISMATCH");
    }
  }
  if (candidate?.riskEvidence?.status !== "APPROVED"
    || candidate.riskEvidence.simulatedOnly !== true
    || !finite(candidate.riskEvidence.evaluatedAtMs)
    || candidate.riskEvidence.evaluatedAtMs > evaluatedAtMs) blockers.push("RISK_EVIDENCE_NOT_APPROVED");
  if (!evidence || evidence.dataQuality !== "READY") blockers.push("BLOCKED_DATA");
  if (!finite(evidence?.asOfMs)) blockers.push("DATA_TIMESTAMP_REQUIRED");
  else if (evidence.asOfMs > evaluatedAtMs) blockers.push("FUTURE_DATA_FORBIDDEN");
  else if (!finite(evidence.maxAgeMs) || evidence.maxAgeMs <= 0 || evaluatedAtMs - evidence.asOfMs > evidence.maxAgeMs) blockers.push("STALE_DATA_FORBIDDEN");
  return [...new Set(blockers)];
}

function blockedSample(candidate, cycle, blockers) {
  return Object.freeze({
    schemaVersion: 1,
    paperSampleId: hash({ cycleId: cycle.cycleId, signalId: candidate?.signal?.signalId ?? null, blockers }),
    signalId: candidate?.signal?.signalId ?? null,
    market: candidate?.signal?.market ?? null,
    status: "BLOCKED",
    blockers: Object.freeze(blockers),
    fill: null,
    ...safetyEnvelope(),
  });
}

function accountBlockedSample(sample, blocker) {
  return Object.freeze({
    ...sample,
    status: "BLOCKED",
    blockers: Object.freeze([...new Set([...(sample.blockers ?? []), blocker])]),
    ...safetyEnvelope(),
  });
}

function positionFromSample(sample, candidate) {
  const dataEvidence = candidate?.execution?.dataEvidence;
  const accountingEvidence = sample.identity.market === "CRYPTO_FUTURES"
    ? Object.freeze({
      schemaVersion: AUTHORITATIVE_NATURAL_PAPER_ENTRY_ACCOUNTING_EVIDENCE_VERSION,
      settlementCurrency: "USDT",
      leverage: dataEvidence?.leverage ?? null,
      marginMode: dataEvidence?.marginMode ?? null,
      entryNotional: sample.fill.notional,
      immediateCost: sample.fill.costs?.immediateCost ?? null,
      quantity: sample.fill.filledQuantity,
      fillPrice: sample.fill.fillPrice,
      parityFingerprint: sample.parityFingerprint,
    })
    : null;
  return Object.freeze({
    positionId: hash({ paperSampleId: sample.paperSampleId, entry: sample.identity.evaluatedAtMs }),
    paperSampleId: sample.paperSampleId,
    signalId: sample.identity.signalId,
    market: sample.identity.market,
    direction: sample.identity.executionDirection,
    strategyId: sample.identity.strategyId,
    strategyVersion: sample.identity.strategyVersion,
    parameterHash: sample.identity.parameterHash,
    researchCodeSha: sample.identity.researchCodeSha,
    costPolicyVersion: sample.profitEvidence.costPolicyId,
    parityFingerprint: sample.parityFingerprint,
    entryTimestampMs: sample.identity.evaluatedAtMs,
    quantity: sample.fill.filledQuantity,
    entryFillPrice: sample.fill.fillPrice,
    lifecycleState: "OPEN",
    accountingEvidence,
    sample,
  });
}

function cycleSummary({ cycleId, state, entries, blocked, noTrade, settled, replayed = false, directEvidence }) {
  const performance = summarizeSettledPaperSamples(state.settlements);
  if (isAuthoritativeNaturalPaperLedger(state.ledger)) {
    const accounting = authoritativeNaturalPaperAccountingSummary(state.ledger);
    return Object.freeze({
      cycleId,
      replayed,
      accountCurrency: accounting.currency,
      initialEquity: accounting.initialEquity,
      knownCurrentEquity: accounting.currentEquity,
      availableMargin: accounting.availableMargin,
      usedMargin: accounting.usedMargin,
      currentEquityKrw: accounting.currentEquityKrw,
      reportingKrwStatus: accounting.reportingKrwStatus,
      initialEquityKrw: null,
      knownCurrentEquityKrw: accounting.currentEquityKrw,
      totalEquityKrw: accounting.currentEquityKrw,
      equityStatus: "READY_NATIVE",
      openPositions: state.positions.length,
      closedPositions: state.settlements.length,
      entries,
      blocked,
      noTrade,
      tradesSettled: settled,
      canonicalNaturalStageEvidence: directEvidence,
      totalCosts: performance.sampleSize ? state.settlements.reduce((sum, row) => sum + row.totalExplicitCost, 0) : null,
      realizedGrossPnl: performance.sampleSize ? state.settlements.reduce((sum, row) => sum + row.grossPnl, 0) : null,
      realizedNetPnl: performance.totalNetPnl,
      hitRate: performance.hitRate,
      expectancy: performance.expectancyNetPnl,
      profitFactor: performance.profitFactor,
      drawdownPercent: performance.maxDrawdownPercent,
      sampleStatus: performance.sampleSize ? performance.sampleStatus : "N/A_INSUFFICIENT_SETTLED_SAMPLE",
      authoritativeAccountBindingVerified: true,
      ...safetyEnvelope(),
    });
  }
  return Object.freeze({
    cycleId,
    replayed,
    initialEquityKrw: 1_000_000,
    knownCurrentEquityKrw: state.ledger.knownEquityKrw,
    totalEquityKrw: state.ledger.totalEquityKrw,
    equityStatus: state.ledger.totalEquityKrw == null ? "PARTIAL" : "READY",
    openPositions: state.positions.length,
    closedPositions: state.settlements.length,
    entries,
    blocked,
    noTrade,
    tradesSettled: settled,
    canonicalNaturalStageEvidence: directEvidence,
    totalCosts: performance.sampleSize ? state.settlements.reduce((sum, row) => sum + row.totalExplicitCost, 0) : null,
    realizedGrossPnl: performance.sampleSize ? state.settlements.reduce((sum, row) => sum + row.grossPnl, 0) : null,
    realizedNetPnl: performance.totalNetPnl,
    hitRate: performance.hitRate,
    expectancy: performance.expectancyNetPnl,
    profitFactor: performance.profitFactor,
    drawdownPercent: performance.maxDrawdownPercent,
    sampleStatus: performance.sampleSize ? performance.sampleStatus : "N/A_INSUFFICIENT_SETTLED_SAMPLE",
    ...safetyEnvelope(),
  });
}

export async function runRecurringPaperCycle({
  state: predecessor,
  cycle,
  candidates = [],
  exits = [],
  ledgerAdapter,
  learningAdapter,
  stateStore,
} = {}) {
  validateState(predecessor);
  validateCycle(cycle, predecessor);
  if (predecessor.cycles.some((row) => row.cycleId === cycle.cycleId)) {
    const replayReason = loopReasonObservation({
      sourceStage: "SIGNAL_CANDIDATE",
      sourceCode: "REPLAYED_CYCLE",
      provenance: "recurring-paper-loop-v1 duplicate cycle guard",
      observedAt: cycle.evaluatedAtMs,
      identity: cycle.identity,
      observationId: cycle.cycleId,
    });
    const directEvidence = recurringLoopStageEvidence({ cycle, replayed: true, reasonObservations: [replayReason] });
    return Object.freeze({
      state: predecessor,
      summary: cycleSummary({
        cycleId: cycle.cycleId, state: predecessor, entries: 0, blocked: 0, noTrade: 0, settled: 0,
        replayed: true, directEvidence,
      }),
    });
  }
  if (!ledgerAdapter || typeof ledgerAdapter.applyEntry !== "function" || typeof ledgerAdapter.applySettlement !== "function") {
    throw new Error("PAPER_LOOP_LEDGER_ADAPTER_REQUIRED");
  }
  if (!learningAdapter || typeof learningAdapter.persistSignal !== "function" || typeof learningAdapter.persistOutcome !== "function") {
    throw new Error("PAPER_LOOP_LEARNING_ADAPTER_REQUIRED");
  }
  if (!stateStore || typeof stateStore.save !== "function") throw new Error("PAPER_LOOP_STATE_STORE_REQUIRED");

  const samples = [...predecessor.samples];
  let positions = [...predecessor.positions];
  const settlements = [...predecessor.settlements];
  let ledger = structuredClone(predecessor.ledger);
  let entryCount = 0;
  let blockedCount = 0;
  let noTradeCount = 0;
  let settledCount = 0;
  const entryEligibleIds = [];
  const entryIds = [];
  const positionIds = [];
  const settlementIds = [];
  const directReasons = [];

  for (const exit of exits) {
    const position = positions.find((row) => row.positionId === exit.positionId);
    if (!position) {
      directReasons.push(loopReasonObservation({
        sourceStage: "EXIT_ELIGIBLE",
        sourceCode: "PAPER_LOOP_EXIT_POSITION_NOT_FOUND",
        provenance: "recurring-paper-loop-v1 open position lookup",
        observedAt: cycle.evaluatedAtMs,
        identity: cycle.identity,
        observationId: exit?.positionId ?? null,
      }));
      continue;
    }
    const settlement = settleFourMarketPaperSample({ sample: position.sample, ...exit.settlementInput, evaluatedAtMs: cycle.evaluatedAtMs });
    if (settlement.status !== "SETTLED") continue;
    const settlementId = hash({ positionId: position.positionId, paperSampleId: settlement.paperSampleId, settledAtMs: settlement.settledAtMs });
    if (settlements.some((row) => row.settlementId === settlementId || row.paperSampleId === settlement.paperSampleId)) {
      directReasons.push(loopReasonObservation({
        sourceStage: "SETTLEMENT",
        sourceCode: "DUPLICATE_SETTLEMENT",
        provenance: "recurring-paper-loop-v1 settlement identity guard",
        observedAt: cycle.evaluatedAtMs,
        identity: cycle.identity,
        observationId: settlementId,
      }));
      continue;
    }
    await learningAdapter.persistOutcome({
      cycle,
      identity: predecessor.identity,
      position,
      settlement: Object.freeze({ ...settlement, settlementId }),
    });
    const nextLedger = await ledgerAdapter.applySettlement({ ledger, position, settlement, settlementId, cycle });
    validateLedgerSnapshot(nextLedger);
    ledger = structuredClone(nextLedger);
    settlements.push(Object.freeze({ ...settlement, settlementId }));
    positions = positions.filter((row) => row.positionId !== position.positionId);
    settledCount += 1;
    settlementIds.push(settlementId);
  }

  const consumedSignals = new Set(samples.map((sample) => sample.identity?.signalId ?? sample.signalId).filter(Boolean));
  for (const candidate of candidates) {
    if (!MARKET_SET.has(candidate?.signal?.market)) throw new Error("PAPER_LOOP_MARKET_UNSUPPORTED");
    if (consumedSignals.has(candidate.signal.signalId)) {
      directReasons.push(loopReasonObservation({
        sourceStage: "ENTRY_ELIGIBLE",
        sourceCode: "DUPLICATE_SIGNAL_ID",
        provenance: "recurring-paper-loop-v1 consumed signal guard",
        observedAt: cycle.evaluatedAtMs,
        identity: cycle.identity,
        observationId: candidate.signal.signalId,
      }));
      continue;
    }
    const blockers = evidenceBlockers(candidate, cycle.evaluatedAtMs, predecessor.identity);
    const sample = blockers.length
      ? blockedSample(candidate, cycle, blockers)
      : buildFourMarketPaperSample({ ...candidate, evaluatedAtMs: cycle.evaluatedAtMs });
    samples.push(sample);
    consumedSignals.add(candidate.signal.signalId);
    if (sample.status === "NO_TRADE") {
      noTradeCount += 1;
      for (const code of candidate?.profitGate?.reasons ?? ["NO_TRADE"]) {
        directReasons.push(loopReasonObservation({
          sourceStage: "ENTRY_ELIGIBLE",
          sourceCode: code,
          provenance: "recurring-paper-loop-v1 candidate profit gate",
          observedAt: cycle.evaluatedAtMs,
          identity: cycle.identity,
          observationId: candidate.signal.signalId,
        }));
      }
      continue;
    }
    if (sample.status !== "OPEN") {
      blockedCount += 1;
      for (const code of sample.blockers ?? ["PAPER_SAMPLE_BLOCKED"]) {
        directReasons.push(loopReasonObservation({
          sourceStage: "ENTRY_ELIGIBLE",
          sourceCode: code,
          provenance: "recurring-paper-loop-v1 evidenceBlockers/buildFourMarketPaperSample",
          observedAt: cycle.evaluatedAtMs,
          identity: cycle.identity,
          observationId: candidate.signal.signalId,
        }));
      }
      continue;
    }
    const position = positionFromSample(sample, candidate);
    if (positions.some((row) => row.positionId === position.positionId)) {
      directReasons.push(loopReasonObservation({
        sourceStage: "ENTRY_ELIGIBLE",
        sourceCode: "DUPLICATE_POSITION_ID",
        provenance: "recurring-paper-loop-v1 position identity guard",
        observedAt: cycle.evaluatedAtMs,
        identity: cycle.identity,
        observationId: position.positionId,
      }));
      continue;
    }
    entryEligibleIds.push(position.positionId);
    let nextLedger;
    try {
      nextLedger = await ledgerAdapter.applyEntry({ ledger, position, cycle });
      validateLedgerSnapshot(nextLedger);
    } catch (error) {
      if (!isAuthoritativeNaturalPaperAccountError(error)) throw error;
      samples[samples.length - 1] = accountBlockedSample(sample, error.code);
      blockedCount += 1;
      directReasons.push(loopReasonObservation({
        sourceStage: "ENTRY_ELIGIBLE",
        sourceCode: error.code,
        provenance: "recurring-paper-loop-v1 ledgerAdapter.applyEntry",
        observedAt: cycle.evaluatedAtMs,
        identity: cycle.identity,
        observationId: position.positionId,
      }));
      continue;
    }
    await learningAdapter.persistSignal({ cycle, identity: predecessor.identity, candidate, sample });
    ledger = structuredClone(nextLedger);
    entryIds.push(sample.paperSampleId);
    positions.push(position);
    positionIds.push(position.positionId);
    entryCount += 1;
  }

  const nextState = Object.freeze({
    ...predecessor,
    updatedAtMs: cycle.evaluatedAtMs,
    cycles: Object.freeze([...predecessor.cycles, Object.freeze({ cycleId: cycle.cycleId, evaluatedAtMs: cycle.evaluatedAtMs })]),
    samples: Object.freeze(samples),
    positions: Object.freeze(positions),
    settlements: Object.freeze(settlements),
    ledger: Object.freeze(ledger),
  });
  validateState(nextState);
  await stateStore.save({
    cycleId: cycle.cycleId,
    idempotencyKey: `paper-cycle:${cycle.cycleId}`,
    state: serializeRecurringPaperLoopState(nextState),
  });
  const directEvidence = recurringLoopStageEvidence({
    cycle,
    entryEligibleIds,
    entryIds,
    positionIds,
    settlementIds,
    reasonObservations: directReasons,
  });
  return Object.freeze({
    state: nextState,
    summary: cycleSummary({
      cycleId: cycle.cycleId,
      state: nextState,
      entries: entryCount,
      blocked: blockedCount,
      noTrade: noTradeCount,
      settled: settledCount,
      directEvidence,
    }),
  });
}

export const RECURRING_PAPER_MARKETS = MARKETS;
