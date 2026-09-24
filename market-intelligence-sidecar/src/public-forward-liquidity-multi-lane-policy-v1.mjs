import { readFileSync } from 'node:fs';

import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1_PATH = new URL(
  '../config/public-forward-liquidity-multi-lane-prospective-policy-v1.json',
  import.meta.url,
);

const CONFIG = Object.freeze(JSON.parse(
  readFileSync(PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1_PATH, 'utf8'),
));
const HOUR_MS = 3_600_000;
const FROZEN_V3_COHORT_START_INCLUSIVE_MS = 1_788_398_220_000;
const FROZEN_V3_COHORT_DIGEST =
  'f58e5b7e7e5249cb60a911eb2269d728fa9fa6604b0f3723256a8b0a0c9e9bd4';
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FROZEN_DIGESTS = Object.freeze({
  policyDigest: '8aa18555127272d7aa914d0b622b5ce9b463ffb0a9e53d6d93ffe679409a8993',
  laneRegistryDigest: '075d52f028efdb027fa39e1acb826afa1fee83fc5d7b60e52906ecc7cc530da4',
  dependencyPolicyDigest: 'c4ff4f6a265c6b9bd19db372d933f922c1343e4dd1cf1b0dc95e4b96bd81bab4',
  balancingPolicyDigest: 'f26defc6810a2655448bc4807c48f09853492daaff96bdcafd891d3cfe63165b',
  approvedCheckpointDigest: 'd5985d9dbd2b0765c73bc8db7c009b29d472cdbbed4a46b30a300066c597297d',
  activationPolicyDigest: '10747aa8f0af81997f0ee9e4d54751deb667662417dca67c81218e24b124e03e',
});

function fail(code) {
  throw new Error(code);
}

function integer(value, code) {
  if (!Number.isInteger(value) || value < 0) fail(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value <= 0) fail(code);
  return value;
}

function exactSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(normalized)) fail(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = String(value ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) fail(code);
  return normalized;
}

function exactDateMs(value, code) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isInteger(parsed) || parsed < 0) fail(code);
  return parsed;
}

function digest(value) {
  return sha256(canonicalJson(value));
}

function laneRegistryMap(config = CONFIG) {
  if (!Array.isArray(config.laneRegistry) || config.laneRegistry.length !== 2) {
    fail('PHASE2_LANE_REGISTRY_CARDINALITY_INVALID');
  }
  const bySchedule = new Map();
  for (const lane of config.laneRegistry) {
    if (!lane || typeof lane !== 'object'
      || !/^P2_V3_BTCUSDT_UTC(?:17|37)$/u.test(String(lane.laneId ?? ''))
      || !/^(?:17|37) \* \* \* \*$/u.test(String(lane.scheduleIdentity ?? ''))
      || lane.market !== 'CRYPTO_FUTURES'
      || lane.provider !== 'BITGET_PUBLIC_UTA_V3'
      || lane.symbol !== 'BTCUSDT'
      || lane.timeframe !== 'EVENT_WINDOW'
      || lane.sidePolicy !== 'NATURAL_OBSERVED_BUY_OR_SELL'
      || lane.maxCreditPerSlot !== 1
      || lane.publicOnly !== true
      || bySchedule.has(lane.scheduleIdentity)) {
      fail('PHASE2_LANE_REGISTRY_INVALID');
    }
    bySchedule.set(lane.scheduleIdentity, Object.freeze({ ...lane }));
  }
  if (!bySchedule.has('17 * * * *') || !bySchedule.has('37 * * * *')) {
    fail('PHASE2_LANE_REGISTRY_SCHEDULE_INVALID');
  }
  return bySchedule;
}

function buildDerivedPolicy(config = CONFIG) {
  const laneMap = laneRegistryMap(config);
  const laneRegistry = Object.freeze([...laneMap.values()]);
  const laneRegistryDigest = digest(laneRegistry);
  const dependencyPolicyDigest = digest(config.dependencyPolicy);
  const balancingPolicyDigest = digest(config.balancingPolicy);
  const approvedCheckpointDigest = digest(config.approvedCheckpoint);
  const activationPolicyDigest = digest(config.activationPolicy);
  const scopeCellPolicyDigest = digest(config.scopeCellDimensions);
  const policyDigestInputs = Object.freeze({
    policyVersion: config.policyVersion,
    authority: config.authority,
    v3Binding: config.v3Binding,
    laneRegistryDigest,
    dependencyPolicyDigest,
    balancingPolicyDigest,
    approvedCheckpointDigest,
    activationPolicyDigest,
    scopeCellPolicyDigest,
    creditPolicy: config.creditPolicy,
    utc27Policy: config.utc27Policy,
    splitPolicy: config.splitPolicy,
    safety: config.safety,
  });
  const policyDigest = digest(policyDigestInputs);
  return Object.freeze({
    policyVersion: config.policyVersion,
    freezeStatus: config.freezeStatus,
    config,
    laneRegistry,
    laneRegistryDigest,
    dependencyPolicyDigest,
    balancingPolicyDigest,
    approvedCheckpointDigest,
    activationPolicyDigest,
    scopeCellPolicyDigest,
    policyDigestInputs,
    policyDigest,
    contractDigest: digest({ config, policyDigestInputs, policyDigest }),
  });
}

export const PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1 = buildDerivedPolicy();

export function verifyPublicForwardLiquidityMultiLanePolicyV1(
  policy = PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1,
) {
  const blockers = [];
  const add = (code) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  try {
    const derived = buildDerivedPolicy(policy.config);
    if (policy.policyVersion !== 'public-forward-liquidity-multi-lane-prospective-policy-v1'
      || policy.freezeStatus !== 'HUMAN_OPTION_B_BALANCED_APPROVED'
      || canonicalJson(policy.policyDigestInputs) !== canonicalJson(derived.policyDigestInputs)
      || policy.policyDigest !== derived.policyDigest
      || policy.contractDigest !== derived.contractDigest
      || Object.entries(FROZEN_DIGESTS).some(([key, value]) => policy[key] !== value)) {
      add('PHASE2_POLICY_IDENTITY_INVALID');
    }
  } catch (error) {
    add(String(error?.message ?? 'PHASE2_POLICY_DERIVATION_FAILED'));
  }
  const { config } = policy;
  if (config.authority.canonicalHubIssue !== 838
    || config.authority.releaseControlIssue !== 23
    || config.authority.humanApprovalSource !== 'EXPLICIT_CODEX_CHAT_COMMAND'
    || exactDateMs(config.authority.humanApprovalRecordedAt, 'PHASE2_APPROVAL_TIME_INVALID')
      !== config.authority.humanApprovalRecordedAtMs
    || exactSha(config.authority.sourceMainSha, 'PHASE2_SOURCE_MAIN_INVALID')
      !== 'b36392aa868268dcfcced9fd206d628f626e6a1b'
    || config.authority.baselineRequiredCiRunId !== 34551430547
    || config.authority.baselineRequiredCi !== '6/6_SUCCESS'
    || config.authority.option !== 'OPTION_B_BALANCED'
    || config.authority.marketOutcomeConsulted !== false
    || config.authority.profitabilityOutcomeConsulted !== false
    || config.authority.representativeOutcomeSelectionAllowed !== false
    || config.authority.aiNumericAuthority !== 'NONE'
    || config.authority.humanFinalPolicyAuthority !== true) {
    add('PHASE2_HUMAN_AUTHORITY_INVALID');
  }
  const checkpoint = config.approvedCheckpoint;
  if (checkpoint.canonicalHubCommentId !== 5628195737
    || checkpoint.sourceRunId !== 34550480876
    || checkpoint.ingestRunId !== 34550523120
    || checkpoint.independenceRunId !== 34550647505
    || checkpoint.authoritativeIndexArtifactId !== 10180662199
    || exactDigest(checkpoint.authoritativeIndexArtifactDigest, 'PHASE2_CHECKPOINT_ARTIFACT_DIGEST_INVALID')
      !== '5167e9ebc9d904c0b99941f0d17e00dbb07b7cfafa6aa77c654318f663656aea'
    || checkpoint.targetSlotIndex !== 192
    || checkpoint.rawAcceptedN !== 1025
    || checkpoint.effectiveIndependentN !== 74
    || checkpoint.buyN !== 39
    || checkpoint.sellN !== 35
    || canonicalJson(checkpoint.splitCounts) !== canonicalJson({ TRAIN: 74, VALIDATION: 0, OOS: 0 })
    || checkpoint.manualCredit !== 0
    || checkpoint.replayCredit !== 0
    || checkpoint.backfillCredit !== 0
    || checkpoint.syntheticCredit !== 0) {
    add('PHASE2_APPROVED_CHECKPOINT_INVALID');
  }
  const credits = config.creditPolicy;
  if (credits.maxCreditPerLanePerSlot !== 1
    || credits.maxTotalCreditPerSlot !== 2
    || credits.maxCreditPerDependencyComponent !== 1
    || credits.capsAreGuaranteedCredit !== false
    || credits.missingIndependenceCredit !== 0
    || credits.ambiguousIndependenceCredit !== 0
    || credits.unverifiableIndependenceCredit !== 0
    || credits.overlappingIndependenceCredit !== 0
    || ['manualCredit', 'replayCredit', 'backfillCredit', 'syntheticCredit', 'operatorSelectedCredit', 'rerunCredit']
      .some((key) => credits[key] !== 0)) {
    add('PHASE2_CREDIT_POLICY_INVALID');
  }
  if (config.utc27Policy.scheduleIdentity !== '27 * * * *'
    || config.utc27Policy.role !== 'EXISTING_FALLBACK_OR_DIAGNOSTIC_ONLY'
    || config.utc27Policy.laneId !== null
    || config.utc27Policy.additionalIndependentCredit !== 0
    || config.utc27Policy.thirdLaneAllowed !== false) {
    add('PHASE2_UTC27_POLICY_INVALID');
  }
  if (config.activationPolicy.mode !== 'DERIVED_EXACT_MAIN_POST_MERGE_REQUIRED_CI'
    || config.activationPolicy.postMergeExactMainRequiredCi !== '6/6_TERMINAL_SUCCESS'
    || config.activationPolicy.requiredCiEvent !== 'workflow_dispatch'
    || config.activationPolicy.completeHourlyLeadSlotN !== 1
    || config.activationPolicy.firstEligibleLaneScheduleMinuteUtc !== 17
    || config.activationPolicy.alreadyRunningAttemptUsesOldPolicy !== true
    || config.activationPolicy.preBoundaryObservationCredit !== 0
    || config.activationPolicy.manualWorkflowDispatchEligible !== false
    || config.activationPolicy.replayEligible !== false
    || config.activationPolicy.backfillEligible !== false
    || config.activationPolicy.activationBoundaryMutationAllowed !== false) {
    add('PHASE2_ACTIVATION_POLICY_INVALID');
  }
  const safety = config.safety;
  if (safety.publicDataOnly !== true
    || safety.executionAuthority !== 'NONE'
    || safety.privateTradingApiAllowed !== false
    || safety.liveTradingAllowed !== false
    || safety.autoTradingAllowed !== false
    || safety.realOrderAllowed !== false
    || safety.financialMutationAllowed !== false
    || safety.productionDeployAllowed !== false
    || safety.stagingDeployAllowed !== false
    || safety.databaseMutationAllowed !== false
    || safety.secretEnvServerMutationAllowed !== false
    || safety.replitAllowed !== false
    || safety.replitAgentAllowed !== false
    || safety.profitabilityProven !== false) {
    add('PHASE2_SAFETY_INVALID');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    policyDigest: policy.policyDigest,
    laneRegistryDigest: policy.laneRegistryDigest,
    dependencyPolicyDigest: policy.dependencyPolicyDigest,
    balancingPolicyDigest: policy.balancingPolicyDigest,
    approvedCheckpointDigest: policy.approvedCheckpointDigest,
    activationPolicyDigest: policy.activationPolicyDigest,
  });
}

function utcHourAfter(timestampMs) {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS + HOUR_MS;
}

export function derivePublicForwardLiquidityMultiLaneActivation({
  exactMainSha,
  workflowRun,
  jobs,
} = {}) {
  const verdict = verifyPublicForwardLiquidityMultiLanePolicyV1();
  if (!verdict.valid) fail(`PHASE2_POLICY_INVALID:${verdict.blockers.join(',')}`);
  const mainSha = exactSha(exactMainSha, 'PHASE2_ACTIVATION_MAIN_SHA_INVALID');
  if (!workflowRun || typeof workflowRun !== 'object') fail('PHASE2_ACTIVATION_CI_RUN_MISSING');
  if (workflowRun.event !== CONFIG.activationPolicy.requiredCiEvent
    || workflowRun.head_branch !== 'main'
    || exactSha(workflowRun.head_sha, 'PHASE2_ACTIVATION_CI_HEAD_SHA_INVALID') !== mainSha
    || workflowRun.status !== 'completed'
    || workflowRun.conclusion !== 'success') {
    fail('PHASE2_ACTIVATION_CI_RUN_INVALID');
  }
  const runId = positiveInteger(Number(workflowRun.id), 'PHASE2_ACTIVATION_CI_RUN_ID_INVALID');
  const candidates = Array.isArray(jobs) ? jobs : [];
  const required = CONFIG.activationPolicy.requiredSuccessfulJobs;
  const byName = new Map();
  for (const job of candidates) {
    if (job?.name && !byName.has(job.name)) byName.set(job.name, job);
  }
  const completedTimes = [];
  for (const name of required) {
    const job = byName.get(name);
    if (!job || job.status !== 'completed' || job.conclusion !== 'success') {
      fail(`PHASE2_ACTIVATION_REQUIRED_CI_NOT_SUCCESS:${name}`);
    }
    completedTimes.push(exactDateMs(job.completed_at, 'PHASE2_ACTIVATION_CI_COMPLETED_AT_INVALID'));
  }
  const ciCompletedAtMs = Math.max(...completedTimes);
  if (ciCompletedAtMs <= CONFIG.authority.humanApprovalRecordedAtMs) {
    fail('PHASE2_ACTIVATION_CI_PREDATES_POLICY_FREEZE');
  }
  const completeLeadSlotStartMs = utcHourAfter(ciCompletedAtMs);
  const completeLeadSlotEndMs = completeLeadSlotStartMs
    + CONFIG.activationPolicy.completeHourlyLeadSlotN * HOUR_MS;
  const activationBoundaryMs = completeLeadSlotEndMs
    + CONFIG.activationPolicy.firstEligibleLaneScheduleMinuteUtc * 60_000;
  const v3Cohort = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort;
  if (v3Cohort.startInclusiveMs != null
    && v3Cohort.startInclusiveMs !== FROZEN_V3_COHORT_START_INCLUSIVE_MS) {
    fail('PHASE2_V3_COHORT_START_MISMATCH');
  }
  const slotIndex = Math.floor(
    (activationBoundaryMs - FROZEN_V3_COHORT_START_INCLUSIVE_MS)
      / v3Cohort.slotCadenceMs,
  );
  const nominalScheduledAtMs = FROZEN_V3_COHORT_START_INCLUSIVE_MS
    + slotIndex * v3Cohort.slotCadenceMs;
  if (v3Cohort.slotCadenceMs !== HOUR_MS
    || slotIndex < 0
    || slotIndex >= v3Cohort.totalSlotN
    || nominalScheduledAtMs !== activationBoundaryMs
    || slotIndex <= CONFIG.approvedCheckpoint.targetSlotIndex) {
    fail('PHASE2_ACTIVATION_BOUNDARY_NOT_FUTURE_V3_SLOT');
  }
  const body = Object.freeze({
    schemaVersion: 'public-forward-liquidity-multi-lane-activation-boundary-v1',
    policyVersion: PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyVersion,
    policyDigest: PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyDigest,
    exactMainSha: mainSha,
    postMergeRequiredCiRunId: runId,
    postMergeRequiredCiHeadSha: mainSha,
    postMergeRequiredCiCompletedAtMs: ciCompletedAtMs,
    requiredSuccessfulJobNames: Object.freeze([...required]),
    completeHourlyLeadSlotN: CONFIG.activationPolicy.completeHourlyLeadSlotN,
    completeLeadSlotStartMs,
    completeLeadSlotEndMs,
    activationBoundaryMs,
    activationSlotIndex: slotIndex,
    activationScheduleIdentity: '17 * * * *',
    preBoundaryObservationCredit: 0,
    manualWorkflowDispatchEligible: false,
    replayEligible: false,
    backfillEligible: false,
  });
  return Object.freeze({ ...body, activationBoundaryDigest: digest(body) });
}

export function buildPublicForwardLiquidityMultiLaneCurrentMainBinding({
  activation,
  currentMainSha,
  compareStatus,
  mergeBaseSha,
} = {}) {
  if (!activation || typeof activation !== 'object'
    || exactDigest(activation.activationBoundaryDigest, 'PHASE2_ACTIVATION_DIGEST_INVALID')
      !== digest(Object.fromEntries(Object.entries(activation)
        .filter(([key]) => key !== 'activationBoundaryDigest')))) {
    fail('PHASE2_ACTIVATION_BINDING_INVALID');
  }
  const activationCiHeadSha = exactSha(
    activation.postMergeRequiredCiHeadSha,
    'PHASE2_ACTIVATION_CI_HEAD_SHA_INVALID',
  );
  const current = exactSha(currentMainSha, 'PHASE2_CURRENT_MAIN_SHA_INVALID');
  const mergeBase = exactSha(mergeBaseSha, 'PHASE2_CURRENT_MAIN_MERGE_BASE_INVALID');
  const status = String(compareStatus ?? '').trim().toLowerCase();
  const relationship = current === activationCiHeadSha
    ? 'EXACT_ACTIVATION_CI_HEAD'
    : 'DESCENDANT_OF_ACTIVATION_CI_HEAD';
  if (mergeBase !== activationCiHeadSha
    || (relationship === 'EXACT_ACTIVATION_CI_HEAD' && status !== 'identical')
    || (relationship === 'DESCENDANT_OF_ACTIVATION_CI_HEAD' && status !== 'ahead')) {
    fail('PHASE2_CURRENT_MAIN_ANCESTRY_INVALID');
  }
  const body = Object.freeze({
    schemaVersion: 'public-forward-liquidity-multi-lane-current-main-binding-v1',
    policyDigest: PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyDigest,
    activationBoundaryDigest: activation.activationBoundaryDigest,
    activationCiHeadSha,
    currentMainSha: current,
    mergeBaseSha: mergeBase,
    compareStatus: status,
    relationship,
  });
  return Object.freeze({ ...body, currentMainBindingDigest: digest(body) });
}

export function resolvePublicForwardLiquidityMultiLaneCreditIdentity({
  scheduleExpression,
  actualRunStartedAtMs,
  slotIndex,
  activation,
} = {}) {
  const actual = integer(actualRunStartedAtMs, 'PHASE2_ACTUAL_START_INVALID');
  const index = integer(slotIndex, 'PHASE2_SLOT_INDEX_INVALID');
  if (!activation || typeof activation !== 'object'
    || activation.policyDigest !== PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyDigest
    || exactDigest(activation.activationBoundaryDigest, 'PHASE2_ACTIVATION_DIGEST_INVALID')
      !== digest(Object.fromEntries(Object.entries(activation)
        .filter(([key]) => key !== 'activationBoundaryDigest')))) {
    fail('PHASE2_ACTIVATION_BINDING_INVALID');
  }
  if (actual < activation.activationBoundaryMs || index < activation.activationSlotIndex) {
    return Object.freeze({ active: false, reason: 'PHASE2_PRE_ACTIVATION_OLD_POLICY' });
  }
  const lane = laneRegistryMap().get(String(scheduleExpression ?? '').trim()) ?? null;
  if (!lane) {
    if (String(scheduleExpression ?? '').trim() !== CONFIG.utc27Policy.scheduleIdentity) {
      fail('PHASE2_SCHEDULE_IDENTITY_NOT_FROZEN');
    }
    return Object.freeze({
      active: true,
      laneId: null,
      role: CONFIG.utc27Policy.role,
      additionalIndependentCredit: 0,
      thirdLaneAllowed: false,
      reason: 'PHASE2_UTC27_ZERO_ADDITIONAL_CREDIT',
    });
  }
  if (SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest != null
    && SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest !== FROZEN_V3_COHORT_DIGEST) {
    fail('PHASE2_V3_COHORT_DIGEST_MISMATCH');
  }
  const cohortDigest = FROZEN_V3_COHORT_DIGEST;
  const scope = Object.freeze({
    policyDigest: PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyDigest,
    cohortDigest,
    slotIndex: index,
    laneId: lane.laneId,
    market: lane.market,
    provider: lane.provider,
    symbol: lane.symbol,
    timeframe: lane.timeframe,
  });
  const globalSlotKey = Object.freeze({
    policyDigest: scope.policyDigest,
    cohortDigest,
    slotIndex: index,
  });
  return Object.freeze({
    active: true,
    laneId: lane.laneId,
    scheduleIdentity: lane.scheduleIdentity,
    lane,
    scope,
    laneCreditKey: scope,
    laneCreditKeyDigest: digest(scope),
    globalSlotKey,
    globalSlotKeyDigest: digest(globalSlotKey),
    maxCreditPerLanePerSlot: CONFIG.creditPolicy.maxCreditPerLanePerSlot,
    maxTotalCreditPerSlot: CONFIG.creditPolicy.maxTotalCreditPerSlot,
    maxCreditPerDependencyComponent: CONFIG.creditPolicy.maxCreditPerDependencyComponent,
  });
}
