import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readResearchSameCandidateRuntimeStages,
  validateResearchSameCandidatePrewire,
} from './research-same-candidate-prewire.service';
import type { ResearchBundleResolution } from './research-bundle.contract';

const SHA = 'a'.repeat(40);
const STRATEGY = '1'.repeat(64);
const MODEL = '2'.repeat(64);
const BUNDLE = '3'.repeat(64);
const FEATURE = '4'.repeat(64);
const ARTIFACT = '5'.repeat(64);
const DATASET_DIGEST = '6'.repeat(64);
const DATASET = 'research-dataset-v1';

function researchFixture(): ResearchBundleResolution {
  return {
    schemaVersion: 'research-bundle-resolution-v1',
    dslValid: true,
    dslDigest: '7'.repeat(64),
    bundleDigest: BUNDLE,
    strategyIdentityDigest: STRATEGY,
    modelIdentityDigest: MODEL,
    featureOrderDigest: FEATURE,
    preprocessingVersion: 'preprocess-v1',
    researchBundleReady: true,
    backtestExecutable: false,
    backtestSubmitted: true,
    backtestCompleted: true,
    backtestStatus: 'COMPLETED',
    backtesterCalls: 0,
    resultArtifactDigest: ARTIFACT,
    publicationStatus: 'READBACK_VERIFIED',
    components: [],
    blockers: [],
    wfStatus: 'NOT_EVALUATED',
    oosStatus: 'NOT_EVALUATED',
    holdoutStatus: 'NOT_EVALUATED',
    wfEvidencePresent: false,
    oosEvidencePresent: false,
    holdoutEvidencePresent: false,
    statisticalFirewallPass: false,
    statisticalFirewallStatus: 'MISSING_EVIDENCE',
    promotionEligible: false,
    profitabilityProven: false,
    champion: null,
    evidenceCredit: 0,
    executionAuthority: 'NONE',
    receipt: {
      bundleDigest: BUNDLE,
      strategyIdentityDigest: STRATEGY,
      modelIdentityDigest: MODEL,
      featureOrderDigest: FEATURE,
      preprocessingVersion: 'preprocess-v1',
      datasetIdentity: DATASET,
      datasetDigest: DATASET_DIGEST,
      riskPolicyId: 'risk-v1',
      riskPolicyVersion: 'risk-policy-v1',
      costPolicyIdentity: 'cost-v1',
      researchCodeSha: SHA,
    },
  } as ResearchBundleResolution;
}

function canonicalOutput(datasetIdentity = DATASET) {
  const measured = (count: number) => ({
    status: 'MEASURED',
    count,
    blocker: null,
    provenance: 'canonical-natural-test',
    observationIds: Array.from({ length: count }, (_, index) => `obs-${index + 1}`),
  });
  return {
    schemaVersion: 'paper-forward-schedule-cli-v5',
    naturalRuntimeSha: SHA,
    canonicalNaturalStageEvidence: {
      schemaVersion: 'canonical-natural-paper-stage-evidence-v1',
      identity: {
        cycleId: 'cycle-1',
        strategyIdentityDigest: STRATEGY,
        modelIdentityDigest: MODEL,
        runtimeSha: SHA,
        datasetIdentity,
      },
      stageCounts: {
        signalCandidate: measured(2),
        entry: measured(1),
        settlement: measured(1),
      },
    },
  };
}

async function writeRuntime(root: string, payload: unknown) {
  const stdoutPath = join(root, 'runs', 'run-1', 'paper-forward', 'stdout.log');
  await mkdir(join(root, 'latest'), { recursive: true });
  await mkdir(join(root, 'runs', 'run-1', 'paper-forward'), { recursive: true });
  await writeFile(join(root, 'latest', 'forward.json'), JSON.stringify({
    results: [{ id: 'paper-forward', stdoutPath }],
  }));
  await writeFile(stdoutPath, `non-json log line\n${JSON.stringify(payload)}\n`);
}

test('natural Paper readback preserves research dataset identity for Forward/Paper/Settlement matching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-prewire-dataset-'));
  try {
    const research = researchFixture();
    await writeRuntime(root, canonicalOutput());
    const stages = await readResearchSameCandidateRuntimeStages(research, { stateRoot: root });

    assert.equal(stages.forward.runtimeStatus, 'PRESENT');
    assert.equal(stages.paper.runtimeStatus, 'PRESENT');
    assert.equal(stages.settlement.runtimeStatus, 'PRESENT');
    assert.equal(stages.forward.datasetIdentity, DATASET);
    assert.equal(stages.paper.datasetIdentity, DATASET);
    assert.equal(stages.settlement.datasetIdentity, DATASET);
    assert.ok(!stages.forward.blockers.includes('FORWARD_RUNTIME_RESEARCH_DATASET_IDENTITY_UNAVAILABLE'));
    assert.ok(!stages.paper.blockers.includes('PAPER_RUNTIME_RESEARCH_DATASET_IDENTITY_UNAVAILABLE'));
    assert.ok(!stages.settlement.blockers.includes('SETTLEMENT_RUNTIME_RESEARCH_DATASET_IDENTITY_UNAVAILABLE'));

    const result = validateResearchSameCandidatePrewire(research, stages);
    assert.equal(result.stages.FORWARD.status, 'IDENTITY_MATCHED');
    assert.equal(result.stages.PAPER.status, 'IDENTITY_MATCHED');
    assert.equal(result.stages.SETTLEMENT.status, 'IDENTITY_MATCHED');
    assert.equal(result.stages.SHADOW.status, 'MISSING_EVIDENCE');
    assert.equal(result.status, 'PREWIRED_WAITING_EVIDENCE');
    assert.equal(result.evidenceCredit, 0);
    assert.equal(result.profitabilityProven, false);
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.liveTrading, false);
    assert.equal(result.privateTradingApiAllowed, false);
    assert.equal(result.orderSubmitted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wrong natural Paper dataset identity remains fail-closed as identity mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-prewire-dataset-mismatch-'));
  try {
    const research = researchFixture();
    await writeRuntime(root, canonicalOutput('wrong-dataset'));
    const stages = await readResearchSameCandidateRuntimeStages(research, { stateRoot: root });
    const result = validateResearchSameCandidatePrewire(research, stages);

    assert.equal(result.stages.FORWARD.status, 'IDENTITY_MISMATCH');
    assert.equal(result.stages.PAPER.status, 'IDENTITY_MISMATCH');
    assert.equal(result.stages.SETTLEMENT.status, 'IDENTITY_MISMATCH');
    assert.equal(result.status, 'IDENTITY_MISMATCH');
    assert.equal(result.allIdentityStagesMatched, false);
    assert.equal(result.executionAuthority, 'NONE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing natural Paper dataset identity remains blocked and receives zero evidence credit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-prewire-dataset-missing-'));
  try {
    const research = researchFixture();
    await writeRuntime(root, canonicalOutput(''));
    const stages = await readResearchSameCandidateRuntimeStages(research, { stateRoot: root });
    assert.ok(stages.forward.blockers.includes('FORWARD_RUNTIME_RESEARCH_DATASET_IDENTITY_UNAVAILABLE'));
    assert.ok(stages.paper.blockers.includes('PAPER_RUNTIME_RESEARCH_DATASET_IDENTITY_UNAVAILABLE'));
    assert.ok(stages.settlement.blockers.includes('SETTLEMENT_RUNTIME_RESEARCH_DATASET_IDENTITY_UNAVAILABLE'));

    const result = validateResearchSameCandidatePrewire(research, stages);
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.evidenceCredit, 0);
    assert.equal(result.profitabilityProven, false);
    assert.equal(result.champion, null);
    assert.equal(result.executionAuthority, 'NONE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
