import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  V3_COHORT_START_DELAY_MS,
  buildProspectiveLiquidityPolicyV3Artifact,
  verifyProspectiveLiquidityPolicyV3Artifact,
} from '../src/public-forward-liquidity-prospective-policy-v3.mjs';

function integerEnv(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}_INVALID`);
  return value;
}

const exactHeadSha = String(process.env.EXACT_HEAD_SHA ?? '').trim().toLowerCase();
const policyFrozenAtMs = integerEnv('POLICY_FROZEN_AT_MS');
const outputDir = resolve(process.env.OUTPUT_DIR ?? 'public-forward-liquidity-prospective-policy-v3');

const artifact = buildProspectiveLiquidityPolicyV3Artifact({
  exactHeadSha,
  policyFrozenAtMs,
  symbol: String(process.env.SYMBOL ?? 'BTCUSDT'),
  cohortStartDelayMs: V3_COHORT_START_DELAY_MS,
});
const verification = verifyProspectiveLiquidityPolicyV3Artifact(artifact);
if (!verification.valid) {
  throw new Error(`PROSPECTIVE_POLICY_V3_INVALID:${verification.blockers.join(',')}`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(
  resolve(outputDir, 'prospective-policy-artifact-v3.json'),
  `${JSON.stringify(artifact, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify({
  status: 'PROSPECTIVE_POLICY_V3_FROZEN',
  policyVersion: artifact.policy.policyVersion,
  artifactDigest: artifact.artifactDigest,
  cohortIdentity: artifact.cohort.cohortIdentity,
  cohortEligibleAfterMs: artifact.cohort.cohortEligibleAfterMs,
  cohortEndExclusiveMs: artifact.cohort.cohortEndExclusiveMs,
  captureIntervalMs: artifact.captureSelectionPolicy.slotIntervalMs,
  captureTriggerType: artifact.captureSelectionPolicy.triggerType,
  overallMinimums: artifact.policy.overallMinimums,
  outcomeHorizonMs: artifact.outcomeMethodology.outcomeHorizonMs,
  captureScheduleActivated: artifact.readiness.CAPTURE_SCHEDULE_ACTIVATED,
  newProspectiveSampleN: artifact.readiness.NEW_PROSPECTIVE_SAMPLE_N,
  fullCostReady: artifact.readiness.FULL_COST_READY,
  evidenceComplete: artifact.readiness.EVIDENCE_COMPLETE,
}));
