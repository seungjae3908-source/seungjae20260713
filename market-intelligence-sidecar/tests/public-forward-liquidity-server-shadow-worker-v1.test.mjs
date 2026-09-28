import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  materializeSuccessorScheduleReliabilityV3Contract,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  buildServerEvidenceShadowEquivalenceReport,
  buildServerEvidenceShadowSelfCheck,
  resolveServerEvidenceNtpSynchronization,
  resolveServerEvidenceShadowSlot,
  runServerEvidenceShadowTick,
  summarizeServerEvidenceShadowState,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';

const CODE_SHA = 'a'.repeat(40);
const BINDING_DIGEST = 'b'.repeat(64);
const RECEIPT_COMMENT_ID = 5865071720;

// Existing Market Intelligence Sidecar CI deliberately stashes the real activation
// binding while running preserved inactive-contract regressions. This immutable test
// fixture reproduces the already-merged frozen activation identity only for tests;
// it does not mint authority, economic credit, or runtime activation.
const FROZEN_ACTIVATION_FIXTURE = Object.freeze({
  schemaVersion:
    'public-forward-liquidity-successor-schedule-reliability-activation-binding-v3',
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
  numericFreezeSha256:
    '10b157de8e1902865f9b386a02439bb56d67b5c2fcd20dd48870d851bdb97ff1',
  minActivationLeadSlots: 1,
  priorV2CreditImported: 0,
  priorV2MissedSlotRecovery: 0,
  priorV2DiagnosticArtifactCredit: 0,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
});

const ACTIVE_CONTRACT =
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound === true
    ? SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT
    : materializeSuccessorScheduleReliabilityV3Contract(
        FROZEN_ACTIVATION_FIXTURE,
      );

const START_MS = ACTIVE_CONTRACT.policyCore.cohort.startInclusiveMs;

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'server-evidence-shadow-v1-'));
}

function baseOptions({ root, nowMs, collector, ntpSynchronized = true } = {}) {
  return {
    nowMs,
    stateRoot: root,
    codeSha: CODE_SHA,
    activationReceiptCommentId: RECEIPT_COMMENT_ID,
    activationReceiptMainSha: CODE_SHA,
    activationBindingDigest: BINDING_DIGEST,
    shadowOnly: true,
    serverCanonical: false,
    ntpSynchronized,
    collector,
    contract: ACTIVE_CONTRACT,
  };
}

function fakeBatch(tag = 'A') {
  return {
    schemaVersion: 1,
    kind: 'synthetic-public-shadow-test-batch',
    tag,
    observations: [],
    privateApiUsed: false,
  };
}

test('self-check preserves frozen split and zero-authority invariants', () => {
  const report = buildServerEvidenceShadowSelfCheck(ACTIVE_CONTRACT);
  assert.equal(report.contractValid, true);
  assert.equal(report.activationBound, true);
  assert.deepEqual(report.triggerMinutesUtc, [17, 27, 37]);
  assert.equal(report.splits.TRAIN.startIndexInclusive, 0);
  assert.equal(report.splits.TRAIN.endIndexInclusive, 511);
  assert.equal(report.splits.VALIDATION.startIndexInclusive, 512);
  assert.equal(report.splits.OOS.startIndexInclusive, 768);
  assert.equal(report.safety.shadowOnly, true);
  assert.equal(report.safety.serverCanonical, false);
  assert.equal(report.safety.prospectiveSlotCredit, 0);
  assert.equal(report.safety.canonicalEconomicCredit, 0);
  assert.equal(report.safety.executionAuthority, 'NONE');
  assert.equal(report.safety.replitAllowed, false);
});

test('frozen :17 server tick captures public shadow evidence with zero economic credit', async () => {
  const root = await tempRoot();
  let calls = 0;
  try {
    const result = await runServerEvidenceShadowTick(baseOptions({
      root,
      nowMs: START_MS + 5_000,
      collector: async () => {
        calls += 1;
        return fakeBatch('FIRST');
      },
    }));
    assert.equal(calls, 1);
    assert.equal(result.receipt.captureStatus, 'PRESENT_SHADOW');
    assert.equal(result.receipt.slotIndex, 0);
    assert.equal(result.receipt.split, 'TRAIN');
    assert.equal(result.receipt.sampleClass, 'CALIBRATION_RESEARCH_SAMPLE');
    assert.equal(result.receipt.prospectiveSlotCredit, 0);
    assert.equal(result.receipt.canonicalEconomicCredit, 0);
    assert.equal(result.receipt.economicSampleCredit, 0);
    assert.equal(result.receipt.shadowOnly, true);
    assert.equal(result.receipt.serverCanonical, false);
    assert.equal(result.receipt.executionAuthority, 'NONE');
    assert.match(result.receipt.rawBatchDigest, /^[a-f0-9]{64}$/u);
    assert.match(result.receipt.receiptDigest, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('later :27 attempt in an already captured slot becomes a zero-credit no-op', async () => {
  const root = await tempRoot();
  let calls = 0;
  const collector = async () => {
    calls += 1;
    return fakeBatch(String(calls));
  };
  try {
    await runServerEvidenceShadowTick(baseOptions({
      root,
      nowMs: START_MS + 3_000,
      collector,
    }));
    const duplicate = await runServerEvidenceShadowTick(baseOptions({
      root,
      nowMs: START_MS + (10 * 60_000) + 4_000,
      collector,
    }));
    assert.equal(calls, 1);
    assert.equal(duplicate.receipt.captureStatus, 'DUPLICATE_SHADOW_SLOT_NOOP');
    assert.deepEqual(
      duplicate.receipt.blockers,
      ['SERVER_EVIDENCE_SHADOW_SLOT_ALREADY_CAPTURED'],
    );
    assert.equal(duplicate.receipt.prospectiveSlotCredit, 0);
    assert.equal(duplicate.receipt.rawBatchDigest, null);

    const summary = await summarizeServerEvidenceShadowState({ stateRoot: root });
    assert.equal(summary.capturedSlotN, 1);
    assert.equal(summary.attemptN, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('late trigger is recorded as missed shadow evidence and never backfilled', async () => {
  const root = await tempRoot();
  let calls = 0;
  try {
    const authority = resolveServerEvidenceShadowSlot({
      nowMs: START_MS + 56_000,
      contract: ACTIVE_CONTRACT,
    });
    assert.equal(authority.eligible, false);
    assert.equal(authority.blocker, 'SERVER_EVIDENCE_TRIGGER_STARTED_TOO_LATE');

    const result = await runServerEvidenceShadowTick(baseOptions({
      root,
      nowMs: START_MS + 56_000,
      collector: async () => {
        calls += 1;
        return fakeBatch('LATE');
      },
    }));
    assert.equal(calls, 0);
    assert.equal(result.receipt.captureStatus, 'NO_CAPTURE_SHADOW');
    assert.deepEqual(
      result.receipt.blockers,
      ['SERVER_EVIDENCE_TRIGGER_STARTED_TOO_LATE'],
    );
    assert.equal(result.receipt.prospectiveSlotCredit, 0);
    assert.equal(result.rawBatch, null);

    const restartedOutsideTrigger = await runServerEvidenceShadowTick(baseOptions({
      root,
      nowMs: START_MS + (3 * 60_000),
      collector: async () => {
        calls += 1;
        return fakeBatch('BACKFILL');
      },
    }));
    assert.equal(calls, 0);
    assert.equal(restartedOutsideTrigger.receipt.captureStatus, 'NO_CAPTURE_SHADOW');
    assert.deepEqual(
      restartedOutsideTrigger.receipt.blockers,
      ['SERVER_EVIDENCE_NOT_FROZEN_TRIGGER_MINUTE'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('NTP resolver accepts an explicit synchronized timedatectl verdict', () => {
  assert.equal(resolveServerEvidenceNtpSynchronization({
    timedatectlSucceeded: true,
    timedatectlValue: 'yes\n',
    systemdSyncMarkerPresent: false,
  }), true);
});

test('NTP resolver never lets the marker override an explicit unsynchronized verdict', () => {
  assert.equal(resolveServerEvidenceNtpSynchronization({
    timedatectlSucceeded: true,
    timedatectlValue: 'no\n',
    systemdSyncMarkerPresent: true,
  }), false);
});

test('NTP resolver uses the systemd sync marker only when timedatectl is unavailable', () => {
  assert.equal(resolveServerEvidenceNtpSynchronization({
    timedatectlSucceeded: false,
    timedatectlValue: null,
    systemdSyncMarkerPresent: true,
  }), true);
  assert.equal(resolveServerEvidenceNtpSynchronization({
    timedatectlSucceeded: false,
    timedatectlValue: null,
    systemdSyncMarkerPresent: false,
  }), false);
});

test('NTP-unsynchronized host fails closed before public capture', async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      runServerEvidenceShadowTick(baseOptions({
        root,
        nowMs: START_MS + 2_000,
        ntpSynchronized: false,
        collector: async () => fakeBatch('NTP'),
      })),
      /SERVER_EVIDENCE_NTP_NOT_SYNCHRONIZED/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical server mode cannot be enabled by the V1 shadow worker', async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      runServerEvidenceShadowTick({
        ...baseOptions({
          root,
          nowMs: START_MS + 2_000,
          collector: async () => fakeBatch('CANONICAL'),
        }),
        serverCanonical: true,
      }),
      /SERVER_EVIDENCE_CANONICAL_CUTOVER_NOT_AUTHORIZED/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale activation receipt SHA fails closed', async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      runServerEvidenceShadowTick({
        ...baseOptions({
          root,
          nowMs: START_MS + 2_000,
          collector: async () => fakeBatch('STALE'),
        }),
        activationReceiptMainSha: 'c'.repeat(40),
      }),
      /SERVER_EVIDENCE_RECEIPT_STALE_FOR_DEPLOYED_SHA/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('equivalence report compares frozen identity without granting credit', async () => {
  const root = await tempRoot();
  try {
    const result = await runServerEvidenceShadowTick(baseOptions({
      root,
      nowMs: START_MS + 1_000,
      collector: async () => fakeBatch('EQ'),
    }));
    const canonicalReceipt = {
      slotIndex: result.receipt.slotIndex,
      split: result.receipt.split,
      policyDigest: result.receipt.policyDigest,
      cohortDigest: result.receipt.cohortDigest,
      rawBatchDigest: result.receipt.rawBatchDigest,
    };
    const report = buildServerEvidenceShadowEquivalenceReport({
      shadowReceipt: result.receipt,
      canonicalReceipt,
    });
    assert.equal(report.identityMatch, true);
    assert.equal(report.rawDigestComparable, true);
    assert.equal(report.rawDigestEqual, true);
    assert.equal(report.economicCreditGranted, 0);
    assert.equal(report.canonicalCutoverReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
