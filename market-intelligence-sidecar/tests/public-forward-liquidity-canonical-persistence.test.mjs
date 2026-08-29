import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  canonicalJson,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
  buildPublicForwardLiquidityCanonicalSplitSource,
  computePublicForwardLiquidityCanonicalDigest,
  persistPublicForwardLiquidityCanonicalCaptures,
  verifyPublicForwardLiquidityCanonicalDataset,
} from '../src/public-forward-liquidity-canonical-persistence.mjs';

const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const PRODUCER_SHA = 'f'.repeat(40);
const REPO_ROOT = resolve(process.cwd());

function digest(seed) {
  return computePublicForwardLiquidityCanonicalDigest({ seed });
}

function observation({
  collectorCodeSha,
  eventNumber,
  eventTimestampMs,
  publicExecutionId = `execution-${eventNumber}`,
  preEventBookTimestampMs = eventTimestampMs - 100,
  postEventTimestampsMs = [eventTimestampMs + 100],
  frameSeed = `frame-${eventNumber}`,
  quantity = 2,
}) {
  const publicExecutionPrice = 100;
  const rawSourceProvenance = {
    preEventBook: {
      endpoint: '/api/v3/market/orderbook',
      query: { category: 'USDT-FUTURES', symbol: 'BTCUSDT' },
      marketTimestampMs: preEventBookTimestampMs,
      receiveTimestampMs: preEventBookTimestampMs + 1,
      rawPayloadDigest: digest(`pre-${frameSeed}`),
    },
    publicTrade: {
      endpoint: '/api/v3/market/fills',
      query: { category: 'USDT-FUTURES', symbol: 'BTCUSDT' },
      publicExecutionId,
      publicExecutionLinkId: '',
      receiveTimestampMs: eventTimestampMs + 1,
      rawFrameDigest: digest(`trade-frame-${frameSeed}`),
      rawTradeDigest: digest(`trade-${publicExecutionId}-${quantity}`),
    },
    postEventBooks: postEventTimestampsMs.map((marketTimestampMs, index) => ({
      endpoint: '/api/v3/market/orderbook',
      query: { category: 'USDT-FUTURES', symbol: 'BTCUSDT' },
      marketTimestampMs,
      receiveTimestampMs: marketTimestampMs + 1,
      rawPayloadDigest: digest(`post-${frameSeed}-${index}`),
    })),
  };
  const preEventVisibleL2Depth = {
    bids: [{ price: 99, quantity: 10 }],
    asks: [{ price: 101, quantity: 12 }],
    bidQuantity: 10,
    askQuantity: 12,
    bidNotional: 990,
    askNotional: 1212,
  };
  const sourceDigest = digest({
    publicExecutionId,
    eventTimestampMs,
    quantity,
    rawSourceProvenance,
  });
  return {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    observationId: `collector-observation-${eventNumber}-${quantity}`,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    forwardCalibrationSampleCredit: 1,
    historicalBackfillForwardCredit: 0,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    eventTimestampMs,
    receiveTimestampMs: eventTimestampMs + 1,
    aggressiveSide: 'BUY',
    aggressiveSideMethod: 'BITGET_PUBLIC_TRADE_SIDE_VERIFIED_AT_PRE_EVENT_BBO',
    tradeFlowQuantity: quantity,
    tradeFlowNotional: quantity * publicExecutionPrice,
    publicExecutionPrice,
    preEventBestBid: 99,
    preEventBestAsk: 101,
    preEventMid: 100,
    preEventSpread: 2,
    preEventSpreadBps: 200,
    preEventVisibleL2Depth,
    preEventBookDigest: digest(`pre-${frameSeed}`),
    instantaneousVisibleDepthBookWalk: null,
    subsequentPublicPriceDrift: [],
    publicDataSource: 'BITGET_PUBLIC_UTA_V3',
    rawSourceProvenance,
    sourceDigest,
    collectorCodeSha,
    missingDataFlags: [],
    calibrationSourceOnly: true,
    executionCostEligible: false,
    liquidityImpactCoefficient: null,
    causalMarketImpactClaim: false,
    paperOrderSourceAllowed: false,
    safety: {
      publicDataOnly: true,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      liveTradingAllowed: false,
      realOrderAllowed: false,
      financialMutationAllowed: false,
    },
  };
}

function captureBundle({ runId, artifactId, collectorCodeSha, observations, droppedEvents = [] }) {
  const startedAtMs = Math.min(...observations.map((value) => value.rawSourceProvenance.preEventBook.marketTimestampMs));
  const completedAtMs = Math.max(...observations.flatMap((value) => [
    value.receiveTimestampMs,
    ...value.rawSourceProvenance.postEventBooks.map((frame) => frame.receiveTimestampMs),
  ]));
  const datasetProvenance = {
    rawSource: {
      provider: 'BITGET_PUBLIC_UTA_V3',
      endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
      privateApiUsed: false,
    },
    collectionPeriod: { startedAtMs, completedAtMs },
    firstObservedAtMs: Math.min(...observations.map((value) => value.eventTimestampMs)),
    lastObservedAtMs: Math.max(...observations.map((value) => value.eventTimestampMs)),
    eventCount: observations.length,
    droppedCount: droppedEvents.length,
    droppedReasons: {},
    rawDigest: digest(`raw-${runId}`),
    normalizedDigest: digest(observations),
    collectorCodeSha,
  };
  const batch = {
    schemaVersion: 1,
    kind: 'public-forward-liquidity-calibration-batch',
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    observations,
    droppedEvents,
    datasetProvenance,
    readiness: {
      LIQUIDITY_IMPACT_PRESENT: false,
      CALIBRATION_SAMPLE_SUFFICIENT: false,
      LIQUIDITY_IMPACT_STATUS: 'BLOCKED_DATA',
      FULL_COST_READY: false,
    },
    safety: {
      publicDataOnly: true,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      liveTradingAllowed: false,
      realOrderAllowed: false,
      financialMutationAllowed: false,
    },
  };
  const rawBatchDigest = sha256(canonicalJson(batch));
  const captureReceipt = {
    schemaVersion: 'public-forward-liquidity-capture-receipt-v1',
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT',
    triggerSource: 'MANUAL_WORKFLOW_DISPATCH',
    runId: String(runId),
    runAttempt: '1',
    repository: REPOSITORY,
    exactMainSha: collectorCodeSha,
    collectorCodeSha,
    symbol: 'BTCUSDT',
    sampleClass: FORWARD_NATURAL_SAMPLE,
    eventObservationDelayMs: 1000,
    postObservationDelaysMs: [1000],
    maxPreEventBookAgeMs: 5000,
    captureStatus: observations.length > 0 ? 'PRESENT' : 'BLOCKED_DATA',
    blockers: [],
    prospectiveObservationCount: observations.length,
    droppedObservationCount: droppedEvents.length,
    datasetProvenance,
    rawBatchDigest,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
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
  const rawArtifact = {
    id: String(artifactId),
    name: `public-forward-liquidity-capture-${runId}-1`,
    digest: digest(`raw-artifact-${artifactId}`),
  };
  const receiptArtifact = {
    id: String(Number(artifactId) + 1),
    name: `public-forward-liquidity-capture-receipt-${runId}-1`,
    digest: digest(`receipt-artifact-${artifactId}`),
  };
  const artifactReceiptBody = {
    schemaVersion: 'public-forward-liquidity-capture-artifact-receipt-v1',
    exactMainSha: collectorCodeSha,
    collectorCodeSha,
    captureStatus: captureReceipt.captureStatus,
    rawBatchDigest,
    prospectiveObservationCount: observations.length,
    artifactId: rawArtifact.id,
    artifactName: rawArtifact.name,
    artifactDigest: rawArtifact.digest,
    artifactReference: `https://github.com/${REPOSITORY}/actions/runs/${runId}/artifacts/${artifactId}`,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    fullCostReady: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return {
    expectedRepository: REPOSITORY,
    batch,
    captureReceipt,
    artifactReceipt: {
      ...artifactReceiptBody,
      receiptDigest: computePublicForwardLiquidityCanonicalDigest(artifactReceiptBody),
    },
    rawArtifact,
    receiptArtifact,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'liquidity-canonical-'));
  const stateRoot = join(root, 'state');
  await mkdir(stateRoot);
  return {
    root,
    stateRoot,
    persist: (captures) => persistPublicForwardLiquidityCanonicalCaptures({
      stateRoot,
      researchRepoRoot: REPO_ROOT,
      storeContract: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
      producerCodeSha: PRODUCER_SHA,
      captures,
    }),
  };
}

test('persists immutable lineage across collector SHAs and counts independent observations', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const firstSha = '1'.repeat(40);
  const secondSha = '2'.repeat(40);
  const firstBundle = captureBundle({
    runId: 1001,
    artifactId: 2001,
    collectorCodeSha: firstSha,
    observations: [observation({ collectorCodeSha: firstSha, eventNumber: 1, eventTimestampMs: 10_000 })],
  });
  const secondBundle = captureBundle({
    runId: 1002,
    artifactId: 2003,
    collectorCodeSha: secondSha,
    observations: [observation({ collectorCodeSha: secondSha, eventNumber: 2, eventTimestampMs: 20_000 })],
  });
  const firstResult = await context.persist([firstBundle]);
  const result = await context.persist([secondBundle]);
  assert.equal(result.report.previousDatasetDigest, firstResult.dataset.datasetDigest);
  assert.equal(result.report.changed, true);
  assert.deepEqual(result.dataset.collectorCodeShas, [firstSha, secondSha]);
  assert.deepEqual(result.dataset.producerCodeShas, [PRODUCER_SHA]);
  assert.deepEqual(result.dataset.counts, {
    RAW_CAPTURE_N: 2,
    RAW_ACCEPTED_N: 2,
    RAW_DROPPED_N: 0,
    UNIQUE_EVENT_N: 2,
    CROSS_BATCH_DUPLICATE_N: 0,
    INTRA_BATCH_DUPLICATE_N: 0,
    IDENTITY_COLLISION_N: 0,
    CANONICAL_ACCEPTED_N: 2,
    INDEPENDENT_N: 2,
    DEPENDENT_REJECTED_N: 0,
    SOURCE_FRAME_COLLISION_N: 0,
  });
  assert.deepEqual(verifyPublicForwardLiquidityCanonicalDataset(result.dataset), { valid: true, reason: null });
  const splitSource = buildPublicForwardLiquidityCanonicalSplitSource(result.dataset);
  assert.equal(splitSource.observationCount, 2);
  assert.equal(splitSource.observations.length, result.report.INDEPENDENT_N);
  assert.equal(splitSource.observations[0].admission.independenceCredit, 1);
  assert.equal(splitSource.observations[0].observation.collectorCodeSha, firstSha);
  assert.equal(splitSource.split.splitAssignmentPerformed, false);
  assert.equal(result.dataset.split.splitAssignmentPerformed, false);
  assert.equal(result.dataset.readiness.fullCostReady, false);
});

test('deduplicates one public event across batches without assigning independent N twice', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const collectorCodeSha = '3'.repeat(40);
  const firstFrame = observation({ collectorCodeSha, eventNumber: 1, eventTimestampMs: 10_000 });
  const laterFrame = observation({
    collectorCodeSha,
    eventNumber: 1,
    eventTimestampMs: 10_000,
    frameSeed: 'later-capture-of-same-event',
    preEventBookTimestampMs: 9_950,
    postEventTimestampsMs: [10_300],
  });
  const result = await context.persist([
    captureBundle({ runId: 1101, artifactId: 2101, collectorCodeSha, observations: [firstFrame] }),
    captureBundle({ runId: 1102, artifactId: 2103, collectorCodeSha, observations: [laterFrame] }),
  ]);
  assert.equal(result.report.RAW_ACCEPTED_N, 2);
  assert.equal(result.report.UNIQUE_EVENT_N, 1);
  assert.equal(result.report.CROSS_BATCH_DUPLICATE_N, 1);
  assert.equal(result.report.CANONICAL_ACCEPTED_N, 1);
  assert.equal(result.report.INDEPENDENT_N, 1);
  assert.equal(buildPublicForwardLiquidityCanonicalSplitSource(result.dataset).observations.length, 1);
});

test('rejects all variants when one event identity has conflicting public-event payloads', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const collectorCodeSha = '4'.repeat(40);
  const first = observation({ collectorCodeSha, eventNumber: 1, eventTimestampMs: 10_000, quantity: 2 });
  const conflicting = observation({ collectorCodeSha, eventNumber: 1, eventTimestampMs: 10_000, quantity: 3 });
  const result = await context.persist([
    captureBundle({ runId: 1201, artifactId: 2201, collectorCodeSha, observations: [first] }),
    captureBundle({ runId: 1202, artifactId: 2203, collectorCodeSha, observations: [conflicting] }),
  ]);
  assert.equal(result.report.UNIQUE_EVENT_N, 1);
  assert.equal(result.report.IDENTITY_COLLISION_N, 1);
  assert.equal(result.report.CANONICAL_ACCEPTED_N, 0);
  assert.equal(result.report.INDEPENDENT_N, 0);
  assert.equal(buildPublicForwardLiquidityCanonicalSplitSource(result.dataset).observations.length, 0);
  assert.equal(result.dataset.identityCollisions[0].observationIdentities.length, 2);
});

test('collapses shared source frames and overlapping source windows to independent representatives', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const collectorCodeSha = '5'.repeat(40);
  const sameFrameFirst = observation({
    collectorCodeSha,
    eventNumber: 1,
    eventTimestampMs: 10_000,
    frameSeed: 'shared',
    preEventBookTimestampMs: 9_900,
    postEventTimestampsMs: [10_500],
  });
  const sameFrameSecond = observation({
    collectorCodeSha,
    eventNumber: 2,
    eventTimestampMs: 10_100,
    frameSeed: 'shared',
    preEventBookTimestampMs: 9_900,
    postEventTimestampsMs: [10_500],
  });
  const overlappingDifferentFrame = observation({
    collectorCodeSha,
    eventNumber: 3,
    eventTimestampMs: 10_700,
    frameSeed: 'overlap',
    preEventBookTimestampMs: 10_400,
    postEventTimestampsMs: [11_000],
  });
  const independent = observation({
    collectorCodeSha,
    eventNumber: 4,
    eventTimestampMs: 20_000,
    frameSeed: 'independent',
    preEventBookTimestampMs: 19_900,
    postEventTimestampsMs: [20_500],
  });
  const result = await context.persist([
    captureBundle({
      runId: 1301,
      artifactId: 2301,
      collectorCodeSha,
      observations: [sameFrameFirst, sameFrameSecond, overlappingDifferentFrame, independent],
    }),
  ]);
  assert.equal(result.report.CANONICAL_ACCEPTED_N, 4);
  assert.equal(result.report.INDEPENDENT_N, 2);
  assert.equal(result.report.DEPENDENT_REJECTED_N, 2);
  assert.equal(result.report.SOURCE_FRAME_COLLISION_N, 1);
  assert.ok(result.dataset.dependentRejections.some((value) => value.reasons.includes('SAME_SOURCE_FRAME')));
  assert.ok(result.dataset.dependentRejections.some((value) => value.reasons.includes('OVERLAPPING_OBSERVATION_WINDOW')));
});

test('is idempotent and leaves immutable bytes unchanged for a repeated capture bundle', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const collectorCodeSha = '6'.repeat(40);
  const bundle = captureBundle({
    runId: 1401,
    artifactId: 2401,
    collectorCodeSha,
    observations: [observation({ collectorCodeSha, eventNumber: 1, eventTimestampMs: 10_000 })],
  });
  const first = await context.persist([bundle]);
  const before = await readFile(first.datasetPath, 'utf8');
  const second = await context.persist([bundle]);
  const after = await readFile(second.datasetPath, 'utf8');
  assert.equal(first.report.changed, true);
  assert.equal(second.report.changed, false);
  assert.equal(second.report.insertedCaptureBatchN, 0);
  assert.equal(second.report.duplicateCaptureBatchN, 1);
  assert.equal(second.dataset.datasetDigest, first.dataset.datasetDigest);
  assert.equal(after, before);
});

test('fails closed for artifact mismatch, tampered state, and unsafe state roots', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const collectorCodeSha = '7'.repeat(40);
  const bundle = captureBundle({
    runId: 1501,
    artifactId: 2501,
    collectorCodeSha,
    observations: [observation({ collectorCodeSha, eventNumber: 1, eventTimestampMs: 10_000 })],
  });
  const mismatched = structuredClone(bundle);
  mismatched.rawArtifact.digest = digest('wrong-artifact');
  await assert.rejects(context.persist([mismatched]), /RAW_ARTIFACT_IDENTITY_MISMATCH/u);
  const first = await context.persist([bundle]);
  const tampered = structuredClone(first.dataset);
  tampered.counts.INDEPENDENT_N = 99;
  assert.equal(verifyPublicForwardLiquidityCanonicalDataset(tampered).valid, false);
  await writeFile(first.datasetPath, `${JSON.stringify(tampered)}\n`, 'utf8');
  await assert.rejects(context.persist([bundle]), /CANONICAL_LIQUIDITY_DATASET_CHAIN_BROKEN/u);
  await assert.rejects(
    persistPublicForwardLiquidityCanonicalCaptures({
      stateRoot: 'relative-state',
      researchRepoRoot: REPO_ROOT,
      storeContract: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
      producerCodeSha: PRODUCER_SHA,
      captures: [bundle],
    }),
    /STATE_ROOT_MUST_BE_ABSOLUTE/u,
  );
  await assert.rejects(
    persistPublicForwardLiquidityCanonicalCaptures({
      stateRoot: REPO_ROOT,
      researchRepoRoot: REPO_ROOT,
      storeContract: PUBLIC_FORWARD_LIQUIDITY_CANONICAL_STORE_CONTRACT,
      producerCodeSha: PRODUCER_SHA,
      captures: [bundle],
    }),
    /STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT/u,
  );
});
