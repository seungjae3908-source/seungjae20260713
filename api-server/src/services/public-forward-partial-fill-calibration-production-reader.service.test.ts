import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
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
  computePublicForwardPartialFillDatasetDigest,
  persistPublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillDatasetPersistResult,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  type PublicForwardPartialFillRegimeBinding,
  type PublicForwardPartialFillSplitPolicy,
} from './public-forward-partial-fill-calibration-split-audit.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_SAFETY,
  readAndConnectPublicForwardPartialFillCalibrationSplitAudit,
  readPublicForwardPartialFillCalibrationDatasetReadOnly,
  type PublicForwardPartialFillProductionReaderInput,
} from './public-forward-partial-fill-calibration-production-reader.service';

const collectorCodeSha = '17fdbc8c868a21d7386752d136f7c698f0727694';
const bucket = 'BTCUSDT-PUBLIC-MIN-ORDER-QTY-0.0001-V1';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function observation(
  overrides: Partial<PublicForwardPartialFillCalibrationObservation> = {},
): PublicForwardPartialFillCalibrationObservation {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    observationId: 'partial-fill-observation:test-only-reader-seam',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: bucket,
    collectorCodeSha,
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    observedAtMs: 2_500,
    passiveLimitPrice: 100_000,
    requestedQuantity: 0.0001,
    eligiblePublicTouchQuantityUpperBound: 0.00005,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: ['test-only-public-execution'],
    actualFillFraction: null,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1',
    sourceDigest: sha256('source'),
    sourceObservationLineageId: 'test-only-source-lineage',
    sourceObservationLineageDigest: sha256('lineage'),
    preEventBookDigest: sha256('pre-book'),
    forwardPublicFillsDigest: sha256('forward-fills'),
    postEventBookDigest: sha256('post-book'),
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

function canonicalReaderInput(
  root: string,
  dataset: PublicForwardPartialFillCalibrationDataset,
  overrides: Partial<PublicForwardPartialFillProductionReaderInput> = {},
): PublicForwardPartialFillProductionReaderInput {
  return {
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    expectedDatasetIdentity: dataset.datasetIdentity,
    expectedDatasetDigest: dataset.datasetDigest,
    ...overrides,
  };
}

async function withPersistedDataset(
  run: (
    root: string,
    persisted: PublicForwardPartialFillDatasetPersistResult,
    datasetPath: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-production-reader-'));
  try {
    const persisted = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation()],
      nowMs: 4_000,
    });
    await run(root, persisted, resolve(root, persisted.datasetRelativePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeTamperedDataset(
  datasetPath: string,
  mutate: (raw: Record<string, unknown>) => void,
  recomputeDigest = false,
): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(datasetPath, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  if (recomputeDigest) {
    raw.datasetDigest = computePublicForwardPartialFillDatasetDigest(
      raw as unknown as PublicForwardPartialFillCalibrationDataset,
    );
  }
  await writeFile(datasetPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return raw;
}

function testPolicy(): PublicForwardPartialFillSplitPolicy {
  return {
    policyIdentity: 'TEST_ONLY_PARTIAL_FILL_SPLIT_POLICY',
    policyVersion: 'test-only-1',
    policyFrozenAtMs: 500,
    expectedRegimeOwnerIdentity: 'TEST_ONLY_REGIME_OWNER',
    expectedRegimePolicyIdentity: 'TEST_ONLY_REGIME_POLICY',
    expectedRegimePolicyDigest: sha256('test-only-regime-policy'),
    maxRegimeEvidenceAgeMs: 500,
    windows: {
      train: { startInclusiveMs: 900, endExclusiveMs: 2_000 },
      validation: { startInclusiveMs: 2_000, endExclusiveMs: 3_000 },
      oos: { startInclusiveMs: 3_000, endExclusiveMs: 4_000 },
    },
    overallMinimums: { train: 1, validation: 1, oos: 1 },
    scopeMinimums: [{
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantityNotionalBucketIdentity: bucket,
      volatilityRegimeIdentity: 'TEST_ONLY_VOL',
      liquidityRegimeIdentity: 'TEST_ONLY_LIQ',
      minimums: { train: 1, validation: 1, oos: 1 },
    }],
  };
}

function testBinding(current: PublicForwardPartialFillCalibrationObservation): PublicForwardPartialFillRegimeBinding {
  return {
    observationId: current.observationId,
    sourceObservationLineageDigest: current.sourceObservationLineageDigest,
    market: current.market,
    symbol: current.symbol,
    side: current.side,
    quantityNotionalBucketIdentity: current.quantityNotionalBucketIdentity,
    regimeOwnerIdentity: 'TEST_ONLY_REGIME_OWNER',
    regimeEvidenceIdentity: 'test-only-regime-evidence',
    regimeEvidenceDigest: sha256('test-only-regime-evidence'),
    regimePolicyIdentity: 'TEST_ONLY_REGIME_POLICY',
    regimePolicyDigest: sha256('test-only-regime-policy'),
    volatilityRegimeIdentity: 'TEST_ONLY_VOL',
    liquidityRegimeIdentity: 'TEST_ONLY_LIQ',
    observedAtMs: 950,
  };
}

test('valid canonical dataset is read through a read-only identity/digest-bound surface', async () => {
  await withPersistedDataset(async (root, persisted, datasetPath) => {
    const beforeBytes = await readFile(datasetPath, 'utf8');
    const beforeStat = await stat(datasetPath);
    const readback = await readPublicForwardPartialFillCalibrationDatasetReadOnly(
      canonicalReaderInput(root, persisted.dataset),
    );
    const afterBytes = await readFile(datasetPath, 'utf8');
    const afterStat = await stat(datasetPath);

    assert.equal(readback.readOnly, true);
    assert.equal(readback.dataset.datasetIdentity, persisted.dataset.datasetIdentity);
    assert.equal(readback.dataset.datasetDigest, persisted.dataset.datasetDigest);
    assert.equal(readback.dataset.observationCount, 1);
    assert.equal(Object.isFrozen(readback.dataset), true);
    assert.equal(Object.isFrozen(readback.dataset.observations), true);
    assert.equal(afterBytes, beforeBytes);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  });
});

test('missing, relative, and non-directory state roots fail closed before any empty dataset can be invented', async () => {
  const identity = `partial-fill-forward-dataset:FORWARD_NATURAL_SAMPLE:${collectorCodeSha}`;
  const base = {
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE' as const,
    collectorCodeSha,
    expectedDatasetIdentity: identity,
    expectedDatasetDigest: 'a'.repeat(64),
  };
  await assert.rejects(
    readPublicForwardPartialFillCalibrationDatasetReadOnly({ ...base, stateRoot: 'relative-root' }),
    /STATE_ROOT_MUST_BE_ABSOLUTE/u,
  );
  const missing = join(tmpdir(), `missing-partial-fill-reader-${process.pid}-${Date.now()}`);
  await rm(missing, { recursive: true, force: true });
  await assert.rejects(
    readPublicForwardPartialFillCalibrationDatasetReadOnly({ ...base, stateRoot: missing }),
    /STATE_ROOT_MISSING/u,
  );
  const fileRoot = join(tmpdir(), `partial-fill-reader-file-${process.pid}-${Date.now()}`);
  await writeFile(fileRoot, 'not-a-directory', 'utf8');
  try {
    await assert.rejects(
      readPublicForwardPartialFillCalibrationDatasetReadOnly({ ...base, stateRoot: fileRoot }),
      /STATE_ROOT_NOT_DIRECTORY/u,
    );
  } finally {
    await rm(fileRoot, { force: true });
  }
});

test('missing dataset and malformed JSON fail closed instead of becoming N=0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-reader-missing-'));
  const identity = `partial-fill-forward-dataset:FORWARD_NATURAL_SAMPLE:${collectorCodeSha}`;
  const input: PublicForwardPartialFillProductionReaderInput = {
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    expectedDatasetIdentity: identity,
    expectedDatasetDigest: 'a'.repeat(64),
  };
  try {
    await assert.rejects(readPublicForwardPartialFillCalibrationDatasetReadOnly(input), /DATASET_MISSING/u);
    const datasetPath = resolve(
      root,
      'forward/partial-fill-calibration-v1/forward_natural_sample',
      collectorCodeSha,
      'dataset.json',
    );
    await mkdir(dirname(datasetPath), { recursive: true });
    await writeFile(datasetPath, '{', 'utf8');
    await assert.rejects(readPublicForwardPartialFillCalibrationDatasetReadOnly(input), /INVALID_JSON/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('schema, sampleClass, collector SHA, dataset identity and dataset digest mismatches each fail closed', async () => {
  const cases: readonly Readonly<{
    name: string;
    mutate: (raw: Record<string, unknown>) => void;
    expected: RegExp;
  }>[] = [
    { name: 'schema', mutate: (raw) => { raw.schemaVersion = 'wrong-schema'; }, expected: /DATASET_SCHEMA_INVALID/u },
    { name: 'sampleClass', mutate: (raw) => { raw.sampleClass = 'CALIBRATION_RESEARCH_SAMPLE'; }, expected: /DATASET_SAMPLE_CLASS_MISMATCH/u },
    { name: 'collector', mutate: (raw) => { raw.collectorCodeSha = 'b'.repeat(40); }, expected: /DATASET_COLLECTOR_SHA_MISMATCH/u },
    { name: 'identity', mutate: (raw) => { raw.datasetIdentity = 'wrong-identity'; }, expected: /DATASET_IDENTITY_MISMATCH/u },
    { name: 'digest', mutate: (raw) => { raw.datasetDigest = 'f'.repeat(64); }, expected: /DATASET_DIGEST_MISMATCH/u },
  ];

  for (const current of cases) {
    await withPersistedDataset(async (root, persisted, datasetPath) => {
      await writeTamperedDataset(datasetPath, current.mutate);
      await assert.rejects(
        readPublicForwardPartialFillCalibrationDatasetReadOnly(canonicalReaderInput(root, persisted.dataset)),
        current.expected,
        current.name,
      );
    });
  }
});

test('invalid persisted structure fails closed', async () => {
  await withPersistedDataset(async (root, persisted, datasetPath) => {
    await writeFile(datasetPath, '{"observations":null}\n', 'utf8');
    await assert.rejects(
      readPublicForwardPartialFillCalibrationDatasetReadOnly(canonicalReaderInput(root, persisted.dataset)),
      /INVALID_PERSISTED_STRUCTURE/u,
    );
  });
});

test('protected application/checkouts roots are rejected before filesystem access', async () => {
  const protectedRoot = resolve(tmpdir(), 'checkouts', 'investment-app');
  const identity = `partial-fill-forward-dataset:FORWARD_NATURAL_SAMPLE:${collectorCodeSha}`;
  await assert.rejects(
    readPublicForwardPartialFillCalibrationDatasetReadOnly({
      stateRoot: protectedRoot,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: identity,
      expectedDatasetDigest: 'a'.repeat(64),
    }),
    /PROTECTED_CHECKOUT_STORAGE/u,
  );
});

test('dataset symlink escape is rejected and never followed as canonical evidence', async () => {
  await withPersistedDataset(async (root, persisted, datasetPath) => {
    const externalRoot = await mkdtemp(join(tmpdir(), 'partial-fill-reader-external-'));
    try {
      const externalPath = join(externalRoot, 'dataset.json');
      await writeFile(externalPath, await readFile(datasetPath, 'utf8'), 'utf8');
      await unlink(datasetPath);
      await symlink(externalPath, datasetPath);
      await assert.rejects(
        readPublicForwardPartialFillCalibrationDatasetReadOnly(canonicalReaderInput(root, persisted.dataset)),
        /DATASET_SYMLINK_FORBIDDEN/u,
      );
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});

test('duplicate observation truth is rejected rather than deduplicated or masked by the reader', async () => {
  await withPersistedDataset(async (root, persisted, datasetPath) => {
    const raw = await writeTamperedDataset(datasetPath, (candidate) => {
      const rows = candidate.observations as unknown[];
      candidate.observations = [...rows, rows[0]];
      candidate.observationCount = 2;
      candidate.forwardCalibrationSampleCreditCount = 2;
    }, true);
    await assert.rejects(
      readPublicForwardPartialFillCalibrationDatasetReadOnly(canonicalReaderInput(root, persisted.dataset, {
        expectedDatasetDigest: String(raw.datasetDigest),
      })),
      /DATASET_DUPLICATE_OBSERVATION_ID/u,
    );
  });
});

test('empty persisted dataset is rejected instead of receiving canonical N=0 readback credit', async () => {
  await withPersistedDataset(async (root, persisted, datasetPath) => {
    const raw = await writeTamperedDataset(datasetPath, (candidate) => {
      candidate.observations = [];
      candidate.observationCount = 0;
      candidate.forwardCalibrationSampleCreditCount = 0;
    }, true);
    await assert.rejects(
      readPublicForwardPartialFillCalibrationDatasetReadOnly(canonicalReaderInput(root, persisted.dataset, {
        expectedDatasetDigest: String(raw.datasetDigest),
      })),
      /DATASET_EMPTY/u,
    );
  });
});

test('canonical N=1 readback preserves LONG/SHORT and actual-fill/queue unknown truth while missing production policy stays NOT_EVALUABLE', async () => {
  await withPersistedDataset(async (root, persisted) => {
    const result = await readAndConnectPublicForwardPartialFillCalibrationSplitAudit({
      reader: canonicalReaderInput(root, persisted.dataset),
      productionPolicy: null,
      regimeBindings: null,
    });
    assert.equal(result.datasetReadback, 'PASS');
    assert.equal(result.splitAuditConnected, true);
    assert.equal(result.splitAuditExecuted, false);
    assert.equal(result.productionCallerConnected, false);
    assert.equal(result.productionPolicyPresent, false);
    assert.equal(result.productionPolicyAuthorityConnected, false);
    assert.equal(result.sufficiencyStatus, 'NOT_EVALUABLE_POLICY_MISSING');
    assert.equal(result.calibrationSampleSufficient, false);
    assert.equal(result.splitAuditResult, null);
    assert.equal(result.rawN, 1);
    assert.equal(result.uniqueN, 1);
    assert.equal(result.longN, 1);
    assert.equal(result.shortN, 0);
    assert.equal(result.actualFillObservedN, 0);
    assert.equal(result.queuePositionKnownN, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'effectiveIndependentN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'buyN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'sellN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'minimumRawN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'minimumEffectiveN'), false);
    assert.equal(result.calibrationArtifactProduced, false);
    assert.equal(result.partialFillCostPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceComplete, 0);
    assert.equal(result.naturalEntryCredit, 0);
    assert.equal(result.runtimeCostCredit, 0);
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.privateApiUsed, false);
    assert.equal(result.liveTrading, false);
    assert.equal(result.orderSubmitted, false);
  });
});

test('existing split audit is callable from the seam with an explicit TEST_ONLY fixture policy but cannot become production sufficiency authority', async () => {
  await withPersistedDataset(async (root, persisted) => {
    const current = persisted.dataset.observations[0].observation;
    const result = await readAndConnectPublicForwardPartialFillCalibrationSplitAudit({
      reader: canonicalReaderInput(root, persisted.dataset),
      productionPolicy: testPolicy(),
      regimeBindings: [testBinding(current)],
    });
    assert.equal(result.splitAuditConnected, true);
    assert.equal(result.splitAuditExecuted, true);
    assert.equal(result.productionPolicyPresent, true);
    assert.equal(result.productionPolicyAuthorityConnected, false);
    assert.equal(result.sufficiencyStatus, 'NOT_EVALUABLE_POLICY_AUTHORITY_NOT_CONNECTED');
    assert.equal(result.calibrationSampleSufficient, false);
    assert.ok(result.splitAuditResult);
    assert.equal(result.splitAuditResult.status, 'PRESENT');
    assert.ok(result.splitAuditResult.audit);
    assert.equal(result.splitAuditResult.audit.calibrationSampleSufficient, false);
    assert.ok(result.splitAuditResult.audit.sampleDeficits.includes('OVERALL_VALIDATION:0/1'));
    assert.ok(result.splitAuditResult.audit.sampleDeficits.includes('OVERALL_OOS:0/1'));
    assert.equal(result.calibrationArtifactProduced, false);
    assert.equal(result.partialFillCostPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceComplete, 0);
  });
});

test('reader safety contract forbids threshold invention, economic credit, storage mutation and execution authority', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_SAFETY, {
    readOnly: true,
    existingCanonicalStateRootRequired: true,
    expectedDatasetIdentityRequired: true,
    expectedDatasetDigestRequired: true,
    protectedApplicationStorageAllowed: false,
    symlinkDatasetAllowed: false,
    missingDatasetBecomesEmpty: false,
    malformedDatasetBecomesEmpty: false,
    duplicateTruthMaskingAllowed: false,
    effectiveIndependentNProduced: false,
    buySellSemanticRemapAllowed: false,
    productionPolicyRequiredForSufficiency: true,
    productionPolicyAuthorityConnected: false,
    defaultSampleThresholdAllowed: false,
    calibrationArtifactProduced: false,
    partialFillCostProduced: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
  });
});
