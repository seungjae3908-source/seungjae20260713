import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  buildAttemptReceipt,
  buildCompleteWindowAttemptLog,
  canonicalJson,
  CAPTURE_PARAMETER_POLICY,
  CRON_UTC,
  resolveScheduledAttempt,
  SCHEDULE_TRIGGER_SOURCE,
  sha256,
  validateScheduledCaptureBatch,
  verifyV3ArtifactBinding,
} from '../src/public-forward-liquidity-v3-scheduled-capture-seam.mjs';
import { collectBitgetForwardLiquidityObservationBatch } from '../src/public-forward-liquidity-calibration.mjs';

const outputDir = String(process.env.OUTPUT_DIR ?? 'public-forward-liquidity-v3-scheduled-capture').trim();
const exactMainSha = String(process.env.EXACT_MAIN_SHA ?? '').trim().toLowerCase();
const runId = String(process.env.GITHUB_RUN_ID ?? '').trim();
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? '1');
const runCreatedAtMs = Number(process.env.RUN_CREATED_AT_MS);
const actualRunStartedAtMs = Number(process.env.ACTUAL_RUN_STARTED_AT_MS ?? Date.now());
const scheduleExpression = String(process.env.SCHEDULE_EXPRESSION ?? CRON_UTC).trim();
const priorScheduleRuns = JSON.parse(process.env.PRIOR_SCHEDULE_RUNS_JSON ?? '[]');
const policyArtifactPath = String(process.env.V3_POLICY_ARTIFACT_PATH ?? '').trim();
const mainExactAtStart = String(process.env.MAIN_EXACT_AT_START ?? 'false').trim() === 'true';

await mkdir(outputDir, { recursive: true });

const artifact = JSON.parse(await readFile(policyArtifactPath, 'utf8'));
const binding = verifyV3ArtifactBinding(artifact);
const metadataDigest = String(process.env.POLICY_ARTIFACT_METADATA_DIGEST ?? '').trim().replace(/^sha256:/u, '').toLowerCase();
const metadataBindingValid = metadataDigest === '476b302eb38d8b17c30d4f3ed0d97f87fd16118d5b201cc03d9aff4b26b8eb7a';

const scheduleResolution = resolveScheduledAttempt({
  runCreatedAtMs,
  actualRunStartedAtMs,
  runAttempt,
  priorScheduleRuns,
  scheduleExpression,
});

let captureStatus;
let rawBatchDigest = null;
let prospectiveObservationCount = 0;
let droppedObservationCount = 0;
let blockers = [];
let rawBatch = null;
let workflowFailure = false;

if (!mainExactAtStart) {
  captureStatus = 'VALIDATION_FAILURE';
  blockers = ['DEFAULT_BRANCH_EXACT_SHA_MISMATCH_AT_START'];
  workflowFailure = true;
} else if (!binding.valid || !metadataBindingValid) {
  captureStatus = 'VALIDATION_FAILURE';
  blockers = [
    ...binding.blockers,
    ...(metadataBindingValid ? [] : ['V3_POLICY_ARTIFACT_ZIP_DIGEST_MISMATCH']),
  ];
  workflowFailure = true;
} else if (!scheduleResolution.eligible) {
  if (scheduleResolution.status === 'MISSED_SLOT') captureStatus = 'MISSED_SLOT';
  else if (scheduleResolution.status === 'PRE_ELIGIBILITY') captureStatus = 'PRE_ELIGIBILITY';
  else captureStatus = 'DIAGNOSTIC_ONLY';
  blockers = [scheduleResolution.status];
  workflowFailure = ['MISSED_SLOT', 'WRONG_SCHEDULE_EXPRESSION', 'PRE_NOMINAL_SCHEDULE_EVENT'].includes(scheduleResolution.status);
} else {
  try {
    rawBatch = await collectBitgetForwardLiquidityObservationBatch({
      symbol: 'BTCUSDT',
      collectorCodeSha: exactMainSha,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      eventObservationDelayMs: CAPTURE_PARAMETER_POLICY.eventObservationDelayMs,
      postObservationDelaysMs: [...CAPTURE_PARAMETER_POLICY.postObservationDelaysMs],
      maxPreEventBookAgeMs: CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs,
    });
    const validation = validateScheduledCaptureBatch(rawBatch, { exactMainSha, symbol: 'BTCUSDT' });
    if (!validation.valid) {
      captureStatus = 'VALIDATION_FAILURE';
      blockers = [...validation.blockers];
      workflowFailure = true;
    } else {
      prospectiveObservationCount = rawBatch.observations.length;
      droppedObservationCount = rawBatch.droppedEvents.length;
      rawBatchDigest = sha256(canonicalJson(rawBatch));
      captureStatus = prospectiveObservationCount > 0 ? 'PRESENT' : 'BLOCKED_DATA';
      blockers = prospectiveObservationCount > 0
        ? []
        : ['FORWARD_OBSERVATIONS_EMPTY', ...Object.keys(rawBatch.datasetProvenance?.droppedReasons ?? {}).sort()];
    }
  } catch (error) {
    captureStatus = 'PROVIDER_FAILURE';
    blockers = [String(error?.message ?? 'PROVIDER_FAILURE')];
    workflowFailure = true;
  }
}

if (rawBatch) {
  await writeFile(`${outputDir}/raw-batch.json`, `${JSON.stringify(rawBatch, null, 2)}\n`, 'utf8');
}
const receipt = buildAttemptReceipt({
  triggerSource: SCHEDULE_TRIGGER_SOURCE,
  runId,
  runAttempt,
  exactMainSha,
  collectorCodeSha: exactMainSha,
  actualRunStartedAtMs,
  runCreatedAtMs,
  scheduleResolution,
  captureStatus,
  rawBatchDigest,
  prospectiveObservationCount,
  droppedObservationCount,
  blockers,
});
await writeFile(`${outputDir}/attempt-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
const completeness = buildCompleteWindowAttemptLog([receipt], { asOfMs: actualRunStartedAtMs });
await writeFile(`${outputDir}/complete-window-attempt-log-partial.json`, `${JSON.stringify(completeness, null, 2)}\n`, 'utf8');
const outcome = {
  captureStatus,
  scheduleAuthorityStatus: scheduleResolution.status,
  slotIndex: scheduleResolution.slotIndex ?? null,
  canonicalAttemptCredit: receipt.canonicalAttemptCredit,
  prospectiveCaptureCredit: receipt.prospectiveCaptureCredit,
  rawBatchDigest,
  prospectiveObservationCount,
  droppedObservationCount,
  blockers,
  workflowFailure,
};
await writeFile(`${outputDir}/capture-outcome.json`, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(outcome));
