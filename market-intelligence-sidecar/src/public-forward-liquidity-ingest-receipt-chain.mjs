import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  canonicalJson,
  sha256,
  verifyLiquidityCalibrationDataset,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from './public-forward-liquidity-capture-ingest.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_INGEST_RECEIPT_CHAIN_VERSION =
  'public-forward-liquidity-ingest-receipt-chain-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function text(value, code) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = text(value, code).replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function exactSha(value, code) {
  const normalized = text(value, code).toLowerCase();
  if (!COMMIT_SHA.test(normalized)) throw new Error(code);
  return normalized;
}

function decimalId(value, code) {
  const normalized = text(value, code);
  if (!DECIMAL_ID.test(normalized)) throw new Error(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!(Number.isInteger(normalized) && normalized >= 0)) throw new Error(code);
  return normalized;
}

function assertTruthBoundary(receipt) {
  if (receipt.canonicalDatasetPersistencePerformed !== true
    || receipt.canonicalDatasetCreditApplied !== false
    || receipt.duplicateCreditEvaluated !== true
    || receipt.forwardCalibrationSampleCreditDelta !== 0
    || receipt.independenceEvaluated !== false
    || receipt.effectiveIndependentCalibrationN !== null
    || receipt.calibrationSampleSufficient !== false
    || receipt.independentSampleCreditAuthority !== 'NONE_UNTIL_CANONICAL_INDEPENDENCE_TRANSFORM'
    || receipt.splitAssignmentPerformed !== false
    || receipt.oosValidationComplete !== false
    || receipt.calibrationArtifactProduced !== false
    || receipt.liquidityImpactPresent !== false
    || receipt.liquidityImpactStatus !== 'BLOCKED_DATA'
    || receipt.fullCostReady !== false
    || receipt.evidenceCompleteCredit !== 0
    || receipt.naturalEntryCredit !== 0
    || receipt.runtimeCostCredit !== 0
    || receipt.executionAuthority !== 'NONE'
    || receipt.privateApiUsed !== false
    || receipt.liveTrading !== false
    || receipt.orderSubmitted !== false
    || receipt.realOrders !== 0) {
    throw new Error('UPSTREAM_INGEST_TRUTH_BOUNDARY_INVALID');
  }
}

function aggregateDroppedReasons(batchProvenance) {
  const aggregate = {};
  for (const provenance of batchProvenance) {
    for (const [reason, count] of Object.entries(provenance?.droppedReasons ?? {})) {
      aggregate[reason] = (aggregate[reason] ?? 0) + Number(count);
    }
  }
  return Object.fromEntries(Object.entries(aggregate).sort(([left], [right]) => left.localeCompare(right)));
}

function reconstructDatasetDigest({ dataset, predecessorDigest, observations, batchProvenance, duplicateAttempts }) {
  const core = {
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-dataset',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    collectorCodeSha: dataset.collectorCodeSha,
    sampleClass: dataset.sampleClass,
    predecessorDigest,
    observations,
    batchProvenance,
    duplicateAttempts,
    datasetProvenance: {
      rawSource: {
        provider: 'BITGET_PUBLIC_UTA_V3',
        endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
        privateApiUsed: false,
      },
      collectionPeriod: {
        startedAtMs: batchProvenance.length
          ? Math.min(...batchProvenance.map((item) => item.collectionPeriod.startedAtMs))
          : null,
        completedAtMs: batchProvenance.length
          ? Math.max(...batchProvenance.map((item) => item.collectionPeriod.completedAtMs))
          : null,
      },
      firstObservedAtMs: observations.length
        ? Math.min(...observations.map((item) => item.eventTimestampMs))
        : null,
      lastObservedAtMs: observations.length
        ? Math.max(...observations.map((item) => item.eventTimestampMs))
        : null,
      eventCount: observations.length,
      droppedCount: batchProvenance.reduce((sum, item) => sum + Number(item.droppedCount ?? 0), 0),
      droppedReasons: aggregateDroppedReasons(batchProvenance),
      rawDigest: sha256(canonicalJson(batchProvenance.map((item) => item.rawDigest).sort())),
      normalizedDigest: sha256(canonicalJson(observations)),
      collectorCodeSha: dataset.collectorCodeSha,
    },
    readiness: dataset.readiness,
    safety: dataset.safety,
  };
  return sha256(canonicalJson(core));
}

function sortedObservations(finalDataset, seenObservationIds) {
  return finalDataset.observations
    .filter((observation) => seenObservationIds.has(observation.observationId))
    .sort((left, right) => left.eventTimestampMs - right.eventTimestampMs
      || left.observationId.localeCompare(right.observationId));
}

export function verifyPublicForwardLiquidityIngestReceiptChain({
  dataset,
  ingestReceipts,
  datasetRelativePath,
  collectorImplementationPath,
} = {}) {
  const finalDataset = object(dataset, 'UPSTREAM_DATASET_INVALID');
  const verification = verifyLiquidityCalibrationDataset(finalDataset);
  if (!verification.valid) throw new Error(`UPSTREAM_DATASET_INVALID:${verification.reason}`);
  if (finalDataset.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || finalDataset.storeContract !== PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT
    || finalDataset.sampleClass !== FORWARD_NATURAL_SAMPLE) {
    throw new Error('UPSTREAM_DATASET_CONTRACT_INVALID');
  }
  if (!Array.isArray(ingestReceipts) || ingestReceipts.length === 0) {
    throw new Error('UPSTREAM_INGEST_RECEIPT_CHAIN_REQUIRED');
  }
  if (ingestReceipts.length !== finalDataset.batchProvenance.length) {
    throw new Error('UPSTREAM_INGEST_RECEIPT_CHAIN_LENGTH_MISMATCH');
  }

  const collectorCodeSha = exactSha(finalDataset.collectorCodeSha, 'UPSTREAM_COLLECTOR_SHA_INVALID');
  const expectedPath = text(datasetRelativePath, 'UPSTREAM_DATASET_RELATIVE_PATH_INVALID');
  const expectedImplementationPath = text(
    collectorImplementationPath,
    'UPSTREAM_COLLECTOR_IMPLEMENTATION_PATH_INVALID',
  );
  const finalById = new Map(finalDataset.observations.map((observation) => [observation.observationId, observation]));
  const seenObservationIds = new Set();
  let previousDatasetDigest = null;
  let previousObservationCount = 0;
  let previousDuplicateCount = 0;
  let implementationBlobSha = null;

  const receiptDigests = [];
  const artifactIds = [];
  const artifactDigests = [];
  const rawBatchDigests = [];

  for (let index = 0; index < ingestReceipts.length; index += 1) {
    const receipt = object(ingestReceipts[index], 'UPSTREAM_INGEST_RECEIPT_INVALID');
    if (receipt.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION) {
      throw new Error('UPSTREAM_INGEST_RECEIPT_VERSION_INVALID');
    }
    const receiptDigest = exactDigest(receipt.receiptDigest, 'UPSTREAM_INGEST_RECEIPT_DIGEST_INVALID');
    if (receiptDigest !== computePublicForwardLiquidityCaptureIngestReceiptDigest(receipt)) {
      throw new Error('UPSTREAM_INGEST_RECEIPT_DIGEST_MISMATCH');
    }
    assertTruthBoundary(receipt);

    if (exactSha(receipt.exactMainSha, 'UPSTREAM_RECEIPT_MAIN_SHA_INVALID') !== collectorCodeSha
      || exactSha(receipt.collectorCodeSha, 'UPSTREAM_RECEIPT_COLLECTOR_SHA_INVALID') !== collectorCodeSha
      || receipt.sampleClass !== finalDataset.sampleClass
      || receipt.storeContract !== finalDataset.storeContract) {
      throw new Error('UPSTREAM_RECEIPT_DATASET_CONTRACT_MISMATCH');
    }
    if (receipt.collectorImplementationPath !== expectedImplementationPath) {
      throw new Error('UPSTREAM_COLLECTOR_IMPLEMENTATION_PATH_INVALID');
    }
    const currentImplementationBlobSha = exactSha(
      receipt.collectorImplementationBlobSha,
      'UPSTREAM_COLLECTOR_IMPLEMENTATION_BLOB_INVALID',
    );
    if (implementationBlobSha === null) implementationBlobSha = currentImplementationBlobSha;
    else if (implementationBlobSha !== currentImplementationBlobSha) {
      throw new Error('UPSTREAM_COLLECTOR_IMPLEMENTATION_CHAIN_MISMATCH');
    }
    if (text(receipt.datasetRelativePath, 'UPSTREAM_RECEIPT_DATASET_PATH_INVALID') !== expectedPath) {
      throw new Error('UPSTREAM_RECEIPT_DATASET_PATH_MISMATCH');
    }

    const batchProvenanceIndex = nonNegativeInteger(
      receipt.batchProvenanceIndex,
      'UPSTREAM_BATCH_PROVENANCE_INDEX_INVALID',
    );
    if (batchProvenanceIndex !== index) throw new Error('UPSTREAM_RECEIPT_BATCH_INDEX_MISMATCH');
    if (nonNegativeInteger(receipt.datasetBatchProvenanceCount, 'UPSTREAM_DATASET_BATCH_COUNT_INVALID') !== index + 1) {
      throw new Error('UPSTREAM_RECEIPT_BATCH_COUNT_MISMATCH');
    }

    const predecessorDatasetDigest = receipt.predecessorDatasetDigest ?? null;
    if (index === 0) {
      if (predecessorDatasetDigest !== null) throw new Error('UPSTREAM_RECEIPT_CHAIN_FIRST_PREDECESSOR_NOT_NULL');
    } else if (exactDigest(predecessorDatasetDigest, 'UPSTREAM_PREDECESSOR_DIGEST_INVALID') !== previousDatasetDigest) {
      throw new Error('UPSTREAM_RECEIPT_CHAIN_PREDECESSOR_MISMATCH');
    }

    const batchObservationCount = nonNegativeInteger(
      receipt.batchObservationCount,
      'UPSTREAM_BATCH_OBSERVATION_COUNT_INVALID',
    );
    if (!Array.isArray(receipt.batchObservationIds)
      || receipt.batchObservationIds.length !== batchObservationCount
      || new Set(receipt.batchObservationIds).size !== batchObservationCount
      || canonicalJson(receipt.batchObservationIds) !== canonicalJson([...receipt.batchObservationIds].sort())) {
      throw new Error('UPSTREAM_BATCH_OBSERVATION_IDS_INVALID');
    }
    const insertedObservationCount = nonNegativeInteger(
      receipt.insertedObservationCount,
      'UPSTREAM_INSERTED_COUNT_INVALID',
    );
    const duplicateObservationCount = nonNegativeInteger(
      receipt.duplicateObservationCount,
      'UPSTREAM_DUPLICATE_COUNT_INVALID',
    );
    if (insertedObservationCount + duplicateObservationCount !== batchObservationCount
      || nonNegativeInteger(receipt.rawIngestObservationDelta, 'UPSTREAM_RAW_INGEST_DELTA_INVALID') !== insertedObservationCount) {
      throw new Error('UPSTREAM_BATCH_INSERT_DUPLICATE_COUNT_MISMATCH');
    }

    const batchObservations = receipt.batchObservationIds.map((observationId) => {
      const observation = finalById.get(observationId);
      if (!observation) throw new Error('UPSTREAM_BATCH_OBSERVATION_NOT_IN_FINAL_DATASET');
      return observation;
    }).sort((left, right) => left.observationId.localeCompare(right.observationId));
    if (exactDigest(receipt.batchObservationDigest, 'UPSTREAM_BATCH_OBSERVATION_DIGEST_INVALID')
      !== sha256(canonicalJson(batchObservations))) {
      throw new Error('UPSTREAM_BATCH_OBSERVATION_DIGEST_MISMATCH');
    }

    const expectedInserted = receipt.batchObservationIds.filter((observationId) => !seenObservationIds.has(observationId));
    const expectedDuplicates = receipt.batchObservationIds.filter((observationId) => seenObservationIds.has(observationId));
    if (expectedInserted.length !== insertedObservationCount || expectedDuplicates.length !== duplicateObservationCount) {
      throw new Error('UPSTREAM_BATCH_INSERT_DUPLICATE_IDENTITY_MISMATCH');
    }
    for (const observationId of receipt.batchObservationIds) seenObservationIds.add(observationId);

    const datasetObservationCount = nonNegativeInteger(
      receipt.datasetObservationCount,
      'UPSTREAM_DATASET_OBSERVATION_COUNT_INVALID',
    );
    const datasetDuplicateAttemptCount = nonNegativeInteger(
      receipt.datasetDuplicateAttemptCount,
      'UPSTREAM_DATASET_DUPLICATE_COUNT_INVALID',
    );
    if (datasetObservationCount !== previousObservationCount + insertedObservationCount
      || datasetObservationCount !== seenObservationIds.size) {
      throw new Error('UPSTREAM_DATASET_OBSERVATION_COUNT_CHAIN_MISMATCH');
    }
    if (datasetDuplicateAttemptCount !== previousDuplicateCount + duplicateObservationCount) {
      throw new Error('UPSTREAM_DATASET_DUPLICATE_COUNT_CHAIN_MISMATCH');
    }

    const currentDuplicateAttempts = finalDataset.duplicateAttempts.slice(
      previousDuplicateCount,
      datasetDuplicateAttemptCount,
    );
    if (currentDuplicateAttempts.length !== duplicateObservationCount) {
      throw new Error('UPSTREAM_DUPLICATE_ATTEMPT_SLICE_MISMATCH');
    }
    const expectedDuplicateIds = new Set(expectedDuplicates);
    for (const attempt of currentDuplicateAttempts) {
      if (!expectedDuplicateIds.has(attempt?.observationId)
        || attempt.sampleCountDelta !== 0
        || attempt.reason !== 'DUPLICATE_OBSERVATION_CREDIT_FORBIDDEN'
        || attempt.sourceDigest !== finalById.get(attempt.observationId)?.sourceDigest) {
        throw new Error('UPSTREAM_DUPLICATE_ATTEMPT_HISTORY_INVALID');
      }
    }

    const batchProvenance = finalDataset.batchProvenance[index];
    if (exactDigest(receipt.batchDatasetProvenanceDigest, 'UPSTREAM_BATCH_PROVENANCE_DIGEST_INVALID')
      !== sha256(canonicalJson(batchProvenance))) {
      throw new Error('UPSTREAM_BATCH_PROVENANCE_DIGEST_MISMATCH');
    }
    const rawBatchDigest = exactDigest(receipt.rawBatchDigest, 'UPSTREAM_RECEIPT_RAW_DIGEST_INVALID');
    exactDigest(batchProvenance?.rawDigest, 'UPSTREAM_BATCH_RAW_DIGEST_INVALID');

    const prefixObservations = sortedObservations(finalDataset, seenObservationIds);
    const prefixBatchProvenance = finalDataset.batchProvenance.slice(0, index + 1);
    const prefixDuplicateAttempts = finalDataset.duplicateAttempts.slice(0, datasetDuplicateAttemptCount);
    const reconstructedDatasetDigest = reconstructDatasetDigest({
      dataset: finalDataset,
      predecessorDigest: previousDatasetDigest,
      observations: prefixObservations,
      batchProvenance: prefixBatchProvenance,
      duplicateAttempts: prefixDuplicateAttempts,
    });
    const currentDatasetDigest = exactDigest(receipt.datasetDigest, 'UPSTREAM_RECEIPT_DATASET_DIGEST_INVALID');
    if (currentDatasetDigest !== reconstructedDatasetDigest) {
      throw new Error('UPSTREAM_RECEIPT_INTERMEDIATE_DATASET_DIGEST_MISMATCH');
    }

    previousDatasetDigest = currentDatasetDigest;
    previousObservationCount = datasetObservationCount;
    previousDuplicateCount = datasetDuplicateAttemptCount;
    receiptDigests.push(receiptDigest);
    artifactIds.push(decimalId(receipt.artifactId, 'UPSTREAM_ARTIFACT_ID_INVALID'));
    artifactDigests.push(exactDigest(receipt.artifactDigest, 'UPSTREAM_ARTIFACT_DIGEST_INVALID'));
    rawBatchDigests.push(rawBatchDigest);
  }

  if (previousDatasetDigest !== exactDigest(finalDataset.datasetDigest, 'UPSTREAM_DATASET_DIGEST_INVALID')) {
    throw new Error('UPSTREAM_RECEIPT_CHAIN_FINAL_DATASET_DIGEST_MISMATCH');
  }
  if (previousObservationCount !== finalDataset.observations.length
    || previousDuplicateCount !== finalDataset.duplicateAttempts.length) {
    throw new Error('UPSTREAM_RECEIPT_CHAIN_FINAL_COUNTS_MISMATCH');
  }

  const summary = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_INGEST_RECEIPT_CHAIN_VERSION,
    receiptCount: ingestReceipts.length,
    receiptDigests: Object.freeze(receiptDigests),
    artifactIds: Object.freeze(artifactIds),
    artifactDigests: Object.freeze(artifactDigests),
    rawBatchDigests: Object.freeze(rawBatchDigests),
    collectorImplementationBlobSha: implementationBlobSha,
    finalReceiptDigest: receiptDigests.at(-1),
    finalDatasetDigest: previousDatasetDigest,
  };
  return Object.freeze({
    ...summary,
    receiptChainDigest: sha256(canonicalJson(summary)),
  });
}
