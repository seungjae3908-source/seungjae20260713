import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  mergeLiquidityCalibrationBatch,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  computePublicForwardLiquiditySplitPolicyDigest,
} from '../src/public-forward-liquidity-calibration-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from '../src/public-forward-liquidity-capture-ingest.mjs';
import {
  buildPublicForwardLiquidityIndependentSplitSource,
} from '../src/public-forward-liquidity-independence-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
} from '../src/public-forward-liquidity-multi-source-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION,
  run,
} from '../scripts/run-public-forward-liquidity-independence-audit.mjs';
import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';

const COLLECTOR_SHA = 'a'.repeat(40);
const PRODUCER_SHA = 'b'.repeat(40);
const IMPLEMENTATION_BLOB_SHA = 'c'.repeat(40);

function bookFrame({ marketTimestampMs, seed }) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: {
        ts: String(marketTimestampMs),
        b: [[100, 20 + seed], [99, 30 + seed]],
        a: [[101, 20 + seed], [102, 30 + seed]],
      },
    },
    requestStartedAtMs: marketTimestampMs - 50,
    receiveTimestampMs: marketTimestampMs + 10,
    maxFrameAgeMs: 10_000,
    endpoint: '/api/v3/market/orderbook',
    query: `category=USDT-FUTURES&symbol=BTCUSDT&limit=50&seed=${seed}`,
  });
}

function tradeFrame({ eventTimestampMs, seed }) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: [{
        execId: `exec-${seed}`,
        execLinkId: `exec-${seed}-link`,
        price: '101',
        size: '1',
        side: 'buy',
        ts: String(eventTimestampMs),
        isRPI: 'NO',
      }],
    },
    requestStartedAtMs: eventTimestampMs + 250,
    receiveTimestampMs: eventTimestampMs + 300,
    endpoint: '/api/v3/market/fills',
    query: `category=USDT-FUTURES&symbol=BTCUSDT&limit=100&seed=${seed}`,
  });
}

function batch(base, seed) {
  return buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame({ marketTimestampMs: base - 100, seed }),
    tradeFrame: tradeFrame({ eventTimestampMs: base, seed }),
    postEventBooks: [bookFrame({ marketTimestampMs: base + 600, seed: seed + 100 })],
    collectorCodeSha: COLLECTOR_SHA,
    maxPreEventBookAgeMs: 5_000,
  });
}

function cumulativeDataset() {
  let dataset = null;
  for (const [base, seed] of [[10_000, 1], [20_000, 2], [30_000, 3]]) {
    dataset = mergeLiquidityCalibrationBatch(dataset, batch(base, seed)).dataset;
  }
  return dataset;
}

function ingestReceipt(dataset, datasetRelativePath) {
  const batchProvenanceIndex = dataset.batchProvenance.length - 1;
  const latestObservation = dataset.observations.find((observation) => observation.eventTimestampMs === 30_000);
  const batchObservationIds = [latestObservation.observationId];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
    exactMainSha: COLLECTOR_SHA,
    collectorCodeSha: COLLECTOR_SHA,
    collectorImplementationPath: 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs',
    collectorImplementationBlobSha: IMPLEMENTATION_BLOB_SHA,
    repository: 'seungjae3908-source/seungjae20260713',
    sampleClass: dataset.sampleClass,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    captureRunId: '7001',
    captureRunAttempt: '1',
    rawBatchDigest: dataset.batchProvenance[batchProvenanceIndex].rawDigest,
    batchObservationIds,
    batchObservationCount: 1,
    batchObservationDigest: sha256(canonicalJson([latestObservation])),
    batchDatasetProvenanceDigest: sha256(canonicalJson(dataset.batchProvenance[batchProvenanceIndex])),
    batchProvenanceIndex,
    captureArtifactReceiptDigest: sha256('capture-artifact-receipt'),
    artifactId: '8001',
    artifactDigest: sha256('capture-artifact'),
    predecessorDatasetDigest: dataset.predecessorDigest,
    datasetDigest: dataset.datasetDigest,
    datasetRelativePath,
    datasetObservationCount: dataset.observations.length,
    datasetBatchProvenanceCount: dataset.batchProvenance.length,
    datasetDuplicateAttemptCount: dataset.duplicateAttempts.length,
    insertedObservationCount: 1,
    duplicateObservationCount: 0,
    rawIngestObservationDelta: 1,
    forwardCalibrationSampleCreditDelta: 0,
    independenceEvaluated: false,
    effectiveIndependentCalibrationN: null,
    calibrationSampleSufficient: false,
    independentSampleCreditAuthority: 'NONE_UNTIL_CANONICAL_INDEPENDENCE_TRANSFORM',
    canonicalDatasetPersistencePerformed: true,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: true,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    realOrders: 0,
  };
  return { ...body, receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body) };
}

function splitPolicy() {
  const body = {
    policyIdentity: 'runner-v2-frozen-split-policy',
    policyVersion: 'v1',
    policyFrozenAtMs: 8_000,
    expectedScopeOwnerIdentity: 'runner-scope-owner',
    expectedScopePolicyIdentity: 'runner-scope-policy',
    expectedScopePolicyDigest: sha256('runner-scope-policy'),
    expectedRegimeOwnerIdentity: 'runner-regime-owner',
    expectedRegimePolicyIdentity: 'runner-regime-policy',
    expectedRegimePolicyDigest: sha256('runner-regime-policy'),
    maxRegimeEvidenceAgeMs: 1_000,
    windows: {
      train: { startInclusiveMs: 9_000, endExclusiveMs: 15_000 },
      validation: { startInclusiveMs: 19_000, endExclusiveMs: 25_000 },
      oos: { startInclusiveMs: 29_000, endExclusiveMs: 35_000 },
    },
    overallMinimums: { train: 1, validation: 1, oos: 1 },
    scopeMinimums: [{
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      aggressiveSide: 'BUY',
      quantityNotionalBucketIdentity: 'bucket-1',
      volatilityRegimeIdentity: 'VOL_NORMAL',
      liquidityRegimeIdentity: 'LIQ_NORMAL',
      minimums: { train: 1, validation: 1, oos: 1 },
    }],
  };
  return { ...body, policyDigest: computePublicForwardLiquiditySplitPolicyDigest(body) };
}

function bindings(splitSource, policy) {
  const scopeBindings = splitSource.observations.map((entry, index) => ({
    observationId: entry.observationId,
    sourceObservationId: entry.sourceObservationId,
    sourceIdentity: entry.sourceIdentity,
    sourceDigest: entry.observation.sourceDigest,
    market: entry.observation.market,
    symbol: entry.observation.symbol,
    aggressiveSide: entry.observation.aggressiveSide,
    tradeFlowQuantity: entry.observation.tradeFlowQuantity,
    tradeFlowNotional: entry.observation.tradeFlowNotional,
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeOwnerIdentity: policy.expectedScopeOwnerIdentity,
    scopePolicyIdentity: policy.expectedScopePolicyIdentity,
    scopePolicyDigest: policy.expectedScopePolicyDigest,
    scopeEvidenceIdentity: `scope-evidence-${index}`,
    scopeEvidenceDigest: sha256(`scope-evidence-${index}`),
    scopePolicyFrozenAtMs: 8_000,
  }));
  const regimeBindings = splitSource.observations.map((entry, index) => ({
    observationId: entry.observationId,
    sourceObservationId: entry.sourceObservationId,
    sourceIdentity: entry.sourceIdentity,
    sourceDigest: entry.observation.sourceDigest,
    market: entry.observation.market,
    symbol: entry.observation.symbol,
    aggressiveSide: entry.observation.aggressiveSide,
    regimeOwnerIdentity: policy.expectedRegimeOwnerIdentity,
    regimePolicyIdentity: policy.expectedRegimePolicyIdentity,
    regimePolicyDigest: policy.expectedRegimePolicyDigest,
    regimeEvidenceIdentity: `regime-evidence-${index}`,
    regimeEvidenceDigest: sha256(`regime-evidence-${index}`),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    observedAtMs: entry.observation.eventTimestampMs - 10,
  }));
  return { scopeBindings, regimeBindings };
}

test('CLI produces deterministic provenance-bound V2 split receipt from cumulative #811 lineage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'liquidity-v2-runner-'));
  try {
    const stateRoot = join(root, 'state');
    const researchRepoRoot = join(root, 'checkout');
    const dataDir = join(stateRoot, 'forward', 'liquidity');
    await mkdir(dataDir, { recursive: true });
    await mkdir(researchRepoRoot, { recursive: true });

    const dataset = cumulativeDataset();
    const datasetPath = join(dataDir, 'dataset.json');
    const receiptPath = join(dataDir, 'ingest-receipt.json');
    const datasetRelativePath = 'forward/liquidity/dataset.json';
    const receipt = ingestReceipt(dataset, datasetRelativePath);
    await writeFile(datasetPath, `${canonicalJson(dataset)}\n`);
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);

    const source = { dataset, ingestReceipt: receipt, datasetRelativePath };
    const splitSourceResult = buildPublicForwardLiquidityIndependentSplitSource({
      sources: [source],
      producerCodeSha: PRODUCER_SHA,
    });
    assert.equal(splitSourceResult.status, 'PRESENT');
    assert.equal(splitSourceResult.audit.counts.INDEPENDENT_N, 3);

    const policy = splitPolicy();
    const { scopeBindings, regimeBindings } = bindings(splitSourceResult.splitSource, policy);
    const manifestPath = join(root, 'manifest.json');
    const policyPath = join(root, 'policy.json');
    const scopePath = join(root, 'scope.json');
    const regimePath = join(root, 'regime.json');
    const outputPath = join(root, 'v2-receipt.json');
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 'public-forward-liquidity-bound-source-manifest-v1',
      stateRoot,
      researchRepoRoot,
      sources: [{ datasetPath, ingestReceiptPath: receiptPath }],
    }));
    await writeFile(policyPath, canonicalJson(policy));
    await writeFile(scopePath, canonicalJson(scopeBindings));
    await writeFile(regimePath, canonicalJson(regimeBindings));

    const result = await run([
      '--source-manifest', manifestPath,
      '--producer-sha', PRODUCER_SHA,
      '--split-policy', policyPath,
      '--scope-bindings', scopePath,
      '--regime-bindings', regimePath,
      '--output', outputPath,
    ]);

    assert.equal(result.status, 'PRESENT');
    assert.equal(result.receipt.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION);
    assert.equal(result.receipt.splitAudit.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION);
    assert.equal(result.receipt.splitAudit.calibrationSampleSufficient, true);
    assert.equal(result.receipt.datasetDigests.length, 1);
    assert.equal(result.receipt.receiptDigests.length, 1);
    assert.deepEqual(result.receipt.collectorCodeShas, [COLLECTOR_SHA]);
    assert.equal(result.receipt.syntheticAggregateDataset, false);
    assert.equal(result.receipt.syntheticSingleCollector, false);
    assert.equal(result.receipt.oosValidationComplete, false);
    assert.equal(result.receipt.fullCostReady, false);
    assert.equal(result.receipt.executionAuthority, 'NONE');

    const written = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(written.receipt.receiptDigest, result.receipt.receiptDigest);
    assert.equal(written.receipt.upstreamLineageDigest, result.receipt.upstreamLineageDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
