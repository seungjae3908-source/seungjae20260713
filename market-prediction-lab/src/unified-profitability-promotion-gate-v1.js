export const UNIFIED_PROFITABILITY_PROMOTION_SCHEMA_VERSION = 1;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requireFingerprint(evidence, expected, stage, reasons) {
  if (!evidence || typeof evidence !== "object") {
    reasons.push(`${stage}:missing_evidence`);
    return false;
  }
  if (evidence.strategyFingerprint !== expected) {
    reasons.push(`${stage}:strategy_identity_mismatch`);
    return false;
  }
  return true;
}

function requireCalibratedPolicy(policy, reasons) {
  if (!policy || policy.status !== "empirically_calibrated") {
    reasons.push("policy:not_empirically_calibrated");
    return false;
  }
  const required = [
    "minTrials",
    "maxPbo",
    "minDsrProbability",
    "minOosTrades",
    "minWalkForwardWindows",
    "minShadowSettled",
    "minShadowElapsedMs",
    "minPaperSettled",
    "minPaperProfitFactor",
    "minPaperExpectancyCiLower",
    "maxPaperMdd",
  ];
  for (const key of required) {
    if (!finite(policy[key])) reasons.push(`policy:${key}_missing`);
  }
  return !reasons.some((reason) => reason.startsWith("policy:"));
}

function evaluateBacktest(backtest, policy, reasons) {
  if (backtest.lineageValid !== true) reasons.push("backtest:lineage_invalid");
  if (backtest.finalHoldoutRetuned === true) reasons.push("backtest:final_holdout_retuned");
  if (backtest.finalHoldoutStatus !== "PASS") reasons.push("backtest:final_holdout_not_passed");
  if (!(backtest.oos?.tradeCount >= policy.minOosTrades)) reasons.push("backtest:oos_sample_insufficient");
  if (!(backtest.oos?.expectancy > 0)) reasons.push("backtest:oos_expectancy_not_positive");
  if (!(backtest.walkForward?.windows >= policy.minWalkForwardWindows)) reasons.push("backtest:walk_forward_coverage_insufficient");
  if (backtest.walkForward?.stabilityPass !== true) reasons.push("backtest:walk_forward_stability_failed");
  if (backtest.costStress?.passed !== true) reasons.push("backtest:cost_stress_failed");
  if (backtest.regime?.passed !== true) reasons.push("backtest:regime_robustness_failed");
  if (backtest.crossSymbol?.passed !== true) reasons.push("backtest:cross_symbol_failed");
}

function evaluateSelectionBias(selectionBias, policy, reasons) {
  if (selectionBias.registryComplete !== true) reasons.push("selection_bias:trial_registry_incomplete");
  if (!(selectionBias.trialCount >= policy.minTrials)) reasons.push("selection_bias:trial_count_insufficient");
  if (!finite(selectionBias.pbo) || selectionBias.pbo > policy.maxPbo) reasons.push("selection_bias:pbo_failed");
  if (!finite(selectionBias.dsrProbability) || selectionBias.dsrProbability < policy.minDsrProbability) {
    reasons.push("selection_bias:dsr_failed");
  }
  if (selectionBias.forwardEvidenceUsedForSelection === true) reasons.push("selection_bias:forward_contamination");
}

function evaluateShadow(shadow, policy, reasons) {
  if (shadow.lineageValid !== true) reasons.push("shadow:lineage_invalid");
  if (shadow.frozenIdentity !== true) reasons.push("shadow:identity_not_frozen");
  if (shadow.naturalScheduleObserved !== true) reasons.push("shadow:natural_schedule_unproven");
  if (shadow.forwardRetuned === true) reasons.push("shadow:forward_retuning_detected");
  if (!(shadow.settled >= policy.minShadowSettled)) reasons.push("shadow:settled_sample_insufficient");
  if (!(shadow.elapsedMs >= policy.minShadowElapsedMs)) reasons.push("shadow:elapsed_period_insufficient");
  if (shadow.neutralCollapse !== false) reasons.push("shadow:neutral_collapse_not_cleared");
  if (shadow.directionalQualityPass !== true) reasons.push("shadow:directional_quality_failed");
}

function evaluatePaper(paper, policy, reasons) {
  if (paper.lineageValid !== true) reasons.push("paper:lineage_invalid");
  if (paper.scheduleActive !== true) reasons.push("paper:schedule_inactive");
  if (paper.naturalCronObserved !== true) reasons.push("paper:natural_cron_unproven");
  if (paper.settlementLinked !== true) reasons.push("paper:settlement_linkage_failed");
  if (!(paper.settledTrades >= policy.minPaperSettled)) reasons.push("paper:settled_sample_insufficient");
  if (!finite(paper.profitFactor) || paper.profitFactor < policy.minPaperProfitFactor) reasons.push("paper:profit_factor_failed");
  if (!finite(paper.expectancyCiLower) || paper.expectancyCiLower <= policy.minPaperExpectancyCiLower) {
    reasons.push("paper:expectancy_confidence_failed");
  }
  if (!finite(paper.maximumDrawdown) || paper.maximumDrawdown > policy.maxPaperMdd) reasons.push("paper:mdd_failed");
  if ((paper.actualOrders ?? 0) !== 0) reasons.push("paper:actual_order_detected");
  if ((paper.privateAccountRequests ?? 0) !== 0) reasons.push("paper:private_request_detected");
}

export function evaluateUnifiedProfitabilityPromotion({
  strategyFingerprint,
  backtest,
  selectionBias,
  shadow,
  paper,
  policy,
} = {}) {
  if (typeof strategyFingerprint !== "string" || strategyFingerprint.length === 0) {
    throw new TypeError("strategyFingerprint is required");
  }
  const reasons = [];
  const policyReady = requireCalibratedPolicy(policy, reasons);
  const identities = {
    backtest: requireFingerprint(backtest, strategyFingerprint, "backtest", reasons),
    selectionBias: requireFingerprint(selectionBias, strategyFingerprint, "selection_bias", reasons),
    shadow: requireFingerprint(shadow, strategyFingerprint, "shadow", reasons),
    paper: requireFingerprint(paper, strategyFingerprint, "paper", reasons),
  };

  if (policyReady && Object.values(identities).every(Boolean)) {
    evaluateBacktest(backtest, policy, reasons);
    evaluateSelectionBias(selectionBias, policy, reasons);
    evaluateShadow(shadow, policy, reasons);
    evaluatePaper(paper, policy, reasons);
  }

  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  const promotionEligible = uniqueReasons.length === 0;
  const stagePass = (prefix) => !uniqueReasons.some((reason) => reason.startsWith(`${prefix}:`));

  return Object.freeze({
    schemaVersion: UNIFIED_PROFITABILITY_PROMOTION_SCHEMA_VERSION,
    strategyFingerprint,
    promotionEligible,
    status: promotionEligible ? "PROMOTION_REVIEW_READY" : "RESEARCH_HOLD",
    reasons: uniqueReasons,
    stages: Object.freeze({
      policy: stagePass("policy"),
      backtest: stagePass("backtest"),
      selectionBias: stagePass("selection_bias"),
      shadow: stagePass("shadow"),
      paper: stagePass("paper"),
    }),
    safety: Object.freeze({
      liveTradingAllowed: false,
      privateTradingApiAllowed: false,
      orderAuthority: false,
      actualOrders: 0,
      promotionReviewOnly: promotionEligible,
    }),
  });
}
