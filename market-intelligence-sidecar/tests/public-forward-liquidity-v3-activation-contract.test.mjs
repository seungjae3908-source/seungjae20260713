import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canonicalJson,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  CRON_UTC,
  FIRST_NOMINAL_SCHEDULED_AT_MS,
  sha256,
  SLOT_EXECUTION_OFFSET_MS,
} from '../src/public-forward-liquidity-v3-scheduled-capture-seam.mjs';

const contractPath = new URL('../contracts/public-forward-liquidity-v3-activation-contract.json', import.meta.url);

function gitBlobSha(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.from(`blob ${body.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

async function maybeBlobSha(path) {
  try { return gitBlobSha(await readFile(path)); } catch { return null; }
}

test('immutable activation contract binds V3 policy, slot mapping, parameter policy and code blobs', async () => {
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  const body = { ...contract };
  delete body.activationContractDigest;
  assert.equal(contract.activationContractDigest, sha256(canonicalJson(body)));
  assert.equal(contract.v3PolicyHead, '43b15ea7cb4edfc84ce7e3055e6b8d7e5443c0f6');
  assert.equal(contract.v3PolicyDigest, '547bcd9fde985a7920f27c88e5e24f082c1dede18ef35a9ebdaa34edc056589b');
  assert.equal(contract.v3PolicyArtifactId, '9722465890');
  assert.equal(contract.v3PolicyArtifactDigest, '476b302eb38d8b17c30d4f3ed0d97f87fd16118d5b201cc03d9aff4b26b8eb7a');
  assert.equal(contract.v3CohortDigest, 'a1f176c286e40b3ca4182167c9357e57b39a7c40540b81ff6e206402f67dff9c');
  assert.equal(contract.firstNominalScheduledAtMs, FIRST_NOMINAL_SCHEDULED_AT_MS);
  assert.equal(contract.slotExecutionOffsetMs, SLOT_EXECUTION_OFFSET_MS);
  assert.equal(contract.cronUtc, CRON_UTC);
  assert.equal(contract.captureParameterPolicyDigest, CAPTURE_PARAMETER_POLICY_DIGEST);
  assert.equal(contract.defaultBranchRequired, true);
  assert.equal(contract.manualCredit, 0);
  assert.equal(contract.replayCredit, 0);
  assert.equal(contract.backfillCredit, 0);
  assert.equal(contract.operatorSelectedCredit, 0);
  assert.equal(contract.scheduleActivated, false);
  for (const split of ['TRAIN', 'VALIDATION', 'OOS']) {
    const row = contract.initialCompleteWindowAttemptLog[split];
    assert.equal(row.expectedSlotN, 0);
    assert.equal(row.attemptedSlotN, 0);
    assert.equal(row.missingSlotN, 0);
    assert.equal(row.duplicateSlotAttemptN, 0);
    assert.equal(row.validCaptureSlotN, 0);
    assert.equal(row.blockedDataSlotN, 0);
  }

  const scheduledPath = new URL('../../.github/workflows/public-forward-liquidity-v3-scheduled-capture.yml', import.meta.url);
  const manualPath = new URL('../../.github/workflows/public-forward-liquidity-calibration-capture.yml', import.meta.url);
  const collectorPath = new URL('../src/public-forward-liquidity-calibration.mjs', import.meta.url);
  const scheduledSha = await maybeBlobSha(scheduledPath);
  const manualSha = await maybeBlobSha(manualPath);
  const collectorSha = await maybeBlobSha(collectorPath);
  if (process.env.GITHUB_ACTIONS === 'true') {
    assert.ok(scheduledSha && manualSha && collectorSha, 'GitHub Actions must have all exact code-binding files');
  }
  if (scheduledSha) assert.equal(scheduledSha, contract.exactScheduledWorkflowSha);
  if (manualSha) assert.equal(manualSha, contract.captureWorkflowSha);
  if (collectorSha) assert.equal(collectorSha, contract.collectorCodeSha);
});
