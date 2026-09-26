import { runCanonicalMeaningfulSearchMarket } from "./canonical-scanner-meaningful-search-runtime-v1.js";
import { evaluateProfitGate } from "./meaningful-search-profit-gate-v1.js";
import { buildSearchDiscoveryCandidate, buildSearchDiscoverySnapshot } from "./search-discovery-contract-v1.js";

function freeze(value) { return Object.freeze(value); }

function signalKey(card) {
  return [
    card?.market ?? "UNKNOWN",
    card?.symbol ?? card?.ticker ?? "UNKNOWN",
    card?.signalId ?? "NO_SIGNAL_ID",
  ].join(":");
}

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

export async function runCanonicalDiscoverySearchMarket({ market, scanBatch, profitInputForCard, ...rest } = {}) {
  if (typeof scanBatch !== "function") throw new TypeError("scanBatch is required");
  const discoveryRows = new Map();
  const rawProfitInput = typeof profitInputForCard === "function"
    ? profitInputForCard
    : (_card, selectedMarket) => defaultProfitInput(selectedMarket);

  const wrappedScanBatch = async (input) => scanBatch(input);
  const wrappedProfitInput = async (card, selectedMarket) => {
    const rawInput = await rawProfitInput(card, selectedMarket);
    const gate = evaluateProfitGate({ ...defaultProfitInput(selectedMarket), ...rawInput, market: selectedMarket });
    discoveryRows.set(signalKey(card), buildSearchDiscoveryCandidate({
      market: selectedMarket,
      card,
      profitGate: gate,
    }));
    return rawInput;
  };

  const strictResult = await runCanonicalMeaningfulSearchMarket({
    ...rest,
    market,
    scanBatch: wrappedScanBatch,
    profitInputForCard: wrappedProfitInput,
  });
  const discovery = buildSearchDiscoverySnapshot([...discoveryRows.values()]);
  const discoveryOutcome = strictResult.searchFailure
    ? "SEARCH_FAILURE"
    : discovery.discoveryCandidateCount > 0 ? "DISCOVERY_CANDIDATES" : "VALID_ZERO_SIGNAL";

  return freeze({
    ...strictResult,
    discoveryOutcome,
    discoveryCandidateCount: discovery.discoveryCandidateCount,
    discoveryCandidates: discovery.candidates,
    discoveryPaperEligibleCount: discovery.paperEligibleCount,
    discoveryAutoTradeEligibleCount: discovery.autoTradeEligibleCount,
    searchVisibilityDependsOnProfitGate: false,
  });
}
