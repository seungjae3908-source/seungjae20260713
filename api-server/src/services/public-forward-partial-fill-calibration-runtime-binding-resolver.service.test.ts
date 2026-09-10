import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillDatasetPersistResult,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  computePublicForwardPartialFillDatasetPointerDigest,
  publishPublicForwardPartialFillCalibrationDatasetPointer,
  type PublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-dataset-pointer.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY,
  computePublicForwardPartialFillReleaseBindingDigest,
  publicForwardPartialFillReleaseBindingRelativePath,
  publishPublicForwardPartialFillCalibrationReleaseBinding,
  type PublicForwardPartialFillAuthoritativeReleaseBinding,
  type PublicForwardPartialFillCalibrationReleaseBinding,
} from './public-forward-partial-fill-calibration-release-binding.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY,
  resolvePublicForwardPartialFillCalibrationRuntimeBinding,
} from './public-forward-partial-fill-calibration-runtime-binding-resolver.service';
import {
  readPublicForwardPartialFillCalibrationDatasetReadOnly,
} from './public-forward-partial-fill-calibration-production-reader.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY,
  runPublicForwardPartialFillCalibrationProductionReadback,
} from './public-forward-partial-fill-calibration-production-caller.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY,
} from './public-forward-partial-fill-production-policy-manifest.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY,
} from './public-forward-partial-fill-business-tolerance-decision-evidence.service';

const repository = 'seungjae3908-source/seungjae20260713';
const collectorCodeSha = 'a'.repeat(40);
const runtimeReleaseSha = 'b'.repeat(40);
const approvedAt = '2026-09-01T00:00:00.000Z';
const researchRepoRoot = resolve(tmpdir(), 'partial-fill-phase-c-research-repo');

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function observation(
  id: string,
  overrides: Partial<PublicForwardPartialFillCalibrationObservation> = {},
): PublicForwardPartialFillCalibrationObservation {
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
    ...overrides,
  };
}

async function withStateRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-phase-c-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function persistDataset(
  root: string,
  ids: readonly string[] = ['obs-1'],
  nowMs = 4_000,
): Promise<PublicForwardPartialFillDatasetPersistResult> {
  return persistPublicForwardPartialFillCalibrationDataset({
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    observations: ids.map((id, index) => observation(id, {
      windowStartMs: 1_000 + index * 5_000,
      windowEndMs: 2_000 + index * 5_000,
      observedAtMs: 3_000 + index * 5_000,
    })),
    nowMs,
  });
}

async function publishPointer(
  root: string,
  ids: readonly string[] = ['obs-1'],
  receiptSeed = 'receipt-1',
  nowMs = 4_000,
) {
  const persisted = await persistDataset(root, ids, nowMs);
  const receiptDigest = sha256(receiptSeed);
  const published = await publishPublicForwardPartialFillCalibrationDatasetPointer({
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
      captureRunId: String(nowMs),
      captureRunAttempt: '1',
      artifactId: String(nowMs + 1),
    },
  });
  return { persisted, published };
}

async function publishBinding(
  root: string,
  pointer: PublicForwardPartialFillCalibrationDatasetPointer,
  seed = 'binding-1',
) {
  return publishPublicForwardPartialFillCalibrationReleaseBinding({
    stateRoot: root,
    researchRepoRoot,
    pointerRelativePath: pointer.pointerRelativePath,
    expectedPointerDigest: pointer.pointerDigest,
    releaseBindingIdentity: `phase-c:${seed}:${pointer.pointerDigest}`,
    releaseControlReference: `https://github.com/${repository}/issues/23`,
    publicationProvenance: {
      repository,
      exactMainSha: runtimeReleaseSha,
      issueNumber: 23,
      approvalReference: `https://github.com/${repository}/issues/23#issuecomment-${seed}`,
      approvedBy: 'seungjae3908-source',
    },
    approvedAt,
  });
}

function runtimeInput(root: string, publication: Awaited<ReturnType<typeof publishBinding>>) {
  return {
    stateRoot: root,
    releaseBindingRef: publication.releaseBindingRelativePath,
    releaseBindingDigest: publication.binding.releaseBindingDigest,
    runtimeReleaseSha,
  };
}

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const path = resolve(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function redigestBinding(
  binding: PublicForwardPartialFillCalibrationReleaseBinding,
  overrides: Record<string, unknown>,
): PublicForwardPartialFillAuthoritativeReleaseBinding {
  const merged = { ...binding, ...overrides } as Record<string, unknown>;
  const { releaseBindingDigest: _ignored, ...body } = merged;
  return {
    ...body,
    releaseBindingDigest: computePublicForwardPartialFillReleaseBindingDigest(
      body as Omit<PublicForwardPartialFillCalibrationReleaseBinding, 'releaseBindingDigest'>,
    ),
  } as PublicForwardPartialFillAuthoritativeReleaseBinding;
}

function redigestPointer(
  pointer: PublicForwardPartialFillCalibrationDatasetPointer,
  overrides: Record<string, unknown>,
): PublicForwardPartialFillCalibrationDatasetPointer {
  const merged = { ...pointer, ...overrides } as Record<string, unknown>;
  const { pointerDigest: _ignored, ...body } = merged;
  return {
    ...body,
    pointerDigest: computePublicForwardPartialFillDatasetPointerDigest(
      body as Omit<PublicForwardPartialFillCalibrationDatasetPointer, 'pointerDigest'>,
    ),
  } as PublicForwardPartialFillCalibrationDatasetPointer;
}

async function installBinding(root: string, binding: PublicForwardPartialFillAuthoritativeReleaseBinding) {
  const ref = publicForwardPartialFillReleaseBindingRelativePath(binding.releaseBindingDigest);
  await writeJson(root, ref, binding);
  return { ref, digest: binding.releaseBindingDigest };
}

async function rebindPointer(
  root: string,
  publication: Awaited<ReturnType<typeof publishBinding>>,
  pointer: PublicForwardPartialFillCalibrationDatasetPointer,
) {
  await writeJson(root, pointer.pointerRelativePath, pointer);
  const binding = redigestBinding(publication.binding, {
    datasetPointerIdentity: pointer.pointerIdentity,
    datasetPointerRef: pointer.pointerRelativePath,
    datasetPointerDigest: pointer.pointerDigest,
  });
  const installed = await installBinding(root, binding);
  return { binding, ...installed };
}

async function assertDatasetFieldMismatch(
  field: string,
  value: unknown,
  expected: RegExp,
): Promise<void> {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const publication = await publishBinding(root, published.pointer);
    const datasetPath = resolve(root, published.pointer.datasetRelativePath);
    const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as Record<string, unknown>;
    dataset[field] = value;
    const bytes = Buffer.from(`${JSON.stringify(dataset, null, 2)}\n`);
    await writeFile(datasetPath, bytes);
    const pointer = redigestPointer(published.pointer, { datasetBytesDigest: sha256(bytes) });
    const rebound = await rebindPointer(root, publication, pointer);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: rebound.ref,
        releaseBindingDigest: rebound.digest,
        runtimeReleaseSha,
      }),
      expected,
    );
  });
}

test('T01 valid #23-authorized release binding resolves successfully', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    const resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding));
    assert.equal(resolved.runtimeBindingSource, 'IMMUTABLE_RELEASE_BINDING');
    assert.equal(resolved.datasetPointerDigest, published.pointer.pointerDigest);
    assert.equal(resolved.datasetRelativePath, published.pointer.datasetRelativePath);
    const caller = await runPublicForwardPartialFillCalibrationProductionReadback({
      RESEARCH_STATE_ROOT: root,
      PARTIAL_FILL_RELEASE_BINDING_REF: binding.releaseBindingRelativePath,
      PARTIAL_FILL_RELEASE_BINDING_DIGEST: binding.binding.releaseBindingDigest,
      DEPLOY_SHA: runtimeReleaseSha,
    });
    assert.equal(caller.status, 'READBACK');
  });
});

test('T02 missing release binding ref fails closed', async () => {
  await withStateRoot(async (root) => {
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: '',
        releaseBindingDigest: '0'.repeat(64),
        runtimeReleaseSha,
      }),
      /RELEASE_BINDING_REF_MISSING/u,
    );
  });
});

test('T03 release-binding digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        ...runtimeInput(root, binding),
        releaseBindingDigest: '0'.repeat(64),
      }),
      /RELEASE_BINDING_DIGEST_MISMATCH/u,
    );
  });
});

test('T04 release-binding schema mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const publication = await publishBinding(root, published.pointer);
    const invalid = redigestBinding(publication.binding, { schemaVersion: 'wrong-schema' });
    const installed = await installBinding(root, invalid);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: installed.ref,
        releaseBindingDigest: installed.digest,
        runtimeReleaseSha,
      }),
      /RELEASE_BINDING_SCHEMA_INVALID/u,
    );
  });
});

test('T05 unauthorized publication authority fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const publication = await publishBinding(root, published.pointer);
    const invalid = redigestBinding(publication.binding, { publicationAuthority: 'CI_IS_AUTHORITY' });
    const installed = await installBinding(root, invalid);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: installed.ref,
        releaseBindingDigest: installed.digest,
        runtimeReleaseSha,
      }),
      /RELEASE_BINDING_AUTHORITY_INVALID/u,
    );
  });
});

test('T06 binding approved for a different runtime release SHA fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        ...runtimeInput(root, binding),
        runtimeReleaseSha: 'c'.repeat(40),
      }),
      /RELEASE_BINDING_MAIN_SHA_MISMATCH/u,
    );
  });
});

test('T07 missing pointer fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    await rm(resolve(root, published.pointer.pointerRelativePath));
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding)),
      /POINTER_NOT_FOUND/u,
    );
  });
});

test('T08 pointer digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const publication = await publishBinding(root, published.pointer);
    const invalid = redigestBinding(publication.binding, { datasetPointerDigest: '0'.repeat(64) });
    const installed = await installBinding(root, invalid);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: installed.ref,
        releaseBindingDigest: installed.digest,
        runtimeReleaseSha,
      }),
      /POINTER_DIGEST_MISMATCH/u,
    );
  });
});

test('T09 missing immutable dataset fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    await rm(resolve(root, published.pointer.datasetRelativePath));
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding)),
      /DATASET_NOT_FOUND/u,
    );
  });
});

test('T10 dataset bytes digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    const datasetPath = resolve(root, published.pointer.datasetRelativePath);
    const bytes = await readFile(datasetPath);
    await writeFile(datasetPath, Buffer.concat([bytes, Buffer.from(' ')]));
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding)),
      /DATASET_BYTES_DIGEST_MISMATCH/u,
    );
  });
});

test('T11 semantic dataset digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const publication = await publishBinding(root, published.pointer);
    const datasetPath = resolve(root, published.pointer.datasetRelativePath);
    const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as Record<string, unknown>;
    dataset.datasetDigest = '0'.repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(dataset, null, 2)}\n`);
    await writeFile(datasetPath, bytes);
    const pointer = redigestPointer(published.pointer, { datasetBytesDigest: sha256(bytes) });
    const rebound = await rebindPointer(root, publication, pointer);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: rebound.ref,
        releaseBindingDigest: rebound.digest,
        runtimeReleaseSha,
      }),
      /DATASET_SEMANTIC_DIGEST_MISMATCH/u,
    );
  });
});

test('T12 dataset identity mismatch fails closed', async () => {
  await assertDatasetFieldMismatch('datasetIdentity', 'wrong-identity', /DATASET_IDENTITY_MISMATCH/u);
});

test('T13 collector SHA mismatch fails closed', async () => {
  await assertDatasetFieldMismatch('collectorCodeSha', 'c'.repeat(40), /DATASET_COLLECTOR_SHA_MISMATCH/u);
});

test('T14 sampleClass mismatch fails closed', async () => {
  await assertDatasetFieldMismatch('sampleClass', 'CALIBRATION_RESEARCH_SAMPLE', /DATASET_SAMPLE_CLASS_MISMATCH/u);
});

test('T15 store contract mismatch fails closed', async () => {
  await assertDatasetFieldMismatch('storeContract', 'wrong-store', /DATASET_STORE_CONTRACT_MISMATCH/u);
});

test('T16 traversal dataset locator fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const publication = await publishBinding(root, published.pointer);
    const pointer = redigestPointer(published.pointer, { datasetRelativePath: '../dataset.json' });
    const rebound = await rebindPointer(root, publication, pointer);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding({
        stateRoot: root,
        releaseBindingRef: rebound.ref,
        releaseBindingDigest: rebound.digest,
        runtimeReleaseSha,
      }),
      /POINTER_LOCATOR_INVALID/u,
    );
  });
});

test('T17 symlink immutable dataset target fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    const datasetPath = resolve(root, published.pointer.datasetRelativePath);
    const external = resolve(root, 'external-dataset.json');
    await writeFile(external, await readFile(datasetPath));
    await rm(datasetPath);
    await symlink(external, datasetPath);
    await assert.rejects(
      resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding)),
      /POINTER_LOCATOR_INVALID/u,
    );
  });
});

test('T18 newer mtime pointer is not selected over the bound pointer', async () => {
  await withStateRoot(async (root) => {
    const first = await publishPointer(root, ['obs-1'], 'receipt-a', 4_000);
    const second = await publishPointer(root, ['obs-2'], 'receipt-b', 9_000);
    await utimes(resolve(root, first.published.pointer.pointerRelativePath), new Date(10_000), new Date(10_000));
    await utimes(resolve(root, second.published.pointer.pointerRelativePath), new Date(20_000), new Date(20_000));
    const binding = await publishBinding(root, first.published.pointer, 'mtime');
    const resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding));
    assert.equal(resolved.datasetPointerDigest, first.published.pointer.pointerDigest);
    assert.notEqual(resolved.datasetPointerDigest, second.published.pointer.pointerDigest);
  });
});

test('T19 lexicographically newest pointer is not selected over the explicit binding', async () => {
  await withStateRoot(async (root) => {
    const first = await publishPointer(root, ['obs-1'], 'receipt-c', 4_000);
    const second = await publishPointer(root, ['obs-2'], 'receipt-d', 9_000);
    const pointers = [first.published.pointer, second.published.pointer]
      .sort((left, right) => left.pointerRelativePath.localeCompare(right.pointerRelativePath));
    const selected = pointers[0];
    const binding = await publishBinding(root, selected, 'lexical');
    const resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding));
    assert.equal(resolved.datasetPointerDigest, selected.pointerDigest);
    assert.notEqual(selected.pointerRelativePath, pointers[1].pointerRelativePath);
  });
});

test('T20 larger-N dataset is ignored unless its pointer is explicitly released', async () => {
  await withStateRoot(async (root) => {
    const one = await publishPointer(root, ['obs-1'], 'receipt-one', 4_000);
    const two = await publishPointer(root, ['obs-2', 'obs-3'], 'receipt-two', 12_000);
    const binding = await publishBinding(root, one.published.pointer, 'larger-n');
    const resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding));
    assert.equal(resolved.datasetDigest, one.published.pointer.datasetDigest);
    assert.notEqual(resolved.datasetDigest, two.published.pointer.datasetDigest);
  });
});

test('T21 rollback publishes a new binding that can select an older pointer', async () => {
  await withStateRoot(async (root) => {
    const first = await publishPointer(root, ['obs-1'], 'receipt-r1', 4_000);
    const second = await publishPointer(root, ['obs-2'], 'receipt-r2', 9_000);
    await publishBinding(root, second.published.pointer, 'forward-r2');
    const rollback = await publishBinding(root, first.published.pointer, 'rollback-r3');
    const resolved = await resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, rollback));
    assert.equal(resolved.datasetPointerDigest, first.published.pointer.pointerDigest);
  });
});

test('T22 rollback never rewrites prior immutable binding or pointer bytes', async () => {
  await withStateRoot(async (root) => {
    const first = await publishPointer(root, ['obs-1'], 'receipt-u1', 4_000);
    const original = await publishBinding(root, first.published.pointer, 'original');
    const pointerBefore = await readFile(resolve(root, first.published.pointer.pointerRelativePath));
    const bindingBefore = await readFile(resolve(root, original.releaseBindingRelativePath));
    const second = await publishPointer(root, ['obs-2'], 'receipt-u2', 9_000);
    await publishBinding(root, second.published.pointer, 'forward');
    await publishBinding(root, first.published.pointer, 'rollback');
    assert.deepEqual(await readFile(resolve(root, first.published.pointer.pointerRelativePath)), pointerBefore);
    assert.deepEqual(await readFile(resolve(root, original.releaseBindingRelativePath)), bindingBefore);
  });
});

test('T23 production startup entry no longer trusts legacy duplicate direct dataset digest authority', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistDataset(root);
    const result = await runPublicForwardPartialFillCalibrationProductionReadback({
      PARTIAL_FILL_CANONICAL_STATE_ROOT: root,
      PARTIAL_FILL_CANONICAL_STORE_CONTRACT: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      PARTIAL_FILL_CANONICAL_SAMPLE_CLASS: 'FORWARD_NATURAL_SAMPLE',
      PARTIAL_FILL_CANONICAL_COLLECTOR_CODE_SHA: collectorCodeSha,
      PARTIAL_FILL_CANONICAL_DATASET_IDENTITY: persisted.dataset.datasetIdentity,
      PARTIAL_FILL_CANONICAL_DATASET_DIGEST: persisted.dataset.datasetDigest,
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.blocker, 'NOT_EVALUABLE_RUNTIME_BINDING_MISSING');
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'rawN'), false);
  });
});

test('T24 production Reader consumes resolver-supplied immutable locator after mutable canonical head is removed', async () => {
  await withStateRoot(async (root) => {
    const { persisted, published } = await publishPointer(root);
    const binding = await publishBinding(root, published.pointer);
    const resolvedBinding = await resolvePublicForwardPartialFillCalibrationRuntimeBinding(runtimeInput(root, binding));
    await rm(resolve(root, persisted.datasetRelativePath));
    const readback = await readPublicForwardPartialFillCalibrationDatasetReadOnly({
      stateRoot: resolvedBinding.stateRoot,
      storeContract: resolvedBinding.storeContract,
      sampleClass: resolvedBinding.sampleClass,
      collectorCodeSha: resolvedBinding.collectorCodeSha,
      expectedDatasetIdentity: resolvedBinding.datasetIdentity,
      expectedDatasetDigest: resolvedBinding.datasetDigest,
      datasetRelativePath: resolvedBinding.datasetRelativePath,
      expectedDatasetBytesDigest: resolvedBinding.datasetBytesDigest,
      runtimeBindingSource: resolvedBinding.runtimeBindingSource,
    });
    assert.equal(readback.datasetRelativePath, published.pointer.datasetRelativePath);
    assert.equal(readback.dataset.datasetDigest, published.pointer.datasetDigest);
  });
});

test('T25 startup missing binding stays explicit NOT_EVALUABLE with no silent fallback', async () => {
  await withStateRoot(async (root) => {
    const result = await runPublicForwardPartialFillCalibrationProductionReadback({
      RESEARCH_STATE_ROOT: root,
      DEPLOY_SHA: runtimeReleaseSha,
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.blocker, 'NOT_EVALUABLE_RUNTIME_BINDING_MISSING');
    assert.equal(result.productionCallerConnected, false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'rawN'), false);
  });
});

test('T26 #855 policy manifest remains candidate-only', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.candidateOnly, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.productionAuthorityConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.policyArtifactProduced, false);
});

test('T27 #857/#858 business-governance lane is not frozen or numericized by runtime binding', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.frozenArtifactProduced, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.statisticalNumericizationAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.productionPolicyAuthorityConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.aiNumericAuthority, 'NONE');
});

test('T28 runtime authority plumbing does not promote economic truth', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.calibrationSampleSufficient, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.partialFillCostPresent, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.evidenceComplete, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.profitabilityProven, false);
});

test('T29 publication validation workflow contains no runtime activation command', async () => {
  const workflowPath = resolve(
    process.cwd(),
    '.github/workflows/public-forward-partial-fill-release-binding-publication.yml',
  );
  const source = await readFile(workflowPath, 'utf8');
  assert.doesNotMatch(
    source,
    /\bpm2\s+(?:restart|start|reload)\b|\bsystemctl\s+(?:enable|start|restart)\b|createWorkflowDispatch[\s\S]{0,200}production-deploy/u,
  );
  assert.match(source, /Runtime activation executed: `false`/u);
});

test('T30 execution and trading authority remain disabled everywhere in Phase C', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.runtimeActivationPerformed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.autoTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY.realOrderEnabled, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.liveTrading, false);
});
