import { createHash } from 'node:crypto';

import {
  buildAdaptiveMultiMarketTournamentPlanV1,
  verifyAdaptiveMultiMarketTournamentPlanV1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  buildAdaptiveTournamentRuntimeAdapterV1,
  buildAdaptiveTournamentRuntimeCompatibilityReportV1,
  verifyAdaptiveTournamentRuntimeAdapterV1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-runtime-adapter-v1.js';
import { buildResearchDataFactoryOverviewV1 } from './research-data-factory.mjs';

export const RESEARCH_FACTORY_CONTROL_PLANE_CONTRACT_V1 = 'research-factory-control-plane/v1';

const SHA40 = /^[0-9a-f]{40}$/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function exactSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new TypeError('researchSha must be an exact 40-character SHA');
  return sha;
}

function exactIso(value) {
  const timestamp = new Date(String(value ?? ''));
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError('observedAt must be an ISO timestamp');
  return timestamp.toISOString();
}

function canonicalAdaptivePlan({ researchSha, observedAt, adaptive }) {
  if (adaptive?.plan != null) {
    if (!verifyAdaptiveMultiMarketTournamentPlanV1(adaptive.plan)) {
      throw new Error('CANONICAL_ADAPTIVE_PLAN_INVALID');
    }
    if (adaptive.plan.sourceSha !== researchSha) throw new Error('CANONICAL_ADAPTIVE_PLAN_SOURCE_SHA_MISMATCH');
    return adaptive.plan;
  }
  return buildAdaptiveMultiMarketTournamentPlanV1({
    sourceSha: researchSha,
    createdAt: observedAt,
    evidenceCatalog: adaptive?.evidenceCatalog ?? {},
    developmentDiagnostics: adaptive?.developmentDiagnostics ?? {},
    policy: adaptive?.policy,
  });
}

function canonicalRuntimeAdapter({ plan, observedAt, adaptive }) {
  if (adaptive?.runtimeAdapter != null) {
    if (!verifyAdaptiveTournamentRuntimeAdapterV1(adaptive.runtimeAdapter)) {
      throw new Error('CANONICAL_ADAPTIVE_RUNTIME_ADAPTER_INVALID');
    }
    if (adaptive.runtimeAdapter.sourceSha !== plan.sourceSha
      || adaptive.runtimeAdapter.planDigest !== plan.planDigest) {
      throw new Error('CANONICAL_ADAPTIVE_RUNTIME_ADAPTER_PLAN_MISMATCH');
    }
    return adaptive.runtimeAdapter;
  }
  return buildAdaptiveTournamentRuntimeAdapterV1({
    plan,
    bindings: adaptive?.bindings ?? {},
    createdAt: observedAt,
  });
}

function dataWork(dataFactory) {
  return Object.freeze(Object.entries(dataFactory.markets)
    .filter(([, row]) => row.ready !== true)
    .map(([market, row]) => Object.freeze({
      market,
      priority: 100,
      canonicalOwner: 'research-production/research-data-factory',
      blockerCount: row.blockers.length,
      blockers: row.blockers,
      executionAuthority: 'NONE',
    })));
}

function nextControlAction(plan, adapter) {
  if (plan.readiness.readyProfileCount === 0) {
    return Object.freeze({
      kind: 'COLLECT_CANONICAL_PROFILE_EVIDENCE',
      priority: 90,
      reason: 'MARKET_PROFILE_DATA_READINESS_MISSING',
      readyProfileCount: 0,
      blockedProfileCount: plan.readiness.blockedProfileCount,
      executionAuthority: 'NONE',
    });
  }
  if (adapter.status === 'BLOCKED_RUNTIME_BINDINGS') {
    return Object.freeze({
      kind: 'BIND_EXISTING_CANONICAL_RUNTIME_OWNERS',
      priority: 90,
      reason: adapter.nextFirstZero,
      missingBindings: Object.freeze([...adapter.bindingAssessment.unavailableBindingKeys]),
      executionAuthority: 'NONE',
    });
  }
  if (adapter.status === 'READY_NON_ACTIVATING') {
    return Object.freeze({
      kind: 'CANONICAL_RUNTIME_READY_FOR_SEPARATE_EXECUTION',
      priority: 80,
      reason: adapter.nextFirstZero,
      readyProfileCount: plan.readiness.readyProfileCount,
      executionAuthority: 'NONE',
    });
  }
  return Object.freeze({
    kind: 'HOLD_FAIL_CLOSED',
    priority: 100,
    reason: adapter.nextFirstZero ?? 'CANONICAL_RUNTIME_STATE_UNKNOWN',
    executionAuthority: 'NONE',
  });
}

export function buildResearchFactoryControlPlaneV1(raw = {}) {
  const researchSha = exactSha(raw.researchSha);
  const observedAt = exactIso(raw.observedAt);
  const dataFactory = buildResearchDataFactoryOverviewV1({
    evidenceByMarket: raw.evidenceByMarket ?? {},
  });
  const adaptive = raw.adaptive ?? {};
  if (adaptive.plan == null && adaptive.policy == null) {
    const core = {
      schemaVersion: 1,
      contract: RESEARCH_FACTORY_CONTROL_PLANE_CONTRACT_V1,
      researchSha,
      observedAt,
      status: 'BLOCKED_POLICY_MISSING',
      dataFactory,
      canonicalAdaptive: {
        policyStatus: 'MISSING',
        planDigest: null,
        planStatus: null,
        readyProfileCount: null,
        blockedProfileCount: null,
        initialCandidateFamilySize: null,
        localFirstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
        runtimeAdapterDigest: null,
        runtimeStatus: null,
        nextFirstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
        compatibility: null,
      },
      parallelDataWork: dataWork(dataFactory),
      nextAction: {
        kind: 'FREEZE_HUMAN_APPROVED_ADAPTIVE_POLICY',
        priority: 100,
        reason: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
        executionAuthority: 'NONE',
      },
      ownership: {
        adaptivePlanOwner: 'market-prediction-lab/adaptive-multi-market-tournament-orchestrator-v1',
        runtimeAdapterOwner: 'market-prediction-lab/adaptive-multi-market-tournament-runtime-adapter-v1',
        checkpointResumeOwner: 'market-prediction-lab/research-tournament-stage-checkpoint-resume-v1',
        backtesterOwner: '#690',
        statisticalFirewallOwner: '#547',
        formulaCompilerOwner: '#550/#551',
      },
      safety: {
        orchestrationDuplicated: false,
        candidateBudgetInvented: false,
        stageSequenceInvented: false,
        runtimeExecutionAttempted: false,
        runtimeActivationAllowed: false,
        scheduleMutationAllowed: false,
        deploymentAllowed: false,
        finalHoldoutAccessAllowed: false,
        oosFeedbackToGeneratorAllowed: false,
        forwardFeedbackToGeneratorAllowed: false,
        paperFeedbackToGeneratorAllowed: false,
        missingEvidenceNumericSubstitutionAllowed: false,
        branchWrite: false,
        databaseMutation: false,
        secretMutation: false,
        liveTrading: false,
        autoTrading: false,
        privateTradingApi: false,
        realOrder: false,
        championPromotion: false,
        profitabilityClaim: false,
        executionAuthority: 'NONE',
      },
    };
    return Object.freeze({ ...core, controlPlaneDigest: digest(core) });
  }
  const plan = canonicalAdaptivePlan({ researchSha, observedAt, adaptive });
  if (!verifyAdaptiveMultiMarketTournamentPlanV1(plan)) throw new Error('CANONICAL_ADAPTIVE_PLAN_INVALID_AFTER_BUILD');
  const runtimeAdapter = canonicalRuntimeAdapter({ plan, observedAt, adaptive });
  if (!verifyAdaptiveTournamentRuntimeAdapterV1(runtimeAdapter)) {
    throw new Error('CANONICAL_ADAPTIVE_RUNTIME_ADAPTER_INVALID_AFTER_BUILD');
  }
  const compatibility = buildAdaptiveTournamentRuntimeCompatibilityReportV1({ adapter: runtimeAdapter });
  const parallelDataWork = dataWork(dataFactory);
  const nextAction = nextControlAction(plan, runtimeAdapter);

  const status = runtimeAdapter.status === 'READY_NON_ACTIVATING'
    ? 'READY_NON_ACTIVATING'
    : runtimeAdapter.status;

  const core = {
    schemaVersion: 1,
    contract: RESEARCH_FACTORY_CONTROL_PLANE_CONTRACT_V1,
    researchSha,
    observedAt,
    status,
    dataFactory,
    canonicalAdaptive: {
      planDigest: plan.planDigest,
      planStatus: plan.allocation.status,
      readyProfileCount: plan.readiness.readyProfileCount,
      blockedProfileCount: plan.readiness.blockedProfileCount,
      initialCandidateFamilySize: plan.successiveHalving.initialCandidateFamilySize,
      localFirstZero: plan.localFirstZero,
      runtimeAdapterDigest: runtimeAdapter.adapterDigest,
      runtimeStatus: runtimeAdapter.status,
      nextFirstZero: runtimeAdapter.nextFirstZero,
      compatibility,
    },
    parallelDataWork,
    nextAction,
    ownership: {
      adaptivePlanOwner: 'market-prediction-lab/adaptive-multi-market-tournament-orchestrator-v1',
      runtimeAdapterOwner: 'market-prediction-lab/adaptive-multi-market-tournament-runtime-adapter-v1',
      checkpointResumeOwner: 'market-prediction-lab/research-tournament-stage-checkpoint-resume-v1',
      backtesterOwner: '#690',
      statisticalFirewallOwner: '#547',
      formulaCompilerOwner: '#550/#551',
    },
    safety: {
      orchestrationDuplicated: false,
      candidateBudgetInvented: false,
      stageSequenceInvented: false,
      runtimeExecutionAttempted: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      deploymentAllowed: false,
      finalHoldoutAccessAllowed: false,
      oosFeedbackToGeneratorAllowed: false,
      forwardFeedbackToGeneratorAllowed: false,
      paperFeedbackToGeneratorAllowed: false,
      missingEvidenceNumericSubstitutionAllowed: false,
      branchWrite: false,
      databaseMutation: false,
      secretMutation: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      championPromotion: false,
      profitabilityClaim: false,
      executionAuthority: 'NONE',
    },
  };
  return Object.freeze({ ...core, controlPlaneDigest: digest(core) });
}
