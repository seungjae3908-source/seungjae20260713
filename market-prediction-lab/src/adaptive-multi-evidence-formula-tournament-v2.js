import { sha256Canonical } from "./research-cache-provenance.js";
import {
  EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT,
} from "./evidence-backed-formula-tournament-adapter-v1.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION } from "./adaptive-multi-evidence-regime-router-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION } from "./adaptive-multi-evidence-independence-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION =
  "adaptive-multi-evidence-formula-tournament-v2";

const SHA40 = /^[0-9a-f]{40}$/iu;
const SHA64 = /^[0-9a-f]{64}$/iu;
const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const SIDES = Object.freeze({
  KR_STOCK: new Set(["BUY"]),
  US_STOCK: new Set(["BUY"]),
  CRYPTO_SPOT: new Set(["BUY"]),
  CRYPTO_FUTURES: new Set(["LONG", "SHORT"]),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    researchOnly: true,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    finalHoldoutPreAccessAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    candidateIdentities: [],
    totalTrialCount: 0,
    multipleTestingRisk: "UNKNOWN",
    blockers: unique(blockers),
    economicSampleCredit: 0,
    decisionAuthority: "NONE",
    ...safety(),
  });
}

function identityCore(raw) {
  const market = text(raw?.market)?.toUpperCase() ?? null;
  const side = text(raw?.side)?.toUpperCase() ?? null;
  const core = {
    formulaCandidateId: text(raw?.formulaCandidateId),
    strategyId: text(raw?.strategyId),
    strategyFamily: text(raw?.strategyFamily),
    strategyVersion: text(raw?.strategyVersion),
    parameterDigest: text(raw?.parameterDigest)?.toLowerCase() ?? null,
    parameterHash: text(raw?.parameterHash)?.toLowerCase() ?? null,
    market,
    timeframe: text(raw?.timeframe),
    side,
    researchCodeSha: text(raw?.researchCodeSha)?.toLowerCase() ?? null,
    costPolicyVersion: text(raw?.costPolicyVersion),
  };
  if (Object.values(core).some((value) => value == null)) throw new Error("V2_FORMULA_CANDIDATE_IDENTITY_INCOMPLETE");
  if (!MARKETS.has(market) || !SIDES[market]?.has(side)) throw new Error("V2_FORMULA_CANDIDATE_MARKET_SIDE_INVALID");
  if (!SHA64.test(core.parameterDigest) || !SHA64.test(core.parameterHash)) {
    throw new Error("V2_FORMULA_CANDIDATE_PARAMETER_IDENTITY_INVALID");
  }
  if (!SHA40.test(core.researchCodeSha)) throw new Error("V2_FORMULA_CANDIDATE_RESEARCH_SHA_INVALID");
  return core;
}

export function createAdaptiveMultiEvidenceFormulaCandidateIdentityV2(raw = {}) {
  const core = identityCore(raw);
  return deepFreeze({
    ...core,
    identityDigest: sha256Canonical(core),
    immutable: true,
    evaluationStatus: "OWNER_TOURNAMENT_RESULT_BOUND",
    profitabilityProven: false,
    executionAuthority: "NONE",
  });
}

function verifyIdentity(identity) {
  try {
    const core = identityCore(identity);
    return identity.identityDigest === sha256Canonical(core)
      && identity.immutable === true
      && identity.profitabilityProven === false
      && identity.executionAuthority === "NONE";
  } catch {
    return false;
  }
}

function validTournamentOwner(result) {
  return result?.contract === EVIDENCE_BACKED_FORMULA_TOURNAMENT_ADAPTER_CONTRACT
    && result.status === "COMPLETED"
    && Array.isArray(result.formulaCandidateIds)
    && result.formulaCandidateIds.length > 0
    && result.formulaCandidateIds.length === new Set(result.formulaCandidateIds).size
    && Number.isSafeInteger(result.globalPlannedCandidateFamilySize)
    && result.globalPlannedCandidateFamilySize > 0
    && result.tournament?.status === "COMPLETED"
    && Array.isArray(result.tournament?.candidates)
    && result.tournament?.profitable === false
    && result.tournament?.champion == null
    && result.safety?.profitabilityClaimAllowed === false
    && result.safety?.championPromotionAllowed === false
    && result.safety?.finalHoldoutPreAccessAllowed === false
    && result.safety?.executionAuthority === "NONE";
}

export function buildAdaptiveMultiEvidenceFormulaTournamentV2({
  regimeRouter,
  independence,
  tournamentResult,
  candidateIdentities,
  maxTrialBudget,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (regimeRouter?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION
      || regimeRouter?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || regimeRouter?.executionAuthority !== "NONE") blockers.push("V2_FORMULA_REGIME_ROUTER_INVALID");
  if (independence?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION
      || independence?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || independence?.status !== "GROUPED_FOR_RESEARCH_ONLY"
      || independence?.executionAuthority !== "NONE") blockers.push("V2_FORMULA_INDEPENDENCE_INPUT_INVALID");
  if (!validTournamentOwner(tournamentResult)) blockers.push("FORMULA_TOURNAMENT_OWNER_RESULT_INVALID");
  if (!Array.isArray(candidateIdentities) || candidateIdentities.some((identity) => !verifyIdentity(identity))) {
    blockers.push("V2_FORMULA_CANDIDATE_IDENTITIES_INVALID");
  }
  if (!Number.isSafeInteger(maxTrialBudget) || maxTrialBudget <= 0 || maxTrialBudget > 4096) {
    blockers.push("V2_FORMULA_TRIAL_BUDGET_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("V2_FORMULA_EXECUTION_AUTHORITY_FORBIDDEN");
  if (blockers.length > 0) return failure(blockers);

  const ownerCandidateIds = [...tournamentResult.formulaCandidateIds].sort();
  const manifestIds = candidateIdentities.map((identity) => identity.formulaCandidateId).sort();
  if (ownerCandidateIds.length !== manifestIds.length
      || ownerCandidateIds.some((id, index) => id !== manifestIds[index])) {
    return failure(["V2_FORMULA_OWNER_IDENTITY_BINDING_MISMATCH"]);
  }
  const totalTrialCount = tournamentResult.tournament.candidates.length;
  if (totalTrialCount > maxTrialBudget
      || tournamentResult.globalPlannedCandidateFamilySize > maxTrialBudget) {
    return failure(["V2_FORMULA_TRIAL_BUDGET_EXCEEDED"]);
  }
  const families = unique(candidateIdentities.map((identity) => identity.strategyFamily));
  const markets = unique(candidateIdentities.map((identity) => identity.market));
  const multipleTesting = {
    generatedFamilySize: tournamentResult.globalPlannedCandidateFamilySize,
    observedTrialCount: totalTrialCount,
    maximumTrialBudget: maxTrialBudget,
    correctionRequired: true,
    riskVisible: true,
    finalHoldoutAccess: false,
  };

  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "READY_FOR_VALIDATION_PIPELINE",
    regime: regimeRouter.regime,
    routedStrategyFamilies: regimeRouter.routing.allowedStrategyFamilies,
    candidateIdentities,
    candidateIdentityDigest: sha256Canonical(candidateIdentities.map((identity) => identity.identityDigest).sort()),
    strategyFamilies: families,
    markets,
    totalTrialCount,
    globalCandidateFamilySize: tournamentResult.globalPlannedCandidateFamilySize,
    multipleTesting,
    multipleTestingRisk: "REQUIRES_STATISTICAL_FIREWALL",
    tournamentOwnerContract: tournamentResult.contract,
    tournamentId: tournamentResult.tournament.tournamentId,
    researchSurvivorCount: tournamentResult.tournament.researchSurvivorCount,
    ownerReportedProfitable: false,
    ownerChampion: null,
    independenceGroupCount: independence.independenceGroupCount,
    independenceGroupsAreNotVotes: true,
    economicSampleCredit: 0,
    profitabilityProven: false,
    promotionEligible: false,
    blockers: [],
    decisionAuthority: "RESEARCH_CANDIDATES_ONLY",
    ...safety(),
  });
}
