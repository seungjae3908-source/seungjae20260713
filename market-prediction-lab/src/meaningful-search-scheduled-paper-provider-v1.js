const READY_RUNTIME_STATUSES = new Set(["PAPER_CANDIDATES_READY", "VALID_NO_TRADE"]);

function freeze(value) {
  return Object.freeze(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function safeEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false;
}

function candidateIdentityBlockers(candidate, market, {
  requireProfitEvidence = true,
  requireExitIntent = false,
} = {}) {
  const signal = candidate?.signal;
  const strategy = signal?.strategyIdentity;
  const identity = candidate?.paperIdentity;
  const blockers = [];

  if (signal?.market !== market || identity?.market !== market) blockers.push("PAPER_CANDIDATE_MARKET_MISMATCH");
  if (!nonEmpty(signal?.signalId) || identity?.signalId !== signal.signalId) blockers.push("PAPER_CANDIDATE_SIGNAL_ID_MISMATCH");
  if (!nonEmpty(signal?.symbol) || identity?.symbol !== signal.symbol) blockers.push("PAPER_CANDIDATE_SYMBOL_MISMATCH");
  if (!nonEmpty(signal?.timeframe) || identity?.timeframe !== signal.timeframe) blockers.push("PAPER_CANDIDATE_TIMEFRAME_MISMATCH");
  if (!Number.isInteger(signal?.horizon) || signal.horizon <= 0 || identity?.horizon !== signal.horizon) blockers.push("PAPER_CANDIDATE_HORIZON_MISMATCH");
  if (!nonEmpty(strategy?.strategyId) || identity?.strategyId !== strategy.strategyId) blockers.push("PAPER_CANDIDATE_STRATEGY_ID_MISMATCH");
  if (!nonEmpty(strategy?.strategyVersion) || identity?.strategyVersion !== strategy.strategyVersion) blockers.push("PAPER_CANDIDATE_STRATEGY_VERSION_MISMATCH");
  if (!nonEmpty(strategy?.parameterHash) || identity?.parameterHash !== strategy.parameterHash) blockers.push("PAPER_CANDIDATE_PARAMETER_HASH_MISMATCH");
  if (!immutableSha(strategy?.researchCodeSha)
    || String(identity?.researchCodeSha ?? "").toLowerCase() !== strategy.researchCodeSha.toLowerCase()) {
    blockers.push("PAPER_CANDIDATE_RESEARCH_SHA_MISMATCH");
  }

  const identityCostPolicyVersion = identity?.costPolicyVersion;
  const executionCostPolicyVersion = candidate?.execution?.costPolicy?.version;
  const profitCostPolicyId = candidate?.profitEvidence?.costPolicyId;
  if (!nonEmpty(identityCostPolicyVersion)
    || identityCostPolicyVersion !== executionCostPolicyVersion) {
    blockers.push("PAPER_CANDIDATE_COST_POLICY_MISMATCH");
  }
  if (requireProfitEvidence) {
    if (!nonEmpty(profitCostPolicyId) || identityCostPolicyVersion !== profitCostPolicyId) {
      blockers.push("PAPER_CANDIDATE_COST_POLICY_MISMATCH");
    }
  } else if (profitCostPolicyId != null
    && (!nonEmpty(profitCostPolicyId) || identityCostPolicyVersion !== profitCostPolicyId)) {
    blockers.push("PAPER_CANDIDATE_COST_POLICY_MISMATCH");
  }

  if (!nonEmpty(identity?.direction) || identity.direction !== signal?.signalDirection) blockers.push("PAPER_CANDIDATE_DIRECTION_MISMATCH");
  if (requireExitIntent && !["EXIT", "REDUCE"].includes(candidate?.executionIntent)) blockers.push("PAPER_EXIT_INTENT_INVALID");
  if (!safeEnvelope(candidate)) blockers.push("PAPER_CANDIDATE_SAFETY_VIOLATION");
  if (identity?.executionAuthority !== "NONE") blockers.push("PAPER_IDENTITY_EXECUTION_AUTHORITY_FORBIDDEN");

  return [...new Set(blockers)];
}

function blockedEvidence(base, runtime, blocker) {
  return freeze({
    ...base,
    status: "BLOCKED_DATA",
    candidates: freeze([]),
    exits: freeze([]),
    blocker,
    paperCandidateSource: freeze({
      schemaVersion: "meaningful-search-scheduled-paper-provider-v1",
      status: runtime?.status ?? "UNKNOWN",
      searchOutcome: runtime?.search?.outcome ?? null,
      eligibleCandidates: Number(runtime?.bridgeEligibleCandidates ?? 0),
      exitSignals: Number(runtime?.paperBridge?.exits ?? 0),
      blocker,
    }),
  });
}

function readyEvidence(base, runtime, candidates, exits) {
  return freeze({
    ...base,
    candidates: freeze(candidates.map((row) => freeze(structuredClone(row)))),
    exits: freeze(exits.map((row) => freeze(structuredClone(row)))),
    blocker: null,
    paperCandidateSource: freeze({
      schemaVersion: "meaningful-search-scheduled-paper-provider-v1",
      status: runtime.status,
      searchOutcome: runtime?.search?.outcome ?? null,
      eligibleCandidates: candidates.length,
      exitSignals: exits.length,
      blocker: null,
    }),
  });
}

/**
 * Composes the already-canonical Meaningful Search -> Paper bridge with the
 * existing scheduled public-evidence provider. This module does not run a
 * second Paper engine and does not activate any financial adapter.
 */
export function wrapPaperForwardProviderWithMeaningfulSearch({
  provider,
  paperRuntimeForMarket,
} = {}) {
  if (!provider || typeof provider.collectPublicEvidence !== "function") {
    throw new TypeError("canonical Paper public evidence provider is required");
  }
  if (typeof paperRuntimeForMarket !== "function") {
    throw new TypeError("canonical Meaningful Search Paper runtime is required");
  }

  return freeze({
    async collectPublicEvidence(input = {}) {
      const base = await provider.collectPublicEvidence(input);
      if (base?.status !== "READY") return base;

      const runtime = await paperRuntimeForMarket({
        market: input.market,
        cycle: input.cycle,
        signal: input.signal,
      });

      if (!runtime || runtime.market !== input.market || !safeEnvelope(runtime)) {
        return blockedEvidence(base, runtime, "PAPER_RUNTIME_CONTRACT_INVALID");
      }
      if (!READY_RUNTIME_STATUSES.has(runtime.status)) {
        const blocker = runtime.status === "SEARCH_FAILURE_BLOCKED"
          ? "SEARCH_FAILURE"
          : runtime.status ?? "PAPER_RUNTIME_NOT_READY";
        return blockedEvidence(base, runtime, blocker);
      }

      const candidates = runtime?.paperBridge?.candidates ?? [];
      const exits = runtime?.paperBridge?.exitSignals ?? [];
      if (!Array.isArray(candidates) || !Array.isArray(exits)) {
        return blockedEvidence(base, runtime, "PAPER_RUNTIME_PAYLOAD_INVALID");
      }
      if (runtime.status === "VALID_NO_TRADE" && (candidates.length > 0 || exits.length > 0)) {
        return blockedEvidence(base, runtime, "VALID_NO_TRADE_PAYLOAD_VIOLATION");
      }

      const candidateBlockers = candidates.flatMap((candidate) => candidateIdentityBlockers(candidate, input.market));
      const exitBlockers = exits.flatMap((candidate) => candidateIdentityBlockers(candidate, input.market, {
        requireProfitEvidence: false,
        requireExitIntent: true,
      }));
      const blockers = [...new Set([...candidateBlockers, ...exitBlockers])];
      if (blockers.length > 0) return blockedEvidence(base, runtime, blockers.join("|"));

      return readyEvidence(base, runtime, candidates, exits);
    },
  });
}
