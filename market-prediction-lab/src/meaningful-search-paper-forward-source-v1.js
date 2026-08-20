const CANONICAL_MEANINGFUL_SEARCH_PAPER_RUNTIME_SCHEMA = "canonical-meaningful-search-paper-runtime-v1";

export const MEANINGFUL_SEARCH_PAPER_FORWARD_SOURCE_CONTRACT = Object.freeze({
  version: "meaningful-search-paper-forward-source-v1",
  publicDataOnly: true,
  simulatedOnly: true,
  executionAuthority: "NONE",
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  orderSubmitted: false,
  exchangeRequestSent: false,
  productionMutationAllowed: false,
  profitabilityClaimAllowed: false,
  settlementAuthority: false,
});

function freeze(value) { return Object.freeze(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function runtimeSafetyEnvelope(value, market) {
  return value?.schemaVersion === CANONICAL_MEANINGFUL_SEARCH_PAPER_RUNTIME_SCHEMA
    && value?.market === market
    && value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false
    && value?.profitabilityClaimAllowed === false;
}
function result(status, { candidates = [], blocker = null, runtimeStatus = null } = {}) {
  return freeze({
    status,
    candidates: freeze([...candidates]),
    exits: freeze([]),
    blocker,
    runtimeStatus,
    safety: MEANINGFUL_SEARCH_PAPER_FORWARD_SOURCE_CONTRACT,
  });
}

export function createMeaningfulSearchPaperForwardSource({
  runMarket,
  ownedMarket = "CRYPTO_FUTURES",
} = {}) {
  if (typeof runMarket !== "function") throw new TypeError("runMarket must be a function");
  if (!nonEmpty(ownedMarket)) throw new TypeError("ownedMarket is required");

  return freeze({
    async collect(input = {}) {
      if (input.market !== ownedMarket) {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_SOURCE_MARKET_NOT_OWNED" });
      }
      let runtime;
      try {
        runtime = await runMarket(input);
      } catch (error) {
        return result("BLOCKED", {
          blocker: `MEANINGFUL_SEARCH_RUNTIME_FAILED:${String(error?.code ?? error?.message ?? "UNKNOWN").slice(0, 160)}`,
        });
      }
      if (!runtime || typeof runtime !== "object") {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_RUNTIME_INVALID" });
      }
      const runtimeStatus = String(runtime.status ?? "UNKNOWN");
      if (!runtimeSafetyEnvelope(runtime, ownedMarket)) {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_RUNTIME_CONTRACT_INVALID", runtimeStatus });
      }
      const bridgeCandidates = runtime?.paperBridge?.candidates;
      const bridgeExits = runtime?.paperBridge?.exitSignals;
      if (!Array.isArray(bridgeCandidates) || !Array.isArray(bridgeExits)) {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_BRIDGE_RESULT_REQUIRED", runtimeStatus });
      }

      if (runtimeStatus === "VALID_NO_TRADE") {
        if (bridgeCandidates.length !== 0 || bridgeExits.length !== 0
          || Number(runtime.bridgeEligibleCandidates ?? 0) !== 0) {
          return result("BLOCKED", { blocker: "VALID_NO_TRADE_BRIDGE_NONZERO", runtimeStatus });
        }
        return result("VALID_NO_TRADE", { runtimeStatus });
      }

      if (runtimeStatus !== "PAPER_CANDIDATES_READY") {
        const admissionBlockers = Array.isArray(runtime.admissionBlockers) ? runtime.admissionBlockers : [];
        const simulationBlockers = Array.isArray(runtime.simulationBlockers) ? runtime.simulationBlockers : [];
        const bridgeResults = Array.isArray(runtime?.paperBridge?.results) ? runtime.paperBridge.results : [];
        const blockers = [
          ...admissionBlockers,
          ...simulationBlockers,
          ...bridgeResults.flatMap((row) => Array.isArray(row?.blockers) ? row.blockers : []),
        ].filter(nonEmpty);
        const detail = blockers[0] ?? runtimeStatus;
        return result("BLOCKED", { blocker: `MEANINGFUL_SEARCH_NOT_READY:${detail}`, runtimeStatus });
      }

      if (bridgeExits.length > 0) {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_SETTLEMENT_EXIT_OWNED_ELSEWHERE", runtimeStatus });
      }
      if (bridgeCandidates.length === 0 || Number(runtime.bridgeEligibleCandidates ?? 0) !== bridgeCandidates.length) {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_READY_WITHOUT_ENTRY_CANDIDATE", runtimeStatus });
      }
      if (bridgeCandidates.some((candidate) => candidate?.signal?.market !== ownedMarket)) {
        return result("BLOCKED", { blocker: "MEANINGFUL_SEARCH_CANDIDATE_MARKET_MISMATCH", runtimeStatus });
      }

      return result("READY", { candidates: bridgeCandidates, runtimeStatus });
    },
  });
}
