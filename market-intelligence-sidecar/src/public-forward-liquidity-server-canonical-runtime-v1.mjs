import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  SERVER_CANONICAL_CUTOVER_READINESS_SCHEMA,
  SERVER_CANONICAL_GITHUB_OUTAGE_MATURITY_MS,
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
} from './public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  resolveServerEvidenceShadowSlot,
} from './public-forward-liquidity-server-shadow-worker-v1.mjs';
import {
  executeSuccessorScheduledCaptureSeamV3,
  finalizeSuccessorArtifactReceipt,
} from './public-forward-liquidity-successor-schedule-seam-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';

export const SERVER_CANONICAL_RUNTIME_SCHEMA =
  'public-forward-liquidity-server-canonical-runtime-v1';
export const SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA =
  'public-forward-liquidity-server-canonical-runtime-activation-v1';
export const SERVER_CANONICAL_RECEIPT_SCHEMA =
  'public-forward-liquidity-server-canonical-receipt-v1';
export const SERVER_CANONICAL_INGEST_HANDOFF_SCHEMA =
  'public-forward-liquidity-server-canonical-ingest-handoff-v1';
export const SERVER_CANONICAL_INGEST_AUTHORIZATION_SCHEMA =
  'public-forward-liquidity-server-canonical-ingest-authorization-v1';
export const SERVER_CANONICAL_SOURCE = 'SERVER_NATURAL_TIMER';
export const GITHUB_CANONICAL_SOURCE = 'GITHUB_V3_SCHEDULE';
export const SERVER_CANONICAL_GITHUB_OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

function exactSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function exactDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function withoutDigest(value, key) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([name]) => name !== key));
}

function immutableDigestValid(value, key) {
  return exactDigest(value?.[key])
    && value[key] === sha256(canonicalJson(withoutDigest(value, key)));
}

export function buildServerCanonicalCreditKey({
  policyDigest,
  cohortDigest,
  slotIndex,
} = {}) {
  if (!exactDigest(policyDigest)
    || !exactDigest(cohortDigest)
    || !nonNegativeInteger(slotIndex)) {
    throw new Error('SERVER_CANONICAL_CREDIT_KEY_INVALID');
  }
  const key = Object.freeze({ policyDigest, cohortDigest, slotIndex });
  return Object.freeze({
    key,
    keyDigest: sha256(canonicalJson(key)),
  });
}

export function buildServerCanonicalRuntimeSelfCheck() {
  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_RUNTIME_SCHEMA,
    defaultEnabled: false,
    activationApplied: false,
    shadowRuntimeMutationApplied: false,
    serverCanonical: false,
    sourcePrecedence: SERVER_CANONICAL_SOURCE_PRECEDENCE,
    githubRecoveryPolicy: 'STOP_SERVER_CANONICAL_AND_EMIT_NO_CREDIT',
    maximumCanonicalEconomicCreditPerPolicyCohortSlot: 1,
    preAuthorityShadowReceiptCanonicalCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    fullCostReady: false,
    profitabilityProven: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  });
}

function githubObservationBlockers({
  observation,
  currentMainSha,
  nowMs,
  requireMatureOutage,
} = {}) {
  const blockers = [];
  if (observation?.targetWorkflowId !== 347888347
    || observation?.targetWorkflowState !== 'active') {
    add(blockers, 'SERVER_CANONICAL_GITHUB_TARGET_WORKFLOW_NOT_ACTIVE');
  }
  if (observation?.targetLatestScheduleWorkflowId !== 347888347
    || observation?.targetLatestScheduleEvent !== 'schedule'
    || !exactSha(observation?.targetLatestScheduleHeadSha)
    || observation?.targetLatestScheduleHeadSha === currentMainSha) {
    add(blockers, 'SERVER_CANONICAL_CURRENT_MAIN_GITHUB_SCHEDULE_ABSENCE_UNPROVEN');
  }
  if (!positiveInteger(observation?.observedAtMs)
    || observation.observedAtMs > nowMs
    || nowMs - observation.observedAtMs > SERVER_CANONICAL_GITHUB_OBSERVATION_MAX_AGE_MS) {
    add(blockers, 'SERVER_CANONICAL_GITHUB_OBSERVATION_STALE');
  }
  if (observation?.targetCurrentMainScheduleRunCount !== 0
    || observation?.targetScheduleRunCountSinceCutoverAuthority !== 0
    || observation?.targetSameSlotScheduleRunCount !== 0
    || observation?.targetRecoveryObserved !== false) {
    add(blockers, 'SERVER_CANONICAL_GITHUB_RECOVERED_NO_CREDIT');
  }
  if (requireMatureOutage === true
    && (!positiveInteger(observation?.targetLatestScheduleCreatedAtMs)
      || observation.observedAtMs - observation.targetLatestScheduleCreatedAtMs
        <= SERVER_CANONICAL_GITHUB_OUTAGE_MATURITY_MS)) {
    add(blockers, 'SERVER_CANONICAL_GITHUB_TARGET_OUTAGE_NOT_MATURED');
  }
  if (!positiveInteger(observation?.repositoryLatestScheduleCreatedAtMs)
    || !positiveInteger(observation?.repositoryLatestScheduleWorkflowId)
    || observation?.repositoryLatestScheduleWorkflowId === 347888347
    || observation?.repositoryLatestScheduleEvent !== 'schedule'
    || observation?.repositoryLatestScheduleHeadSha !== currentMainSha
    || observation.repositoryLatestScheduleCreatedAtMs
      <= observation.targetLatestScheduleCreatedAtMs) {
    add(blockers, 'SERVER_CANONICAL_REPOSITORY_SCHEDULE_HEALTH_NOT_OBSERVED');
  }
  return blockers;
}

function validateBaselineEvidence(baselineEvidence, blockers) {
  if (baselineEvidence?.canonicalTrainReceiptN !== 4
    || baselineEvidence?.independentN !== 4
    || baselineEvidence?.validationN !== 0
    || baselineEvidence?.oosN !== 0
    || baselineEvidence?.retroactiveRecomputePerformed !== false
    || baselineEvidence?.historicalShadowPromotionPerformed !== false) {
    add(blockers, 'SERVER_CANONICAL_FROZEN_BASELINE_NOT_PRESERVED');
  }
}

export function evaluateServerCanonicalRuntimeGate({
  nowMs,
  currentMainSha,
  activationBindingDigest,
  cutoverReadiness,
  runtimeActivation,
  serverRuntime,
  githubDelivery,
  canonicalCreditLedger,
  historicalShadowLedger,
  baselineEvidence,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  const blockers = [];
  const now = Number(nowMs);
  if (!positiveInteger(now)) add(blockers, 'SERVER_CANONICAL_NOW_INVALID');
  if (!exactSha(currentMainSha)) add(blockers, 'SERVER_CANONICAL_CURRENT_MAIN_SHA_INVALID');
  if (!exactDigest(activationBindingDigest)) {
    add(blockers, 'SERVER_CANONICAL_BINDING_DIGEST_INVALID');
  }

  const readinessDigest = sha256(canonicalJson(cutoverReadiness ?? null));
  if (cutoverReadiness?.schemaVersion !== SERVER_CANONICAL_CUTOVER_READINESS_SCHEMA
    || cutoverReadiness?.readyForFutureCanonicalCutover !== true
    || cutoverReadiness?.activationApplied !== false
    || cutoverReadiness?.futureCanonicalCreditPermittedByThisReadinessCheck !== false
    || cutoverReadiness?.requiresSeparateProtectedRuntimeActivation !== true
    || !sameArray(cutoverReadiness?.sourcePrecedence, SERVER_CANONICAL_SOURCE_PRECEDENCE)
    || cutoverReadiness?.maximumCanonicalEconomicCreditPerPolicyCohortSlot !== 1) {
    add(blockers, 'SERVER_CANONICAL_CUTOVER_READINESS_INVALID');
  }

  if (runtimeActivation?.schemaVersion !== SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA
    || runtimeActivation?.activationApplied !== true
    || runtimeActivation?.defaultOffAcknowledged !== true
    || runtimeActivation?.targetMainSha !== currentMainSha
    || runtimeActivation?.activationBindingDigest !== activationBindingDigest
    || runtimeActivation?.readinessDigest !== readinessDigest
    || !positiveInteger(runtimeActivation?.activationReceiptCommentId)
    || !positiveInteger(runtimeActivation?.authorityCommentId)
    || !positiveInteger(runtimeActivation?.authorizedAtMs)
    || !nonNegativeInteger(runtimeActivation?.firstEligibleSlotIndex)
    || runtimeActivation?.preAuthorityShadowCanonicalCredit !== 0
    || runtimeActivation?.preCutoverShadowCanonicalCredit !== 0
    || runtimeActivation?.replayCredit !== 0
    || runtimeActivation?.backfillCredit !== 0
    || runtimeActivation?.manualCredit !== 0
    || runtimeActivation?.syntheticCredit !== 0
    || runtimeActivation?.hindsightCredit !== 0
    || runtimeActivation?.executionAuthority !== 'NONE'
    || !sameArray(runtimeActivation?.sourcePrecedence, SERVER_CANONICAL_SOURCE_PRECEDENCE)
    || !immutableDigestValid(runtimeActivation, 'activationDigest')) {
    add(blockers, 'SERVER_CANONICAL_PROTECTED_RUNTIME_ACTIVATION_INVALID');
  }
  const cohort = contract?.policyCore?.cohort;
  const authorizationSlotIndex = positiveInteger(runtimeActivation?.authorizedAtMs)
    && Number.isSafeInteger(cohort?.startInclusiveMs)
    && Number.isSafeInteger(cohort?.endExclusiveMs)
    && Number.isSafeInteger(cohort?.slotCadenceMs)
    && runtimeActivation.authorizedAtMs >= cohort.startInclusiveMs
    && runtimeActivation.authorizedAtMs < cohort.endExclusiveMs
      ? Math.floor(
          (runtimeActivation.authorizedAtMs - cohort.startInclusiveMs)
            / cohort.slotCadenceMs,
        )
      : null;
  if (authorizationSlotIndex == null
    || runtimeActivation?.firstEligibleSlotIndex < authorizationSlotIndex + 1) {
    add(blockers, 'SERVER_CANONICAL_RUNTIME_FUTURE_SLOT_LEAD_REQUIRED');
  }

  if (serverRuntime?.deployedSha !== currentMainSha
    || serverRuntime?.timerEnabled !== true
    || serverRuntime?.timerActive !== true
    || serverRuntime?.persistent !== false
    || serverRuntime?.ntpSynchronized !== true
    || serverRuntime?.serverCanonical !== true
    || serverRuntime?.shadowOnly !== false
    || serverRuntime?.receiptPersistence !== 'CREATE_ONLY_WX'
    || serverRuntime?.manualCapturePerformed !== false
    || serverRuntime?.productionAppMutationPerformed !== false
    || serverRuntime?.executionAuthority !== 'NONE') {
    add(blockers, 'SERVER_CANONICAL_RUNTIME_NOT_ACTIVE_OR_SAFE');
  }

  const authority = positiveInteger(now)
    ? resolveServerEvidenceShadowSlot({ nowMs: now, contract })
    : Object.freeze({ eligible: false, blocker: 'SERVER_CANONICAL_NOW_INVALID' });
  if (authority.eligible !== true) {
    add(blockers, authority.blocker ?? 'SERVER_CANONICAL_NOT_NATURAL_TIMER_SLOT');
  }
  if (authority.eligible === true
    && (authority.slotIndex < runtimeActivation?.firstEligibleSlotIndex
      || authority.slotIndex < cutoverReadiness?.firstEligibleSlotIndex
      || now <= runtimeActivation?.authorizedAtMs)) {
    add(blockers, 'SERVER_CANONICAL_FUTURE_SLOT_NOT_YET_ELIGIBLE');
  }

  for (const blocker of githubObservationBlockers({
    observation: githubDelivery,
    currentMainSha,
    nowMs: now,
    requireMatureOutage: true,
  })) add(blockers, blocker);

  let creditKey = null;
  if (authority.eligible === true) {
    creditKey = buildServerCanonicalCreditKey({
      policyDigest: contract.policyDigest,
      cohortDigest: contract.cohortDigest,
      slotIndex: authority.slotIndex,
    });
  }
  if (!creditKey
    || canonicalCreditLedger?.lookupComplete !== true
    || canonicalCreditLedger?.creditKeyDigest !== creditKey.keyDigest
    || !Array.isArray(canonicalCreditLedger?.matchingCanonicalCredits)) {
    add(blockers, 'SERVER_CANONICAL_PRIOR_CREDIT_LOOKUP_UNPROVEN');
  } else if (canonicalCreditLedger.matchingCanonicalCredits.length > 0) {
    add(blockers, 'SERVER_CANONICAL_DUPLICATE_SLOT_NO_CREDIT');
  }

  if (historicalShadowLedger?.lookupComplete !== true
    || historicalShadowLedger?.canonicalCreditN !== 0
    || historicalShadowLedger?.retroactivePromotionPerformed !== false) {
    add(blockers, 'SERVER_CANONICAL_HISTORICAL_SHADOW_ZERO_CREDIT_UNPROVEN');
  }
  validateBaselineEvidence(baselineEvidence, blockers);

  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_RUNTIME_SCHEMA,
    status: blockers.length === 0 ? 'CAPTURE_ALLOWED' : 'NO_CAPTURE_NO_CREDIT',
    captureAllowed: blockers.length === 0,
    blockers: Object.freeze(blockers),
    authority,
    creditKey,
    readinessDigest,
    sourcePrecedence: SERVER_CANONICAL_SOURCE_PRECEDENCE,
    selectedSource: blockers.length === 0 ? SERVER_CANONICAL_SOURCE : null,
    prospectiveSlotCredit: 0,
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    executionAuthority: 'NONE',
  });
}

function normalizeCaptureReceipt({
  captureReceipt,
  gate,
  runtimeActivation,
  activationBindingDigest,
  previousGithubObservedAtMs,
  postGithubDelivery,
  postCheckAtMs,
}) {
  const recoveryBlockers = githubObservationBlockers({
    observation: postGithubDelivery,
    currentMainSha: captureReceipt?.exactMainSha,
    nowMs: postCheckAtMs,
    requireMatureOutage: false,
  });
  if (!positiveInteger(previousGithubObservedAtMs)
    || postGithubDelivery?.observedAtMs < previousGithubObservedAtMs) {
    add(recoveryBlockers, 'SERVER_CANONICAL_POST_CAPTURE_GITHUB_OBSERVATION_REGRESSED');
  }
  const originalBody = withoutDigest(captureReceipt, 'captureReceiptDigest');
  const originalCandidate = captureReceipt?.captureStatus === 'PRESENT'
    && captureReceipt?.prospectiveSlotCredit === 1
    && Array.isArray(captureReceipt?.blockers)
    && captureReceipt.blockers.length === 0;
  const candidate = originalCandidate && recoveryBlockers.length === 0;
  const body = {
    ...originalBody,
    canonicalSource: SERVER_CANONICAL_SOURCE,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    serverCanonical: true,
    serverShadowOnly: false,
    serverCanonicalRuntimeSchema: SERVER_CANONICAL_RUNTIME_SCHEMA,
    serverCanonicalCreditKey: gate.creditKey.key,
    serverCanonicalCreditKeyDigest: gate.creditKey.keyDigest,
    serverCanonicalReadinessDigest: gate.readinessDigest,
    serverCanonicalActivationDigest: runtimeActivation.activationDigest,
    serverCanonicalAuthorityCommentId: runtimeActivation.authorityCommentId,
    serverCanonicalFirstEligibleSlotIndex: runtimeActivation.firstEligibleSlotIndex,
    activationBindingDigest,
    serverCanonicalReceiptPersistence: 'CREATE_ONLY_WX',
    shadowReceiptPromotionPerformed: false,
    captureStatus: candidate
      ? 'PRESENT'
      : (originalCandidate ? 'PRESENT_ZERO_CREDIT' : captureReceipt?.captureStatus),
    blockers: Object.freeze([
      ...(captureReceipt?.blockers ?? []),
      ...recoveryBlockers,
    ]),
    prospectiveSlotCredit: candidate ? 1 : 0,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
    duplicateOrRerunCredit: 0,
    missedSlotCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    privateTradingApiAllowed: false,
    realOrderEnabled: false,
    executionAuthority: 'NONE',
  };
  return Object.freeze({
    receipt: Object.freeze({
      ...body,
      captureReceiptDigest: sha256(canonicalJson(body)),
    }),
    candidate,
    recoveryBlockers: Object.freeze(recoveryBlockers),
  });
}

async function writeCreateOnly(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function persistCanonicalPackage({
  stateRoot,
  gate,
  nowMs,
  rawBatch,
  captureReceipt,
  artifactReceipt,
  serverReceipt,
}) {
  const requestedRoot = String(stateRoot ?? '').trim();
  if (!requestedRoot) throw new Error('SERVER_CANONICAL_STATE_ROOT_REQUIRED');
  const root = resolve(requestedRoot);
  const slotRoot = join(
    root,
    'server-canonical-v1',
    'slots',
    `slot-${String(gate.authority.slotIndex).padStart(4, '0')}`,
  );
  await mkdir(slotRoot, { recursive: true, mode: 0o700 });
  const attemptRoot = join(slotRoot, `${nowMs}-${gate.creditKey.keyDigest}`);
  await mkdir(attemptRoot, { recursive: false, mode: 0o700 });
  if (rawBatch !== null) await writeCreateOnly(join(attemptRoot, 'raw-batch.json'), rawBatch);
  await writeCreateOnly(join(attemptRoot, 'capture-receipt.json'), captureReceipt);
  if (artifactReceipt !== null) {
    await writeCreateOnly(join(attemptRoot, 'artifact-receipt.json'), artifactReceipt);
  }
  await writeCreateOnly(join(attemptRoot, 'server-canonical-receipt.json'), serverReceipt);
  return Object.freeze({ root, slotRoot, attemptRoot });
}

export function buildServerCanonicalIngestHandoff({
  serverReceipt,
  rawBatch,
  captureReceipt,
  artifactReceipt,
} = {}) {
  const candidate = serverReceipt?.readyForProtectedCanonicalIngestGate === true
    && serverReceipt?.prospectiveSlotCredit === 1
    && serverReceipt?.canonicalEconomicCredit === 0;
  if (!candidate
    || serverReceipt?.schemaVersion !== SERVER_CANONICAL_RECEIPT_SCHEMA
    || !immutableDigestValid(serverReceipt, 'receiptDigest')
    || captureReceipt?.captureReceiptDigest !== serverReceipt?.captureReceiptDigest
    || artifactReceipt?.receiptDigest !== serverReceipt?.artifactReceiptDigest
    || sha256(canonicalJson(rawBatch)) !== serverReceipt?.rawBatchDigest) {
    throw new Error('SERVER_CANONICAL_INGEST_HANDOFF_INVALID');
  }
  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_INGEST_HANDOFF_SCHEMA,
    canonicalSource: SERVER_CANONICAL_SOURCE,
    sourcePrecedence: SERVER_CANONICAL_SOURCE_PRECEDENCE,
    creditKey: serverReceipt.creditKey,
    creditKeyDigest: serverReceipt.creditKeyDigest,
    serverReceipt,
    rawBatch,
    captureReceipt,
    artifactReceipt,
    readyForProtectedCanonicalIngestGate: true,
    freshGithubAndCreditLedgerRevalidationRequiredAtIngest: true,
    canonicalIngestPermitted: false,
    canonicalIngestPerformed: false,
    independencePermittedOnlyAfterVerifiedIngest: true,
    independencePerformed: false,
    canonicalEconomicCredit: 0,
    executionAuthority: 'NONE',
  });
}

export function evaluateServerCanonicalIngestGate({
  handoff,
  githubDelivery,
  canonicalCreditLedger,
  authorizedAtMs,
} = {}) {
  const blockers = [];
  const now = Number(authorizedAtMs);
  const receipt = handoff?.serverReceipt;
  if (!positiveInteger(now)) add(blockers, 'SERVER_CANONICAL_INGEST_AUTHORIZED_AT_INVALID');
  if (handoff?.schemaVersion !== SERVER_CANONICAL_INGEST_HANDOFF_SCHEMA
    || handoff?.readyForProtectedCanonicalIngestGate !== true
    || handoff?.canonicalIngestPermitted !== false
    || handoff?.canonicalIngestPerformed !== false
    || receipt?.schemaVersion !== SERVER_CANONICAL_RECEIPT_SCHEMA
    || !immutableDigestValid(receipt, 'receiptDigest')) {
    add(blockers, 'SERVER_CANONICAL_INGEST_HANDOFF_INVALID');
  }
  for (const blocker of githubObservationBlockers({
    observation: githubDelivery,
    currentMainSha: receipt?.targetMainSha,
    nowMs: now,
    requireMatureOutage: true,
  })) add(blockers, blocker);
  if (canonicalCreditLedger?.lookupComplete !== true
    || canonicalCreditLedger?.creditKeyDigest !== receipt?.creditKeyDigest
    || !Array.isArray(canonicalCreditLedger?.matchingCanonicalCredits)) {
    add(blockers, 'SERVER_CANONICAL_INGEST_PRIOR_CREDIT_LOOKUP_UNPROVEN');
  } else if (canonicalCreditLedger.matchingCanonicalCredits.length > 0) {
    add(blockers, 'SERVER_CANONICAL_INGEST_DUPLICATE_SLOT_NO_CREDIT');
  }
  if (blockers.length > 0) {
    return Object.freeze({
      schemaVersion: SERVER_CANONICAL_INGEST_AUTHORIZATION_SCHEMA,
      status: 'BLOCKED_NO_CREDIT',
      canonicalIngestPermitted: false,
      blockers: Object.freeze(blockers),
      canonicalEconomicCredit: 0,
      independencePerformed: false,
      executionAuthority: 'NONE',
    });
  }
  const body = {
    schemaVersion: SERVER_CANONICAL_INGEST_AUTHORIZATION_SCHEMA,
    status: 'AUTHORIZED_FOR_PROTECTED_CANONICAL_INGEST',
    canonicalSource: SERVER_CANONICAL_SOURCE,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    targetMainSha: receipt.targetMainSha,
    creditKey: receipt.creditKey,
    creditKeyDigest: receipt.creditKeyDigest,
    captureReceiptDigest: receipt.captureReceiptDigest,
    serverReceiptDigest: receipt.receiptDigest,
    githubObservedAtMs: githubDelivery.observedAtMs,
    authorizedAtMs: now,
    githubRecoveryObserved: false,
    priorCanonicalCreditN: 0,
    maximumCanonicalEconomicCredit: 1,
    canonicalIngestPermitted: true,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    canonicalEconomicCredit: 0,
    executionAuthority: 'NONE',
  };
  return Object.freeze({
    ...body,
    authorizationDigest: sha256(canonicalJson(body)),
  });
}

export async function runServerCanonicalNaturalTick({
  stateRoot,
  repository,
  nowMs = Date.now(),
  currentMainSha,
  activationBindingDigest,
  cutoverReadiness,
  runtimeActivation,
  serverRuntime,
  githubDelivery,
  observeGithubDelivery,
  canonicalCreditLedger,
  historicalShadowLedger,
  baselineEvidence,
  getRemoteMainSha,
  captureEngine = executeSuccessorScheduledCaptureSeamV3,
  clock = () => Date.now(),
  collector,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  const gate = evaluateServerCanonicalRuntimeGate({
    nowMs,
    currentMainSha,
    activationBindingDigest,
    cutoverReadiness,
    runtimeActivation,
    serverRuntime,
    githubDelivery,
    canonicalCreditLedger,
    historicalShadowLedger,
    baselineEvidence,
    contract,
  });
  if (typeof observeGithubDelivery !== 'function') {
    return Object.freeze({
      ...gate,
      status: 'NO_CAPTURE_NO_CREDIT',
      captureAllowed: false,
      blockers: Object.freeze([
        ...gate.blockers,
        'SERVER_CANONICAL_POST_CAPTURE_GITHUB_OBSERVER_REQUIRED',
      ]),
      collectorInvoked: false,
      persisted: null,
    });
  }
  if (!gate.captureAllowed) {
    return Object.freeze({ ...gate, collectorInvoked: false, persisted: null });
  }
  if (typeof getRemoteMainSha !== 'function') {
    return Object.freeze({
      ...gate,
      status: 'NO_CAPTURE_NO_CREDIT',
      captureAllowed: false,
      blockers: Object.freeze([
        ...gate.blockers,
        'SERVER_CANONICAL_REMOTE_MAIN_RESOLVER_REQUIRED',
      ]),
      collectorInvoked: false,
      persisted: null,
    });
  }

  const scheduleExpression = `${gate.authority.triggerMinuteUtc} * * * *`;
  const captured = await captureEngine({
    eventName: 'schedule',
    scheduleExpression,
    scheduledRunCreatedAtMs: gate.authority.triggerAtMs,
    exactMainSha: currentMainSha,
    defaultBranchRef: 'refs/heads/main',
    actualRunStartedAtMs: nowMs,
    runAttempt: 1,
    runId: String(nowMs),
    repository,
    hasPriorCreditedSlot: async (identity) => {
      const key = buildServerCanonicalCreditKey(identity);
      if (key.keyDigest !== gate.creditKey.keyDigest) {
        throw new Error('SERVER_CANONICAL_CAPTURE_CREDIT_KEY_DRIFT');
      }
      return canonicalCreditLedger.matchingCanonicalCredits.length > 0;
    },
    getRemoteMainSha,
    clock,
    ...(collector ? { collector } : {}),
    contract,
  });
  const postGithubDelivery = await observeGithubDelivery({
    slotIndex: gate.authority.slotIndex,
    creditKey: gate.creditKey.key,
  });
  const postCheckAtMs = Number(clock());
  const normalized = normalizeCaptureReceipt({
    captureReceipt: captured.captureReceipt,
    gate,
    runtimeActivation,
    activationBindingDigest,
    previousGithubObservedAtMs: githubDelivery.observedAtMs,
    postGithubDelivery,
    postCheckAtMs,
  });
  const rawBatch = captured.batch ?? null;
  const rawBatchDigest = rawBatch === null ? null : sha256(canonicalJson(rawBatch));
  const artifactId = String(nowMs);
  const artifactDigest = sha256(canonicalJson({
    rawBatch,
    captureReceipt: normalized.receipt,
  }));
  const canonicalSlotKeyDigest = sha256(canonicalJson(
    gate.authority.slot.canonicalSlotKey,
  ));
  const artifactName = `public-forward-liquidity-successor-slot-${gate.authority.slotIndex}-${canonicalSlotKeyDigest}`;
  const artifactReference = `server-create-only://${gate.creditKey.keyDigest}/${artifactId}`;
  const artifactReceipt = rawBatch === null
    ? null
    : finalizeSuccessorArtifactReceipt({
        captureReceipt: normalized.receipt,
        artifactId,
        artifactDigest,
        artifactName,
        artifactReference,
      });
  const candidate = normalized.candidate && rawBatch !== null && artifactReceipt !== null;
  const serverBody = {
    schemaVersion: SERVER_CANONICAL_RECEIPT_SCHEMA,
    canonicalSource: SERVER_CANONICAL_SOURCE,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    githubRecoveryPolicy: 'STOP_SERVER_CANONICAL_AND_EMIT_NO_CREDIT',
    stateContract: 'public-forward-liquidity-server-canonical-state-root-v1',
    receiptPersistence: 'CREATE_ONLY_WX',
    targetMainSha: currentMainSha,
    activationBindingDigest,
    readinessDigest: gate.readinessDigest,
    runtimeActivationDigest: runtimeActivation.activationDigest,
    authorityCommentId: runtimeActivation.authorityCommentId,
    activationReceiptCommentId: runtimeActivation.activationReceiptCommentId,
    authorizedAtMs: runtimeActivation.authorizedAtMs,
    firstEligibleSlotIndex: runtimeActivation.firstEligibleSlotIndex,
    creditKey: gate.creditKey.key,
    creditKeyDigest: gate.creditKey.keyDigest,
    slotIndex: gate.authority.slotIndex,
    split: gate.authority.split,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    triggerAtMs: gate.authority.triggerAtMs,
    serverStartedAtMs: nowMs,
    captureStatus: normalized.receipt.captureStatus,
    blockers: [...normalized.receipt.blockers],
    rawBatchDigest,
    captureReceiptDigest: normalized.receipt.captureReceiptDigest,
    artifactReceiptDigest: artifactReceipt?.receiptDigest ?? null,
    artifactDigest: artifactReceipt?.artifactDigest ?? null,
    shadowReceiptPromotionPerformed: false,
    preAuthorityShadowCanonicalCredit: 0,
    preCutoverShadowCanonicalCredit: 0,
    prospectiveSlotCredit: candidate ? 1 : 0,
    canonicalEconomicCredit: 0,
    readyForProtectedCanonicalIngestGate: candidate,
    canonicalIngestPermitted: false,
    canonicalIngestPerformed: false,
    independencePermitted: false,
    independencePerformed: false,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    fullCostReady: false,
    profitabilityProven: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  };
  const serverReceipt = Object.freeze({
    ...serverBody,
    receiptDigest: sha256(canonicalJson(serverBody)),
  });
  const persisted = await persistCanonicalPackage({
    stateRoot,
    gate,
    nowMs,
    rawBatch,
    captureReceipt: normalized.receipt,
    artifactReceipt,
    serverReceipt,
  });
  const ingestHandoff = candidate
    ? buildServerCanonicalIngestHandoff({
        serverReceipt,
        rawBatch,
        captureReceipt: normalized.receipt,
        artifactReceipt,
      })
    : null;
  return Object.freeze({
    ...gate,
    status: candidate ? 'CANONICAL_INGEST_HANDOFF_READY' : 'CAPTURED_NO_CREDIT',
    collectorInvoked: captured.captureReceipt?.collectorInvoked === true,
    captureReceipt: normalized.receipt,
    artifactReceipt,
    serverReceipt,
    rawBatch,
    ingestHandoff,
    persisted,
    prospectiveSlotCredit: candidate ? 1 : 0,
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    executionAuthority: 'NONE',
  });
}
