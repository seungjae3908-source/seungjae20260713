import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  CAPTURE_PARAMETER_POLICY,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  SCHEDULED_TRIGGER_SOURCE,
  V3_POLICY_BINDING,
  buildCompleteWindowAttemptLog,
  buildV3ScheduleEntries,
} from '../src/public-forward-liquidity-capture-seam-v3.mjs';

export const STRICT_COMPLETE_WINDOW_VERIFIER_CONTRACT =
  'public-forward-liquidity-v3-complete-window-verifier-v1';

const ACTIVATION_CONTRACT_PATH =
  'market-intelligence-sidecar/config/public-forward-liquidity-v3-activation-contract.json';
const VERIFIER_WORKFLOW_PATH =
  '.github/workflows/public-forward-liquidity-v3-complete-window-verifier.yml';
const VERIFIER_SCRIPT_PATH =
  'market-intelligence-sidecar/scripts/verify-public-forward-liquidity-v3-complete-window.mjs';
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const DECIMAL = /^[0-9]+$/u;
const FINAL_RECEIPT_ARTIFACT = /^public-forward-liquidity-v3-slot-receipt-(\d+)-(\d+)-(\d+)$/u;
const ALLOWED_CAPTURE_STATUSES = new Set([
  'PRESENT',
  'BLOCKED_DATA',
  'PROVIDER_FAILURE',
  'VALIDATION_FAILURE',
  'DIAGNOSTIC_ONLY',
  'MISSED_SLOT',
  'PRE_ELIGIBILITY_ATTEMPT',
  'STALE_MAIN_DURING_CAPTURE',
]);

function fail(code) {
  throw new Error(code);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function integer(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(code);
  return parsed;
}

function positiveInteger(value, code) {
  const parsed = integer(value, code);
  if (parsed <= 0) fail(code);
  return parsed;
}

function decimal(value, code) {
  const normalized = String(value ?? '').trim();
  if (!DECIMAL.test(normalized)) fail(code);
  return normalized;
}

function sha256Digest(value, code) {
  const normalized = String(value ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) fail(code);
  return normalized;
}

function sha1(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA1.test(normalized)) fail(code);
  return normalized;
}

function gitBlobSha(path) {
  return execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim().toLowerCase();
}

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

function expectedRawArtifactName(receipt, slot) {
  const canonical = `public-forward-liquidity-v3-slot-${slot.slotIndex}-${slot.canonicalSlotKeyDigest}`;
  const diagnostic = `${canonical}-diagnostic-${receipt.runId}-${receipt.runAttempt}`;
  const startedOutsideSlot = Number(receipt.actualRunStartedAtMs) >= slot.slotEndMs;
  if (receipt.captureStatus === 'DIAGNOSTIC_ONLY'
    || receipt.captureStatus === 'PRE_ELIGIBILITY_ATTEMPT'
    || (receipt.captureStatus === 'MISSED_SLOT' && startedOutsideSlot)) {
    return diagnostic;
  }
  return canonical;
}

function verifyReceiptDigests(receipt) {
  const finalDigest = sha256Digest(receipt.receiptDigest, 'FINAL_RECEIPT_DIGEST_INVALID');
  const finalBody = withoutKeys(receipt, new Set(['receiptDigest']));
  if (sha256(canonicalJson(finalBody)) !== finalDigest) fail('FINAL_RECEIPT_DIGEST_MISMATCH');

  const captureDigest = sha256Digest(receipt.captureReceiptDigest, 'CAPTURE_RECEIPT_DIGEST_INVALID');
  const captureBody = withoutKeys(receipt, new Set([
    'artifactId',
    'artifactName',
    'artifactDigest',
    'artifactReference',
    'receiptDigest',
    'captureReceiptDigest',
  ]));
  if (receipt.schemaVersion === 'public-forward-liquidity-capture-artifact-receipt-v3') {
    captureBody.schemaVersion = 'public-forward-liquidity-capture-receipt-v3';
  }
  if (sha256(canonicalJson(captureBody)) !== captureDigest) fail('CAPTURE_RECEIPT_DIGEST_MISMATCH');
}

export function verifyScheduledFinalReceipt({ receipt, metadata, activationContract }) {
  const item = object(receipt, 'FINAL_RECEIPT_INVALID');
  const meta = object(metadata, 'RECEIPT_ARTIFACT_METADATA_INVALID');
  const contract = object(activationContract, 'ACTIVATION_CONTRACT_MISSING');

  if (![
    'public-forward-liquidity-capture-receipt-v3',
    'public-forward-liquidity-capture-artifact-receipt-v3',
  ].includes(item.schemaVersion)) fail('FINAL_RECEIPT_SCHEMA_INVALID');
  if (item.evidenceClass !== 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ATTEMPT_RECEIPT') {
    fail('FINAL_RECEIPT_EVIDENCE_CLASS_INVALID');
  }
  if (item.triggerSource !== SCHEDULED_TRIGGER_SOURCE || item.ATTEMPTED !== true) {
    fail('FINAL_RECEIPT_TRIGGER_AUTHORITY_INVALID');
  }

  verifyReceiptDigests(item);

  if (item.policyVersion !== V3_POLICY_BINDING.policyVersion
    || item.policyDigest !== V3_POLICY_BINDING.policyDigest
    || String(item.policyArtifactId ?? '') !== V3_POLICY_BINDING.policyArtifactId
    || item.policyArtifactDigest !== V3_POLICY_BINDING.policyArtifactDigest
    || item.policyInternalArtifactDigest !== V3_POLICY_BINDING.policyInternalArtifactDigest
    || item.cohortId !== V3_POLICY_BINDING.cohortId
    || item.cohortDigest !== V3_POLICY_BINDING.cohortDigest
    || item.cohortEligibleAfterMs !== V3_POLICY_BINDING.cohortEligibleAfterMs
    || item.captureSelectionPolicyDigest !== V3_POLICY_BINDING.captureSelectionPolicyDigest
    || item.slotIntervalMs !== V3_POLICY_BINDING.slotIntervalMs) {
    fail('FINAL_RECEIPT_V3_BINDING_MISMATCH');
  }
  if (item.activationContractDigest !== contract.activationContractDigest
    || item.activationContractVersion !== contract.activationContractVersion) {
    fail('FINAL_RECEIPT_ACTIVATION_CONTRACT_MISMATCH');
  }
  if (item.captureParameterPolicyDigest !== CAPTURE_PARAMETER_POLICY_DIGEST
    || item.eventObservationDelayMs !== CAPTURE_PARAMETER_POLICY.eventObservationDelayMs
    || canonicalJson(item.postObservationDelaysMs) !== canonicalJson(CAPTURE_PARAMETER_POLICY.postObservationDelaysMs)
    || item.maxPreEventBookAgeMs !== CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs) {
    fail('FINAL_RECEIPT_CAPTURE_PARAMETER_POLICY_MISMATCH');
  }

  const exactMainSha = sha1(item.exactMainSha, 'FINAL_RECEIPT_MAIN_SHA_INVALID');
  if (sha1(item.collectorCodeSha, 'FINAL_RECEIPT_COLLECTOR_SHA_INVALID') !== exactMainSha
    || item.collectorImplementationBlobSha !== CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha) {
    fail('FINAL_RECEIPT_COLLECTOR_IDENTITY_MISMATCH');
  }
  if (item.repository !== 'seungjae3908-source/seungjae20260713'
    || item.market !== V3_POLICY_BINDING.market
    || item.symbol !== V3_POLICY_BINDING.symbol
    || item.sampleClass !== 'FORWARD_NATURAL_SAMPLE') {
    fail('FINAL_RECEIPT_SCOPE_MISMATCH');
  }

  const slotIndex = integer(item.slotIndex, 'FINAL_RECEIPT_SLOT_INDEX_INVALID');
  const slot = buildV3ScheduleEntries()[slotIndex];
  if (!slot) fail('FINAL_RECEIPT_SLOT_OUT_OF_RANGE');
  if (item.split !== slot.split
    || item.slotStartMs !== slot.slotStartMs
    || item.slotEndMs !== slot.slotEndMs
    || item.nominalScheduledAtMs !== slot.nominalScheduledAtMs
    || item.cronUtc !== slot.cronUtc
    || canonicalJson(item.canonicalSlotKey) !== canonicalJson(slot.canonicalSlotKey)
    || item.canonicalSlotKeyDigest !== slot.canonicalSlotKeyDigest) {
    fail('FINAL_RECEIPT_SLOT_BINDING_MISMATCH');
  }

  const runId = decimal(item.runId, 'FINAL_RECEIPT_RUN_ID_INVALID');
  const runAttempt = positiveInteger(item.runAttempt, 'FINAL_RECEIPT_RUN_ATTEMPT_INVALID');
  const actualRunStartedAtMs = integer(item.actualRunStartedAtMs, 'FINAL_RECEIPT_RUN_START_INVALID');
  const actualRunCompletedAtMs = integer(item.actualRunCompletedAtMs, 'FINAL_RECEIPT_RUN_COMPLETION_INVALID');
  if (actualRunCompletedAtMs < actualRunStartedAtMs) fail('FINAL_RECEIPT_NEGATIVE_RUNTIME');
  if (!ALLOWED_CAPTURE_STATUSES.has(item.captureStatus)) fail('FINAL_RECEIPT_CAPTURE_STATUS_INVALID');

  const slotCredit = integer(item.prospectiveSlotCredit, 'FINAL_RECEIPT_SLOT_CREDIT_INVALID');
  if (![0, 1].includes(slotCredit)) fail('FINAL_RECEIPT_SLOT_CREDIT_INVALID');
  if (slotCredit === 1) {
    if (item.captureStatus !== 'PRESENT'
      || runAttempt !== 1
      || actualRunStartedAtMs < slot.nominalScheduledAtMs
      || actualRunStartedAtMs >= slot.slotEndMs
      || actualRunCompletedAtMs >= slot.slotEndMs) {
      fail('FINAL_RECEIPT_CREDIT_ESCALATION');
    }
  }
  if (actualRunCompletedAtMs >= slot.slotEndMs && item.captureStatus !== 'MISSED_SLOT') {
    fail('FINAL_RECEIPT_LATE_COMPLETION_NOT_FAILED_CLOSED');
  }
  if (runAttempt !== 1 && item.captureStatus !== 'DIAGNOSTIC_ONLY') {
    fail('FINAL_RECEIPT_RERUN_NOT_DIAGNOSTIC');
  }
  if (item.captureStatus === 'DIAGNOSTIC_ONLY' && slotCredit !== 0) {
    fail('FINAL_RECEIPT_DIAGNOSTIC_CREDIT_INVALID');
  }
  if (item.captureStatus === 'PRESENT') {
    sha256Digest(item.rawBatchDigest, 'FINAL_RECEIPT_RAW_BATCH_DIGEST_INVALID');
  }

  if (item.manualCredit !== 0
    || item.replayCredit !== 0
    || item.backfillCredit !== 0
    || item.operatorSelectedCredit !== 0
    || item.canonicalDatasetPersistencePerformed !== false
    || item.canonicalDatasetCreditApplied !== false
    || item.splitAssignmentPerformed !== false
    || item.oosValidationComplete !== false
    || item.calibrationArtifactProduced !== false
    || item.liquidityImpactPresent !== false
    || item.fullCostReady !== false
    || item.evidenceCompleteCredit !== 0
    || item.naturalEntryCredit !== 0
    || item.runtimeCostCredit !== 0
    || item.executionAuthority !== 'NONE'
    || item.privateApiUsed !== false
    || item.liveTrading !== false
    || item.orderSubmitted !== false
    || item.realOrders !== 0) {
    fail('FINAL_RECEIPT_SAFETY_OR_CREDIT_BOUNDARY_INVALID');
  }

  const rawArtifactId = decimal(item.artifactId, 'FINAL_RECEIPT_RAW_ARTIFACT_ID_INVALID');
  sha256Digest(item.artifactDigest, 'FINAL_RECEIPT_RAW_ARTIFACT_DIGEST_INVALID');
  const expectedReference = `https://github.com/${item.repository}/actions/runs/${runId}/artifacts/${rawArtifactId}`;
  if (item.artifactReference !== expectedReference || item.artifactName !== expectedRawArtifactName(item, slot)) {
    fail('FINAL_RECEIPT_RAW_ARTIFACT_BINDING_MISMATCH');
  }

  const receiptArtifactName = String(meta.receiptArtifactName ?? '').trim();
  const nameMatch = FINAL_RECEIPT_ARTIFACT.exec(receiptArtifactName);
  if (!nameMatch
    || Number(nameMatch[1]) !== slotIndex
    || nameMatch[2] !== runId
    || Number(nameMatch[3]) !== runAttempt) {
    fail('FINAL_RECEIPT_ARTIFACT_NAME_MISMATCH');
  }
  decimal(meta.receiptArtifactId, 'FINAL_RECEIPT_ARTIFACT_ID_INVALID');
  sha256Digest(meta.receiptArtifactDigest, 'FINAL_RECEIPT_ARTIFACT_DIGEST_INVALID');
  if (meta.expired !== false
    || String(meta.workflowRunId ?? '') !== runId
    || meta.workflowRunHeadBranch !== 'main'
    || sha1(meta.workflowRunHeadSha, 'FINAL_RECEIPT_WORKFLOW_HEAD_INVALID') !== exactMainSha) {
    fail('FINAL_RECEIPT_GITHUB_PROVENANCE_MISMATCH');
  }

  return Object.freeze({ ...item });
}

function withElapsedExpectedCounts(log, { asOfMs }) {
  const now = integer(asOfMs, 'VERIFIER_AS_OF_INVALID');
  const schedule = buildV3ScheduleEntries();
  const splits = {};
  let expectedTotalSlotN = 0;
  for (const split of ['TRAIN', 'VALIDATION', 'OOS']) {
    const policyExpectedSlotN = V3_POLICY_BINDING.slotCounts[split];
    const expectedSlotN = schedule.filter(
      (slot) => slot.split === split && slot.nominalScheduledAtMs <= now,
    ).length;
    expectedTotalSlotN += expectedSlotN;
    splits[split] = Object.freeze({
      ...log.splits[split],
      policyExpectedSlotN,
      expectedSlotN,
    });
  }
  return Object.freeze({
    ...log,
    policyExpectedTotalSlotN: 48,
    expectedTotalSlotN,
    splits: Object.freeze(splits),
  });
}

export function buildStrictCompleteWindowLog(receipts, { asOfMs }) {
  const raw = buildCompleteWindowAttemptLog(receipts, { asOfMs });
  return withElapsedExpectedCounts(raw, { asOfMs });
}

export function verifyProducedCompleteWindow({ receipts, producedLog, sourceSummary }) {
  const log = object(producedLog, 'PRODUCED_COMPLETE_WINDOW_LOG_MISSING');
  const summary = object(sourceSummary, 'PRODUCED_COMPLETE_WINDOW_SUMMARY_MISSING');
  const asOfMs = integer(log.asOfMs, 'PRODUCED_COMPLETE_WINDOW_AS_OF_INVALID');
  const inScope = receipts.filter((receipt) => Number(receipt.actualRunStartedAtMs) <= asOfMs);
  const expected = buildStrictCompleteWindowLog(inScope, { asOfMs });
  if (canonicalJson(log) !== canonicalJson(expected)) fail('PRODUCED_COMPLETE_WINDOW_LOG_MISMATCH');
  if (summary.schemaVersion !== 'public-forward-liquidity-v3-complete-window-source-summary-v1'
    || summary.asOfMs !== asOfMs
    || summary.acceptedScheduledReceiptN !== inScope.length
    || summary.policyDigest !== V3_POLICY_BINDING.policyDigest
    || summary.cohortDigest !== V3_POLICY_BINDING.cohortDigest
    || summary.selectionComplete !== log.selectionComplete
    || summary.fullCostReady !== false
    || summary.evidenceComplete !== 0) {
    fail('PRODUCED_COMPLETE_WINDOW_SUMMARY_MISMATCH');
  }
  return Object.freeze({ expected, inScopeReceiptN: inScope.length });
}

async function loadJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(code);
  }
}

async function findMetadataFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await findMetadataFiles(path));
    else if (entry.isFile() && entry.name === 'receipt-artifact-metadata.json') files.push(path);
  }
  return files;
}

export async function verifyVerifierBinding({ activationContractPath = ACTIVATION_CONTRACT_PATH } = {}) {
  const contract = await loadJson(resolve(activationContractPath), 'VERIFIER_ACTIVATION_CONTRACT_MISSING');
  const workflowSha = gitBlobSha(VERIFIER_WORKFLOW_PATH);
  const scriptSha = gitBlobSha(VERIFIER_SCRIPT_PATH);
  if (contract.completeWindowVerifierContract !== STRICT_COMPLETE_WINDOW_VERIFIER_CONTRACT
    || contract.completeWindowVerifierWorkflowSha !== workflowSha
    || contract.completeWindowVerifierScriptSha !== scriptSha) {
    fail('STRICT_COMPLETE_WINDOW_VERIFIER_BINDING_MISMATCH');
  }
  return Object.freeze({ contract, workflowSha, scriptSha });
}

async function runRuntimeVerification() {
  const outputDir = resolve(process.env.OUTPUT_DIR || 'public-forward-liquidity-v3-complete-window-verification');
  await mkdir(outputDir, { recursive: true });
  const reportPath = resolve(outputDir, 'strict-complete-window-verification.json');
  const report = {
    schemaVersion: STRICT_COMPLETE_WINDOW_VERIFIER_CONTRACT,
    valid: false,
    blockers: [],
    fullCostReady: false,
    evidenceComplete: 0,
  };
  try {
    const binding = await verifyVerifierBinding();
    const receiptRoot = resolve(process.env.RECEIPT_ROOT || 'public-forward-liquidity-v3-verifier-receipts');
    const windowRoot = resolve(process.env.PRODUCED_WINDOW_ROOT || 'public-forward-liquidity-v3-produced-window');
    const metadataFiles = await findMetadataFiles(receiptRoot);
    const envelopes = [];
    for (const metadataPath of metadataFiles) {
      const metadata = await loadJson(metadataPath, 'RECEIPT_ARTIFACT_METADATA_UNREADABLE');
      const receiptPath = resolve(dirname(metadataPath), 'artifact-receipt.json');
      const receipt = await loadJson(receiptPath, 'FINAL_RECEIPT_UNREADABLE');
      envelopes.push({ receipt, metadata });
    }
    const producedLog = await loadJson(
      resolve(windowRoot, 'complete-window-attempt-log.json'),
      'PRODUCED_COMPLETE_WINDOW_LOG_MISSING',
    );
    const sourceSummary = await loadJson(
      resolve(windowRoot, 'complete-window-source-summary.json'),
      'PRODUCED_COMPLETE_WINDOW_SUMMARY_MISSING',
    );
    const validated = envelopes
      .filter(({ metadata }) => Number(metadata.receiptArtifactCreatedAtMs) <= Number(producedLog.asOfMs))
      .map(({ receipt, metadata }) => verifyScheduledFinalReceipt({
        receipt,
        metadata,
        activationContract: binding.contract,
      }));
    const comparison = verifyProducedCompleteWindow({
      receipts: validated,
      producedLog,
      sourceSummary,
    });
    report.valid = true;
    report.sourceWorkflowRunId = String(process.env.SOURCE_WORKFLOW_RUN_ID || '');
    report.sourceWorkflowHeadSha = String(process.env.SOURCE_WORKFLOW_HEAD_SHA || '');
    report.activationContractDigest = binding.contract.activationContractDigest;
    report.verifierWorkflowSha = binding.workflowSha;
    report.verifierScriptSha = binding.scriptSha;
    report.validatedReceiptN = validated.length;
    report.inScopeReceiptN = comparison.inScopeReceiptN;
    report.completeWindowLog = comparison.expected;
  } catch (error) {
    report.blockers = [String(error?.message || 'STRICT_COMPLETE_WINDOW_VERIFICATION_FAILED')];
  }
  report.verificationDigest = sha256(canonicalJson(withoutKeys(report, new Set(['verificationDigest']))));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
  if (!report.valid) process.exitCode = 1;
}

async function runBindingVerification() {
  const result = await verifyVerifierBinding();
  console.log(JSON.stringify({
    contract: STRICT_COMPLETE_WINDOW_VERIFIER_CONTRACT,
    workflowSha: result.workflowSha,
    scriptSha: result.scriptSha,
    activationContractDigest: result.contract.activationContractDigest,
    valid: true,
  }));
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(selfPath)) {
  const mode = String(process.argv[2] || 'verify-runtime');
  if (mode === 'verify-binding') await runBindingVerification();
  else if (mode === 'verify-runtime') await runRuntimeVerification();
  else fail(`STRICT_COMPLETE_WINDOW_VERIFIER_MODE_INVALID:${mode}`);
}
