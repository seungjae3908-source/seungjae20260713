import { evaluateProfitGate } from "./meaningful-search-profit-gate-v1.js";
import { meaningfulSearchPaperCandidates } from "./meaningful-search-paper-bridge-v1.js";
import { runCanonicalMeaningfulSearchMarket } from "./canonical-scanner-meaningful-search-runtime-v1.js";

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

function candidateForPaper(card) {
  return card?.paperCandidate && typeof card.paperCandidate === "object" ? card.paperCandidate : card;
}

function runtimeStatus(search, capturedCount, bridge) {
  if (search.outcome === "SEARCH_FAILURE") return "SEARCH_FAILURE_BLOCKED";
  if (search.outcome === "VALID_NO_TRADE") return "VALID_NO_TRADE";
  if (capturedCount === 0) return "PROFIT_GATE_EVIDENCE_MISSING";
  if (bridge.eligible === capturedCount) return "PAPER_CANDIDATES_READY";
  return "PAPER_CANDIDATE_CONTRACT_BLOCKED";
}

export async function runCanonicalMeaningfulSearchPaperMarket({
  market,
  scanBatch,
  profitInputForCard = (_card, selectedMarket) => defaultProfitInput(selectedMarket),
  maximumBatches = 1_000,
  onProgress,
} = {}) {
  if (typeof profitInputForCard !== "function") throw new TypeError("profitInputForCard must be a function");
  const captured = [];
  const captureProfitInput = async (card, selectedMarket) => {
    const rawInput = await profitInputForCard(card, selectedMarket);
    const normalized = { ...defaultProfitInput(selectedMarket), ...rawInput, market: selectedMarket };
    const profitGate = evaluateProfitGate(normalized);
    if (profitGate.eligible === true) {
      captured.push(freeze({
        candidate: candidateForPaper(card),
        profitGate,
        profitEvidence: profitEvidenceFromMeaningfulSearchGate({
          market: selectedMarket,
          profitInput: normalized,
          profitGate,
        }),
      }));
    }
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

  const bridge = meaningfulSearchPaperCandidates(captured.map((row) => ({
    searchOutcome: search.outcome,
    candidate: row.candidate,
    profitGate: row.profitGate,
    profitEvidence: row.profitEvidence,
  })));

  return freeze({
    schemaVersion: "canonical-meaningful-search-paper-runtime-v1",
    market,
    status: runtimeStatus(search, captured.length, bridge),
    search,
    capturedProfitGateCandidates: captured.length,
    bridgeEligibleCandidates: bridge.eligible,
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
