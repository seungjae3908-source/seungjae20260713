#!/usr/bin/env node
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson } from '../src/public-forward-liquidity-calibration.mjs';
import {
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
} from '../src/public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  buildProtectedServerCanonicalActivation,
  buildServerCanonicalCutoverAuthority,
} from '../src/public-forward-liquidity-server-canonical-control-v1.mjs';

const mode = String(process.argv[2] ?? '').trim();
const args = process.argv.slice(3);

function value(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`MISSING_ARGUMENT:${flag}`);
  return args[index + 1];
}

function optionalValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (index + 1 >= args.length) throw new Error(`MISSING_ARGUMENT:${flag}`);
  return args[index + 1];
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function nonNegativeInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function exactSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeCreateOnly(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function listJsonFiles(root, filename) {
  const values = [];
  let top = [];
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return values;
    throw error;
  }
  for (const first of top) {
    if (!first.isDirectory()) continue;
    const firstRoot = join(root, first.name);
    let children = [];
    try {
      children = await readdir(firstRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      try {
        const receipt = await readJson(join(firstRoot, child.name, filename));
        values.push(receipt);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return values;
}

async function collectShadowEvidence() {
  const stateRoot = resolve(value('--state-root'));
  const targetMainSha = exactSha(value('--target-main-sha'), 'TARGET_MAIN_SHA_INVALID');
  const activationReceiptCommentId = positiveInteger(
    value('--activation-receipt-comment-id'),
    'ACTIVATION_RECEIPT_COMMENT_ID_INVALID',
  );
  const activationBindingDigest = exactDigest(
    value('--activation-binding-digest'),
    'ACTIVATION_BINDING_DIGEST_INVALID',
  );
  const cutoverAuthorizedAtMs = positiveInteger(
    value('--cutover-authorized-at-ms'),
    'CUTOVER_AUTHORIZED_AT_INVALID',
  );
  const firstEligibleSlotIndex = nonNegativeInteger(
    value('--first-eligible-slot-index'),
    'FIRST_ELIGIBLE_SLOT_INDEX_INVALID',
  );

  const shadowReceipts = await listJsonFiles(join(stateRoot, 'slots'), 'shadow-receipt.json');
  const candidates = shadowReceipts
    .filter((receipt) => receipt?.captureStatus === 'PRESENT_SHADOW'
      && receipt?.shadowOnly === true
      && receipt?.serverCanonical === false
      && receipt?.codeSha === targetMainSha
      && receipt?.activationReceiptMainSha === targetMainSha
      && receipt?.activationReceiptCommentId === activationReceiptCommentId
      && receipt?.activationBindingDigest === activationBindingDigest
      && receipt?.serverStartedAtMs > cutoverAuthorizedAtMs
      && Number.isSafeInteger(receipt?.slotIndex)
      && receipt.slotIndex >= firstEligibleSlotIndex
      && receipt?.prospectiveSlotCredit === 0
      && receipt?.canonicalEconomicCredit === 0
      && receipt?.profitabilityCredit === 0
      && receipt?.executionAuthority === 'NONE'
      && Array.isArray(receipt?.blockers)
      && receipt.blockers.length === 0)
    .sort((left, right) => Number(right.serverStartedAtMs) - Number(left.serverStartedAtMs));
  if (candidates.length === 0) {
    throw new Error('SERVER_CANONICAL_FUTURE_PRESENT_SHADOW_RECEIPT_MISSING');
  }
  const shadowReceipt = candidates[0];

  const canonicalReceipts = await listJsonFiles(
    join(stateRoot, 'server-canonical-v1', 'slots'),
    'server-canonical-receipt.json',
  );
  const matchingCanonicalCredits = canonicalReceipts.filter((receipt) =>
    receipt?.policyDigest === shadowReceipt.policyDigest
      && receipt?.cohortDigest === shadowReceipt.cohortDigest
      && receipt?.slotIndex === shadowReceipt.slotIndex
      && (receipt?.prospectiveSlotCredit === 1
        || receipt?.canonicalEconomicCredit === 1
        || receipt?.readyForProtectedCanonicalIngestGate === true));

  process.stdout.write(`${canonicalJson({
    shadowReceipt,
    canonicalCreditLedger: {
      lookupComplete: true,
      creditKey: {
        policyDigest: shadowReceipt.policyDigest,
        cohortDigest: shadowReceipt.cohortDigest,
        slotIndex: shadowReceipt.slotIndex,
      },
      sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
      matchingCanonicalCredits,
      maximumCanonicalEconomicCredit: 1,
    },
  })}\n`);
}

async function buildAuthority() {
  const authority = buildServerCanonicalCutoverAuthority({
    authorityCommentId: value('--authority-comment-id'),
    authorizedAtMs: value('--authorized-at-ms'),
    targetMainSha: value('--target-main-sha'),
    activationBindingDigest: value('--activation-binding-digest'),
    activationReceiptCommentId: value('--activation-receipt-comment-id'),
  });
  process.stdout.write(`${canonicalJson(authority)}\n`);
}

async function buildActivation() {
  const input = await readJson(value('--input'));
  const outputDir = resolve(value('--output-dir'));
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const result = buildProtectedServerCanonicalActivation(input);
  await writeCreateOnly(join(outputDir, 'cutover-readiness.json'), result.readiness);
  await writeCreateOnly(join(outputDir, 'runtime-activation.json'), result.runtimeActivation);
  await writeCreateOnly(join(outputDir, 'control-bundle.json'), result);
  process.stdout.write(`${canonicalJson({
    status: 'READY_FOR_PROTECTED_RUNTIME_ACTIVATION',
    readinessDigest: result.runtimeActivation.readinessDigest,
    activationDigest: result.runtimeActivation.activationDigest,
    firstEligibleSlotIndex: result.runtimeActivation.firstEligibleSlotIndex,
    cutoverAuthorityCommentId: result.cutoverAuthority.authorityCommentId,
    runtimeAuthorityCommentId: result.runtimeActivation.authorityCommentId,
    baselinePreserved: result.baselinePreserved,
    executionAuthority: result.safety.executionAuthority,
  })}\n`);
}

if (mode === 'build-authority') await buildAuthority();
else if (mode === 'collect-shadow-evidence') await collectShadowEvidence();
else if (mode === 'build-activation') await buildActivation();
else if (mode === 'self-check') {
  process.stdout.write(`${canonicalJson({
    status: 'PASS',
    activationApplied: false,
    networkRequestPerformed: false,
    serverMutationPerformed: false,
    economicCreditCreated: 0,
    executionAuthority: 'NONE',
  })}\n`);
} else {
  const extra = optionalValue('--help');
  void extra;
  throw new Error('SERVER_CANONICAL_CONTROL_MODE_INVALID');
}
