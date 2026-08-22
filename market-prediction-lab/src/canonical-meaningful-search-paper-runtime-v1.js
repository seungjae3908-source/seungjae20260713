import { evaluateProfitGate } from "./meaningful-search-profit-gate-v1.js";
import { meaningfulSearchPaperCandidates } from "./meaningful-search-paper-bridge-v1.js";
import { runCanonicalMeaningfulSearchMarket } from "./canonical-scanner-meaningful-search-runtime-v1.js";
import { resolveCanonicalPaperAdmissionBridgeCandidate } from "./canonical-paper-admission-bridge-v1.js";
import { resolveCanonicalPaperSimulationAuthority } from "./canonical-paper-simulation-authority-v1.js";
import {
  deriveExecutionDecision,
  normalizeSignalDirection,
  resolveSignalLifecycle,
} from "./signal-direction-contract-v1.js";

const PAPER_ADMISSION_BUNDLE_SCHEMA = "scanner-paper-admission-evidence-bundle-v1";

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

function defaultProfitInput(market) {
  return {
    market,
    probabilities: { tp: null, sl: null, expire: null },
    returns: { target: null, stop: null, expire: null },
    costs: { status: "MISSING", components: {} },
    calibration: { status: "INSUFFICIENT_SAMPLE", sampleSize: 0, tpFirstCount: 0 },
    featureParity: market === "CRYPTO_FUTURES"
      ? { pass: true, allowedFeatures: [], blockedFeatures: [] }
      : { pass: true },
  };
}

function explicitCostPolicyId(input) {
  const value = input?.costPolicyId ?? input?.costs?.costPolicyId ?? input?.costs?.policyId ?? input?.costs?.version;
  return nonEmpty(value) ? value : null;
}

function riskRewardRatio(input) {
  const target = input?.returns?.target;
  const stop = input?.returns?.stop;
  if (!finite(target) || !finite(stop) || Math.abs(stop) === 0) return null;
  return Math.abs(target) / Math.abs(stop);
}

export function profitEvidenceFromMeaningfulSearchGate({ market, profitInput, profitGate } = {}) {
  if (!profitGate || typeof profitGate !== "object") throw new TypeError("profitGate is required");
  return freeze({
    status: profitGate.eligible === true ? "READY" : "NOT_ELIGIBLE",
    market,
    expectedNetEdge: finite(profitGate.evLowerBound) ? profitGate.evLowerBound : null,
    expectedNetReturn: finite(profitGate.netEv) ? profitGate.netEv : null,
    riskRewardRatio: riskRewardRatio(profitInput),
    sampleSize: Number.isInteger(profitInput?.calibration?.sampleSize) ? profitInput.calibration.sampleSize : 0,
    costPolicyId: explicitCostPolicyId(profitInput),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function admissionBundleForCard(card) {
  if (card?.paperAdmissionEvidenceBundle?.schemaVersion === PAPER_ADMISSION_BUNDLE_SCHEMA) {
    return card.paperAdmissionEvidenceBundle;
  }
  if (card?.schemaVersion === PAPER_ADMISSION_BUNDLE_SCHEMA) return card;
  return null;
}

function fallbackCandidateForCard(card) {
  return card?.paperCandidate && typeof card.paperCandidate === "object" ? card.paperCandidate : card;
}

function preparedCandidateForCard(card, nowMs) {
  const fallback = fallbackCandidateForCard(card);
  const bundle = admissionBundleForCard(card);
  if (!bundle) {
    return freeze({
      candidate: fallback,
      admissionStatus: "NOT_REQUESTED",
      admissionBlockers: freeze([]),
      simulationStatus: "NOT_REQUESTED",
      simulationBlockers: freeze([]),
    });
  }

  const admission = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle, nowMs });
  if (admission.status !== "BRIDGE_READY" || !admission.candidate) {
    return freeze({
      candidate: fallback,
      admissionStatus: admission.status ?? "BLOCKED",
      admissionBlockers: freeze([...(admission.blockers ?? [])]),
      simulationStatus: "NOT_REQUESTED",
      simulationBlockers: freeze([]),
    });
  }

  const simulation = resolveCanonicalPaperSimulationAuthority({
    candidate: admission.candidate,
    nowMs,
  });
  if (simulation.status !== "READY" || !simulation.execution || !simulation.order || !simulation.quote) {
    return freeze({
      candidate: admission.candidate,
      admissionStatus: "BRIDGE_READY",
      admissionBlockers: freeze([]),
      simulationStatus: simulation.status ?? "BLOCKED",
      simulationBlockers: freeze([...(simulation.blockers ?? [])]),
    });
  }

  return freeze({
    candidate: freeze({
      ...admission.candidate,
      execution: simulation.execution,
      order: simulation.order,
      quote: simulation.quote,
      sampleExecutionReady: true,
      sampleExecutionBlockers: freeze([]),
      simulationAuthority: freeze({
        schemaVersion: simulation.schemaVersion,
        marketAdapterIdentity: simulation.marketAdapterIdentity,
        executionPolicyVersion: simulation.executionPolicy?.version ?? null,
        orderPolicyVersion: simulation.orderPolicy?.version ?? null,
        sampleExecutionReady: true,
        executionAuthority: "NONE",
        simulatedOnly: true,
        liveOrderAllowed: false,
        privateTradingApiAllowed: false,
        orderSubmitted: false,
        exchangeRequestSent: false,
      }),
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
      productionMutationAllowed: false,
    }),
    admissionStatus: "BRIDGE_READY",
    admissionBlockers: freeze([]),
    simulationStatus: "READY",
    simulationBlockers: freeze([]),
  });
}

function needsPaperExitEvaluation(candidate) {
  const signal = candidate?.signal;
  if (!signal || !finite(signal.timestampMs)) return false;
  const evaluatedAtMs = finite(candidate?.riskEvidence?.evaluatedAtMs)
    ? candidate.riskEvidence.evaluatedAtMs
    : finite(candidate?.execution?.dataEvidence?.asOfMs)
      ? candidate.execution.dataEvidence.asOfMs
      : signal.timestampMs;
  try {
    const lifecycle = resolveSignalLifecycle({
      lifecycle: signal.lifecycle ?? candidate?.signalLifecycle ?? "ACTIVE",
      generatedAtMs: signal.timestampMs,
      ttlMs: signal.ttlMs,
      expiresAtMs: signal.expiresAtMs,
      evaluatedAtMs,
      invalidated: signal.invalidated === true || candidate?.invalidated === true,
      enteredPaper: signal.lifecycle === "ENTERED_PAPER",
      settled: signal.lifecycle === "SETTLED",
    });
    const direction = normalizeSignalDirection(
      signal.signalDirection ?? signal.direction ?? candidate?.signalDirection ?? candidate?.direction,
    );
    const execution = deriveExecutionDecision({
      market: signal.market,
      direction,
      positionSide: signal.positionSide ?? candidate?.positionSide ?? "FLAT",
      lifecycle,
      reduceOnly: signal.reduceOnly === true || candidate?.reduceOnly === true,
    });
    return execution.executionIntent === "EXIT" || execution.executionIntent === "REDUCE";
  } catch {
    return false;
  }
}

function runtimeStatus(search, evaluatedCount, bridge) {
  if (search.outcome === "SEARCH_FAILURE") return "SEARCH_FAILURE_BLOCKED";
  if (bridge.blocked > 0) return "PAPER_CANDIDATE_CONTRACT_BLOCKED";
  if (bridge.eligible > 0 || bridge.exits > 0) return "PAPER_CANDIDATES_READY";
  if (search.outcome === "VALID_NO_TRADE" || bridge.noTrade === evaluatedCount) return "VALID_NO_TRADE";
  if (evaluatedCount === 0) return "PROFIT_GATE_EVIDENCE_MISSING";
  return "PAPER_CANDIDATE_CONTRACT_BLOCKED";
}

function uniqueBlockers(rows, field) {
  return freeze([...new Set(rows.flatMap((row) => Array.isArray(row?.[field]) ? row[field] : []))]);
}

export async function runCanonicalMeaningfulSearchPaperMarket({
  market,
  scanBatch,
  profitInputForCard = (_card, selectedMarket) => defaultProfitInput(selectedMarket),
  maximumBatches = 1_000,
  onProgress,
  now = () => Date.now(),
} = {}) {
  if (typeof profitInputForCard !== "function") throw new TypeError("profitInputForCard must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const evaluated = [];
  const captured = [];
  const captureProfitInput = async (card, selectedMarket) => {
    const evaluatedAtMs = now();
    if (!finite(evaluatedAtMs) || evaluatedAtMs <= 0) throw new TypeError("now must return a positive finite timestamp");
    const rawInput = await profitInputForCard(card, selectedMarket);
    const normalized = { ...defaultProfitInput(selectedMarket), ...rawInput, market: selectedMarket };
    const profitGate = evaluateProfitGate(normalized);
    const prepared = preparedCandidateForCard(card, evaluatedAtMs);
    const row = freeze({
      candidate: prepared.candidate,
      profitGate,
      profitEvidence: profitEvidenceFromMeaningfulSearchGate({
        market: selectedMarket,
        profitInput: normalized,
        profitGate,
      }),
      admissionStatus: prepared.admissionStatus,
      admissionBlockers: prepared.admissionBlockers,
      simulationStatus: prepared.simulationStatus,
      simulationBlockers: prepared.simulationBlockers,
    });
    if (profitGate.eligible === true) captured.push(row);
    if (profitGate.eligible === true || needsPaperExitEvaluation(row.candidate)) evaluated.push(row);
    return rawInput;
  };

  const search = await runCanonicalMeaningfulSearchMarket({
    market,
    scanBatch,
    profitInputForCard: captureProfitInput,
    maximumBatches,
    onProgress,
  });

  if (search.finalCandidates !== captured.length) {
    throw new Error("PAPER_CAPTURE_PROFIT_GATE_COUNT_MISMATCH");
  }

  const bridgeSearchOutcome = search.outcome === "SEARCH_FAILURE" ? "SEARCH_FAILURE" : "TRADE_CANDIDATES";
  const bridge = meaningfulSearchPaperCandidates(evaluated.map((row) => ({
    searchOutcome: bridgeSearchOutcome,
    candidate: row.candidate,
    profitGate: row.profitGate,
    profitEvidence: row.profitEvidence,
  })));
  const admissionBlockers = uniqueBlockers(evaluated, "admissionBlockers");
  const simulationBlockers = uniqueBlockers(evaluated, "simulationBlockers");

  return freeze({
    schemaVersion: "canonical-meaningful-search-paper-runtime-v1",
    market,
    status: runtimeStatus(search, evaluated.length, bridge),
    search,
    evaluatedPaperCandidates: evaluated.length,
    capturedProfitGateCandidates: captured.length,
    admissionBridgeReadyCandidates: evaluated.filter((row) => row.admissionStatus === "BRIDGE_READY").length,
    admissionBlockedCandidates: evaluated.filter((row) => row.admissionStatus === "BLOCKED").length,
    simulationReadyCandidates: evaluated.filter((row) => row.simulationStatus === "READY").length,
    simulationBlockedCandidates: evaluated.filter((row) => row.simulationStatus === "BLOCKED").length,
    admissionBlockers,
    simulationBlockers,
    bridgeEligibleCandidates: bridge.eligible,
    bridgeExitSignals: bridge.exits,
    bridgeBlockedCandidates: bridge.blocked,
    paperBridge: bridge,
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}
