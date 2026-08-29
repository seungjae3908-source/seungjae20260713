import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildProspectiveLiquidityPolicyArtifact,
  verifyProspectiveLiquidityPolicyArtifact,
} from '../src/public-forward-liquidity-prospective-policy.mjs';

function integerEnv(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}_INVALID`);
  return value;
}

const exactHeadSha = String(process.env.EXACT_HEAD_SHA ?? '').trim().toLowerCase();
const policyFrozenAtMs = integerEnv('POLICY_FROZEN_AT_MS');
const outputDir = resolve(process.env.OUTPUT_DIR ?? 'public-forward-liquidity-prospective-policy');
const artifact = buildProspectiveLiquidityPolicyArtifact({
  exactHeadSha,
  policyFrozenAtMs,
  symbol: String(process.env.SYMBOL ?? 'BTCUSDT'),
});
const verification = verifyProspectiveLiquidityPolicyArtifact(artifact);
if (!verification.valid) throw new Error(`PROSPECTIVE_POLICY_INVALID:${verification.blockers.join(',')}`);
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'prospective-policy-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  status: 'PROSPECTIVE_POLICY_CANDIDATE_FROZEN',
  artifactDigest: artifact.artifactDigest,
  policyDigest: artifact.policy.policyDigest,
  policyFrozenAtMs: artifact.policy.policyFrozenAtMs,
  cohortEligibleAfterMs: artifact.cohort.cohortEligibleAfterMs,
  cohortEndExclusiveMs: artifact.cohort.cohortEndExclusiveMs,
  overallMinimums: artifact.policy.overallMinimums,
  sideMinimums: artifact.policy.scopeMinimums.map(({ aggressiveSide, minimums }) => ({ aggressiveSide, minimums })),
  outcomeHorizonMs: artifact.outcomeMethodology.outcomeHorizonMs,
  historicalObservationCredit: 0,
  fullCostReady: false,
  evidenceComplete: 0,
  executionAuthority: 'NONE',
}));
