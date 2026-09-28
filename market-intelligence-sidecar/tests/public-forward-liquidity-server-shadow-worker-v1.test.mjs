import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  buildServerEvidenceShadowEquivalenceReport,
  buildServerEvidenceShadowSelfCheck,
  resolveServerEvidenceShadowSlot,
  runServerEvidenceShadowTick,
  summarizeServerEvidenceShadowState,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';

const CODE_SHA = 'a'.repeat(40);
const BINDING_DIGEST = 'b'.repeat(64);
const RECEIPT_COMMENT_ID = 5865071720;
const START_MS =
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort.startInclusiveMs;

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
  const report = buildServerEvidenceShadowSelfCheck();
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
