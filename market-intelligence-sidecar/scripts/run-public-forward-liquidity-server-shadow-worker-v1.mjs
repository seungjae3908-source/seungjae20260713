#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  buildServerEvidenceShadowSelfCheck,
  resolveServerEvidenceNtpSynchronization,
  runServerEvidenceShadowTick,
  summarizeServerEvidenceShadowState,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';

const mode = String(process.argv[2] ?? 'self-check').trim();

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function exactSha(value, code) {
  const normalized = required(value, code).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = required(value, code).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

async function deployedSha() {
  const path = process.env.SERVER_EVIDENCE_DEPLOY_SHA_FILE
    ?? '/opt/stock-app/.deploy/current-sha';
  return exactSha(
    await readFile(path, 'utf8'),
    'SERVER_EVIDENCE_DEPLOY_SHA_INVALID',
  );
}

async function activationBindingDigest() {
  const path = new URL(
    '../config/public-forward-liquidity-successor-schedule-reliability-activation-v3.json',
    import.meta.url,
  );
  const binding = JSON.parse(await readFile(path, 'utf8'));
  const digest = sha256(canonicalJson(binding));
  const expected = String(
    process.env.SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST ?? '',
  ).trim();
  if (expected && exactDigest(
    expected,
    'SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST_INVALID',
  ) !== digest) {
    throw new Error('SERVER_EVIDENCE_ACTIVATION_BINDING_DIGEST_MISMATCH');
  }
  return digest;
}

function ntpSynchronized() {
  let output;
  try {
    output = execFileSync(
      '/usr/bin/timedatectl',
      ['show', '-p', 'NTPSynchronized', '--value'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    return resolveServerEvidenceNtpSynchronization({
      timedatectlSucceeded: false,
      timedatectlValue: null,
      systemdSyncMarkerPresent: existsSync('/run/systemd/timesync/synchronized'),
    });
  }
  return resolveServerEvidenceNtpSynchronization({
    timedatectlSucceeded: true,
    timedatectlValue: output,
    systemdSyncMarkerPresent: false,
  });
}

function stateRoot() {
  return process.env.SERVER_EVIDENCE_STATE_ROOT
    ?? '/var/lib/stock-app-server-evidence-shadow-v1';
}

async function selfCheck() {
  const report = buildServerEvidenceShadowSelfCheck();
  const bindingDigest = await activationBindingDigest();
  process.stdout.write(`${JSON.stringify({
    ...report,
    computedActivationBindingDigest: bindingDigest,
    runtimeActivated: false,
    networkRequestPerformed: false,
  })}\n`);
}

async function tick() {
  const codeSha = await deployedSha();
  const activationReceiptMainSha = exactSha(
    process.env.SERVER_EVIDENCE_ACTIVATION_RECEIPT_MAIN_SHA,
    'SERVER_EVIDENCE_ACTIVATION_RECEIPT_MAIN_SHA_INVALID',
  );
  const activationReceiptCommentId = positiveInteger(
    process.env.SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID,
    'SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID_INVALID',
  );
  const bindingDigest = await activationBindingDigest();

  const result = await runServerEvidenceShadowTick({
    nowMs: Date.now(),
    stateRoot: stateRoot(),
    codeSha,
    activationReceiptCommentId,
    activationReceiptMainSha,
    activationBindingDigest: bindingDigest,
    shadowOnly: process.env.SERVER_EVIDENCE_SHADOW_ONLY ?? 'true',
    serverCanonical: process.env.SERVER_EVIDENCE_SERVER_CANONICAL ?? 'false',
    ntpSynchronized: ntpSynchronized(),
  });
  process.stdout.write(`${JSON.stringify({
    captureStatus: result.receipt.captureStatus,
    slotIndex: result.receipt.slotIndex,
    split: result.receipt.split,
    rawBatchPresent: result.rawBatch !== null,
    rawBatchDigest: result.receipt.rawBatchDigest,
    receiptDigest: result.receipt.receiptDigest,
    prospectiveSlotCredit: result.receipt.prospectiveSlotCredit,
    canonicalEconomicCredit: result.receipt.canonicalEconomicCredit,
    fullCostReady: result.receipt.fullCostReady,
    evidenceComplete: result.receipt.evidenceComplete,
    profitabilityProven: result.receipt.profitabilityProven,
    executionAuthority: result.receipt.executionAuthority,
  })}\n`);
}

async function status() {
  const summary = await summarizeServerEvidenceShadowState({
    stateRoot: stateRoot(),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (mode === 'self-check') await selfCheck();
else if (mode === 'tick') await tick();
else if (mode === 'status') await status();
else throw new Error('SERVER_EVIDENCE_SHADOW_RUNNER_MODE_INVALID');
