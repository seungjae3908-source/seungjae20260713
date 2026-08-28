import {
  assertHypothesisDecisionV1,
  assertStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import {
  compileStrategyHypothesisToFormulaCandidatesV1,
} from "./autonomous-strategy-formula-generator-v1.js";
import {
  buildResearchTournamentReadModelV1,
  rankResearchSurvivorsV1,
  runResearchTournamentV1,
} from "./research-tournament-engine-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_VERSION = 1;
export const EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT = "evidence-backed-formula-tournament-adapter/v1";
export const EVIDENCE_BACKED_FORMULA_SEED_CONTRACT = "evidence-backed-formula-seed-catalog/v1";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function assertExactKeys(value, keys, code) {
  assertPlainObject(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
}

function canonical(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("adapter evidence contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  throw new TypeError("adapter evidence must be JSON-compatible");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function snapshot(value) {
  return deepFreeze(canonical(value));
}

function safetyEnvelope() {
  return Object.freeze({
    researchOnly: true,
    scannerRuntimeMutationAllowed: false,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    finalHoldoutPreAccessAllowed: false,
    executionAuthority: "NONE",
  });
}

function validateProducerContract(catalog, seedResult, profileId) {
  assertPlainObject(catalog, "catalog");
  if (catalog.schemaVersion !== 1 || catalog.contract !== EVIDENCE_BACKED_FORMULA_SEED_CONTRACT) {
    throw new Error("FORMULA_SEED_CATALOG_CONTRACT_INVALID");
  }
  if (!Array.isArray(catalog.profiles) || !Array.isArray(catalog.families)) {
    throw new Error("FORMULA_SEED_CATALOG_SHAPE_INVALID");
  }
  if (catalog.safety?.executionAuthority !== "NONE" || catalog.safety?.profitabilityClaimAllowed !== false) {
    throw new Error("FORMULA_SEED_CATALOG_SAFETY_INVALID");
  }

  assertPlainObject(seedResult, "seedResult");
  const profile = catalog.profiles.find((candidate) => candidate?.profileId === profileId);
  if (!profile) throw new Error(`FORMULA_SEED_PROFILE_NOT_IN_CATALOG:${profileId}`);
  if (seedResult.profile?.profileId !== profileId) throw new Error("FORMULA_SEED_PROFILE_MISMATCH");
  if (seedResult.safety?.executionAuthority !== "NONE" || seedResult.safety?.profitabilityClaimAllowed !== false) {
    throw new Error("FORMULA_SEED_RESULT_SAFETY_INVALID");
  }
  if (!Array.isArray(seedResult.templates) || !Array.isArray(seedResult.blockers)) {
    throw new Error("FORMULA_SEED_RESULT_SHAPE_INVALID");
  }
  if (seedResult.status !== profile.status) throw new Error("FORMULA_SEED_PROFILE_STATUS_MISMATCH");

  if (profile.status !== "READY") {
    if (seedResult.templates.length !== 0) throw new Error("BLOCKED_FORMULA_SEED_MUST_HAVE_ZERO_TEMPLATES");
    return profile;
  }

  const expectedFamilies = new Set(profile.formulaFamilies ?? []);
  if (expectedFamilies.size === 0 || seedResult.templates.length !== expectedFamilies.size) {
    throw new Error("FORMULA_SEED_FAMILY_COVERAGE_INVALID");
  }
  const seenFamilies = new Set();
  for (const template of seedResult.templates) {
    if (!expectedFamilies.has(template?.strategyFamily)) throw new Error("FORMULA_SEED_UNKNOWN_FAMILY");
    if (seenFamilies.has(template.strategyFamily)) throw new Error("FORMULA_SEED_DUPLICATE_FAMILY");
    seenFamilies.add(template.strategyFamily);
    if (template.market !== profile.market || template.timeframe !== profile.timeframe) {
      throw new Error("FORMULA_SEED_TEMPLATE_PROFILE_MISMATCH");
    }
    if (!(profile.directions ?? []).includes(template.direction)) throw new Error("FORMULA_SEED_DIRECTION_MISMATCH");
  }
  return profile;
}

function hypothesisBinding(hypothesis, decision) {
  return Object.freeze({
    hypothesisId: hypothesis.hypothesisId,
    hypothesisConfigHash: hypothesis.configHash,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
  });
}

function validateTemplateBindings(seedResult, binding) {
  for (const template of seedResult.templates) {
    const candidate = template?.hypothesisBinding;
    if (!candidate
      || candidate.hypothesisId !== binding.hypothesisId
      || candidate.hypothesisConfigHash !== binding.hypothesisConfigHash
      || candidate.decisionId !== binding.decisionId
      || candidate.decisionHash !== binding.decisionHash) {
      throw new Error("FORMULA_SEED_HYPOTHESIS_BINDING_MISMATCH");
    }
  }
}

function validateAdapterSearch(raw) {
  assertExactKeys(raw, ["method", "seed", "datasetIdentity", "finalHoldoutAccess"], "ADAPTER_SEARCH_SHAPE_INVALID");
  const method = requiredText(raw.method, "search.method").toUpperCase();
  if (!["BOUNDED_GRID", "SEEDED_RANDOM", "DETERMINISTIC_SAMPLING"].includes(method)) {
    throw new Error("ADAPTER_SEARCH_METHOD_INVALID");
  }
  if (!Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff) throw new Error("ADAPTER_SEARCH_SEED_INVALID");
  if (raw.finalHoldoutAccess !== false) throw new Error("FINAL_HOLDOUT_PREACCESS_FORBIDDEN");
  return Object.freeze({ method, seed: raw.seed, datasetIdentity: requiredText(raw.datasetIdentity, "search.datasetIdentity"), finalHoldoutAccess: false });
}

function validateTournamentConfig(raw) {
  assertExactKeys(raw, ["generationBudget", "search", "budget", "policy", "resourceSnapshot", "observedAt"], "ADAPTER_TOURNAMENT_CONFIG_SHAPE_INVALID");
  assertPlainObject(raw.generationBudget, "tournament.generationBudget");
  assertPlainObject(raw.budget, "tournament.budget");
  assertPlainObject(raw.policy, "tournament.policy");
  if (raw.resourceSnapshot != null) assertPlainObject(raw.resourceSnapshot, "tournament.resourceSnapshot");
  return Object.freeze({
    generationBudget: snapshot(raw.generationBudget),
    search: validateAdapterSearch(raw.search),
    budget: snapshot(raw.budget),
    policy: snapshot(raw.policy),
    resourceSnapshot: raw.resourceSnapshot == null ? null : snapshot(raw.resourceSnapshot),
    observedAt: requiredText(raw.observedAt, "tournament.observedAt"),
  });
}

function partitionInteger(value, divisor, floorMinimum = 1) {
  if (!Number.isSafeInteger(value) || value <= 0) return value;
  return Math.max(floorMinimum, Math.floor(value / divisor));
}

function perFormulaGenerationBudget(globalBudget, formulaCount, candidatesPerFormula) {
  return Object.freeze({
    ...globalBudget,
    maxCandidatesPerHypothesis: Math.min(globalBudget.maxCandidatesPerHypothesis, candidatesPerFormula),
    maxCandidatesPerRun: candidatesPerFormula,
    maxParameterCombinations: partitionInteger(globalBudget.maxParameterCombinations, formulaCount, candidatesPerFormula),
    maxRuntimeMs: partitionInteger(globalBudget.maxRuntimeMs, formulaCount),
    maxCpuMs: partitionInteger(globalBudget.maxCpuMs, formulaCount),
  });
}

function perFormulaTournamentBudget(globalBudget, formulaCount, candidatesPerFormula) {
  return Object.freeze({
    ...globalBudget,
    maxCandidatesPerRun: candidatesPerFormula,
    maxConcurrentBacktests: 1,
    maxTotalCandles: partitionInteger(globalBudget.maxTotalCandles, formulaCount),
    maxRuntimeMs: partitionInteger(globalBudget.maxRuntimeMs, formulaCount),
  });
}

function validateGlobalBudget(config, formulaCount, candidatesPerFormula) {
  const planned = formulaCount * candidatesPerFormula;
  if (!Number.isSafeInteger(planned) || planned <= 0) throw new Error("ADAPTER_PLANNED_CANDIDATE_COUNT_INVALID");
  if (!Number.isSafeInteger(config.generationBudget.maxCandidatesPerRun)
    || planned > config.generationBudget.maxCandidatesPerRun) {
    throw new Error("ADAPTER_GLOBAL_GENERATION_BUDGET_EXCEEDED");
  }
  if (!Number.isSafeInteger(config.budget.maxCandidatesPerRun) || planned > config.budget.maxCandidatesPerRun) {
    throw new Error("ADAPTER_GLOBAL_TOURNAMENT_BUDGET_EXCEEDED");
  }
  return planned;
}

function wrapDependenciesForGlobalStatisticalFamily(dependencies, globalFamilySize, baseAlpha) {
  if (!dependencies || typeof dependencies !== "object") return dependencies;
  if (typeof dependencies.runStatisticalFirewall !== "function") return dependencies;
  const strictAlpha = baseAlpha / Math.max(1, globalFamilySize);
  return Object.freeze({
    ...dependencies,
    runStatisticalFirewall: (payload) => dependencies.runStatisticalFirewall({
      ...payload,
      candidateFamilySize: Math.max(globalFamilySize, payload.candidateFamilySize ?? 0),
      requiredAdjustedAlpha: Math.min(strictAlpha, payload.requiredAdjustedAlpha ?? strictAlpha),
    }),
  });
}

function combinedTournamentResult(profile, formulaCandidates, runs) {
  const candidates = Object.freeze(runs.flatMap((run) => run.result.candidates));
  const ranking = rankResearchSurvivorsV1(candidates);
  const survivorCount = candidates.filter((candidate) => candidate.researchSurvivor === true && candidate.failure === null).length;
  const core = Object.freeze({
    schemaVersion: 1,
    tournamentId: `evidence-seed-tournament:sha256:${researchDigest({
      profileId: profile.profileId,
      formulaCandidateIds: formulaCandidates.map((candidate) => candidate.candidateId),
      childTournamentIds: runs.map((run) => run.result.tournamentId),
    })}`,
    status: "COMPLETED",
    candidates,
    ranking,
    researchSurvivorCount: survivorCount,
    profitable: false,
    champion: null,
    safety: safetyEnvelope(),
  });
  return Object.freeze({ ...core, readModel: buildResearchTournamentReadModelV1(core) });
}

export async function runEvidenceBackedFormulaTournamentAdapterV1(input = {}, dependencies = {}) {
  assertExactKeys(input, [
    "catalog",
    "seedResult",
    "hypothesis",
    "decision",
    "compilerPolicy",
    "candidatesPerFormula",
    "tournament",
  ], "FORMULA_TOURNAMENT_ADAPTER_INPUT_SHAPE_INVALID");

  assertStrategyHypothesisV1(input.hypothesis);
  assertHypothesisDecisionV1(input.decision);
  if (input.decision.hypothesisId !== input.hypothesis.hypothesisId
    || input.decision.hypothesisConfigHash !== input.hypothesis.configHash) {
    throw new Error("FORMULA_TOURNAMENT_HYPOTHESIS_DECISION_MISMATCH");
  }

  const profileId = requiredText(input.seedResult?.profile?.profileId, "seedResult.profile.profileId").toUpperCase();
  const profile = validateProducerContract(input.catalog, input.seedResult, profileId);
  const binding = hypothesisBinding(input.hypothesis, input.decision);

  if (profile.status !== "READY") {
    return deepFreeze({
      schemaVersion: EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_VERSION,
      contract: EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT,
      status: profile.status,
      profile,
      seedTemplateCount: 0,
      formulaCandidateCount: 0,
      formulaCandidateIds: [],
      globalPlannedCandidateFamilySize: 0,
      runs: [],
      tournament: null,
      blockers: [...input.seedResult.blockers],
      safety: safetyEnvelope(),
    });
  }

  validateTemplateBindings(input.seedResult, binding);
  const candidatesPerFormula = positiveInteger(input.candidatesPerFormula, "candidatesPerFormula", 32);
  const config = validateTournamentConfig(input.tournament);
  assertPlainObject(input.compilerPolicy, "compilerPolicy");
  if (input.compilerPolicy.datasetIdentity !== config.search.datasetIdentity) {
    throw new Error("FORMULA_TOURNAMENT_DATASET_IDENTITY_MISMATCH");
  }

  const formulaCandidates = compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis: input.hypothesis,
    decision: input.decision,
    templates: input.seedResult.templates,
    policy: input.compilerPolicy,
  });
  if (formulaCandidates.length !== input.seedResult.templates.length) {
    throw new Error("FORMULA_TOURNAMENT_COMPILER_COVERAGE_MISMATCH");
  }
  for (const formula of formulaCandidates) {
    if (formula.evaluationStatus !== "NOT_EVALUATED" || formula.formulaPassed !== false || formula.safety?.executionAuthority !== "NONE") {
      throw new Error("FORMULA_TOURNAMENT_PREMATURE_EVALUATION_FORBIDDEN");
    }
  }

  const globalFamilySize = validateGlobalBudget(config, formulaCandidates.length, candidatesPerFormula);
  const globalBaseAlpha = Number(config.policy.multipleTestingBaseAlpha ?? 0.05);
  if (!Number.isFinite(globalBaseAlpha) || globalBaseAlpha < 0 || globalBaseAlpha > 1) {
    throw new Error("FORMULA_TOURNAMENT_MULTIPLE_TESTING_ALPHA_INVALID");
  }
  const wrappedDependencies = wrapDependenciesForGlobalStatisticalFamily(dependencies, globalFamilySize, globalBaseAlpha);
  const generationBudget = perFormulaGenerationBudget(config.generationBudget, formulaCandidates.length, candidatesPerFormula);
  const tournamentBudget = perFormulaTournamentBudget(config.budget, formulaCandidates.length, candidatesPerFormula);
  const runs = [];

  for (let index = 0; index < formulaCandidates.length; index += 1) {
    const formulaCandidate = formulaCandidates[index];
    const result = await runResearchTournamentV1({
      formulaCandidates: [formulaCandidate],
      generationBudget,
      search: {
        method: config.search.method,
        seed: (config.search.seed + index) >>> 0,
        requestedCandidates: candidatesPerFormula,
        datasetIdentity: config.search.datasetIdentity,
        finalHoldoutAccess: false,
      },
      budget: tournamentBudget,
      policy: config.policy,
      resourceSnapshot: config.resourceSnapshot,
      observedAt: config.observedAt,
    }, wrappedDependencies);
    runs.push(Object.freeze({
      formulaCandidateId: formulaCandidate.candidateId,
      strategyFamily: formulaCandidate.strategyFamily,
      result,
    }));
  }

  const tournament = combinedTournamentResult(profile, formulaCandidates, runs);
  return deepFreeze({
    schemaVersion: EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_VERSION,
    contract: EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT,
    status: "COMPLETED",
    profile,
    seedTemplateCount: input.seedResult.templates.length,
    formulaCandidateCount: formulaCandidates.length,
    formulaCandidateIds: formulaCandidates.map((candidate) => candidate.candidateId),
    globalPlannedCandidateFamilySize: globalFamilySize,
    runs,
    tournament,
    blockers: [],
    safety: safetyEnvelope(),
  });
}
