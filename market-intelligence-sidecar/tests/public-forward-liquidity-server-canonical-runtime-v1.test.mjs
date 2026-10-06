import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  SERVER_CANONICAL_CUTOVER_READINESS_SCHEMA,
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
} from '../src/public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
  buildServerCanonicalCreditKey,
  buildServerCanonicalRuntimeSelfCheck,
  evaluateServerCanonicalIngestGate,
  evaluateServerCanonicalRuntimeGate,
  runServerCanonicalNaturalTick,
} from '../src/public-forward-liquidity-server-canonical-runtime-v1.mjs';
import {
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  materializeSuccessorScheduleReliabilityV3Contract,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';

const ACTIVATION_BINDING = Object.freeze({
  schemaVersion: 'public-forward-liquidity-successor-schedule-reliability-activation-binding-v3',
  authorityIssue: 23,
  authorityCommentId: 5805902930,
  hubFreezeAuthorityCommentId: 5804802177,
  hubFreezeTimestampCommentId: 5804808369,
  frozenCohortFreezeBlobSha: '65ef02d9ef5611c767755e71b40b840737b0658a',
  frozenCohortFreezeMs: 1790207015000,
  frozenCohortEffectiveStartMs: 1790263020000,
  activationBoundaryMs: 1790212089000,
  cutoverStartMs: 1790263020000,
  authorizedCurrentMainSha: '24d9c8b4bbca54c1b3bce4ad28a8c1286beaff92',
  numericFreezeSha256: '10b157de8e1902865f9b386a02439bb56d67b5c2fcd20dd48870d851bdb97ff1',
  minActivationLeadSlots: 1,
  priorV2CreditImported: 0,
  priorV2MissedSlotRecovery: 0,
  priorV2DiagnosticArtifactCredit: 0,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
});
const CONTRACT = materializeSuccessorScheduleReliabilityV3Contract(ACTIVATION_BINDING);
const MAIN = 'a'.repeat(40);
const BINDING = sha256(canonicalJson(ACTIVATION_BINDING));
const FIRST_ELIGIBLE_SLOT_INDEX = 106;
const SLOT = buildSuccessorScheduleReliabilityV3SlotDescriptor(
  FIRST_ELIGIBLE_SLOT_INDEX,
  CONTRACT,
);
const NOW = SLOT.nominalScheduledAtMs + 10_000;

function readiness(overrides = {}) {
  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_CUTOVER_READINESS_SCHEMA,
    readyForFutureCanonicalCutover: true,
    activationApplied: false,
    futureCanonicalCreditPermittedByThisReadinessCheck: false,
    requiresSeparateProtectedRuntimeActivation: true,
    firstEligibleSlotIndex: FIRST_ELIGIBLE_SLOT_INDEX,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    maximumCanonicalEconomicCreditPerPolicyCohortSlot: 1,
    blockers: [],
    ...overrides,
  });
}

function activation(cutoverReadiness = readiness(), overrides = {}) {
  const body = {
    schemaVersion: SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
    activationApplied: true,
    defaultOffAcknowledged: true,
    targetMainSha: MAIN,
    activationBindingDigest: BINDING,
    readinessDigest: sha256(canonicalJson(cutoverReadiness)),
    activationReceiptCommentId: 5881193542,
    authorityCommentId: 6000000001,
    authorizedAtMs: SLOT.nominalScheduledAtMs - 30 * 60 * 1000,
    firstEligibleSlotIndex: FIRST_ELIGIBLE_SLOT_INDEX,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    preAuthorityShadowCanonicalCredit: 0,
    preCutoverShadowCanonicalCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
    ...overrides,
  };
  return Object.freeze({
    ...body,
    activationDigest: sha256(canonicalJson(body)),
  });
}

function serverRuntime(overrides = {}) {
  return {
    deployedSha: MAIN,
    timerEnabled: true,
    timerActive: true,
    persistent: false,
    ntpSynchronized: true,
    serverCanonical: true,
    shadowOnly: false,
    receiptPersistence: 'CREATE_ONLY_WX',
    manualCapturePerformed: false,
    productionAppMutationPerformed: false,
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function githubDelivery(overrides = {}) {
  return {
    targetWorkflowId: 347888347,
    targetWorkflowState: 'active',
    targetLatestScheduleWorkflowId: 347888347,
    targetLatestScheduleEvent: 'schedule',
    targetLatestScheduleHeadSha: 'f'.repeat(40),
    targetLatestScheduleCreatedAtMs: NOW - 2 * 60 * 60 * 1000,
    targetCurrentMainScheduleRunCount: 0,
    targetScheduleRunCountSinceCutoverAuthority: 0,
    targetSameSlotScheduleRunCount: 0,
    targetRecoveryObserved: false,
    repositoryLatestScheduleCreatedAtMs: NOW - 60_000,
    repositoryLatestScheduleWorkflowId: 343418331,
    repositoryLatestScheduleEvent: 'schedule',
    repositoryLatestScheduleHeadSha: MAIN,
    observedAtMs: NOW,
    ...overrides,
  };
}

function creditLedger(overrides = {}) {
  const key = buildServerCanonicalCreditKey({
    policyDigest: CONTRACT.policyDigest,
    cohortDigest: CONTRACT.cohortDigest,
    slotIndex: FIRST_ELIGIBLE_SLOT_INDEX,
  });
  return {
    lookupComplete: true,
    creditKeyDigest: key.keyDigest,
    matchingCanonicalCredits: [],
    ...overrides,
  };
}

function base(overrides = {}) {
  const cutoverReadiness = overrides.cutoverReadiness ?? readiness();
  return {
    nowMs: NOW,
    currentMainSha: MAIN,
    activationBindingDigest: BINDING,
    cutoverReadiness,
    runtimeActivation: activation(cutoverReadiness),
    serverRuntime: serverRuntime(),
    githubDelivery: githubDelivery(),
    canonicalCreditLedger: creditLedger(),
    historicalShadowLedger: {
      lookupComplete: true,
      canonicalCreditN: 0,
      retroactivePromotionPerformed: false,
    },
    baselineEvidence: {
      canonicalTrainReceiptN: 4,
      independentN: 4,
      validationN: 0,
      oosN: 0,
      retroactiveRecomputePerformed: false,
      historicalShadowPromotionPerformed: false,
    },
    contract: CONTRACT,
    ...overrides,
  };
}

function fakeCaptureEngine() {
  const batch = Object.freeze({ kind: 'test-server-natural-batch', observations: [1] });
  const body = {
    schemaVersion: 'public-forward-liquidity-capture-receipt-v3',
    exactMainSha: MAIN,
    collectorInvoked: true,
    captureStatus: 'PRESENT',
    blockers: [],
    rawBatchDigest: sha256(canonicalJson(batch)),
    rawEvidencePreserved: true,
    prospectiveSlotCredit: 1,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
    duplicateOrRerunCredit: 0,
    missedSlotCredit: 0,
    syntheticCredit: 0,
    executionAuthority: 'NONE',
  };
  return Promise.resolve(Object.freeze({
    batch,
    captureReceipt: Object.freeze({
      ...body,
      captureReceiptDigest: sha256(canonicalJson(body)),
    }),
  }));
}

test('GitHub schedule health lookup is exact-main and cache resistant', async () => {
  const runner = await readFile(
    new URL('../scripts/run-public-forward-liquidity-server-canonical-runtime-v1.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(runner.includes("url.searchParams.set('_canonical_observed_at_ms', String(Date.now()));"));
  assert.ok(runner.includes("'Cache-Control': 'no-cache'"));
  assert.ok(runner.includes("Pragma: 'no-cache'"));
  assert.ok(runner.includes(
    `/actions/runs?event=schedule&branch=main&head_sha=\${encodeURIComponent(currentMainSha)}&per_page=100`,
  ));
  assert.equal(
    runner.includes("githubJson('/actions/runs?event=schedule&branch=main&per_page=100')"),
    false,
  );
});

test('runtime is explicitly default OFF and grants no credit', () => {
  const report = buildServerCanonicalRuntimeSelfCheck();
  assert.equal(report.defaultEnabled, false);
  assert.equal(report.activationApplied, false);
  assert.equal(report.serverCanonical, false);
  assert.equal(report.canonicalEconomicCredit, 0);
  assert.equal(report.executionAuthority, 'NONE');
});

test('protected activation is mandatory before the existing capture engine can run', async () => {
  let captureCalls = 0;
  const result = await runServerCanonicalNaturalTick({
    ...base({ runtimeActivation: null }),
    observeGithubDelivery: async () => githubDelivery(),
    captureEngine: async () => {
      captureCalls += 1;
      return fakeCaptureEngine();
    },
  });

  assert.equal(result.captureAllowed, false);
  assert.equal(captureCalls, 0);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_PROTECTED_RUNTIME_ACTIVATION_INVALID'));
  assert.equal(result.canonicalEconomicCredit, 0);
});

test('GitHub recovery and an existing canonical key both fail closed', () => {
  const result = evaluateServerCanonicalRuntimeGate(base({
    githubDelivery: githubDelivery({
      targetCurrentMainScheduleRunCount: 1,
      targetScheduleRunCountSinceCutoverAuthority: 1,
      targetSameSlotScheduleRunCount: 1,
      targetRecoveryObserved: true,
    }),
    canonicalCreditLedger: creditLedger({
      matchingCanonicalCredits: [{ source: 'GITHUB_V3_SCHEDULE' }],
    }),
  }));

  assert.equal(result.captureAllowed, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_GITHUB_RECOVERED_NO_CREDIT'));
  assert.ok(result.blockers.includes('SERVER_CANONICAL_DUPLICATE_SLOT_NO_CREDIT'));
});

test('eligible natural server capture creates an immutable zero-economic-credit ingest handoff', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'server-canonical-v1-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const result = await runServerCanonicalNaturalTick({
    ...base(),
    stateRoot,
    repository: 'seungjae3908-source/seungjae20260713',
    observeGithubDelivery: async () => githubDelivery({ observedAtMs: NOW + 1_000 }),
    getRemoteMainSha: async () => MAIN,
    captureEngine: fakeCaptureEngine,
    clock: () => NOW + 2_000,
  });

  assert.equal(result.status, 'CANONICAL_INGEST_HANDOFF_READY');
  assert.equal(result.prospectiveSlotCredit, 1);
  assert.equal(result.canonicalEconomicCredit, 0);
  assert.equal(result.ingestHandoff.canonicalIngestPerformed, false);
  assert.equal(result.ingestHandoff.canonicalIngestPermitted, false);
  assert.equal(result.ingestHandoff.readyForProtectedCanonicalIngestGate, true);
  assert.equal(result.ingestHandoff.independencePerformed, false);
  assert.equal(result.serverReceipt.shadowReceiptPromotionPerformed, false);
  assert.equal(result.serverReceipt.executionAuthority, 'NONE');
  const persisted = JSON.parse(await readFile(
    join(result.persisted.attemptRoot, 'server-canonical-receipt.json'),
    'utf8',
  ));
  const { receiptDigest, ...body } = persisted;
  assert.equal(receiptDigest, sha256(canonicalJson(body)));

  const ingestAuthorization = evaluateServerCanonicalIngestGate({
    handoff: result.ingestHandoff,
    githubDelivery: githubDelivery({ observedAtMs: NOW + 1_000 }),
    canonicalCreditLedger: creditLedger(),
    authorizedAtMs: NOW + 2_000,
  });
  assert.equal(ingestAuthorization.canonicalIngestPermitted, true);
  assert.equal(ingestAuthorization.canonicalIngestPerformed, false);
  assert.equal(ingestAuthorization.canonicalEconomicCredit, 0);

  await assert.rejects(
    runServerCanonicalNaturalTick({
      ...base(),
      stateRoot,
      repository: 'seungjae3908-source/seungjae20260713',
      observeGithubDelivery: async () => githubDelivery({ observedAtMs: NOW + 1_000 }),
      getRemoteMainSha: async () => MAIN,
      captureEngine: fakeCaptureEngine,
      clock: () => NOW + 2_000,
    }),
    (error) => error?.code === 'EEXIST',
  );
});

test('GitHub recovery observed after capture downgrades the server package to NO-CREDIT', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'server-canonical-recovery-v1-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const result = await runServerCanonicalNaturalTick({
    ...base(),
    stateRoot,
    repository: 'seungjae3908-source/seungjae20260713',
    observeGithubDelivery: async () => githubDelivery({
      observedAtMs: NOW + 1_000,
      targetCurrentMainScheduleRunCount: 1,
      targetScheduleRunCountSinceCutoverAuthority: 1,
      targetSameSlotScheduleRunCount: 1,
      targetRecoveryObserved: true,
    }),
    getRemoteMainSha: async () => MAIN,
    captureEngine: fakeCaptureEngine,
    clock: () => NOW + 2_000,
  });

  assert.equal(result.status, 'CAPTURED_NO_CREDIT');
  assert.equal(result.prospectiveSlotCredit, 0);
  assert.equal(result.canonicalEconomicCredit, 0);
  assert.equal(result.ingestHandoff, null);
  assert.ok(result.captureReceipt.blockers.includes(
    'SERVER_CANONICAL_GITHUB_RECOVERED_NO_CREDIT',
  ));
});

test('GitHub recovery at protected ingest gate blocks a previously captured server handoff', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'server-canonical-ingest-gate-v1-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const result = await runServerCanonicalNaturalTick({
    ...base(),
    stateRoot,
    repository: 'seungjae3908-source/seungjae20260713',
    observeGithubDelivery: async () => githubDelivery({ observedAtMs: NOW + 1_000 }),
    getRemoteMainSha: async () => MAIN,
    captureEngine: fakeCaptureEngine,
    clock: () => NOW + 2_000,
  });
  const authorization = evaluateServerCanonicalIngestGate({
    handoff: result.ingestHandoff,
    githubDelivery: githubDelivery({
      observedAtMs: NOW + 2_000,
      targetCurrentMainScheduleRunCount: 1,
      targetScheduleRunCountSinceCutoverAuthority: 1,
      targetSameSlotScheduleRunCount: 1,
      targetRecoveryObserved: true,
    }),
    canonicalCreditLedger: creditLedger(),
    authorizedAtMs: NOW + 3_000,
  });

  assert.equal(authorization.canonicalIngestPermitted, false);
  assert.ok(authorization.blockers.includes(
    'SERVER_CANONICAL_GITHUB_RECOVERED_NO_CREDIT',
  ));
});
