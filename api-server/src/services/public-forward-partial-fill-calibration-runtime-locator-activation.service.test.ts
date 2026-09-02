import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  publishPublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-dataset-pointer.service';
import {
  publishPublicForwardPartialFillCalibrationReleaseBinding,
} from './public-forward-partial-fill-calibration-release-binding.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY,
  PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_KEYS,
  preparePublicForwardPartialFillRuntimeLocatorActivation,
} from './public-forward-partial-fill-calibration-runtime-locator-activation.service';

const repository = 'seungjae3908-source/seungjae20260713';
const collectorCodeSha = 'a'.repeat(40);
const runtimeReleaseSha = 'b'.repeat(40);
const approvedAt = '2026-09-01T00:00:00.000Z';
const researchRepoRoot = resolve(tmpdir(), 'partial-fill-locator-activation-research-repo');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function observation(id = 'obs-1'): PublicForwardPartialFillCalibrationObservation {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    observationId: id,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: `BTCUSDT-${id}`,
    collectorCodeSha,
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    observedAtMs: 3_000,
    passiveLimitPrice: 100,
    requestedQuantity: 2,
    eligiblePublicTouchQuantityUpperBound: 1,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: [`exec-${id}`],
    actualFillFraction: null,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1',
    sourceDigest: sha256(`source-${id}`),
    sourceObservationLineageId: `lineage-${id}`,
    sourceObservationLineageDigest: sha256(`lineage-${id}`),
    preEventBookDigest: sha256(`pre-${id}`),
    forwardPublicFillsDigest: sha256(`fills-${id}`),
    postEventBookDigest: sha256(`post-${id}`),
    endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
    forwardCalibrationSampleCredit: 1,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    calibrationArtifactProduced: false,
    durablePersistencePerformed: false,
    calibrationSampleSufficient: false,
    partialFillStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    privateApiUsed: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    orderSubmitted: false,
  };
}

async function withStateRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-locator-activation-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fixture(root: string) {
  const persisted = await persistPublicForwardPartialFillCalibrationDataset({
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    observations: [observation()],
    nowMs: 4_000,
  });
  const receiptDigest = sha256('locator-activation-receipt');
  const pointer = await publishPublicForwardPartialFillCalibrationDatasetPointer({
    stateRoot: root,
    researchRepoRoot,
    dataset: persisted.dataset,
    mutableDatasetRelativePath: persisted.datasetRelativePath,
    sourceIngestReceiptDigest: receiptDigest,
    sourceIngestReceiptRef: `ingest-receipt:sha256:${receiptDigest}`,
    publicationProvenance: {
      authority: 'CANONICAL_INGEST_PRODUCER',
      repository,
      exactMainSha: collectorCodeSha,
      captureRunId: '100',
      captureRunAttempt: '1',
      artifactId: '200',
    },
  });
  const binding = await publishPublicForwardPartialFillCalibrationReleaseBinding({
    stateRoot: root,
    researchRepoRoot,
    pointerRelativePath: pointer.pointer.pointerRelativePath,
    expectedPointerDigest: pointer.pointer.pointerDigest,
    releaseBindingIdentity: `locator-activation:${pointer.pointer.pointerDigest}`,
    releaseControlReference: `https://github.com/${repository}/issues/23`,
    publicationProvenance: {
      repository,
      exactMainSha: runtimeReleaseSha,
      issueNumber: 23,
      approvalReference: `https://github.com/${repository}/issues/23#issuecomment-1`,
      approvedBy: 'seungjae3908-source',
    },
    approvedAt,
  });
  const input = {
    stateRoot: root,
    releaseBindingRef: binding.releaseBindingRelativePath,
    releaseBindingDigest: binding.binding.releaseBindingDigest,
    runtimeReleaseSha,
  };
  return { persisted, pointer, binding, input };
}

test('L01 valid immutable release binding produces exact locator-only activation preflight', async () => {
  await withStateRoot(async (root) => {
    const { input, binding, pointer } = await fixture(root);
    const result = await preparePublicForwardPartialFillRuntimeLocatorActivation(input);
    assert.equal(result.status, 'LOCATOR_ACTIVATION_PREFLIGHT_READY');
    assert.equal(result.releaseBindingRef, binding.releaseBindingRelativePath);
    assert.equal(result.releaseBindingDigest, binding.binding.releaseBindingDigest);
    assert.equal(result.datasetPointerDigest, pointer.pointer.pointerDigest);
    assert.equal(result.requiredExistingDeploySha, runtimeReleaseSha);
  });
});

test('L02 missing release-binding ref fails closed', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    await assert.rejects(
      preparePublicForwardPartialFillRuntimeLocatorActivation({ ...input, releaseBindingRef: '' }),
      /RELEASE_BINDING_REF_MISSING/u,
    );
  });
});

test('L03 release-binding digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    await assert.rejects(
      preparePublicForwardPartialFillRuntimeLocatorActivation({ ...input, releaseBindingDigest: 'c'.repeat(64) }),
      /RELEASE_BINDING_DIGEST_MISMATCH/u,
    );
  });
});

test('L04 deployed SHA mismatch with publication-approved main fails closed', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    await assert.rejects(
      preparePublicForwardPartialFillRuntimeLocatorActivation({ ...input, runtimeReleaseSha: 'd'.repeat(40) }),
      /RELEASE_BINDING_MAIN_SHA_MISMATCH/u,
    );
  });
});

test('L05 traversal-style release-binding locator cannot become activation authority', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    await assert.rejects(
      preparePublicForwardPartialFillRuntimeLocatorActivation({ ...input, releaseBindingRef: '../binding.json' }),
      /RELEASE_BINDING_REF_MISSING/u,
    );
  });
});

test('L06 immutable dataset byte tampering blocks locator preflight before activation', async () => {
  await withStateRoot(async (root) => {
    const { input, pointer } = await fixture(root);
    await writeFile(resolve(root, pointer.pointer.datasetRelativePath), '{"tampered":true}\n', 'utf8');
    await assert.rejects(
      preparePublicForwardPartialFillRuntimeLocatorActivation(input),
      /DATASET_BYTES_DIGEST_MISMATCH/u,
    );
  });
});

test('L07 locator mutation surface is exactly three keys and never includes DEPLOY_SHA', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    const result = await preparePublicForwardPartialFillRuntimeLocatorActivation(input);
    assert.deepEqual(result.locatorKeys, [
      'RESEARCH_STATE_ROOT',
      'PARTIAL_FILL_RELEASE_BINDING_REF',
      'PARTIAL_FILL_RELEASE_BINDING_DIGEST',
    ]);
    assert.deepEqual(Object.keys(result.locatorValues).sort(), [...PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_KEYS].sort());
    assert.equal(Object.hasOwn(result.locatorValues, 'DEPLOY_SHA'), false);
  });
});

test('L08 preflight service performs no environment mutation, restart, deployment or publication', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.runtimeMutationPerformed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.runtimeActivationPerformed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.serviceRestartPerformed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.codeDeployAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.releaseBindingPublicationAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.deployShaMutationAllowed, false);
});

test('L09 identical immutable binding input produces an idempotent activation plan', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    const first = await preparePublicForwardPartialFillRuntimeLocatorActivation(input);
    const second = await preparePublicForwardPartialFillRuntimeLocatorActivation(input);
    assert.deepEqual(first, second);
  });
});

test('L10 locator seam cannot select newest, mtime, largest-N, lexical or CI-artifact winners', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.resolverReuseRequired, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.authoritySource, 'IMMUTABLE_RELEASE_BINDING');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.pointerMutationAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_LOCATOR_ACTIVATION_SAFETY.datasetMutationAllowed, false);
});

test('L11 approved main SHA is carried only as an existing DEPLOY_SHA requirement', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    const result = await preparePublicForwardPartialFillRuntimeLocatorActivation(input);
    assert.equal(result.approvedMainSha, runtimeReleaseSha);
    assert.equal(result.requiredExistingDeploySha, runtimeReleaseSha);
    assert.equal(result.deployShaMutationPerformed, false);
  });
});

test('L12 locator readiness never promotes economic, policy or trading truth', async () => {
  await withStateRoot(async (root) => {
    const { input } = await fixture(root);
    const result = await preparePublicForwardPartialFillRuntimeLocatorActivation(input);
    assert.equal(result.productionPolicyAuthorityConnected, false);
    assert.equal(result.calibrationSampleSufficient, false);
    assert.equal(result.partialFillCostPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceComplete, 0);
    assert.equal(result.profitabilityProven, false);
    assert.equal(result.currentValidatedChampion, 'NONE');
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.privateApiUsed, false);
    assert.equal(result.liveTrading, false);
    assert.equal(result.orderSubmitted, false);
  });
});
