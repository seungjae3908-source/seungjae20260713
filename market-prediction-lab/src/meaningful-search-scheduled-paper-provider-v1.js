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

function cloneMeasurements(value) {
  return Array.isArray(value)
    ? freeze(value.map((row) => freeze(structuredClone(row))))
    : freeze([]);
}

function cloneReasonEvidenceByStage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return freeze({});
  return freeze(Object.fromEntries(
    Object.entries(value).map(([stage, evidence]) => [stage, freeze(structuredClone(evidence))]),
  ));
}

function cloneObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? freeze(structuredClone(value))
    : null;
}

function naturalRuntimeMetadata(runtime) {
  return {
    naturalFunnelMeasurements: cloneMeasurements(runtime?.naturalFunnelMeasurements),
    naturalFirstZeroStage: runtime?.naturalFirstZeroStage ?? "UNKNOWN",
    naturalFirstZeroReason: runtime?.naturalFirstZeroReason ?? null,
    naturalEvidenceIdentity: runtime?.naturalEvidenceIdentity ?? null,
    naturalRuntimeSha: runtime?.naturalRuntimeSha ?? null,
    authoritativeFirstZeroReasonEvidenceByStage: cloneReasonEvidenceByStage(
      runtime?.authoritativeFirstZeroReasonEvidenceByStage,
    ),
    canonicalNaturalStageEvidence: cloneObject(runtime?.canonicalNaturalStageEvidence),
    exitConditionEvidence: cloneObject(runtime?.exitConditionEvidence),
  };
}

function exactPositionIdentity(position) {
  const sample = position?.sample?.identity ?? {};
  return {
    market: position?.market ?? sample.market,
    symbol: sample.symbol,
    timeframe: sample.timeframe,
    horizon: sample.horizon,
    strategyId: position?.strategyId ?? sample.strategyId,
    strategyVersion: position?.strategyVersion ?? sample.strategyVersion,
    parameterHash: position?.parameterHash ?? sample.parameterHash,
    researchCodeSha: position?.researchCodeSha ?? sample.researchCodeSha,
    costPolicyVersion: position?.costPolicyVersion ?? position?.sample?.profitEvidence?.costPolicyId,
  };
}

function exactIdentityMatch(position, paperIdentity) {
  if (!position || !paperIdentity) return false;
  const value = exactPositionIdentity(position);
  return ["market", "symbol", "timeframe", "strategyId", "strategyVersion", "parameterHash", "researchCodeSha", "costPolicyVersion"]
    .every((key) => nonEmpty(value[key]) && value[key] === paperIdentity[key])
    && Number.isInteger(value.horizon)
    && value.horizon === paperIdentity.horizon;
}

function exitEligibilityEvidence(runtime, openPositions) {
  const condition = runtime?.exitConditionEvidence;
  const observations = Array.isArray(condition?.observations) ? condition.observations : [];
  const positionsKnown = Array.isArray(openPositions);
  const identityComplete = observations.every((row) => row?.paperIdentity && typeof row.paperIdentity === "object");
  const measured = condition?.status === "MEASURED" && positionsKnown && identityComplete;
  const reasonObservations = [];
  const enriched = observations.map((row) => {
    const matches = measured ? openPositions.filter((position) => exactIdentityMatch(position, row.paperIdentity)) : [];
    const matchedOpenPosition = matches.length === 1;
    const exitEligible = measured && matchedOpenPosition && row.requirementsSatisfied === true;
    let sourceCode = null;
    let canonicalReason = "UNKNOWN";
    let lossless = false;
    if (measured && row.requirementsSatisfied !== true) {
      sourceCode = row.sourceCode ?? "EXIT_REQUIREMENTS_NOT_SATISFIED";
    } else if (measured && matches.length === 0) {
      sourceCode = "OPEN_POSITION_NOT_MATCHED";
      canonicalReason = "IDENTITY_MISMATCH";
      lossless = true;
    } else if (measured && matches.length > 1) {
      sourceCode = "OPEN_POSITION_MATCH_AMBIGUOUS";
    }
    if (sourceCode) reasonObservations.push(freeze({
      sourceStage: "EXIT_ELIGIBLE",
      sourceCode,
      sourceReason: row.sourceReason ?? sourceCode,
      canonicalReason,
      lossless,
      provenance: "meaningful-search-scheduled-paper-provider-v1 exact open-position identity join",
      observedAt: row.observedAt ?? null,
      identity: freeze({ observationId: row.observationId ?? null }),
      naturalCredit: 0,
      replayCredit: 0,
      duplicateCredit: 0,
    }));
    return freeze({
      ...structuredClone(row),
      matchedOpenPosition,
      matchedPositionId: matchedOpenPosition ? matches[0].positionId : null,
      exitEligible,
    });
  });
  return freeze({
    schemaVersion: "canonical-paper-exit-eligibility-evidence-v1",
    status: measured ? "MEASURED" : "UNKNOWN",
    exitEvaluationCount: measured ? enriched.length : null,
    matchedOpenPositionCount: measured ? enriched.filter((row) => row.matchedOpenPosition).length : null,
    exitEligibleCount: measured ? enriched.filter((row) => row.exitEligible).length : null,
    observations: freeze(enriched),
    reasonObservations: freeze(reasonObservations),
    blocker: measured ? null : "EXIT_ELIGIBILITY_DIRECT_PROVENANCE_INCOMPLETE",
    provenance: "canonical exit condition evidence + exact open-position identity snapshot",
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
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

function blockedEvidence(base, runtime, blocker, exitEligibility = null) {
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
      eligibleCandidates: Number.isInteger(runtime?.bridgeEligibleCandidates)
        ? runtime.bridgeEligibleCandidates
        : null,
      exitSignals: Number.isInteger(runtime?.paperBridge?.exits)
        ? runtime.paperBridge.exits
        : null,
      stageMeasurements: cloneMeasurements(runtime?.stageMeasurements),
      firstZeroStage: runtime?.firstZeroStage ?? "UNKNOWN",
      firstZeroReason: runtime?.firstZeroReason ?? blocker,
      ...naturalRuntimeMetadata(runtime),
      exitEligibilityEvidence: exitEligibility,
      blocker,
    }),
  });
}

function readyEvidence(base, runtime, candidates, exits, exitEligibility) {
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
      stageMeasurements: cloneMeasurements(runtime.stageMeasurements),
      firstZeroStage: runtime.firstZeroStage ?? "UNKNOWN",
      firstZeroReason: runtime.firstZeroReason ?? null,
      ...naturalRuntimeMetadata(runtime),
      exitEligibilityEvidence: exitEligibility,
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
      const exitEligibility = exitEligibilityEvidence(runtime, input.openPositions);
      if (!READY_RUNTIME_STATUSES.has(runtime.status)) {
        const admissionBlockers = Array.isArray(runtime.admissionBlockers)
          ? runtime.admissionBlockers.filter(nonEmpty)
          : [];
        const blocker = admissionBlockers.length > 0
          ? [...new Set(admissionBlockers)].join("|")
          : runtime.status === "SEARCH_FAILURE_BLOCKED"
            ? "SEARCH_FAILURE"
            : runtime.status ?? "PAPER_RUNTIME_NOT_READY";
        return blockedEvidence(base, runtime, blocker, exitEligibility);
      }

      const candidates = runtime?.paperBridge?.candidates ?? [];
      const exits = runtime?.paperBridge?.exitSignals ?? [];
      if (!Array.isArray(candidates) || !Array.isArray(exits)) {
        return blockedEvidence(base, runtime, "PAPER_RUNTIME_PAYLOAD_INVALID", exitEligibility);
      }
      if (runtime.status === "VALID_NO_TRADE" && (candidates.length > 0 || exits.length > 0)) {
        return blockedEvidence(base, runtime, "VALID_NO_TRADE_PAYLOAD_VIOLATION", exitEligibility);
      }

      const candidateBlockers = candidates.flatMap((candidate) => candidateIdentityBlockers(candidate, input.market));
      const exitBlockers = exits.flatMap((candidate) => candidateIdentityBlockers(candidate, input.market, {
        requireProfitEvidence: false,
        requireExitIntent: true,
      }));
      const blockers = [...new Set([...candidateBlockers, ...exitBlockers])];
      if (blockers.length > 0) return blockedEvidence(base, runtime, blockers.join("|"), exitEligibility);

      return readyEvidence(base, runtime, candidates, exits, exitEligibility);
    },
  });
}
