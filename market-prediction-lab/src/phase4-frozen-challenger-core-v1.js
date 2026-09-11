import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
  phase3DigestV1,
} from "./phase3-strategy-tournament-core-v1.js";

export const PHASE4_FROZEN_CHALLENGER_SCHEMA_VERSION = 1;
export const PHASE4_FREEZE_VERSION = "phase4-frozen-challenger-v1";
export const PHASE4_SELECTION_POLICY_SCHEMA = "phase4-finalist-selection-policy-v1";

export const PHASE4_REASON_CODES = Object.freeze([
  "FINALIST_MISSING",
  "FINALIST_IDENTITY_INVALID",
  "FINALIST_SELECTION_POLICY_MISSING",
  "FINALIST_NOT_ADMISSIBLE",
  "FREEZE_POLICY_MISSING",
  "FREEZE_IDENTITY_MISMATCH",
  "PARAMETER_DIGEST_MISMATCH",
  "TOURNAMENT_LINEAGE_MISSING",
  "STATISTICAL_POLICY_MISSING",
  "PROSPECTIVE_BOUNDARY_MISSING",
  "RETROACTIVE_CREDIT_REJECTED",
  "HANDOFF_IDENTITY_MISMATCH",
  "VALIDATION_LEAKAGE_REJECTED",
  "OOS_LEAKAGE_REJECTED",
  "EXECUTION_LEDGER_CONTAMINATION",
  "FULL_COST_NOT_READY",
]);

const REQUIRED_FINALIST_FIELDS = Object.freeze([
  "candidateId", "strategyFamilyId", "strategyVersion", "parameterDigest", "parameters",
  "datasetIdentity", "datasetDigest", "searchPolicyDigest", "rankingPolicyDigest",
  "statisticalPolicyDigest", "tournamentRunId", "rank", "selectionReason",
]);
const ECONOMIC_IDENTITY_FIELDS = Object.freeze([
  "candidateId", "strategyFamily", "strategyVersion", "canonicalParameters", "parameterDigest",
  "marketType", "market", "provider", "symbol", "timeframe", "sidePolicy", "accountMode",
  "tournamentRunId", "rankingPolicyDigest", "statisticalPolicyDigest", "sourceFinalistDigest",
]);
const SIDE_VALUES = new Set(["BUY", "SELL", "LONG", "SHORT"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonical(value, path = "value") {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item, index) => canonical(item, `${path}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must contain JSON-compatible values only`);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

function snapshot(value, path = "value") {
  return deepFreeze(canonical(value, path));
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function phase3CandidateId(value) {
  return typeof value === "string" && /^phase3-candidate:sha256:[0-9a-f]{64}$/u.test(value);
}

function failResult(reason, extra = {}) {
  return deepFreeze({
    schemaVersion: PHASE4_FROZEN_CHALLENGER_SCHEMA_VERSION,
    status: "BLOCKED",
    FIRST_ZERO: reason,
    reason,
    ...extra,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    CHAMPION: "NONE",
    executionRealismCredit: 0,
    profitabilityCredit: 0,
  });
}

function truthLocks() {
  return Object.freeze({
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    CHAMPION: "NONE",
    executionRealismCredit: 0,
    profitabilityCredit: 0,
  });
}

function hasOutcomeLeakage(input) {
  if (!isPlainObject(input)) return null;
  if (input.validationEvidence !== undefined || input.validationResult !== undefined) return "VALIDATION_LEAKAGE_REJECTED";
  if (input.oosEvidence !== undefined || input.oosResult !== undefined || input.finalHoldoutEvidence !== undefined) return "OOS_LEAKAGE_REJECTED";
  if (input.paperEvidence !== undefined || input.paperResult !== undefined
    || input.settlementEvidence !== undefined || input.settlementResult !== undefined
    || input.futurePnl !== undefined || input.futureFills !== undefined
    || input.championStatus !== undefined) return "VALIDATION_LEAKAGE_REJECTED";
  return null;
}

function finalistShapeValid(finalist) {
  if (!isPlainObject(finalist)) return false;
  for (const field of REQUIRED_FINALIST_FIELDS) {
    if (finalist[field] === undefined || finalist[field] === null || finalist[field] === "") return false;
  }
  return phase3CandidateId(finalist.candidateId)
    && text(finalist.strategyFamilyId)
    && text(finalist.strategyVersion)
    && digest64(finalist.parameterDigest)
    && isPlainObject(finalist.parameters)
    && text(finalist.datasetIdentity)
    && text(finalist.datasetDigest)
    && digest64(finalist.searchPolicyDigest)
    && digest64(finalist.rankingPolicyDigest)
    && digest64(finalist.statisticalPolicyDigest)
    && text(finalist.tournamentRunId)
    && Number.isSafeInteger(finalist.rank)
    && finalist.rank > 0
    && text(finalist.selectionReason)
    && finalist.evidenceRole === "ALPHA_CANDIDATE_ONLY"
    && finalist.PROFITABILITY_PROVEN === false
    && finalist.NET_ALPHA_PROVEN === false
    && finalist.CHAMPION === "NONE"
    && finalist.parameterMutationAllowed === false;
}

function candidateMatchesFinalist(candidate, finalist) {
  return candidate.candidateId === finalist.candidateId
    && candidate.strategyFamilyId === finalist.strategyFamilyId
    && candidate.strategyVersion === finalist.strategyVersion
    && candidate.parameterDigest === finalist.parameterDigest
    && JSON.stringify(canonical(candidate.parameters)) === JSON.stringify(canonical(finalist.parameters))
    && candidate.datasetIdentity === finalist.datasetIdentity
    && candidate.datasetDigest === finalist.datasetDigest;
}

export function admitPhase3FinalistV1({ tournamentResult, tournamentInput, candidateId } = {}) {
  if (!isPlainObject(tournamentResult) || tournamentResult.status !== "COMPLETE" || !Array.isArray(tournamentResult.finalists)) {
    return failResult("FINALIST_MISSING", { admission: null });
  }
  if (!text(tournamentResult.tournamentRunId)) {
    return failResult("TOURNAMENT_LINEAGE_MISSING", { admission: null });
  }
  if (!isPlainObject(tournamentInput) || !Array.isArray(tournamentInput.families) || !Array.isArray(tournamentInput.universe)) {
    return failResult("FINALIST_IDENTITY_INVALID", { admission: null });
  }
  const finalists = tournamentResult.finalists.filter((item) => item?.candidateId === candidateId);
  if (finalists.length !== 1) return failResult("FINALIST_NOT_ADMISSIBLE", { admission: null });
  const finalist = finalists[0];
  if (!finalistShapeValid(finalist)) return failResult("FINALIST_IDENTITY_INVALID", { admission: null });
  if (finalist.tournamentRunId !== tournamentResult.tournamentRunId) {
    return failResult("TOURNAMENT_LINEAGE_MISSING", { admission: null });
  }
  if (!digest64(finalist.statisticalPolicyDigest)) return failResult("STATISTICAL_POLICY_MISSING", { admission: null });

  let registry;
  try {
    registry = buildPhase3StrategyFamilyRegistryV1(tournamentInput.families);
  } catch {
    return failResult("FINALIST_IDENTITY_INVALID", { admission: null });
  }
  const families = registry.families.filter((family) => family.strategyFamilyId === finalist.strategyFamilyId
    && family.strategyVersion === finalist.strategyVersion);
  if (families.length !== 1) return failResult("FINALIST_IDENTITY_INVALID", { admission: null });
  const family = families[0];

  const identities = [];
  for (const universeEntry of tournamentInput.universe) {
    if (universeEntry?.datasetIdentity !== finalist.datasetIdentity || universeEntry?.datasetDigest !== finalist.datasetDigest) continue;
    try {
      const candidate = createPhase3CandidateIdentityV1({ family, universeEntry, parameters: finalist.parameters });
      if (candidateMatchesFinalist(candidate, finalist)) identities.push(candidate);
    } catch {
      // A non-matching universe row is not evidence for this finalist.
    }
  }
  if (identities.length !== 1) return failResult("FINALIST_IDENTITY_INVALID", { admission: null });

  const identity = identities[0];
  if (!SIDE_VALUES.has(identity.side)) return failResult("FINALIST_IDENTITY_INVALID", { admission: null });
  const sourceFinalistDigest = phase3DigestV1(finalist);
  const admission = snapshot({
    schemaVersion: 1,
    status: "ADMITTED",
    candidateId: identity.candidateId,
    strategyFamily: identity.strategyFamilyId,
    strategyVersion: identity.strategyVersion,
    canonicalParameters: identity.parameters,
    parameterDigest: identity.parameterDigest,
    marketType: identity.marketType,
    market: identity.market,
    provider: null,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    sidePolicy: identity.side,
    datasetIdentity: identity.datasetIdentity,
    datasetDigest: identity.datasetDigest,
    sourceFrameIdentity: identity.sourceFrameIdentity,
    eventWindow: identity.eventWindow,
    searchPolicyDigest: finalist.searchPolicyDigest,
    rankingPolicyDigest: finalist.rankingPolicyDigest,
    statisticalPolicyDigest: finalist.statisticalPolicyDigest,
    tournamentRunId: finalist.tournamentRunId,
    rank: finalist.rank,
    selectionReason: finalist.selectionReason,
    sourceFinalistDigest,
    evidenceRole: "ALPHA_CANDIDATE_ONLY",
  }, "admission");
  return deepFreeze({ status: "ACCEPTED", FIRST_ZERO: null, reason: null, admission, ...truthLocks() });
}

function selectionPolicyValid(policy, admission) {
  if (!isPlainObject(policy)) return false;
  return policy.schemaVersion === PHASE4_SELECTION_POLICY_SCHEMA
    && text(policy.policyVersion)
    && policy.selectionRule === "PRECOMMITTED_EXPLICIT_FINALIST_ID"
    && policy.selectionAuthority === "HUMAN_FROZEN_POLICY"
    && policy.tournamentRunId === admission.tournamentRunId
    && policy.selectedCandidateId === admission.candidateId
    && policy.validationOutcomeConsulted === false
    && policy.oosOutcomeConsulted === false
    && policy.paperOutcomeConsulted === false
    && policy.settlementOutcomeConsulted === false
    && policy.futurePnlConsulted === false
    && policy.futureFillConsulted === false
    && policy.championStatusConsulted === false
    && policy.postOutcomeManualSelection === false
    && policy.postFreezeMutationAllowed === false;
}

export function bindPhase4FinalistSelectionPolicyV1({ admission, selectionPolicy } = {}) {
  if (!admission || admission.status !== "ADMITTED") return failResult("FINALIST_NOT_ADMISSIBLE", { selection: null });
  if (selectionPolicy === undefined || selectionPolicy === null) {
    return failResult("FINALIST_SELECTION_POLICY_MISSING", { selection: null });
  }
  if (!selectionPolicyValid(selectionPolicy, admission)) {
    return failResult("FREEZE_POLICY_MISSING", { selection: null });
  }
  const selectionPolicySnapshot = snapshot(selectionPolicy, "selectionPolicy");
  const selection = snapshot({
    status: "SELECTED",
    candidateId: admission.candidateId,
    tournamentRunId: admission.tournamentRunId,
    selectionPolicy: selectionPolicySnapshot,
    selectionPolicyDigest: phase3DigestV1(selectionPolicySnapshot),
  }, "selection");
  return deepFreeze({ status: "BOUND", FIRST_ZERO: null, reason: null, selection, ...truthLocks() });
}

function freezePayload({ admission, selection }) {
  return snapshot({
    freezeVersion: PHASE4_FREEZE_VERSION,
    candidateId: admission.candidateId,
    strategyFamily: admission.strategyFamily,
    strategyVersion: admission.strategyVersion,
    canonicalParameters: admission.canonicalParameters,
    parameterDigest: admission.parameterDigest,
    marketType: admission.marketType,
    market: admission.market,
    provider: admission.provider,
    symbol: admission.symbol,
    timeframe: admission.timeframe,
    sidePolicy: admission.sidePolicy,
    accountMode: "PAPER",
    tournamentRunId: admission.tournamentRunId,
    rankingPolicyDigest: admission.rankingPolicyDigest,
    statisticalPolicyDigest: admission.statisticalPolicyDigest,
    sourceFinalistDigest: admission.sourceFinalistDigest,
    selectionPolicyDigest: selection.selectionPolicyDigest,
  }, "freezePayload");
}

export function freezePhase4ChallengerV1({ admission, selection, freezeTimestamp } = {}) {
  if (!admission || admission.status !== "ADMITTED") return failResult("FINALIST_NOT_ADMISSIBLE", { challenger: null });
  if (!selection || selection.status !== "SELECTED" || selection.candidateId !== admission.candidateId) {
    return failResult("FREEZE_POLICY_MISSING", { challenger: null });
  }
  const parsed = Date.parse(String(freezeTimestamp ?? ""));
  if (!Number.isSafeInteger(parsed) || parsed < 0) return failResult("PROSPECTIVE_BOUNDARY_MISSING", { challenger: null });
  const payload = freezePayload({ admission, selection });
  const freezeDigest = phase3DigestV1(payload);
  const challenger = snapshot({
    schemaVersion: PHASE4_FROZEN_CHALLENGER_SCHEMA_VERSION,
    state: "FROZEN_CHALLENGER",
    challengerId: `phase4-challenger:sha256:${freezeDigest}`,
    candidateId: admission.candidateId,
    freezeId: `phase4-freeze:sha256:${freezeDigest}`,
    freezeVersion: PHASE4_FREEZE_VERSION,
    freezeTimestamp: new Date(parsed).toISOString(),
    freezeTimestampMs: parsed,
    prospectiveBoundary: new Date(parsed).toISOString(),
    prospectiveBoundaryMs: parsed,
    strategyFamily: admission.strategyFamily,
    strategyVersion: admission.strategyVersion,
    canonicalParameters: admission.canonicalParameters,
    parameterDigest: admission.parameterDigest,
    marketType: admission.marketType,
    market: admission.market,
    provider: admission.provider,
    symbol: admission.symbol,
    timeframe: admission.timeframe,
    sidePolicy: admission.sidePolicy,
    accountMode: "PAPER",
    tournamentRunId: admission.tournamentRunId,
    rankingPolicyDigest: admission.rankingPolicyDigest,
    statisticalPolicyDigest: admission.statisticalPolicyDigest,
    sourceFinalistDigest: admission.sourceFinalistDigest,
    selectionPolicyDigest: selection.selectionPolicyDigest,
    freezeDigest,
    prospectiveOnly: true,
    retroactiveCreditAllowed: false,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    CHAMPION: "NONE",
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
  }, "challenger");
  return deepFreeze({ status: "FROZEN", FIRST_ZERO: null, reason: null, challenger, ...truthLocks() });
}

function challengerEconomicIdentity(challenger) {
  return snapshot(Object.fromEntries(ECONOMIC_IDENTITY_FIELDS.map((field) => [field, challenger[field]])), "challengerEconomicIdentity");
}

export function verifyPhase4FrozenChallengerV1(challenger) {
  if (!isPlainObject(challenger)
    || challenger.state !== "FROZEN_CHALLENGER"
    || challenger.freezeVersion !== PHASE4_FREEZE_VERSION
    || challenger.accountMode !== "PAPER"
    || challenger.prospectiveOnly !== true
    || challenger.retroactiveCreditAllowed !== false) {
    return failResult("FREEZE_IDENTITY_MISMATCH", { valid: false });
  }
  if (!phase3CandidateId(challenger.candidateId)
    || !digest64(challenger.parameterDigest)
    || !text(challenger.marketType)
    || !text(challenger.market)
    || !text(challenger.symbol)
    || !text(challenger.timeframe)
    || !SIDE_VALUES.has(challenger.sidePolicy)) {
    return failResult("FREEZE_IDENTITY_MISMATCH", { valid: false });
  }
  if (!Number.isSafeInteger(challenger.freezeTimestampMs)
    || challenger.freezeTimestampMs !== challenger.prospectiveBoundaryMs
    || challenger.freezeTimestamp !== challenger.prospectiveBoundary) {
    return failResult("PROSPECTIVE_BOUNDARY_MISSING", { valid: false });
  }
  const payload = snapshot({
    freezeVersion: challenger.freezeVersion,
    ...challengerEconomicIdentity(challenger),
    selectionPolicyDigest: challenger.selectionPolicyDigest,
  }, "freezeVerificationPayload");
  const expectedDigest = phase3DigestV1(payload);
  if (challenger.freezeDigest !== expectedDigest
    || challenger.challengerId !== `phase4-challenger:sha256:${expectedDigest}`
    || challenger.freezeId !== `phase4-freeze:sha256:${expectedDigest}`) {
    return failResult("FREEZE_IDENTITY_MISMATCH", { valid: false });
  }
  if (challenger.executionRealismCredit !== 0 || challenger.profitabilityCredit !== 0) {
    return failResult("EXECUTION_LEDGER_CONTAMINATION", { valid: false });
  }
  if (challenger.FULL_COST_READY !== false) return failResult("FULL_COST_NOT_READY", { valid: false });
  if (challenger.NET_ALPHA_PROVEN !== false || challenger.PROFITABILITY_PROVEN !== false || challenger.CHAMPION !== "NONE") {
    return failResult("FREEZE_IDENTITY_MISMATCH", { valid: false });
  }
  return deepFreeze({ status: "VERIFIED", FIRST_ZERO: null, reason: null, valid: true, freezeDigest: expectedDigest, ...truthLocks() });
}

function stageHandoff(stage, challenger) {
  const identity = challengerEconomicIdentity(challenger);
  return snapshot({
    schemaVersion: 1,
    stage,
    status: "CONTRACT_READY",
    challengerId: challenger.challengerId,
    candidateId: challenger.candidateId,
    freezeDigest: challenger.freezeDigest,
    strategyFamily: challenger.strategyFamily,
    strategyVersion: challenger.strategyVersion,
    parameterDigest: challenger.parameterDigest,
    canonicalParameters: challenger.canonicalParameters,
    marketType: challenger.marketType,
    market: challenger.market,
    provider: challenger.provider,
    symbol: challenger.symbol,
    timeframe: challenger.timeframe,
    sidePolicy: challenger.sidePolicy,
    accountMode: challenger.accountMode,
    prospectiveBoundary: challenger.prospectiveBoundary,
    prospectiveBoundaryMs: challenger.prospectiveBoundaryMs,
    prospectiveOnly: true,
    retroactiveCreditAllowed: false,
    createdFromTournament: true,
    profitabilityProven: false,
    netAlphaProven: false,
    champion: false,
    economicCreditCreated: false,
    activationAllowed: false,
    dispatchAllowed: false,
    executionAuthority: "NONE",
    identityDigest: phase3DigestV1(identity),
  }, `${stage}Handoff`);
}

export function buildPhase4ProspectiveHandoffsV1(challenger) {
  const verification = verifyPhase4FrozenChallengerV1(challenger);
  if (!verification.valid) return failResult(verification.reason, { handoffs: null });
  const handoffs = snapshot({
    prospective: stageHandoff("PROSPECTIVE_SAMPLE_ADMISSION", challenger),
    forward: stageHandoff("FORWARD", challenger),
    shadow: stageHandoff("SHADOW", challenger),
    paper: stageHandoff("PAPER", challenger),
  }, "handoffs");
  return deepFreeze({ status: "READY", FIRST_ZERO: null, reason: null, handoffs, ...truthLocks() });
}

export function verifyPhase4HandoffIdentityV1({ challenger, handoff } = {}) {
  const verification = verifyPhase4FrozenChallengerV1(challenger);
  if (!verification.valid || !isPlainObject(handoff)) return failResult("HANDOFF_IDENTITY_MISMATCH", { valid: false });
  const keys = [
    "challengerId", "candidateId", "freezeDigest", "strategyFamily", "strategyVersion", "parameterDigest",
    "marketType", "market", "provider", "symbol", "timeframe", "sidePolicy", "accountMode",
    "prospectiveBoundary", "prospectiveBoundaryMs",
  ];
  if (keys.some((key) => handoff[key] !== challenger[key])) return failResult("HANDOFF_IDENTITY_MISMATCH", { valid: false });
  if (JSON.stringify(canonical(handoff.canonicalParameters)) !== JSON.stringify(canonical(challenger.canonicalParameters))) {
    return failResult("HANDOFF_IDENTITY_MISMATCH", { valid: false });
  }
  if (handoff.prospectiveOnly !== true || handoff.retroactiveCreditAllowed !== false
    || handoff.createdFromTournament !== true || handoff.economicCreditCreated !== false
    || handoff.activationAllowed !== false || handoff.dispatchAllowed !== false
    || handoff.executionAuthority !== "NONE") {
    return failResult("HANDOFF_IDENTITY_MISMATCH", { valid: false });
  }
  return deepFreeze({ status: "VERIFIED", FIRST_ZERO: null, reason: null, valid: true, ...truthLocks() });
}

export function evaluatePhase4ProspectiveEvidenceV1({ handoff, evidence } = {}) {
  if (!isPlainObject(handoff) || handoff.stage !== "PROSPECTIVE_SAMPLE_ADMISSION") {
    return failResult("HANDOFF_IDENTITY_MISMATCH", { admitted: false, economicCreditCreated: false });
  }
  if (!isPlainObject(evidence) || !Number.isSafeInteger(evidence.observedAtMs)) {
    return failResult("PROSPECTIVE_BOUNDARY_MISSING", { admitted: false, economicCreditCreated: false });
  }
  if (evidence.observedAtMs <= handoff.prospectiveBoundaryMs
    || evidence.replay === true || evidence.backfill === true || evidence.synthetic === true
    || evidence.manual === true || evidence.historical === true || evidence.retroactive === true) {
    return failResult("RETROACTIVE_CREDIT_REJECTED", { admitted: false, economicCreditCreated: false });
  }
  for (const key of ["candidateId", "strategyFamily", "parameterDigest", "market", "symbol", "timeframe", "accountMode"]) {
    if (evidence[key] !== handoff[key]) return failResult("HANDOFF_IDENTITY_MISMATCH", { admitted: false, economicCreditCreated: false });
  }
  if (evidence.side !== handoff.sidePolicy && evidence.sidePolicy !== handoff.sidePolicy) {
    return failResult("HANDOFF_IDENTITY_MISMATCH", { admitted: false, economicCreditCreated: false });
  }
  return deepFreeze({
    status: "PROSPECTIVE_EVIDENCE_CANDIDATE",
    FIRST_ZERO: null,
    reason: null,
    admitted: true,
    economicCreditCreated: false,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    ...truthLocks(),
  });
}

export function assertPhase4OutcomeFirewallV1(input) {
  const reason = hasOutcomeLeakage(input);
  return reason ? failResult(reason, { allowed: false }) : deepFreeze({ status: "PASS", FIRST_ZERO: null, reason: null, allowed: true, ...truthLocks() });
}

export function auditCurrentPhase1PaperNamespaceV1(challenger) {
  const verification = verifyPhase4FrozenChallengerV1(challenger);
  if (!verification.valid) return failResult("HANDOFF_IDENTITY_MISMATCH", { compatible: false });
  const compatible = phase3CandidateId(challenger.candidateId);
  return deepFreeze({
    status: compatible ? "COMPATIBLE" : "BLOCKED",
    FIRST_ZERO: compatible ? null : "HANDOFF_IDENTITY_MISMATCH",
    reason: compatible ? null : "PAPER_CANDIDATE_ID_NAMESPACE_INCOMPATIBLE",
    compatible,
    candidateIdPreserved: true,
    secondIdentityCreated: false,
    ...truthLocks(),
  });
}

export function runPhase4FrozenChallengerCoreV1(input = {}) {
  const firewall = assertPhase4OutcomeFirewallV1(input);
  if (!firewall.allowed) return firewall;
  const admissionResult = admitPhase3FinalistV1({
    tournamentResult: input.tournamentResult,
    tournamentInput: input.tournamentInput,
    candidateId: input.candidateId,
  });
  if (admissionResult.status !== "ACCEPTED") return admissionResult;
  const selectionResult = bindPhase4FinalistSelectionPolicyV1({
    admission: admissionResult.admission,
    selectionPolicy: input.selectionPolicy,
  });
  if (selectionResult.status !== "BOUND") return selectionResult;
  const freezeResult = freezePhase4ChallengerV1({
    admission: admissionResult.admission,
    selection: selectionResult.selection,
    freezeTimestamp: input.freezeTimestamp,
  });
  if (freezeResult.status !== "FROZEN") return freezeResult;
  const handoffResult = buildPhase4ProspectiveHandoffsV1(freezeResult.challenger);
  if (handoffResult.status !== "READY") return handoffResult;
  return deepFreeze({
    schemaVersion: PHASE4_FROZEN_CHALLENGER_SCHEMA_VERSION,
    status: "PROSPECTIVE_ADMISSION_READY",
    FIRST_ZERO: null,
    reason: null,
    admission: admissionResult.admission,
    selection: selectionResult.selection,
    challenger: freezeResult.challenger,
    handoffs: handoffResult.handoffs,
    observability: Object.freeze({
      FINALIST_COUNT: input.tournamentResult.finalists.length,
      FREEZE_ELIGIBLE_COUNT: 1,
      FROZEN_CHALLENGER_COUNT: 1,
      REJECTED_COUNT: 0,
      CHALLENGER_ID: freezeResult.challenger.challengerId,
      CANDIDATE_ID: freezeResult.challenger.candidateId,
      FREEZE_DIGEST: freezeResult.challenger.freezeDigest,
      TOURNAMENT_RUN_ID: freezeResult.challenger.tournamentRunId,
      PROSPECTIVE_BOUNDARY: freezeResult.challenger.prospectiveBoundary,
      FORWARD_HANDOFF_STATUS: "CONTRACT_READY",
      SHADOW_HANDOFF_STATUS: "CONTRACT_READY",
      PAPER_HANDOFF_STATUS: "CONTRACT_READY",
      VALIDATION_STATUS: "NOT_EVALUATED",
      OOS_STATUS: "NOT_EVALUATED",
      FULL_COST_READY: false,
      NET_ALPHA_PROVEN: false,
      PROFITABILITY_PROVEN: false,
      CHAMPION: "NONE",
    }),
    ...truthLocks(),
  });
}
