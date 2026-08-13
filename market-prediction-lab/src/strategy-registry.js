export const STRATEGY_REGISTRY_STATES = Object.freeze([
  "candidate",
  "research_hold",
  "rejected",
  "frozen",
  "final_holdout_passed",
]);

export const STRATEGY_REGISTRY_GROUPS = Object.freeze([
  "KR_STOCK_SCALPING",
  "KR_STOCK_SWING",
  "US_STOCK_SCALPING",
  "US_STOCK_SWING",
  "CRYPTO_SPOT_SCALPING",
  "CRYPTO_SPOT_SWING",
  "BINANCE_FUTURES_SCALPING_LONG",
  "BINANCE_FUTURES_SCALPING_SHORT",
  "BINANCE_FUTURES_SWING_LONG",
  "BINANCE_FUTURES_SWING_SHORT",
]);

export const SCALPING_COMPATIBILITY = Object.freeze({
  V1: Object.freeze({ verdict: "SCALPING_COMPATIBLE", reason: "dedicated_15m_bounded_parameter_space_exists" }),
  V2: Object.freeze({ verdict: "NEEDS_SCALPING_ADAPTER", reason: "existing_optimization_parameters_are_not_15m_scalping_calibrated" }),
  V3: Object.freeze({ verdict: "NEEDS_SCALPING_ADAPTER", reason: "volume_trend_filter_depends_on_existing_v2_parameters_and_needs_15m_calibration" }),
  V4: Object.freeze({ verdict: "NEEDS_SCALPING_ADAPTER", reason: "regime_rsi_macd_filter_depends_on_existing_v2_parameters_and_needs_15m_calibration" }),
  V5: Object.freeze({ verdict: "NEEDS_SCALPING_ADAPTER", reason: "price_structure_filter_depends_on_existing_v2_parameters_and_needs_15m_calibration" }),
  V6: Object.freeze({ verdict: "NEEDS_SCALPING_ADAPTER", reason: "entry_signal_is_independent_but_existing_risk_exit_parameters_are_not_15m_scalping_calibrated" }),
});

const STATES = new Set(STRATEGY_REGISTRY_STATES);
const GROUPS = new Set(STRATEGY_REGISTRY_GROUPS);

export function createStrategyRegistryEntry({
  id,
  group,
  state = "candidate",
  strategyVersion,
  market,
  style,
  direction,
  venue = null,
  researchCodeSha,
  artifactDigest = null,
  selectionDataStatus = null,
  finalHoldoutStatus = "LOCKED_NOT_EVALUATED",
  livePromotionAllowed = false,
} = {}) {
  if (typeof id !== "string" || id.length < 3) throw new TypeError("strategy registry id is required");
  if (!GROUPS.has(group)) throw new TypeError(`unsupported strategy registry group: ${group}`);
  if (!STATES.has(state)) throw new TypeError(`unsupported strategy registry state: ${state}`);
  if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be immutable SHA");
  if (livePromotionAllowed !== false) throw new Error("LIVE_STRATEGY_PROMOTION_FORBIDDEN_IN_RESEARCH_REGISTRY");
  if (state === "final_holdout_passed" && finalHoldoutStatus !== "PASSED") throw new Error("FINAL_HOLDOUT_PASS_REQUIRED");
  if (state === "frozen" && finalHoldoutStatus === "LOCKED_NOT_EVALUATED") {
    // Frozen means the candidate definition may be queued for a separately approved one-shot holdout.
    // It does not mean holdout has been read or passed.
  }
  return Object.freeze({
    schemaVersion: 1,
    id,
    group,
    state,
    strategyVersion,
    market,
    style,
    direction,
    venue,
    researchCodeSha: researchCodeSha.toLowerCase(),
    artifactDigest,
    selectionDataStatus,
    finalHoldoutStatus,
    livePromotionAllowed: false,
    paperRequiredBeforeLive: true,
    shadowRequiredBeforeLive: true,
    userApprovalRequiredBeforeLive: true,
  });
}

export function transitionStrategyRegistryEntry(entry, nextState, evidence = {}) {
  if (!entry || typeof entry !== "object" || !STATES.has(entry.state)) throw new TypeError("valid strategy registry entry is required");
  if (!STATES.has(nextState)) throw new TypeError(`unsupported next strategy state: ${nextState}`);
  const allowed = Object.freeze({
    candidate: new Set(["research_hold", "rejected", "frozen"]),
    research_hold: new Set(["rejected", "frozen"]),
    rejected: new Set([]),
    frozen: new Set(["final_holdout_passed", "rejected"]),
    final_holdout_passed: new Set([]),
  });
  if (!allowed[entry.state].has(nextState)) throw new Error(`INVALID_STRATEGY_REGISTRY_TRANSITION:${entry.state}->${nextState}`);
  if (nextState === "frozen") {
    if (evidence.selectionDataStatus !== "DATA_READY") throw new Error("FREEZE_REQUIRES_SELECTION_DATA_READY");
    if (evidence.candidateDefinitionFrozen !== true) throw new Error("FREEZE_REQUIRES_IMMUTABLE_CANDIDATE_DEFINITION");
    if (evidence.finalHoldoutRead === true) throw new Error("FREEZE_CANNOT_USE_FINAL_HOLDOUT");
  }
  if (nextState === "final_holdout_passed" && evidence.finalHoldoutVerdict !== "PASSED") throw new Error("FINAL_HOLDOUT_PASS_REQUIRED");
  return Object.freeze({
    ...entry,
    state: nextState,
    finalHoldoutStatus: nextState === "final_holdout_passed" ? "PASSED" : entry.finalHoldoutStatus,
    transitionEvidence: Object.freeze({ ...evidence }),
    livePromotionAllowed: false,
  });
}

export function buildStrategyRegistryContract({ researchCodeSha } = {}) {
  if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be immutable SHA");
  return Object.freeze({
    schemaVersion: 1,
    researchCodeSha: researchCodeSha.toLowerCase(),
    states: STRATEGY_REGISTRY_STATES,
    groups: STRATEGY_REGISTRY_GROUPS,
    scalpingCompatibility: SCALPING_COMPATIBILITY,
    automaticLivePromotion: false,
    finalHoldoutExecutionAllowed: false,
    productionMutationAllowed: false,
    privateApiAllowed: false,
    orderSubmissionAllowed: false,
  });
}
