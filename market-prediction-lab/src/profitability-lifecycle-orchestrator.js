import { evaluateStrategyLifecycle } from "./strategy-lifecycle.js";
import { evaluateChampionChallenger } from "./champion-challenger.js";
import { evaluateResearchCapitalAllocation } from "./capital-allocation-risk.js";
import { estimateEmpiricalExecutionCapacity } from "./capacity-impact.js";
import { evaluateRealityCheckAndSpa } from "./spa-reality-check.js";

export const PROFITABILITY_LIFECYCLE_CONTROL_SCHEMA_VERSION = 1;

export function evaluateProfitabilityLifecycleControl({
  champion,
  challengers = [],
  lifecyclePolicy,
  challengerPolicy,
  capitalPolicy,
  capacityPolicy,
  capacityInput = null,
  multipleTestingInput = null,
} = {}) {
  if (!champion || typeof champion.strategyFingerprint !== "string") throw new TypeError("champion is required");

  const lifecycleAssessment = evaluateStrategyLifecycle({
    strategyFingerprint: champion.strategyFingerprint,
    baseline: champion.baseline,
    current: champion.current,
    baselineReturnSamples: champion.baselineReturnSamples,
    recentReturnSamples: champion.netReturnSamples,
    consecutiveDegradedWindows: champion.consecutiveDegradedWindows ?? 0,
    previousState: champion.lifecycleState ?? "CHAMPION",
    policy: lifecyclePolicy,
  });

  const championWithLifecycle = Object.freeze({ ...champion, lifecycleAssessment });
  const challengerAssessment = evaluateChampionChallenger({
    champion: championWithLifecycle,
    challengers,
    policy: challengerPolicy,
  });

  const capital = evaluateResearchCapitalAllocation({
    strategies: [championWithLifecycle, ...challengers],
    policy: capitalPolicy,
  });

  const capacity = capacityInput
    ? estimateEmpiricalExecutionCapacity({ ...capacityInput, policy: capacityPolicy })
    : Object.freeze({
      status: "NOT_READY",
      blockers: Object.freeze(["capacity:evidence_not_supplied"]),
      permanentImpactAvailable: false,
      orderAuthority: false,
    });

  const multipleTesting = multipleTestingInput
    ? evaluateRealityCheckAndSpa(multipleTestingInput)
    : Object.freeze({
      status: "RESEARCH_HOLD",
      reason: "multiple_testing_evidence_not_supplied",
      safety: Object.freeze({ promotionAuthority: false, liveTradingAllowed: false, orderAuthority: false }),
    });

  const blockers = [];
  if (!["KEEP_CHAMPION", "DEMOTE_TO_WATCH", "RETIRE_REVIEW_REQUIRED"].includes(lifecycleAssessment.action)) blockers.push("lifecycle:not_evaluable");
  if (capital.status !== "ALLOCATION_REVIEW_READY") blockers.push("capital:not_review_ready");
  if (multipleTesting.status !== "EVIDENCE_READY"
    || multipleTesting.realityCheck?.rejectsNoSuperiorStrategyNull !== true
    || multipleTesting.spa?.rejectsNoSuperiorStrategyNull !== true) {
    blockers.push("multiple_testing:superiority_not_proven");
  }
  if (!["CAPACITY_REVIEW_READY", "NO_POSITIVE_CAPACITY"].includes(capacity.status)) blockers.push("capacity:not_ready");

  return Object.freeze({
    schemaVersion: PROFITABILITY_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    status: blockers.length === 0 ? "LIFECYCLE_REVIEW_READY" : "RESEARCH_HOLD",
    blockers: Object.freeze(blockers),
    championFingerprint: champion.strategyFingerprint,
    lifecycleAssessment,
    challengerAssessment,
    capital,
    capacity,
    multipleTesting,
    safety: Object.freeze({
      liveTradingAllowed: false,
      privateTradingApiAllowed: false,
      orderAuthority: false,
      automaticPromotionAllowed: false,
      automaticChampionSwapAllowed: false,
      automaticCapitalMutationAllowed: false,
      reviewOnly: true,
    }),
  });
}
