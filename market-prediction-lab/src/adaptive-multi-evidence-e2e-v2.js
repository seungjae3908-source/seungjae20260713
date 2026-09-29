import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION } from "./adaptive-multi-evidence-market-features-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION } from "./adaptive-multi-evidence-regime-router-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION } from "./adaptive-multi-evidence-event-normalization-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION } from "./adaptive-multi-evidence-research-ingest-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION } from "./adaptive-multi-evidence-independence-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION } from "./adaptive-multi-evidence-formula-tournament-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION } from "./adaptive-multi-evidence-validation-v2.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
  verifyAdaptiveMultiEvidenceStrategyPortfolioV2,
} from "./adaptive-multi-evidence-strategy-portfolio-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_META_DECISION_V2_VERSION } from "./adaptive-multi-evidence-meta-decision-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION } from "./adaptive-multi-evidence-cost-liquidity-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_GLOBAL_RISK_V2_VERSION } from "./adaptive-multi-evidence-global-risk-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION } from "./adaptive-multi-evidence-position-policy-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION } from "./adaptive-multi-evidence-natural-paper-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION } from "./adaptive-multi-evidence-journal-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_STRATEGY_HEALTH_V2_VERSION } from "./adaptive-multi-evidence-strategy-health-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_E2E_V2_VERSION = "adaptive-multi-evidence-e2e-v2";

const STAGES = Object.freeze([
  ["phase3MarketFeatures", ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION,
    ["READY_FOR_SPECIALIST_RESEARCH_ONLY", "PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY"]],
  ["phase4Regime", ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION,
    ["READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY"]],
  ["phase5Events", ADAPTIVE_MULTI_EVIDENCE_EVENT_NORMALIZATION_V2_VERSION,
    ["READY_FOR_DEDUP_RESEARCH_ONLY", "PARTIAL_EVENT_EVIDENCE", "NO_ADMISSIBLE_EVENT_EVIDENCE"]],
  ["phase6Research", ADAPTIVE_MULTI_EVIDENCE_RESEARCH_INGEST_V2_VERSION,
    ["READY_FOR_DEDUP_RESEARCH_ONLY", "PARTIAL_RESEARCH_EVIDENCE", "NO_ADMISSIBLE_RESEARCH_EVIDENCE"]],
  ["phase7Independence", ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION, ["GROUPED_FOR_RESEARCH_ONLY"]],
  ["phase8Tournament", ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION, ["READY_FOR_VALIDATION_PIPELINE"]],
  ["phase9Validation", ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION, ["VALIDATED_FINALISTS_AVAILABLE"]],
  ["phase10Portfolio", ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION, ["FROZEN_V2_STRATEGY_PORTFOLIO"]],
  ["phase11Decision", ADAPTIVE_MULTI_EVIDENCE_META_DECISION_V2_VERSION, ["RESEARCH_DECISION_READY"]],
  ["phase12CostLiquidity", ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION, ["COST_LIQUIDITY_GATE_PASS"]],
  ["phase13GlobalRisk", ADAPTIVE_MULTI_EVIDENCE_GLOBAL_RISK_V2_VERSION, ["GLOBAL_RISK_PASS"]],
  ["phase14Position", ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION, ["POSITION_POLICY_READY"]],
  ["phase15NaturalPaper", ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION, ["NATURAL_PAPER_CANDIDATE_READY_INACTIVE"]],
  ["phase16DecisionJournal", ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION, ["PRE_DECISION_RECORDED"]],
  ["phase16OutcomeJournal", ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION, ["OUTCOME_ATTRIBUTED_RESEARCH_ONLY"]],
  ["phase17Health", ADAPTIVE_MULTI_EVIDENCE_STRATEGY_HEALTH_V2_VERSION, ["STRATEGY_HEALTH_EVALUATED"]],
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safety() {
  return {
    scheduleActive: false,
    naturalPaperRuntimeActivated: false,
    activationRequiresSeparateApproval: true,
    stagingAction: false,
    productionAction: false,
    databaseMutation: false,
    secretMutation: false,
    environmentMutation: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    realOrderCount: 0,
    privateTradingApiCallCount: 0,
    executionAuthority: "NONE",
  };
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_E2E_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "FULL_E2E_BLOCKED",
    blockers: [...new Set(blockers)].sort(),
    phaseAcceptance: null,
    paperRuntime: null,
    frozenV1Contamination: 0,
    economicSampleCredit: 0,
    profitabilityProven: false,
    ...safety(),
  });
}

function safeStage(value) {
  return value?.lineageId === ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
    && value?.executionAuthority === "NONE"
    && value?.liveTrading === false
    && value?.autoTrading === false
    && value?.realOrderEnabled === false
    && value?.privateTradingApiAllowed === false
    && value?.frozenV1Contamination === 0;
}

function settlementIdentity(result, candidateId) {
  const settlement = result?.state?.settlements?.[0];
  return result?.summary?.tradesSettled === 1
    && result.state.positions.length === 0
    && result.state.settlements.length === 1
    && settlement?.candidateId === candidateId
    && settlement?.naturalSampleCredit === 1
    && settlement?.lifecycleEvidence?.naturalSampleCredit === 1
    && settlement?.executionAuthority === "NONE"
    && settlement?.orderSubmitted === false
    && typeof settlement?.grossPnl === "number"
    && typeof settlement?.totalExplicitCost === "number"
    && settlement.netPnl === settlement.grossPnl - settlement.totalExplicitCost;
}

export function buildAdaptiveMultiEvidencePaperRuntimeProofV2({
  candidateId,
  opened,
  restartedState,
  settled,
  duplicate,
} = {}) {
  const blockers = [];
  if (!text(candidateId)) blockers.push("V2_E2E_RUNTIME_CANDIDATE_REQUIRED");
  const openedPosition = opened?.state?.positions?.[0];
  if (opened?.summary?.entries !== 1 || opened?.state?.positions?.length !== 1
      || opened?.state?.samples?.length !== 1
      || openedPosition?.candidateId !== candidateId
      || opened.state.samples[0]?.identity?.candidateId !== candidateId) {
    blockers.push("V2_E2E_ENTRY_FILL_POSITION_NOT_PROVEN");
  }
  if (sha256Canonical(restartedState) !== sha256Canonical(opened?.state)) {
    blockers.push("V2_E2E_RESTART_RESTORE_NOT_EXACT");
  }
  if (!settlementIdentity(settled, candidateId)) blockers.push("V2_E2E_NATURAL_SETTLEMENT_NOT_PROVEN");
  const settledRows = settled?.state?.settlements;
  const duplicateRows = duplicate?.state?.settlements;
  if (duplicate?.summary?.tradesSettled !== 0 || duplicateRows?.length !== 1
      || sha256Canonical(duplicateRows) !== sha256Canonical(settledRows)) {
    blockers.push("V2_E2E_DUPLICATE_SETTLEMENT_PROTECTION_NOT_PROVEN");
  }
  if (blockers.length > 0) return deepFreeze({
    schemaVersion: "adaptive-multi-evidence-paper-runtime-proof-v2",
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    candidateId: candidateId ?? null,
    naturalSampleCredit: 0,
    ...safety(),
  });
  const proof = {
    candidateId,
    entryCount: 1,
    fillCount: 1,
    positionCount: 1,
    settlementCount: 1,
    restartExact: true,
    duplicateSettlementPrevented: true,
    nextCycleCompleted: true,
    fullCostReady: true,
    naturalSampleCredit: 1,
    settlementId: settled.state.settlements[0].settlementId,
  };
  return deepFreeze({
    schemaVersion: "adaptive-multi-evidence-paper-runtime-proof-v2",
    status: "PAPER_CLOSED_LOOP_PASS",
    ...proof,
    proofDigest: sha256Canonical(proof),
    blockers: [],
    ...safety(),
  });
}

export function buildAdaptiveMultiEvidenceE2EAcceptanceV2(input = {}) {
  const blockers = [];
  const phases = input.phases ?? {};
  const acceptance = [];
  for (const [name, schemaVersion, statuses] of STAGES) {
    const value = phases[name];
    const passed = value?.schemaVersion === schemaVersion && statuses.includes(value?.status) && safeStage(value);
    acceptance.push({ name, schemaVersion, status: value?.status ?? null, passed });
    if (!passed) blockers.push(`V2_E2E_${name.toUpperCase()}_INVALID`);
  }
  const portfolio = phases.phase10Portfolio;
  const candidateId = phases.phase14Position?.identity?.strategyIdentity;
  if (!verifyAdaptiveMultiEvidenceStrategyPortfolioV2(portfolio)
      || !portfolio?.portfolio?.members?.some((member) => member.candidateId === candidateId)) {
    blockers.push("V2_E2E_FROZEN_PORTFOLIO_CANDIDATE_BINDING_INVALID");
  }
  if (phases.phase4Regime?.sourceContentDigest !== phases.phase3MarketFeatures?.contentDigest
      || phases.phase8Tournament?.tournamentId !== phases.phase9Validation?.tournamentId) {
    blockers.push("V2_E2E_RESEARCH_LINEAGE_BINDING_INVALID");
  }
  const candidateBindings = [
    phases.phase11Decision?.strategyIdentity,
    phases.phase12CostLiquidity?.cost?.strategyIdentity,
    phases.phase14Position?.identity?.strategyIdentity,
    phases.phase15NaturalPaper?.candidate?.candidateId,
    phases.phase16DecisionJournal?.record?.identity?.candidateId,
    phases.phase16OutcomeJournal?.record?.identity?.candidateId,
    phases.phase17Health?.health?.candidateId,
    input.paperRuntimeProof?.candidateId,
  ];
  if (!candidateId || candidateBindings.some((value) => value !== candidateId)) {
    blockers.push("V2_E2E_CANDIDATE_IDENTITY_DISCONTINUITY");
  }
  const times = [phases.phase3MarketFeatures?.decisionTime, phases.phase4Regime?.decisionTime,
    phases.phase5Events?.decisionTime, phases.phase6Research?.decisionTime,
    phases.phase7Independence?.decisionTime].filter(Boolean);
  if (times.length !== 5 || new Set(times).size !== 1) blockers.push("V2_E2E_DECISION_TIME_DISCONTINUITY");
  if (input.paperRuntimeProof?.schemaVersion !== "adaptive-multi-evidence-paper-runtime-proof-v2"
      || input.paperRuntimeProof?.status !== "PAPER_CLOSED_LOOP_PASS"
      || input.paperRuntimeProof?.executionAuthority !== "NONE"
      || input.paperRuntimeProof?.scheduleActive !== false) blockers.push("V2_E2E_PAPER_RUNTIME_PROOF_INVALID");
  if (phases.phase15NaturalPaper?.scheduleActive !== false
      || phases.phase15NaturalPaper?.runtimeActivated !== false
      || phases.phase15NaturalPaper?.activationRequiresSeparateApproval !== true) {
    blockers.push("V2_E2E_NATURAL_PAPER_ACTIVATION_BOUNDARY_INVALID");
  }
  if (phases.phase16OutcomeJournal?.record?.outcome?.settlementId !== input.paperRuntimeProof?.settlementId
      || phases.phase16OutcomeJournal?.immutablePreDecisionDigest
        !== phases.phase16DecisionJournal?.record?.immutablePreDecisionDigest
      || phases.phase16OutcomeJournal?.preDecisionStateRewritten !== false) {
    blockers.push("V2_E2E_JOURNAL_SETTLEMENT_BINDING_INVALID");
  }
  const journalLedger = input.journalLedger;
  if (journalLedger?.schemaVersion !== "adaptive-multi-evidence-journal-ledger-v2"
      || journalLedger?.executionAuthority !== "NONE"
      || journalLedger?.recordCount !== 2
      || journalLedger?.recordCount !== journalLedger?.records?.length
      || journalLedger?.ledgerDigest !== sha256Canonical(journalLedger?.records)
      || journalLedger?.records?.[0]?.decisionRecordId !== phases.phase16DecisionJournal?.record?.decisionRecordId
      || journalLedger?.records?.[0]?.outcome !== null
      || journalLedger?.records?.[1]?.outcome?.settlementId !== input.paperRuntimeProof?.settlementId
      || journalLedger?.records?.[1]?.immutablePreDecisionDigest
        !== journalLedger?.records?.[0]?.immutablePreDecisionDigest) {
    blockers.push("V2_E2E_APPEND_ONLY_JOURNAL_LEDGER_INVALID");
  }
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") blockers.push("V2_E2E_EXECUTION_AUTHORITY_FORBIDDEN");
  if (blockers.length > 0) return failure(blockers);
  const phaseAcceptance = acceptance.map((row) => ({ ...row, passed: true }));
  const core = {
    candidateId,
    portfolioId: portfolio.portfolio.portfolioId,
    decisionTime: times[0],
    phaseAcceptance,
    paperRuntimeProofDigest: input.paperRuntimeProof.proofDigest,
    journalOutcomeDigest: phases.phase16OutcomeJournal.outcomeDigest,
    journalLedgerDigest: journalLedger.ledgerDigest,
    healthEvidenceId: phases.phase17Health.healthEvidenceId,
  };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_E2E_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "FULL_E2E_PASS_INACTIVE",
    phaseAcceptance,
    paperRuntime: input.paperRuntimeProof,
    acceptanceDigest: sha256Canonical(core),
    finalHumanStop: "NATURAL_PAPER_24_7_ACTIVATION_APPROVAL_REQUIRED",
    integrationPrReady: true,
    frozenV1Contamination: 0,
    unresolvedP0P1: 0,
    economicSampleCredit: 0,
    profitabilityProven: false,
    blockers: [],
    ...safety(),
  });
}
