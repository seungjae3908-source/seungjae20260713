import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import { SUCCESSOR_PROSPECTIVE_CONTRACT } from '../src/public-forward-liquidity-successor-prospective-cohort.mjs';
import {
  bindSuccessorV3GithubScheduleMetadataReceipt,
  normalizeSuccessorV3GithubScheduleCreatedAt,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  executeSuccessorScheduledCaptureSeam,
  executeSuccessorScheduledCaptureSeamV3,
  finalizeSuccessorArtifactReceipt,
} from '../src/public-forward-liquidity-successor-schedule-seam-v1.mjs';

const API_ORIGIN = 'https://api.github.com';
const mode = String(process.argv[2] ?? '').trim();
const outputDir = resolve(
  process.env.OUTPUT_DIR || 'public-forward-liquidity-successor-capture',
);
const COLLECTOR_PATH = 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';
const EXPECTED_COLLECTOR_BLOB_SHA =
  SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.technicalIdentity.collectorImplementationBlobSha;

function requiredString(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function requiredInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function requiredPositiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function exactSha(value, code) {
  const normalized = requiredString(value, code).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = requiredString(value, code)
    .replace(/^sha256:/u, '')
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function gitBlobSha(path) {
  return exactSha(
    execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim(),
    'SUCCESSOR_COLLECTOR_ACTUAL_BLOB_SHA_INVALID',
  );
}

function verifyFrozenCollectorBlob() {
  const expected = exactSha(
    EXPECTED_COLLECTOR_BLOB_SHA,
    'SUCCESSOR_COLLECTOR_EXPECTED_BLOB_SHA_INVALID',
  );
  const actual = gitBlobSha(COLLECTOR_PATH);
  if (actual !== expected) throw new Error('SUCCESSOR_FROZEN_COLLECTOR_BLOB_MISMATCH');
  return Object.freeze({ path: COLLECTOR_PATH, expected, actual });
}

function parseRepository(value) {
  const normalized = requiredString(value, 'SUCCESSOR_GITHUB_REPOSITORY_MISSING');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) {
    throw new Error('SUCCESSOR_GITHUB_REPOSITORY_INVALID');
  }
  const [owner, repo] = normalized.split('/');
  return Object.freeze({ owner, repo, fullName: normalized });
}

function githubToken() {
  return requiredString(
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    'SUCCESSOR_GITHUB_TOKEN_MISSING',
  );
}

async function githubGet(path, token) {
  if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//u.test(path)) {
    throw new Error('SUCCESSOR_GITHUB_API_PATH_INVALID');
  }
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'successor-forward-schedule-seam-v1',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`SUCCESSOR_GITHUB_API_READ_FAILED:${response.status}`);
  }
  return response.json();
}

function appendGithubOutput(entries) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${String(value ?? '')}`);
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

async function loadSchedulePayload() {
  const path = requiredString(
    process.env.GITHUB_EVENT_PATH,
    'SUCCESSOR_GITHUB_EVENT_PATH_MISSING',
  );
  const payload = JSON.parse(await readFile(path, 'utf8'));
  const scheduleExpression = requiredString(
    payload?.schedule,
    'SUCCESSOR_GITHUB_SCHEDULE_PAYLOAD_MISSING',
  );
  return Object.freeze({ payload, scheduleExpression });
}

function canonicalRawArtifactName(captureReceipt) {
  if (!Number.isInteger(captureReceipt?.slotIndex)) {
    throw new Error('SUCCESSOR_CAPTURE_RECEIPT_SLOT_INDEX_MISSING');
  }
  const slotKeyDigest = exactDigest(
    captureReceipt.canonicalSlotKeyDigest,
    'SUCCESSOR_CAPTURE_RECEIPT_SLOT_KEY_DIGEST_INVALID',
  );
  return `public-forward-liquidity-successor-slot-${captureReceipt.slotIndex}-${slotKeyDigest}`;
}

function attemptArtifactName(captureReceipt, { runId, runAttempt }) {
  const canonicalName = canonicalRawArtifactName(captureReceipt);
  if (captureReceipt.prospectiveSlotCredit === 1) return canonicalName;
  return `${canonicalName}-diagnostic-${runId}-${runAttempt}`;
}

async function verifyRunIdentity({ repository, token, runId, runAttempt, exactMainSha }) {
  const run = await githubGet(
    `/repos/${repository.owner}/${repository.repo}/actions/runs/${runId}`,
    token,
  );
  if (run?.event !== 'schedule') throw new Error('SUCCESSOR_GITHUB_RUN_EVENT_NOT_SCHEDULE');
  if (String(run?.head_branch ?? '') !== 'main') {
    throw new Error('SUCCESSOR_GITHUB_RUN_HEAD_BRANCH_NOT_MAIN');
  }
  if (exactSha(run?.head_sha, 'SUCCESSOR_GITHUB_RUN_HEAD_SHA_INVALID') !== exactMainSha) {
    throw new Error('SUCCESSOR_GITHUB_RUN_HEAD_SHA_MISMATCH');
  }
  if (requiredPositiveInteger(run?.run_attempt, 'SUCCESSOR_GITHUB_RUN_ATTEMPT_INVALID') !== runAttempt) {
    throw new Error('SUCCESSOR_GITHUB_RUN_ATTEMPT_MISMATCH');
  }
  const createdAtMs = Date.parse(String(run?.created_at ?? ''));
  if (!Number.isInteger(createdAtMs) || createdAtMs < 0) {
    throw new Error('SUCCESSOR_GITHUB_RUN_CREATED_AT_INVALID');
  }
  return Object.freeze({ run, createdAtMs });
}

async function currentRemoteMainSha({ repository, token }) {
  const branch = await githubGet(
    `/repos/${repository.owner}/${repository.repo}/branches/main`,
    token,
  );
  return exactSha(branch?.commit?.sha, 'SUCCESSOR_REMOTE_MAIN_SHA_INVALID');
}

async function priorCreditedSlotExists({ repository, token, lookup }) {
  const canonicalName = `public-forward-liquidity-successor-slot-${lookup.slotIndex}-${lookup.canonicalSlotKeyDigest}`;
  const name = encodeURIComponent(canonicalName);
  const artifacts = await githubGet(
    `/repos/${repository.owner}/${repository.repo}/actions/artifacts?per_page=100&name=${name}`,
    token,
  );
  if (!Array.isArray(artifacts?.artifacts)) {
    throw new Error('SUCCESSOR_ARTIFACT_INDEX_RESPONSE_INVALID');
  }
  return artifacts.artifacts.some((artifact) =>
    artifact?.expired === false && artifact?.name === canonicalName);
}

async function persistCaptureResult({ batch, captureReceipt, runId, runAttempt }) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  if (batch !== null) {
    await writeFile(
      resolve(outputDir, 'raw-batch.json'),
      `${JSON.stringify(batch, null, 2)}\n`,
      'utf8',
    );
  }
  await writeFile(
    resolve(outputDir, 'capture-receipt.json'),
    `${JSON.stringify(captureReceipt, null, 2)}\n`,
    'utf8',
  );
  const terminal = Object.freeze({
    captureStatus: captureReceipt.captureStatus,
    prospectiveSlotCredit: captureReceipt.prospectiveSlotCredit,
    rawBatchPresent: batch !== null,
    rawBatchDigest: captureReceipt.rawBatchDigest,
    priorCreditedSlotCheck: captureReceipt.priorCreditedSlotCheck,
    blockers: [...(captureReceipt.blockers ?? [])],
    slotIndex: captureReceipt.slotIndex ?? null,
    split: captureReceipt.split ?? null,
    canonicalRawArtifactName: captureReceipt.slotIndex == null
      ? null
      : canonicalRawArtifactName(captureReceipt),
    attemptArtifactName: captureReceipt.slotIndex == null
      ? null
      : attemptArtifactName(captureReceipt, { runId, runAttempt }),
    fullCostReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  });
  await writeFile(
    resolve(outputDir, 'capture-terminal.json'),
    `${JSON.stringify(terminal, null, 2)}\n`,
    'utf8',
  );
  appendGithubOutput({
    capture_status: terminal.captureStatus,
    prospective_slot_credit: terminal.prospectiveSlotCredit,
    raw_batch_present: terminal.rawBatchPresent,
    slot_index: terminal.slotIndex ?? '',
    split: terminal.split ?? '',
    canonical_raw_artifact_name: terminal.canonicalRawArtifactName ?? '',
    attempt_artifact_name: terminal.attemptArtifactName ?? '',
  });
  console.log(JSON.stringify(terminal));
}

async function runCapture(executor = executeSuccessorScheduledCaptureSeam) {
  if (process.env.GITHUB_EVENT_NAME !== 'schedule') {
    throw new Error('SUCCESSOR_RUNNER_REQUIRES_GITHUB_SCHEDULE_EVENT');
  }
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('SUCCESSOR_RUNNER_REQUIRES_DEFAULT_MAIN_REF');
  }
  const collectorBlob = verifyFrozenCollectorBlob();

  const repository = parseRepository(process.env.GITHUB_REPOSITORY);
  const token = githubToken();
  const runId = requiredPositiveInteger(process.env.GITHUB_RUN_ID, 'SUCCESSOR_GITHUB_RUN_ID_INVALID');
  const runAttempt = requiredPositiveInteger(
    process.env.GITHUB_RUN_ATTEMPT,
    'SUCCESSOR_GITHUB_RUN_ATTEMPT_INVALID',
  );
  const exactMainSha = exactSha(process.env.GITHUB_SHA, 'SUCCESSOR_GITHUB_SHA_INVALID');
  const { scheduleExpression } = await loadSchedulePayload();
  const runIdentity = await verifyRunIdentity({
    repository,
    token,
    runId,
    runAttempt,
    exactMainSha,
  });
  const actualRunStartedAtMs = Date.now();
  const v3ScheduleMetadata = executor === executeSuccessorScheduledCaptureSeamV3
    ? normalizeSuccessorV3GithubScheduleCreatedAt({
        scheduleExpression,
        scheduledRunCreatedAtMs: runIdentity.createdAtMs,
        actualRunStartedAtMs,
      })
    : null;
  const authorityCreatedAtMs = v3ScheduleMetadata?.authorityCreatedAtMs
    ?? runIdentity.createdAtMs;

  let { batch, captureReceipt } = await executor({
    eventName: process.env.GITHUB_EVENT_NAME,
    scheduleExpression,
    scheduledRunCreatedAtMs: authorityCreatedAtMs,
    exactMainSha,
    defaultBranchRef: process.env.GITHUB_REF,
    actualRunStartedAtMs,
    runAttempt,
    runId,
    repository: repository.fullName,
    hasPriorCreditedSlot: async (lookup) => priorCreditedSlotExists({
      repository,
      token,
      lookup,
    }),
    getRemoteMainSha: async () => currentRemoteMainSha({ repository, token }),
  });

  if (v3ScheduleMetadata !== null) {
    captureReceipt = bindSuccessorV3GithubScheduleMetadataReceipt({
      captureReceipt,
      scheduleMetadata: v3ScheduleMetadata,
    });
  }

  if (captureReceipt.collectorImplementationBlobSha !== collectorBlob.actual) {
    throw new Error('SUCCESSOR_CAPTURE_RECEIPT_COLLECTOR_BLOB_MISMATCH');
  }
  await persistCaptureResult({
    batch,
    captureReceipt,
    runId,
    runAttempt,
  });
}

async function verifyUploadedArtifact({ repository, token, artifactId, artifactName, artifactDigest, runId }) {
  const artifact = await githubGet(
    `/repos/${repository.owner}/${repository.repo}/actions/artifacts/${artifactId}`,
    token,
  );
  if (artifact?.expired !== false) throw new Error('SUCCESSOR_UPLOADED_ARTIFACT_EXPIRED');
  if (artifact?.name !== artifactName) throw new Error('SUCCESSOR_UPLOADED_ARTIFACT_NAME_MISMATCH');
  if (exactDigest(artifact?.digest, 'SUCCESSOR_UPLOADED_ARTIFACT_DIGEST_INVALID') !== artifactDigest) {
    throw new Error('SUCCESSOR_UPLOADED_ARTIFACT_DIGEST_MISMATCH');
  }
  if (artifact?.workflow_run?.id != null
    && requiredPositiveInteger(artifact.workflow_run.id, 'SUCCESSOR_UPLOADED_ARTIFACT_RUN_ID_INVALID') !== runId) {
    throw new Error('SUCCESSOR_UPLOADED_ARTIFACT_RUN_ID_MISMATCH');
  }
  return artifact;
}

async function runBindArtifact() {
  const repository = parseRepository(process.env.GITHUB_REPOSITORY);
  const token = githubToken();
  const runId = requiredPositiveInteger(process.env.GITHUB_RUN_ID, 'SUCCESSOR_GITHUB_RUN_ID_INVALID');
  const captureReceipt = JSON.parse(
    await readFile(resolve(outputDir, 'capture-receipt.json'), 'utf8'),
  );
  const artifactId = requiredPositiveInteger(
    process.env.ARTIFACT_ID,
    'SUCCESSOR_ARTIFACT_ID_INVALID',
  );
  const artifactName = requiredString(
    process.env.ARTIFACT_NAME,
    'SUCCESSOR_ARTIFACT_NAME_MISSING',
  );
  const artifactDigest = exactDigest(
    process.env.ARTIFACT_DIGEST,
    'SUCCESSOR_ARTIFACT_DIGEST_INVALID',
  );
  const expectedName = attemptArtifactName(captureReceipt, {
    runId,
    runAttempt: requiredPositiveInteger(
      process.env.GITHUB_RUN_ATTEMPT,
      'SUCCESSOR_GITHUB_RUN_ATTEMPT_INVALID',
    ),
  });
  if (artifactName !== expectedName) {
    throw new Error('SUCCESSOR_ARTIFACT_NAME_NOT_BOUND_TO_CAPTURE_RECEIPT');
  }

  await verifyUploadedArtifact({
    repository,
    token,
    artifactId,
    artifactName,
    artifactDigest,
    runId,
  });

  const artifactReceipt = finalizeSuccessorArtifactReceipt({
    captureReceipt,
    artifactId: String(artifactId),
    artifactDigest,
    artifactName,
    artifactReference: `https://github.com/${repository.fullName}/actions/runs/${runId}/artifacts/${artifactId}`,
  });
  await writeFile(
    resolve(outputDir, 'artifact-receipt.json'),
    `${JSON.stringify(artifactReceipt, null, 2)}\n`,
    'utf8',
  );
  const identity = Object.freeze({
    artifactId: String(artifactId),
    artifactName,
    artifactDigest,
    rawBatchDigest: artifactReceipt.rawBatchDigest,
    captureReceiptDigest: artifactReceipt.captureReceiptDigest,
    receiptDigest: artifactReceipt.receiptDigest,
    prospectiveSlotCredit: artifactReceipt.prospectiveSlotCredit,
    slotIndex: artifactReceipt.slotIndex,
    split: artifactReceipt.split,
    executionAuthority: 'NONE',
  });
  await writeFile(
    resolve(outputDir, 'artifact-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
    'utf8',
  );
  appendGithubOutput({
    receipt_digest: artifactReceipt.receiptDigest,
    artifact_id: artifactId,
    artifact_name: artifactName,
    artifact_digest: artifactDigest,
  });
  console.log(JSON.stringify(identity));
}

async function runSelfCheck() {
  const collectorBlob = verifyFrozenCollectorBlob();
  const source = await readFile(
    new URL('../src/public-forward-liquidity-successor-schedule-seam-v1.mjs', import.meta.url),
    'utf8',
  );
  const self = await readFile(new URL(import.meta.url), 'utf8');
  const identity = Object.freeze({
    schemaVersion: 'public-forward-liquidity-successor-schedule-runner-self-check-v1',
    seamSourceDigest: sha256(canonicalJson(source)),
    runnerSourceDigest: sha256(canonicalJson(self)),
    collectorPath: collectorBlob.path,
    expectedCollectorBlobSha: collectorBlob.expected,
    actualCollectorBlobSha: collectorBlob.actual,
    collectorBlobVerified: true,
    v3CaptureModeAvailable: true,
    activationTriggerPresent: false,
    scheduleExecutionPerformed: false,
    collectorInvoked: false,
    networkRequestPerformed: false,
    prospectiveSlotCredit: 0,
    fullCostReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  });
  console.log(JSON.stringify(identity));
}

if (mode === 'self-check') await runSelfCheck();
else if (mode === 'capture') await runCapture(executeSuccessorScheduledCaptureSeam);
else if (mode === 'capture-v3') await runCapture(executeSuccessorScheduledCaptureSeamV3);
else if (mode === 'bind-artifact') await runBindArtifact();
else throw new Error('SUCCESSOR_RUNNER_MODE_INVALID');
