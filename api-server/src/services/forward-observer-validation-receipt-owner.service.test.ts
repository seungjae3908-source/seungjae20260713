import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ManualPaperCanonicalIdentity } from './manual-paper-canonical-contract.service';
import { manualPaperEvidenceSha256 } from './manual-paper-canonical-contract.service';
import {
  createForwardObserverArtifactValidationEvidenceReader,
  createForwardObserverValidationReceiptOwner,
  FORWARD_OBSERVER_VALIDATION_RECEIPT_OWNER_VERSION,
} from './forward-observer-validation-receipt-owner.service';

const identity: ManualPaperCanonicalIdentity = Object.freeze({
  candidateId: 'paper-candidate-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  strategyId: 'scanner-swing-test-LONG',
  parameterHash: 'b'.repeat(64),
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
  timeframe: '60m',
  side: 'LONG',
  leverage: 3,
  parameterDigest: 'b'.repeat(64),
  signalDirection: 'LONG',
  accountMode: 'PAPER',
  researchCodeSha: 'c'.repeat(40),
});

test('issues only from genuine prospective evidence and verifies durable readback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forward-validation-receipt-'));
  try {
    const observedAtMs = Date.parse('2026-09-18T01:00:00.000Z');
    const nowMs = observedAtMs + 60_000;
    const issue = createForwardObserverValidationReceiptOwner({
      receiptRoot: root,
      maximumAgeMs: 5 * 60_000,
      readValidationEvidence: async (actualIdentity) => {
        assert.deepEqual(actualIdentity, identity);
        return Object.freeze({
          source: 'FORWARD_RECOMMENDATION_OBSERVER',
          provenance: 'PROSPECTIVE_PUBLIC_FORWARD',
          observedAtMs,
          sampleSize: 30,
          minimumSampleSize: 30,
          datasetDigest: 'd'.repeat(64),
          resultArtifactDigest: 'e'.repeat(64),
        });
      },
    });

    const result = await issue(identity, nowMs);
    assert.equal(result.receipt.status, 'VALIDATED');
    assert.equal(result.receipt.synthetic, false);
    assert.equal(result.receipt.replay, false);
    assert.equal(result.receipt.backfill, false);
    assert.equal(result.receipt.historical, false);
    assert.equal(result.receipt.testOnly, false);
    assert.equal(result.receipt.identity.candidateId, identity.candidateId);
    assert.equal(result.verification.ownerId, FORWARD_OBSERVER_VALIDATION_RECEIPT_OWNER_VERSION);
    assert.equal(result.verification.readbackVerified, true);
    assert.equal(result.verification.validationPassed, true);
    assert.equal(result.verification.receiptSha256, manualPaperEvidenceSha256(result.receipt));

    const files = await import('node:fs/promises').then(({ readdir }) => readdir(root));
    assert.equal(files.length, 1);
    const persisted = JSON.parse(await readFile(path.join(root, files[0]!), 'utf8'));
    assert.equal(manualPaperEvidenceSha256(persisted), result.verification.receiptSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when genuine evidence is stale', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forward-validation-stale-'));
  try {
    const issue = createForwardObserverValidationReceiptOwner({
      receiptRoot: root,
      maximumAgeMs: 1_000,
      readValidationEvidence: async () => Object.freeze({
        source: 'FORWARD_RECOMMENDATION_OBSERVER',
        provenance: 'PROSPECTIVE_PUBLIC_FORWARD',
        observedAtMs: 1_000,
        sampleSize: 30,
        minimumSampleSize: 30,
        datasetDigest: 'd'.repeat(64),
        resultArtifactDigest: 'e'.repeat(64),
      }),
    });
    await assert.rejects(() => issue(identity, 2_001), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'FORWARD_VALIDATION_EVIDENCE_STALE');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact reader does not convert missing artifact into validation credit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forward-validation-missing-'));
  try {
    const readEvidence = createForwardObserverArtifactValidationEvidenceReader({ artifactRoot: root });
    await assert.rejects(() => readEvidence(identity), (error: unknown) => {
      const code = (error as { code?: string }).code;
      assert.ok(code === 'FORWARD_VALIDATION_PROMOTION_IDENTITY_REQUIRED'
        || code === 'FORWARD_VALIDATION_ARTIFACT_READBACK_UNAVAILABLE');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
