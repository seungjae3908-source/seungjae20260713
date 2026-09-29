import { researchDigest } from "./research-trial-registry.js";

export const QUALITY_DAYTRADE_SEARCH_CONTRACT_VERSION = "us-quality-daytrade-search-plan-v1";

const SEARCH_SELECTION_STAGES = new Set(["development", "validation"]);

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} is required`);
  return value.trim();
}

function normalizePolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("policy is required");
  const policy = {
    policyVersion: nonEmpty(raw.policyVersion, "policy.policyVersion"),
    minSlicesPerStage: positiveInteger(raw.minSlicesPerStage, "policy.minSlicesPerStage"),
    minTotalTrades: positiveInteger(raw.minTotalTrades, "policy.minTotalTrades"),
    minCostAdjustedNetExpectancy: finiteNumber(raw.minCostAdjustedNetExpectancy, "policy.minCostAdjustedNetExpectancy"),
    minProfitFactor: finiteNumber(raw.minProfitFactor, "policy.minProfitFactor"),
    maxDrawdownPct: finiteNumber(raw.maxDrawdownPct, "policy.maxDrawdownPct"),
    maxTailLossPct: finiteNumber(raw.maxTailLossPct, "policy.maxTailLossPct"),
    narrowLimit: positiveInteger(raw.narrowLimit, "policy.narrowLimit"),
    fineTakeProfitStepPct: finiteNumber(raw.fineTakeProfitStepPct, "policy.fineTakeProfitStepPct"),
    fineStopStepPct: finiteNumber(raw.fineStopStepPct, "policy.fineStopStepPct"),
    fineRadiusSteps: positiveInteger(raw.fineRadiusSteps, "policy.fineRadiusSteps"),
    maxFineCandidates: positiveInteger(raw.maxFineCandidates, "policy.maxFineCandidates"),
  };
  if (!(policy.minProfitFactor > 0)) throw new RangeError("policy.minProfitFactor must be positive");
  if (!(policy.maxDrawdownPct > 0)) throw new RangeError("policy.maxDrawdownPct must be positive");
  if (!(policy.maxTailLossPct > 0)) throw new RangeError("policy.maxTailLossPct must be positive");
  if (!(policy.fineTakeProfitStepPct > 0)) throw new RangeError("policy.fineTakeProfitStepPct must be positive");
  if (!(policy.fineStopStepPct > 0)) throw new RangeError("policy.fineStopStepPct must be positive");
  if (policy.fineRadiusSteps > 3) throw new RangeError("policy.fineRadiusSteps must be <= 3");
  if (policy.narrowLimit > 100) throw new RangeError("policy.narrowLimit must be <= 100");
  if (policy.maxFineCandidates > 10_000) throw new RangeError("policy.maxFineCandidates must be <= 10000");
  return Object.freeze(policy);
}

function validatePlanAndRegistry(experimentPlan, registry) {
  if (!experimentPlan || typeof experimentPlan !== "object" || !Array.isArray(experimentPlan.candidates)) {
    throw new TypeError("valid quality day-trade experimentPlan is required");
  }
  if (!registry || !Array.isArray(registry.trials) || !registry.strategyIdentity) {
    throw new TypeError("valid trial registry is required");
  }
  const planFingerprint = experimentPlan.registry?.strategyIdentity?.familyFingerprint;
  if (!planFingerprint || registry.strategyIdentity.familyFingerprint !== planFingerprint) {
    throw new Error("experiment plan / trial registry strategy identity mismatch");
  }
  if (registry.experimentId !== experimentPlan.registry.experimentId) {
    throw new Error("experiment plan / trial registry experimentId mismatch");
  }
  const candidateIds = new Set(experimentPlan.candidates.map((candidate) => candidate.candidateId));
  const parameterHashes = new Set(experimentPlan.candidates.map((candidate) => candidate.parameterHash));
  for (const trial of registry.trials) {
    if (!candidateIds.has(trial.candidateId) || !parameterHashes.has(trial.parameterHash)) {
      throw new Error("trial registry contains a candidate outside the immutable experiment plan");
    }
    if (trial.selectionEligible && !SEARCH_SELECTION_STAGES.has(trial.stage)) {
      throw new Error(`${trial.stage} evidence cannot tune coarse/narrow search`);
    }
  }
}

function trialMetrics(trial) {
  const metrics = trial?.metrics ?? {};
  const required = [
    "costAdjustedNetExpectancy",
    "profitFactor",
    "maxDrawdownPct",
    "tailLossPct",
    "tradeCount",
  ];
  const missing = required.filter((name) => !Number.isFinite(Number(metrics[name])));
  if (missing.length) return Object.freeze({ valid: false, missing: Object.freeze(missing) });
  const tradeCount = Number(metrics.tradeCount);
  if (!Number.isInteger(tradeCount) || tradeCount < 0) {
    return Object.freeze({ valid: false, missing: Object.freeze(["tradeCount:non_integer_or_negative"]) });
  }
  return Object.freeze({
    valid: true,
    costAdjustedNetExpectancy: Number(metrics.costAdjustedNetExpectancy),
    profitFactor: Number(metrics.profitFactor),
    maxDrawdownPct: Number(metrics.maxDrawdownPct),
    tailLossPct: Number(metrics.tailLossPct),
    tradeCount,
  });
}

function aggregateCandidate(candidate, registry, policy) {
  const rows = registry.trials.filter((trial) => trial.candidateId === candidate.candidateId && trial.selectionEligible);
  const stageCounts = Object.fromEntries([...SEARCH_SELECTION_STAGES].map((stage) => [stage, rows.filter((trial) => trial.stage === stage).length]));
  const blockers = [];
  for (const stage of SEARCH_SELECTION_STAGES) {
    if (stageCounts[stage] < policy.minSlicesPerStage) blockers.push(`INSUFFICIENT_${stage.toUpperCase()}_SLICES`);
  }
  const parsed = rows.map((trial) => Object.freeze({ trial, metrics: trialMetrics(trial) }));
  if (parsed.some((row) => !row.metrics.valid)) blockers.push("MISSING_REQUIRED_METRICS");
  const valid = parsed.filter((row) => row.metrics.valid).map((row) => row.metrics);
  const totalTrades = valid.reduce((sum, metrics) => sum + metrics.tradeCount, 0);
  if (totalTrades < policy.minTotalTrades) blockers.push("INSUFFICIENT_TRADES");

  const worstCostAdjustedNetExpectancy = valid.length ? Math.min(...valid.map((metrics) => metrics.costAdjustedNetExpectancy)) : null;
  const worstProfitFactor = valid.length ? Math.min(...valid.map((metrics) => metrics.profitFactor)) : null;
  const worstDrawdownPct = valid.length ? Math.max(...valid.map((metrics) => metrics.maxDrawdownPct)) : null;
  const worstTailLossPct = valid.length ? Math.max(...valid.map((metrics) => metrics.tailLossPct)) : null;

  if (worstCostAdjustedNetExpectancy != null && worstCostAdjustedNetExpectancy < policy.minCostAdjustedNetExpectancy) blockers.push("COST_ADJUSTED_EXPECTANCY_BELOW_POLICY");
  if (worstProfitFactor != null && worstProfitFactor < policy.minProfitFactor) blockers.push("PROFIT_FACTOR_BELOW_POLICY");
  if (worstDrawdownPct != null && worstDrawdownPct > policy.maxDrawdownPct) blockers.push("DRAWDOWN_ABOVE_POLICY");
  if (worstTailLossPct != null && worstTailLossPct > policy.maxTailLossPct) blockers.push("TAIL_LOSS_ABOVE_POLICY");

  return Object.freeze({
    candidate,
    eligible: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    stageCounts: Object.freeze(stageCounts),
    totalTrades,
    worstCostAdjustedNetExpectancy,
    worstProfitFactor,
    worstDrawdownPct,
    worstTailLossPct,
  });
}

function compareAggregates(left, right) {
  if (left.worstCostAdjustedNetExpectancy !== right.worstCostAdjustedNetExpectancy) {
    return right.worstCostAdjustedNetExpectancy - left.worstCostAdjustedNetExpectancy;
  }
  if (left.worstProfitFactor !== right.worstProfitFactor) return right.worstProfitFactor - left.worstProfitFactor;
  if (left.worstDrawdownPct !== right.worstDrawdownPct) return left.worstDrawdownPct - right.worstDrawdownPct;
  if (left.worstTailLossPct !== right.worstTailLossPct) return left.worstTailLossPct - right.worstTailLossPct;
  return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
}

function fineParameterPayload(experimentPlan, params) {
  return Object.freeze({
    qualityTier: experimentPlan.qualityTier,
    catalystDay: experimentPlan.catalystDay,
    session: experimentPlan.session,
    takeProfitPct: params.takeProfitPct,
    fixedStopPct: params.fixedStopPct,
    timeStopMinutes: params.timeStopMinutes,
    exitMode: params.exitMode,
  });
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function buildFineCandidates(experimentPlan, narrowRows, policy) {
  if (!narrowRows.length) return Object.freeze([]);
  const allTakeProfits = experimentPlan.candidates.map((candidate) => Number(candidate.params.takeProfitPct));
  const allStops = experimentPlan.candidates.map((candidate) => Number(candidate.params.fixedStopPct));
  const minTp = Math.min(...allTakeProfits);
  const maxTp = Math.max(...allTakeProfits);
  const minStop = Math.min(...allStops);
  const maxStop = Math.max(...allStops);
  const seen = new Set(experimentPlan.candidates.map((candidate) => candidate.parameterHash));
  const fine = [];
  for (const row of narrowRows) {
    const seed = row.candidate;
    for (let tpRadius = -policy.fineRadiusSteps; tpRadius <= policy.fineRadiusSteps; tpRadius += 1) {
      for (let stopRadius = -policy.fineRadiusSteps; stopRadius <= policy.fineRadiusSteps; stopRadius += 1) {
        if (tpRadius === 0 && stopRadius === 0) continue;
        const params = Object.freeze({
          takeProfitPct: round(seed.params.takeProfitPct + tpRadius * policy.fineTakeProfitStepPct),
          fixedStopPct: round(seed.params.fixedStopPct + stopRadius * policy.fineStopStepPct),
          timeStopMinutes: seed.params.timeStopMinutes,
          exitMode: seed.params.exitMode,
        });
        if (params.takeProfitPct < minTp || params.takeProfitPct > maxTp || params.fixedStopPct < minStop || params.fixedStopPct > maxStop) continue;
        const payload = fineParameterPayload(experimentPlan, params);
        const parameterHash = researchDigest(payload);
        if (seen.has(parameterHash)) continue;
        seen.add(parameterHash);
        fine.push(Object.freeze({
          candidateId: `quality-daytrade-fine:${experimentPlan.qualityTier}:${experimentPlan.session}:${experimentPlan.catalystDay ? "catalyst" : "normal"}:${parameterHash.slice(0, 16)}`,
          parameterHash,
          seedCandidateId: seed.candidateId,
          params,
        }));
        if (fine.length >= policy.maxFineCandidates) return Object.freeze(fine);
      }
    }
  }
  return Object.freeze(fine);
}

export function buildQualityDaytradeCoarseNarrowFinePlan({ experimentPlan, registry, policy } = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  validatePlanAndRegistry(experimentPlan, registry);
  const aggregates = Object.freeze(experimentPlan.candidates.map((candidate) => aggregateCandidate(candidate, registry, normalizedPolicy)));
  const eligible = aggregates.filter((row) => row.eligible).sort(compareAggregates);
  const narrow = Object.freeze(eligible.slice(0, normalizedPolicy.narrowLimit));
  const fineCandidates = buildFineCandidates(experimentPlan, narrow, normalizedPolicy);
  const status = narrow.length ? "READY_FOR_FINE" : "INSUFFICIENT_EVIDENCE";
  const policyDigest = researchDigest(normalizedPolicy);
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_SEARCH_CONTRACT_VERSION,
    status,
    policy: normalizedPolicy,
    policyDigest,
    coarseCandidateCount: experimentPlan.candidates.length,
    evaluatedCandidateCount: aggregates.filter((row) => row.stageCounts.development + row.stageCounts.validation > 0).length,
    eligibleCandidateCount: eligible.length,
    narrowCandidateCount: narrow.length,
    fineCandidateCount: fineCandidates.length,
    narrowCandidates: narrow,
    fineCandidates,
    rejectedCandidates: Object.freeze(aggregates.filter((row) => !row.eligible)),
    selectionEvidenceStages: Object.freeze(["development", "validation"]),
    oosEvidenceCanTuneSearch: false,
    walkForwardEvidenceCanTuneSearch: false,
    finalHoldoutEvidenceCanTuneSearch: false,
    paperEvidenceCanTuneSearch: false,
    shadowEvidenceCanTuneSearch: false,
    duplicateTrialAllowed: false,
    liveTradingAllowed: false,
    privateApiAllowed: false,
    executionAuthority: "NONE",
    planDigest: researchDigest({
      familyFingerprint: registry.strategyIdentity.familyFingerprint,
      registryDigest: registry.registryDigest,
      policyDigest,
      narrow: narrow.map((row) => row.candidate.parameterHash),
      fine: fineCandidates.map((row) => row.parameterHash),
    }),
  });
}
