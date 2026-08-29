import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  canonicalJson,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  CAPTURE_PARAMETER_POLICY,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  MANUAL_TRIGGER_SOURCE,
  SCHEDULED_TRIGGER_SOURCE,
  V3_POLICY_BINDING,
  buildCompleteWindowAttemptLog,
  executeCaptureSeam,
  finalizeArtifactReceipt,
  resolveScheduledAuthority,
  verifyActivationContract,
} from '../src/public-forward-liquidity-capture-seam-v3.mjs';

const mode = String(process.argv[2] ?? 'capture').trim();
const outputDir = resolve(process.env.OUTPUT_DIR || 'public-forward-liquidity-capture');
const contractPath = resolve(process.env.ACTIVATION_CONTRACT_PATH || 'market-intelligence-sidecar/config/public-forward-liquidity-v3-activation-contract.json');
const scheduledWorkflowPath = '.github/workflows/public-forward-liquidity-calibration-scheduled-v3.yml';
const captureWorkflowPath = '.github/workflows/public-forward-liquidity-calibration-capture.yml';
const collectorPath = 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';
const seamSourcePath = 'market-intelligence-sidecar/src/public-forward-liquidity-capture-seam-v3.mjs';
const seamRunnerPath = 'market-intelligence-sidecar/scripts/run-public-forward-liquidity-capture-seam-v3.mjs';

function gitBlobSha(path) {
  return execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim().toLowerCase();
}

async function loadActivationContract() {
  return JSON.parse(await readFile(contractPath, 'utf8'));
}

function appendGithubOutput(entries) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${String(value ?? '')}`);
  return import('node:fs').then(({ appendFileSync }) => appendFileSync(path, `${lines.join('\n')}\n`, 'utf8'));
}

function requiredInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function captureParametersFromEnv() {
  const eventObservationDelayMs = process.env.EVENT_DELAY_MS == null
    ? CAPTURE_PARAMETER_POLICY.eventObservationDelayMs
    : requiredInteger(process.env.EVENT_DELAY_MS, 'EVENT_DELAY_MS_INVALID');
  const post1 = process.env.POST_DELAY_1_MS == null
    ? CAPTURE_PARAMETER_POLICY.postObservationDelaysMs[0]
    : requiredInteger(process.env.POST_DELAY_1_MS, 'POST_DELAY_1_MS_INVALID');
  const post2 = process.env.POST_DELAY_2_MS == null
    ? CAPTURE_PARAMETER_POLICY.postObservationDelaysMs[1]
    : requiredInteger(process.env.POST_DELAY_2_MS, 'POST_DELAY_2_MS_INVALID');
  const maxAge = process.env.MAX_PRE_EVENT_BOOK_AGE_MS == null
    ? CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs
    : requiredInteger(process.env.MAX_PRE_EVENT_BOOK_AGE_MS, 'MAX_PRE_EVENT_BOOK_AGE_MS_INVALID');
  return { eventObservationDelayMs, postObservationDelaysMs: [post1, post2], maxPreEventBookAgeMs: maxAge };
}

function buildLegacyManualCaptureReceipt(captureReceipt, batch) {
  if (captureReceipt?.triggerSource !== MANUAL_TRIGGER_SOURCE) return captureReceipt;
  return Object.freeze({
    schemaVersion: 'public-forward-liquidity-capture-receipt-v1',
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT',
    triggerSource: MANUAL_TRIGGER_SOURCE,
    runId: String(captureReceipt.runId ?? ''),
    runAttempt: String(captureReceipt.runAttempt ?? ''),
    repository: String(captureReceipt.repository ?? ''),
    exactMainSha: captureReceipt.exactMainSha,
    collectorCodeSha: captureReceipt.collectorCodeSha,
    symbol: captureReceipt.symbol,
    sampleClass: captureReceipt.sampleClass,
    eventObservationDelayMs: captureReceipt.eventObservationDelayMs,
    postObservationDelaysMs: [...(captureReceipt.postObservationDelaysMs ?? [])],
    maxPreEventBookAgeMs: captureReceipt.maxPreEventBookAgeMs,
    captureStatus: captureReceipt.captureStatus,
    blockers: [...(captureReceipt.blockers ?? [])],
    prospectiveObservationCount: captureReceipt.prospectiveObservationCount,
    droppedObservationCount: captureReceipt.droppedObservationCount,
    datasetProvenance: batch?.datasetProvenance ?? null,
    rawBatchDigest: captureReceipt.rawBatchDigest,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    realOrders: 0,
  });
}

function buildLegacyManualArtifactReceipt(captureReceipt, { artifactId, artifactDigest, artifactName, artifactReference }) {
  const normalizedArtifactId = String(artifactId ?? '').trim();
  if (!/^[0-9]+$/u.test(normalizedArtifactId)) throw new Error('ARTIFACT_ID_INVALID');
  const normalizedArtifactDigest = String(artifactDigest ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedArtifactDigest)) throw new Error('ARTIFACT_DIGEST_INVALID');
  const body = {
    schemaVersion: 'public-forward-liquidity-capture-artifact-receipt-v1',
    exactMainSha: captureReceipt.exactMainSha,
    collectorCodeSha: captureReceipt.collectorCodeSha,
    captureStatus: captureReceipt.captureStatus,
    rawBatchDigest: captureReceipt.rawBatchDigest,
    prospectiveObservationCount: captureReceipt.prospectiveObservationCount,
    artifactId: normalizedArtifactId,
    artifactName: String(artifactName ?? '').trim(),
    artifactDigest: normalizedArtifactDigest,
    artifactReference,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    fullCostReady: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

async function verifyActivation() {
  const contract = await loadActivationContract();
  const fileIdentity = {
    scheduledWorkflowBlobSha: gitBlobSha(scheduledWorkflowPath),
    captureWorkflowBlobSha: gitBlobSha(captureWorkflowPath),
    collectorBlobSha: gitBlobSha(collectorPath),
    seamSourceBlobSha: gitBlobSha(seamSourcePath),
    seamRunnerBlobSha: gitBlobSha(seamRunnerPath),
  };
  const verification = verifyActivationContract(contract, fileIdentity);
  const extraBlockers = [];
  if (contract?.v3PolicyInternalArtifactDigest !== V3_POLICY_BINDING.policyInternalArtifactDigest) {
    extraBlockers.push('ACTIVATION_V3_INTERNAL_ARTIFACT_DIGEST_MISMATCH');
  }
  if (contract?.v3CohortId !== V3_POLICY_BINDING.cohortId) extraBlockers.push('ACTIVATION_V3_COHORT_ID_MISMATCH');
  if (contract?.seamSourceBlobSha !== fileIdentity.seamSourceBlobSha) extraBlockers.push('ACTIVATION_SEAM_SOURCE_SHA_MISMATCH');
  if (contract?.seamRunnerBlobSha !== fileIdentity.seamRunnerBlobSha) extraBlockers.push('ACTIVATION_SEAM_RUNNER_SHA_MISMATCH');
  if (contract?.replayCredit !== 0 || contract?.backfillCredit !== 0 || contract?.operatorSelectedCredit !== 0) {
    extraBlockers.push('ACTIVATION_NON_SCHEDULED_CREDIT_BOUNDARY_INVALID');
  }
  if (contract?.scheduleActivated !== false) extraBlockers.push('ACTIVATION_CONTRACT_MUST_BE_PRE_ACTIVATION');
  if (!verification.valid || extraBlockers.length > 0) {
    throw new Error(`ACTIVATION_CONTRACT_INVALID:${[...verification.blockers, ...extraBlockers].join(',')}`);
  }
  return {
    contract,
    fileIdentity,
    verification: Object.freeze({ valid: true, blockers: Object.freeze([]) }),
  };
}

async function runSlotPreflight() {
  const actualRunStartedAtMs = requiredInteger(process.env.ACTUAL_RUN_STARTED_AT_MS ?? Date.now(), 'ACTUAL_RUN_STARTED_AT_MS_INVALID');
  const authority = resolveScheduledAuthority({
    scheduleExpression: process.env.SCHEDULE_EXPRESSION,
    actualRunStartedAtMs,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    duplicateCanonicalArtifact: false,
  });
  if (!authority.slot) throw new Error(`SCHEDULE_SLOT_UNBOUND:${authority.blocker}`);
  const artifactName = `public-forward-liquidity-v3-slot-${authority.slot.slotIndex}-${authority.slot.canonicalSlotKeyDigest}`;
  const summary = {
    slotIndex: authority.slot.slotIndex,
    split: authority.slot.split,
    slotStartMs: authority.slot.slotStartMs,
    slotEndMs: authority.slot.slotEndMs,
    nominalScheduledAtMs: authority.slot.nominalScheduledAtMs,
    actualRunStartedAtMs,
    cronUtc: authority.slot.cronUtc,
    canonicalSlotKeyDigest: authority.slot.canonicalSlotKeyDigest,
    preflightStatus: authority.captureStatus,
    preflightEligible: authority.eligible,
    artifactName,
  };
  await appendGithubOutput({
    slot_index: summary.slotIndex,
    split: summary.split,
    slot_key_digest: summary.canonicalSlotKeyDigest,
    raw_artifact_name: artifactName,
    nominal_scheduled_at_ms: summary.nominalScheduledAtMs,
    slot_end_ms: summary.slotEndMs,
    preflight_status: summary.preflightStatus,
    preflight_eligible: summary.preflightEligible,
  });
  console.log(JSON.stringify(summary));
}

async function runCapture() {
  const triggerSource = String(process.env.CAPTURE_TRIGGER_SOURCE || MANUAL_TRIGGER_SOURCE).trim();
  const exactMainSha = String(process.env.EXPECTED_SHA || process.env.GITHUB_SHA || '').trim().toLowerCase();
  const actualRunStartedAtMs = requiredInteger(process.env.ACTUAL_RUN_STARTED_AT_MS ?? Date.now(), 'ACTUAL_RUN_STARTED_AT_MS_INVALID');
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? 1);
  let scheduledAuthority = null;
  let activationContract = null;
  if (triggerSource === SCHEDULED_TRIGGER_SOURCE) {
    const verified = await verifyActivation();
    activationContract = verified.contract;
    scheduledAuthority = resolveScheduledAuthority({
      scheduleExpression: process.env.SCHEDULE_EXPRESSION,
      actualRunStartedAtMs,
      runAttempt,
      duplicateCanonicalArtifact: String(process.env.DUPLICATE_CANONICAL_ARTIFACT ?? 'false').toLowerCase() === 'true',
    });
    if (!scheduledAuthority.slot) throw new Error(`SCHEDULE_SLOT_UNBOUND:${scheduledAuthority.blocker}`);
  }

  const parameters = captureParametersFromEnv();
  const { batch, captureReceipt } = await executeCaptureSeam({
    triggerSource,
    exactMainSha,
    symbol: process.env.SYMBOL || V3_POLICY_BINDING.symbol,
    ...parameters,
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt,
    repository: process.env.GITHUB_REPOSITORY || '',
    actualRunStartedAtMs,
    scheduledAuthority,
    activationContract,
  });
  const persistedCaptureReceipt = triggerSource === MANUAL_TRIGGER_SOURCE
    ? buildLegacyManualCaptureReceipt(captureReceipt, batch)
    : captureReceipt;

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  if (batch) await writeFile(resolve(outputDir, 'raw-batch.json'), `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outputDir, 'capture-receipt.json'), `${JSON.stringify(persistedCaptureReceipt, null, 2)}\n`, 'utf8');
  const terminal = {
    captureStatus: persistedCaptureReceipt.captureStatus,
    prospectiveSlotCredit: persistedCaptureReceipt.prospectiveSlotCredit ?? 0,
    ATTEMPTED: persistedCaptureReceipt.ATTEMPTED ?? true,
    rawBatchPresent: Boolean(batch),
    rawBatchDigest: persistedCaptureReceipt.rawBatchDigest,
    blockers: persistedCaptureReceipt.blockers,
  };
  await writeFile(resolve(outputDir, 'capture-terminal.json'), `${JSON.stringify(terminal, null, 2)}\n`, 'utf8');
  await appendGithubOutput({
    capture_status: terminal.captureStatus,
    prospective_slot_credit: terminal.prospectiveSlotCredit,
    raw_batch_present: terminal.rawBatchPresent,
  });
  console.log(JSON.stringify(terminal));
}

async function runBindArtifact() {
  const captureReceipt = JSON.parse(await readFile(resolve(outputDir, 'capture-receipt.json'), 'utf8'));
  const artifactId = process.env.ARTIFACT_ID;
  const artifactDigest = process.env.ARTIFACT_DIGEST;
  const artifactName = process.env.ARTIFACT_NAME;
  const artifactReference = artifactId && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts/${artifactId}`
    : null;
  const artifactReceipt = captureReceipt.schemaVersion === 'public-forward-liquidity-capture-receipt-v1'
    ? buildLegacyManualArtifactReceipt(captureReceipt, { artifactId, artifactDigest, artifactName, artifactReference })
    : finalizeArtifactReceipt({ captureReceipt, artifactId, artifactDigest, artifactName, artifactReference });
  await writeFile(resolve(outputDir, 'artifact-receipt.json'), `${JSON.stringify(artifactReceipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    receiptDigest: artifactReceipt.receiptDigest,
    artifactId: artifactReceipt.artifactId,
    artifactDigest: artifactReceipt.artifactDigest,
    captureStatus: artifactReceipt.captureStatus,
    prospectiveSlotCredit: artifactReceipt.prospectiveSlotCredit ?? 0,
  }));
}

async function runVerifyActivation() {
  const result = await verifyActivation();
  const report = {
    activationContractPresent: true,
    activationContractDigest: result.contract.activationContractDigest,
    exactScheduledWorkflowSha: result.fileIdentity.scheduledWorkflowBlobSha,
    captureWorkflowSha: result.fileIdentity.captureWorkflowBlobSha,
    collectorCodeSha: result.fileIdentity.collectorBlobSha,
    seamSourceBlobSha: result.fileIdentity.seamSourceBlobSha,
    seamRunnerBlobSha: result.fileIdentity.seamRunnerBlobSha,
    captureParameterPolicyDigest: CAPTURE_PARAMETER_POLICY_DIGEST,
    valid: result.verification.valid,
    blockers: result.verification.blockers,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'activation-contract-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const initialAttemptLog = buildCompleteWindowAttemptLog([], { asOfMs: V3_POLICY_BINDING.cohortEligibleAfterMs - 1 });
  await writeFile(resolve(outputDir, 'complete-window-attempt-log-initial.json'), `${JSON.stringify(initialAttemptLog, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}

async function runMarkStaleMain() {
  const path = resolve(outputDir, 'capture-receipt.json');
  const captureReceipt = JSON.parse(await readFile(path, 'utf8'));
  if (captureReceipt.schemaVersion === 'public-forward-liquidity-capture-receipt-v1') {
    captureReceipt.captureStatus = 'STALE_MAIN_DURING_CAPTURE';
    captureReceipt.blockers = [...new Set([...(captureReceipt.blockers ?? []), 'REMOTE_MAIN_MOVED_DURING_CAPTURE'])];
    captureReceipt.canonicalDatasetCreditApplied = false;
    captureReceipt.fullCostReady = false;
    captureReceipt.evidenceCompleteCredit = 0;
    await writeFile(path, `${JSON.stringify(captureReceipt, null, 2)}\n`, 'utf8');
  } else {
    const { captureReceiptDigest: _ignored, ...body } = captureReceipt;
    body.captureStatus = 'STALE_MAIN_DURING_CAPTURE';
    body.blockers = [...new Set([...(body.blockers ?? []), 'REMOTE_MAIN_MOVED_DURING_CAPTURE'])];
    body.prospectiveSlotCredit = 0;
    body.canonicalDatasetCreditApplied = false;
    body.fullCostReady = false;
    body.evidenceCompleteCredit = 0;
    const updated = { ...body, captureReceiptDigest: sha256(canonicalJson(body)) };
    await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }
  const updated = JSON.parse(await readFile(path, 'utf8'));
  const terminal = {
    captureStatus: updated.captureStatus,
    prospectiveSlotCredit: updated.prospectiveSlotCredit ?? 0,
    ATTEMPTED: updated.ATTEMPTED ?? true,
    rawBatchPresent: await readFile(resolve(outputDir, 'raw-batch.json'), 'utf8').then(() => true).catch(() => false),
    rawBatchDigest: updated.rawBatchDigest,
    blockers: updated.blockers,
  };
  await writeFile(resolve(outputDir, 'capture-terminal.json'), `${JSON.stringify(terminal, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(terminal));
}

async function runAssertTerminal() {
  const terminal = JSON.parse(await readFile(resolve(outputDir, 'capture-terminal.json'), 'utf8'));
  const allowDiagnostic = String(process.env.ALLOW_DIAGNOSTIC_ONLY ?? 'false').toLowerCase() === 'true';
  if (terminal.captureStatus === 'PRESENT') return;
  if (allowDiagnostic && terminal.captureStatus === 'DIAGNOSTIC_ONLY') return;
  throw new Error(`CAPTURE_NOT_PRESENT:${terminal.captureStatus}:${(terminal.blockers ?? []).join(',')}`);
}

switch (mode) {
  case 'slot-preflight':
    await runSlotPreflight();
    break;
  case 'capture':
    await runCapture();
    break;
  case 'bind-artifact':
    await runBindArtifact();
    break;
  case 'verify-activation':
    await runVerifyActivation();
    break;
  case 'mark-stale-main':
    await runMarkStaleMain();
    break;
  case 'assert-terminal':
    await runAssertTerminal();
    break;
  default:
    throw new Error(`CAPTURE_SEAM_MODE_INVALID:${mode}`);
}
