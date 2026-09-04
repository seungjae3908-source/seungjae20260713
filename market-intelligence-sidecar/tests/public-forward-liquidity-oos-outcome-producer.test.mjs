import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  mergeLiquidityCalibrationBatch,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from '../src/public-forward-liquidity-capture-ingest.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_INGEST_RECEIPT_CHAIN_VERSION,
  verifyPublicForwardLiquidityIngestReceiptChain,
} from '../src/public-forward-liquidity-ingest-receipt-chain.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
} from '../src/public-forward-liquidity-multi-source-split-audit.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
  computePublicForwardLiquidityOosMethodologyDigest,
  validatePublicForwardLiquiditySuccessorV3OosOutcomes,
  validatePublicForwardLiquiditySuccessorV3SplitIndex,
} from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_OOS_OUTCOME_ARTIFACT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_OOS_SELECTION_POLICY,
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_OUTCOME_ARTIFACT_VERSION,
  producePublicForwardLiquidityHeldOutOosArtifact,
  producePublicForwardLiquiditySuccessorV3HeldOutOosArtifact,
} from '../src/public-forward-liquidity-oos-outcome-producer.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
} from '../src/public-forward-liquidity-successor-oos-outcome-horizon.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
} from '../src/public-forward-liquidity-v3-independence-binding.mjs';

const COLLECTOR_SHA = 'a'.repeat(40);
const COLLECTOR_BLOB = 'b'.repeat(40);
const SPLIT_PRODUCER_SHA = 'c'.repeat(40);
const OUTCOME_PRODUCER_SHA = 'd'.repeat(40);
const COLLECTOR_PATH = 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';
const DATASET_PATH = `forward/liquidity-calibration-v1/forward_natural_sample/${COLLECTOR_SHA}/dataset.json`;

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

function tradeFrame(events) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: events.map((event) => ({
        execId: event.execId,
        execLinkId: `${event.execId}-link`,
        price: '101',
        size: '1',
        side: event.side ?? 'buy',
        ts: String(event.eventTimestampMs),
        isRPI: 'NO',
      })),
    },
    requestStartedAtMs: 4_400,
    receiveTimestampMs: 4_500,
    endpoint: '/api/v3/market/fills',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function canonicalBatch({ duplicatePostFrame = false, postEventMs = 6_000 } = {}) {
  const post = bookFrame({ marketTimestampMs: postEventMs, seed: 9 });
  return buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame({ marketTimestampMs: 1_000, seed: 1 }),
    tradeFrame: tradeFrame([
      { execId: 'train-event', eventTimestampMs: 2_000 },
      { execId: 'validation-event', eventTimestampMs: 3_000 },
      { execId: 'oos-event', eventTimestampMs: 4_000 },
    ]),
    postEventBooks: duplicatePostFrame ? [post, post] : [post],
    collectorCodeSha: COLLECTOR_SHA,
    maxPreEventBookAgeMs: 5_000,
  });
}

function receiptForDataset(dataset) {
  const ids = dataset.observations.map((observation) => observation.observationId).sort();
  const observations = dataset.observations
    .filter((observation) => ids.includes(observation.observationId))
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  const provenance = dataset.batchProvenance[0];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
    exactMainSha: COLLECTOR_SHA,
    collectorCodeSha: COLLECTOR_SHA,
    collectorImplementationPath: COLLECTOR_PATH,
    collectorImplementationBlobSha: COLLECTOR_BLOB,
    repository: 'seungjae3908-source/seungjae20260713',
    sampleClass: dataset.sampleClass,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    captureRunId: '9001',
    captureRunAttempt: '1',
    rawBatchDigest: provenance.rawDigest,
    batchObservationIds: ids,
    batchObservationCount: ids.length,
    batchObservationDigest: sha256(canonicalJson(observations)),
    batchDatasetProvenanceDigest: sha256(canonicalJson(provenance)),
    batchProvenanceIndex: 0,
    captureArtifactReceiptDigest: sha256('capture-artifact-receipt'),
    artifactId: '9101',
    artifactDigest: sha256('capture-artifact'),
    predecessorDatasetDigest: null,
    datasetDigest: dataset.datasetDigest,
    datasetRelativePath: DATASET_PATH,
    datasetObservationCount: dataset.observations.length,
    datasetBatchProvenanceCount: 1,
    datasetDuplicateAttemptCount: 0,
    insertedObservationCount: dataset.observations.length,
    duplicateObservationCount: 0,
    rawIngestObservationDelta: dataset.observations.length,
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

function scopeKey(observation, side = observation.aggressiveSide) {
  return [observation.market, observation.symbol, side, 'bucket-1', 'VOL_NORMAL', 'LIQ_NORMAL'].join('|');
}

function buildFixture({ duplicatePostFrame = false, postEventMs = 6_000,
  splitLabels = ['TRAIN', 'VALIDATION', 'OOS'] } = {}) {
  const batch = canonicalBatch({ duplicatePostFrame, postEventMs });
  const dataset = mergeLiquidityCalibrationBatch(null, batch).dataset;
  const ingestReceipt = receiptForDataset(dataset);
  const chain = verifyPublicForwardLiquidityIngestReceiptChain({
    dataset,
    ingestReceipts: [ingestReceipt],
    datasetRelativePath: DATASET_PATH,
    collectorImplementationPath: COLLECTOR_PATH,
  });
  assert.equal(chain.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_INGEST_RECEIPT_CHAIN_VERSION);

  const upstream = {
    schemaVersion: 'public-forward-liquidity-bound-source-v1',
    sourceIdentity: 'bound-source:fixture',
    producerCodeSha: SPLIT_PRODUCER_SHA,
    collectorCodeSha: COLLECTOR_SHA,
    collectorImplementationPath: COLLECTOR_PATH,
    collectorImplementationBlobSha: COLLECTOR_BLOB,
    ingestReceiptChainVersion: chain.schemaVersion,
    ingestReceiptChainDigest: chain.receiptChainDigest,
    ingestReceiptCount: chain.receiptCount,
    ingestReceiptDigests: [...chain.receiptDigests],
    artifactIds: [...chain.artifactIds],
    artifactDigests: [...chain.artifactDigests],
    rawBatchDigests: [...chain.rawBatchDigests],
    datasetDigest: dataset.datasetDigest,
    datasetRelativePath: DATASET_PATH,
    receiptDigest: chain.finalReceiptDigest,
    artifactId: chain.artifactIds.at(-1),
    artifactDigest: chain.artifactDigests.at(-1),
    rawBatchDigest: chain.rawBatchDigests.at(-1),
  };
  const orderedObservations = [...dataset.observations]
    .sort((left, right) => left.eventTimestampMs - right.eventTimestampMs);
  const assignments = orderedObservations.map((observation, index) => ({
    observationId: `bound-${observation.observationId}`,
    sourceObservationId: observation.observationId,
    sourceIdentity: upstream.sourceIdentity,
    sourceDatasetDigest: upstream.datasetDigest,
    sourceReceiptDigest: upstream.receiptDigest,
    sourceReceiptChainDigest: upstream.ingestReceiptChainDigest,
    sourceReceiptCount: upstream.ingestReceiptCount,
    sourceCollectorCodeSha: upstream.collectorCodeSha,
    sourceDigest: observation.sourceDigest,
    eventIdentity: `public-event:${observation.observationId}`,
    sourceFrameIdentity: `source-frame:${index}`,
    publicExecutionId: observation.rawSourceProvenance.publicTrade.publicExecutionId,
    eventTimestampMs: observation.eventTimestampMs,
    split: splitLabels[index],
    scopeKey: scopeKey(observation),
    quantityNotionalBucketIdentity: 'bucket-1',
    scopeEvidenceIdentity: `scope-${index}`,
    scopeEvidenceDigest: sha256(`scope-${index}`),
    volatilityRegimeIdentity: 'VOL_NORMAL',
    liquidityRegimeIdentity: 'LIQ_NORMAL',
    regimeEvidenceIdentity: `regime-${index}`,
    regimeEvidenceDigest: sha256(`regime-${index}`),
  }));
  const counts = { train: 0, validation: 0, oos: 0 };
  for (const assignment of assignments) counts[assignment.split.toLowerCase()] += 1;
  const upstreamSources = [upstream];
  const auditBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_AUDIT_VERSION,
    independentSplitSourceVersion: 'public-forward-liquidity-independent-split-source-v1',
    independentSplitSourceDigest: sha256('independent-split-source'),
    independenceAuditDigest: sha256('independence-audit'),
    producerCodeSha: SPLIT_PRODUCER_SHA,
    datasetContract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    datasetStoreContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    sampleClass: FORWARD_NATURAL_SAMPLE,
    upstreamSources,
    upstreamLineageDigest: sha256(canonicalJson(upstreamSources)),
    datasetDigests: [upstream.datasetDigest],
    receiptDigests: [upstream.receiptDigest],
    receiptChainDigests: [upstream.ingestReceiptChainDigest],
    receiptCounts: [upstream.ingestReceiptCount],
    collectorCodeShas: [upstream.collectorCodeSha],
    splitPolicyIdentity: 'liquidity-forward-multi-source-split-policy-v2',
    splitPolicyVersion: 'v2',
    splitPolicyDigest: sha256('split-policy'),
    splitPolicyFrozenAtMs: 1_500,
    scopeOwnerIdentity: 'canonical-liquidity-scope-owner',
    scopePolicyIdentity: 'canonical-liquidity-scope-policy-v1',
    scopePolicyDigest: sha256('scope-policy'),
    regimeOwnerIdentity: 'canonical-regime-owner',
    regimePolicyIdentity: 'canonical-regime-policy-v1',
    regimePolicyDigest: sha256('regime-policy'),
    totalObservationCount: assignments.length,
    counts,
    assignments,
    assignmentDigest: sha256(canonicalJson(assignments)),
    scopeCounts: [],
    sampleDeficits: [],
    regimeScopeComplete: true,
    splitAssignmentComplete: true,
    calibrationSampleSufficient: true,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const audit = { ...auditBody, auditDigest: sha256(canonicalJson(auditBody)) };
  const receiptBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_MULTI_SOURCE_SPLIT_RECEIPT_VERSION,
    status: 'PRESENT',
    blockers: [],
    producerCodeSha: audit.producerCodeSha,
    independenceAuditDigest: audit.independenceAuditDigest,
    independentSplitSourceDigest: audit.independentSplitSourceDigest,
    splitAuditDigest: audit.auditDigest,
    upstreamLineageDigest: audit.upstreamLineageDigest,
    datasetDigests: [...audit.datasetDigests],
    receiptDigests: [...audit.receiptDigests],
    collectorCodeShas: [...audit.collectorCodeShas],
    splitPolicyDigest: audit.splitPolicyDigest,
    scopeBindingsDigest: sha256('scope-bindings'),
    regimeBindingsDigest: sha256('regime-bindings'),
    splitAudit: audit,
    syntheticAggregateDataset: false,
    syntheticSingleCollector: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  const splitReceipt = { ...receiptBody, receiptDigest: sha256(canonicalJson(receiptBody)) };
  const methodology = methodologyFor({ frozenAtMs: splitLabels[1] === 'OOS' ? 2_500 : 3_500 });
  return {
    dataset,
    ingestReceipt,
    upstream,
    audit,
    splitReceipt,
    methodology,
    sources: [{ dataset, ingestReceipts: [ingestReceipt], datasetRelativePath: DATASET_PATH }],
  };
}

function successorNativePolicy() {
  const contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT;
  const outcome = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  return {
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    scheduleReliabilityContractVersion: contract.contractVersion,
    scheduleReliabilityNumericFreezeSha256: contract.numericFreezeSha256,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    splitMode: contract.policyCore.splits.mode,
    splits: Object.fromEntries(['TRAIN', 'VALIDATION', 'OOS'].map((name) => [name, {
      startIndexInclusive: contract.policyCore.splits[name].startIndexInclusive,
      endIndexInclusive: contract.policyCore.splits[name].endIndexInclusive,
      expectedSlotN: contract.policyCore.splits[name].expectedSlotN,
    }])),
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    oosOutcomeHorizonMs: outcome.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: outcome.outcomeSelectionPolicy,
  };
}

function nativeSuccessorFixture({ slotIndex = 768, postEventMs = 9_000 } = {}) {
  const fixture = buildFixture({ postEventMs });
  const sourceObservation = [...fixture.dataset.observations]
    .sort((left, right) => left.eventTimestampMs - right.eventTimestampMs)
    .at(-1);
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex);
  const canonicalSlotKeyDigest = sha256(canonicalJson(slot.canonicalSlotKey));
  const captureReceiptDigest = sha256('successor-capture-receipt');
  const artifactReceiptDigest = sha256('successor-artifact-receipt');
  const receiptBody = {
    ...fixture.ingestReceipt,
    captureArtifactReceiptDigest: artifactReceiptDigest,
    sourceV3Lineage: {
      sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
      producerWorkflowName: 'Public Forward Liquidity Successor Scheduled Capture',
      producerWorkflowId: 347888347,
      triggerSource: 'schedule',
      scheduleReliabilityContractVersion: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.contractVersion,
      scheduleReliabilityNumericFreezeSha256: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.numericFreezeSha256,
      oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
      oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
      oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
      cohortId: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortId,
      prospectiveSlotCredit: 1,
      manualCredit: 0,
      replayCredit: 0,
      backfillCredit: 0,
      operatorSelectedCredit: 0,
      slotIndex,
      split: slot.split,
      policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
      cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
      canonicalSlotKey: slot.canonicalSlotKey,
      canonicalSlotKeyDigest,
      captureReceiptDigest,
      artifactReceiptDigest,
    },
  };
  delete receiptBody.receiptDigest;
  const ingestReceipt = {
    ...receiptBody,
    receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(receiptBody),
  };
  const observation = {
    observationId: `bound-${sourceObservation.observationId}`,
    sourceObservationId: sourceObservation.observationId,
    sourceIdentity: 'bound-source:successor-v3',
    ingestSourceIdentity: 'v3-cohort:test',
    eventIdentity: `public-event:${sourceObservation.observationId}`,
    sourceFrameIdentity: 'source-frame:successor-v3',
    eventTimestampMs: sourceObservation.eventTimestampMs,
    aggressiveSide: sourceObservation.aggressiveSide,
    split: slot.split,
    slotIndex,
    canonicalSlotKeyDigest,
    collectorCodeSha: COLLECTOR_SHA,
    datasetDigest: fixture.dataset.datasetDigest,
    ingestReceiptRelativePath: `receipts/${slotIndex}.json`,
    ingestReceiptDigest: ingestReceipt.receiptDigest,
    captureReceiptDigest,
    artifactReceiptDigest,
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
  };
  const counts = {
    TRAIN: slot.split === 'TRAIN' ? 1 : 0,
    TRAIN_BUY: slot.split === 'TRAIN' && observation.aggressiveSide === 'BUY' ? 1 : 0,
    TRAIN_SELL: slot.split === 'TRAIN' && observation.aggressiveSide === 'SELL' ? 1 : 0,
    VALIDATION: slot.split === 'VALIDATION' ? 1 : 0,
    VALIDATION_BUY: slot.split === 'VALIDATION' && observation.aggressiveSide === 'BUY' ? 1 : 0,
    VALIDATION_SELL: slot.split === 'VALIDATION' && observation.aggressiveSide === 'SELL' ? 1 : 0,
    OOS: slot.split === 'OOS' ? 1 : 0,
    OOS_BUY: slot.split === 'OOS' && observation.aggressiveSide === 'BUY' ? 1 : 0,
    OOS_SELL: slot.split === 'OOS' && observation.aggressiveSide === 'SELL' ? 1 : 0,
  };
  const indexBody = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
    kind: 'PUBLIC_FORWARD_LIQUIDITY_V3_FROZEN_SPLIT_PROPAGATION',
    producerCodeSha: SPLIT_PRODUCER_SHA,
    sourceInventoryDigest: sha256('source-inventory'),
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    successorNativePolicy: successorNativePolicy(),
    independenceAuditDigest: sha256('v3-independence-audit'),
    independentSplitSourceDigest: sha256('v3-independent-split-source'),
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    targetSlotIndex: slotIndex,
    genuineScheduledSlotN: 1,
    creditedReceiptN: 1,
    sourceDatasetDigests: [fixture.dataset.datasetDigest],
    effectiveIndependentN: 1,
    counts,
    observations: [observation],
    duplicateObservationLineageN: 0,
    frozenSplitSource: 'V3_SCHEDULED_SLOT_RECEIPT_ONLY',
    retrospectiveSplitSelection: false,
    syntheticSplitAssignment: false,
    additionalIndependentSampleCredit: 0,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    realOrders: 0,
  };
  const v3SplitIndex = { ...indexBody, indexDigest: sha256(canonicalJson(indexBody)) };
  return {
    ...fixture,
    ingestReceipt,
    v3SplitIndex,
    sources: [{
      sourceIdentity: observation.ingestSourceIdentity,
      dataset: fixture.dataset,
      ingestReceipts: [ingestReceipt],
      ingestReceiptRelativePaths: [observation.ingestReceiptRelativePath],
      datasetRelativePath: DATASET_PATH,
    }],
  };
}

function methodologyFor({ frozenAtMs = 3_500, horizonMs = 2_000, includeHorizon = true } = {}) {
  const body = {
    methodologyIdentity: 'liquidity-oos-public-market-outcome-v1',
    methodologyDigest: null,
    methodologyFrozenAtMs: frozenAtMs,
    oosDataAccessBeforeFreeze: false,
    allowedCalibrationSplits: ['TRAIN', 'VALIDATION'],
    outcomeHorizonIdentity: 'PUBLIC_FORWARD_2S_AFTER_EVENT',
    ...(includeHorizon ? {
      outcomeHorizonMs: horizonMs,
      outcomeSelectionPolicy: PUBLIC_FORWARD_LIQUIDITY_OOS_SELECTION_POLICY,
    } : {}),
  };
  body.methodologyDigest = computePublicForwardLiquidityOosMethodologyDigest(body);
  return body;
}

function resignAudit(fixture, mutate) {
  const audit = structuredClone(fixture.audit);
  mutate(audit);
  delete audit.auditDigest;
  audit.assignmentDigest = sha256(canonicalJson(audit.assignments));
  audit.upstreamLineageDigest = sha256(canonicalJson(audit.upstreamSources));
  audit.datasetDigests = audit.upstreamSources.map((source) => source.datasetDigest);
  audit.receiptDigests = audit.upstreamSources.map((source) => source.receiptDigest);
  audit.receiptChainDigests = audit.upstreamSources.map((source) => source.ingestReceiptChainDigest);
  audit.receiptCounts = audit.upstreamSources.map((source) => source.ingestReceiptCount);
  audit.collectorCodeShas = [...new Set(audit.upstreamSources.map((source) => source.collectorCodeSha))].sort();
  audit.auditDigest = sha256(canonicalJson(audit));
  const receiptBody = {
    ...structuredClone(fixture.splitReceipt),
    splitAudit: audit,
    splitAuditDigest: audit.auditDigest,
    upstreamLineageDigest: audit.upstreamLineageDigest,
    datasetDigests: [...audit.datasetDigests],
    receiptDigests: [...audit.receiptDigests],
    collectorCodeShas: [...audit.collectorCodeShas],
    splitPolicyDigest: audit.splitPolicyDigest,
  };
  delete receiptBody.receiptDigest;
  const splitReceipt = { ...receiptBody, receiptDigest: sha256(canonicalJson(receiptBody)) };
  return { ...fixture, audit, splitReceipt };
}

function produce(fixture, overrides = {}) {
  return producePublicForwardLiquidityHeldOutOosArtifact({
    splitReceipt: fixture.splitReceipt,
    methodology: fixture.methodology,
    sources: fixture.sources,
    outcomeProducerCodeSha: OUTCOME_PRODUCER_SHA,
    createdAtMs: 10_000,
    ...overrides,
  });
}

test('one genuine frozen assignment produces one immutable post-freeze OOS outcome', () => {
  const fixture = buildFixture();
  const result = produce(fixture);
  assert.equal(result.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_OOS_OUTCOME_ARTIFACT_VERSION);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.assignmentCount, 1);
  assert.equal(result.matureAssignmentCount, 1);
  assert.equal(result.settledOutcomeCount, 1);
  assert.equal(result.missingOutcomeCount, 0);
  assert.equal(result.rejectedOutcomeCount, 0);
  assert.equal(result.buyOosCount, 1);
  assert.equal(result.sellOosCount, 0);
  assert.equal(result.exactOosCoverage, true);
  assert.equal(result.oosPolicyPass, true);
  assert.equal(result.outcomes[0].sourceType, 'PUBLIC_FORWARD_MARKET_DATA');
  assert.equal(result.outcomes[0].observedAtMs, 6_000);
  assert.equal(result.outcomes[0].executionCostEligible, false);
  assert.equal(result.outcomes[0].liquidityImpactCoefficient, null);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.evidenceCompleteCredit, 0);
  assert.match(result.outcomeArtifactDigest, /^[a-f0-9]{64}$/u);
});

test('split receipt authenticity and upstream lineage tampering fail closed', () => {
  const fixture = buildFixture();
  assert.ok(produce(fixture, { splitReceipt: null }).blockers.includes('MULTI_SOURCE_SPLIT_RECEIPT_REQUIRED'));

  const forged = structuredClone(fixture.splitReceipt);
  forged.receiptDigest = 'f'.repeat(64);
  assert.ok(produce(fixture, { splitReceipt: forged }).blockers.includes('MULTI_SOURCE_SPLIT_RECEIPT_DIGEST_MISMATCH'));

  const embedded = structuredClone(fixture.splitReceipt);
  embedded.splitAudit.assignments[2].scopeKey = 'CRYPTO_FUTURES|ETHUSDT|BUY|bucket-1|VOL_NORMAL|LIQ_NORMAL';
  const embeddedBody = { ...embedded };
  delete embeddedBody.receiptDigest;
  embedded.receiptDigest = sha256(canonicalJson(embeddedBody));
  const embeddedResult = produce(fixture, { splitReceipt: embedded });
  assert.equal(embeddedResult.status, 'BLOCKED_DATA');
  assert.ok(embeddedResult.blockers.includes('SPLIT_ASSIGNMENT_DIGEST_MISMATCH'));
  assert.ok(embeddedResult.blockers.includes('SPLIT_AUDIT_DIGEST_MISMATCH'));

  const wrongIndependence = { ...fixture.splitReceipt, independenceAuditDigest: sha256('wrong-independence') };
  const wrongIndependenceBody = { ...wrongIndependence };
  delete wrongIndependenceBody.receiptDigest;
  wrongIndependence.receiptDigest = sha256(canonicalJson(wrongIndependenceBody));
  assert.ok(produce(fixture, { splitReceipt: wrongIndependence }).blockers
    .includes('MULTI_SOURCE_SPLIT_RECEIPT_INDEPENDENCE_DIGEST_MISMATCH'));

  const wrongUpstream = { ...fixture.splitReceipt, upstreamLineageDigest: sha256('wrong-upstream') };
  const wrongUpstreamBody = { ...wrongUpstream };
  delete wrongUpstreamBody.receiptDigest;
  wrongUpstream.receiptDigest = sha256(canonicalJson(wrongUpstreamBody));
  assert.ok(produce(fixture, { splitReceipt: wrongUpstream }).blockers
    .includes('MULTI_SOURCE_SPLIT_RECEIPT_UPSTREAM_DIGEST_MISMATCH'));
});

test('frozen-time firewall rejects missing horizon policy and immature future evidence', () => {
  const fixture = buildFixture();
  const noHorizon = methodologyFor({ includeHorizon: false });
  assert.ok(produce(fixture, { methodology: noHorizon }).blockers.includes('OOS_HORIZON_POLICY_MISSING'));

  const immature = methodologyFor({ horizonMs: 20_000 });
  const result = produce(fixture, { methodology: immature });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.matureAssignmentCount, 0);
  assert.equal(result.missingOutcomeCount, 1);
  assert.ok(result.blockers.includes('NO_MATURE_FROZEN_ASSIGNMENTS'));
  assert.ok(result.blockers.includes('NO_POST_FREEZE_PUBLIC_FORWARD_OBSERVATIONS'));

  const preFreeze = methodologyFor({ frozenAtMs: 4_000 });
  assert.ok(produce(fixture, { methodology: preFreeze }).blockers.includes('OOS_METHODOLOGY_NOT_FROZEN_BEFORE_OOS'));
});

test('wrong market, symbol, side, assignment and fabricated BUY/SELL inversion fail closed', () => {
  const fixture = buildFixture();
  for (const scope of [
    'CRYPTO_FUTURES|ETHUSDT|BUY|bucket-1|VOL_NORMAL|LIQ_NORMAL',
    'CRYPTO_FUTURES|BTCUSDT|SELL|bucket-1|VOL_NORMAL|LIQ_NORMAL',
    'US_STOCK|BTCUSDT|BUY|bucket-1|VOL_NORMAL|LIQ_NORMAL',
  ]) {
    const altered = resignAudit(fixture, (audit) => { audit.assignments[2].scopeKey = scope; });
    const result = produce(altered);
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.settledOutcomeCount, 0);
  }
  const wrongAssignment = resignAudit(fixture, (audit) => { audit.assignments[2].sourceObservationId = 'missing-source-observation'; });
  const missing = produce(wrongAssignment);
  assert.equal(missing.status, 'BLOCKED_DATA');
  assert.ok(missing.assignmentOutcomes[0].rejectionReason.includes('OOS_SOURCE_OBSERVATION_MISSING'));
});

test('broken dataset, receipt chain, receipt digest and collector implementation fail closed', () => {
  const fixture = buildFixture();
  const noSource = produce(fixture, { sources: [] });
  assert.equal(noSource.status, 'BLOCKED_DATA');
  assert.equal(noSource.assignmentOutcomes[0].rejectionReason, 'OOS_SOURCE_EVIDENCE_REQUIRED');

  const brokenReceipt = structuredClone(fixture.sources[0]);
  brokenReceipt.ingestReceipts[0].receiptDigest = 'f'.repeat(64);
  const receiptResult = produce(fixture, { sources: [brokenReceipt] });
  assert.equal(receiptResult.status, 'BLOCKED_DATA');
  assert.match(receiptResult.assignmentOutcomes[0].rejectionReason, /OOS_SOURCE_RECEIPT_CHAIN_INVALID/u);

  const wrongDataset = structuredClone(fixture.sources[0]);
  wrongDataset.dataset.datasetDigest = 'e'.repeat(64);
  const datasetResult = produce(fixture, { sources: [wrongDataset] });
  assert.equal(datasetResult.status, 'BLOCKED_DATA');

  const wrongBlob = resignAudit(fixture, (audit) => {
    audit.upstreamSources[0].collectorImplementationBlobSha = 'e'.repeat(40);
  });
  const blobResult = produce(wrongBlob);
  assert.equal(blobResult.status, 'BLOCKED_DATA');
  assert.match(blobResult.assignmentOutcomes[0].rejectionReason, /OOS_SOURCE_COLLECTOR_IMPLEMENTATION_MISMATCH/u);
});

test('replay, duplicate frame and one observation double-credit are rejected instead of selecting a favorable result', () => {
  const replayFixture = buildFixture({ duplicatePostFrame: true });
  const replay = produce(replayFixture);
  assert.equal(replay.status, 'BLOCKED_DATA');
  assert.match(replay.assignmentOutcomes[0].rejectionReason, /OOS_REPLAY_OUTCOME_SOURCE/u);

  const doubleFixture = buildFixture({ splitLabels: ['TRAIN', 'OOS', 'OOS'] });
  const double = produce(doubleFixture);
  assert.equal(double.status, 'BLOCKED_DATA');
  assert.equal(double.assignmentCount, 2);
  assert.equal(double.settledOutcomeCount, 1);
  assert.equal(double.rejectedOutcomeCount, 1);
  assert.ok(double.assignmentOutcomes.some((row) => row.rejectionReason === 'OOS_PUBLIC_FRAME_REUSED'));
});

test('historical/backfill/synthetic authority cannot be upgraded to genuine OOS', () => {
  const fixture = buildFixture();
  const syntheticDataset = resignAudit(fixture, (audit) => { audit.datasetDigest = sha256('synthetic-aggregate'); });
  assert.ok(produce(syntheticDataset).blockers.includes('SYNTHETIC_AGGREGATE_DATASET_FORBIDDEN'));

  const syntheticCollector = resignAudit(fixture, (audit) => { audit.collectorCodeSha = COLLECTOR_SHA; });
  assert.ok(produce(syntheticCollector).blockers.includes('SYNTHETIC_SINGLE_COLLECTOR_FORBIDDEN'));

  const backfillSource = structuredClone(fixture.sources[0]);
  backfillSource.dataset.observations[2].historicalBackfillForwardCredit = 1;
  const backfill = produce(fixture, { sources: [backfillSource] });
  assert.equal(backfill.status, 'BLOCKED_DATA');
  assert.equal(backfill.settledOutcomeCount, 0);

  const method = methodologyFor();
  method.oosDataAccessBeforeFreeze = true;
  method.methodologyDigest = computePublicForwardLiquidityOosMethodologyDigest(method);
  assert.ok(produce(fixture, { methodology: method }).blockers.includes('OOS_PRE_FREEZE_DATA_ACCESS_FORBIDDEN'));
});

test('producer never creates independent-N, cost, calibration, profitability or execution credit', () => {
  const result = produce(buildFixture());
  assert.equal(result.effectiveIndependentN, null);
  assert.equal(result.buyCoverageProven, false);
  assert.equal(result.representativenessProven, false);
  assert.equal(result.calibrationArtifactProduced, false);
  assert.equal(result.liquidityImpactProduced, false);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.evidenceCompleteCredit, 0);
  assert.equal(result.replayCredit, 0);
  assert.equal(result.backfillCredit, 0);
  assert.equal(result.syntheticCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.orderSubmitted, false);
});

function produceNative(fixture, overrides = {}) {
  return producePublicForwardLiquiditySuccessorV3HeldOutOosArtifact({
    v3SplitIndex: fixture.v3SplitIndex,
    sources: fixture.sources,
    outcomeProducerCodeSha: OUTCOME_PRODUCER_SHA,
    createdAtMs: 10_000,
    ...overrides,
  });
}

function resignNativeIndex(index, mutate) {
  const value = structuredClone(index);
  mutate(value);
  delete value.indexDigest;
  return { ...value, indexDigest: sha256(canonicalJson(value)) };
}

test('native Successor V3 OOS index selects the exact frozen 5000ms public outcome', () => {
  const fixture = nativeSuccessorFixture();
  const indexVerdict = validatePublicForwardLiquiditySuccessorV3SplitIndex(fixture.v3SplitIndex);
  assert.equal(indexVerdict.valid, true);
  const result = produceNative(fixture);
  assert.equal(result.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_OUTCOME_ARTIFACT_VERSION);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.sourceContractFamily, SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY);
  assert.equal(result.outcomeHorizonMs, 5_000);
  assert.equal(result.assignmentCount, 1);
  assert.equal(result.genuineV3OosSlotN, 1);
  assert.equal(result.genuineOosOutcomeN, 1);
  assert.equal(result.outcomes[0].slotIndex, 768);
  assert.equal(result.outcomes[0].observedAtMs, 9_000);
  assert.equal(result.outcomes[0].v3IndependentSplitIndexDigest, fixture.v3SplitIndex.indexDigest);
  const validation = validatePublicForwardLiquiditySuccessorV3OosOutcomes({
    v3SplitIndex: fixture.v3SplitIndex,
    outcomes: result.outcomes,
    expectedOutcomeProducerCodeSha: OUTCOME_PRODUCER_SHA,
  });
  assert.equal(validation.status, 'PRESENT');
  assert.equal(validation.validation.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION);
  assert.equal(validation.validation.genuineOosOutcomeN, 1);
  assert.equal(validation.validation.calibrationArtifactProduced, false);
  assert.equal(validation.validation.fullCostReady, false);
  assert.equal(validation.validation.executionAuthority, 'NONE');
  const inverted = structuredClone(result.outcomes);
  inverted[0].aggressiveSide = inverted[0].aggressiveSide === 'BUY' ? 'SELL' : 'BUY';
  assert.ok(validatePublicForwardLiquiditySuccessorV3OosOutcomes({
    v3SplitIndex: fixture.v3SplitIndex,
    outcomes: inverted,
    expectedOutcomeProducerCodeSha: OUTCOME_PRODUCER_SHA,
  }).blockers.includes('SUCCESSOR_V3_OOS_OUTCOME_LINEAGE_MISMATCH'));
});

test('current genuine TRAIN lineage remains missing OOS evidence instead of becoming zero-valued proof', () => {
  const fixture = nativeSuccessorFixture({ slotIndex: 20 });
  const result = produceNative(fixture);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.deepEqual(result.blockers, ['SUCCESSOR_V3_OOS_ASSIGNMENTS_MISSING']);
  assert.equal(result.genuineV3OosSlotN, 0);
  assert.equal(result.genuineOosOutcomeN, 0);
  assert.equal(result.oosStatus, 'MISSING_EVIDENCE');
  assert.equal(result.fullCostReady, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('native Successor V3 index rejects legacy-family relabel, horizon drift, and split drift', () => {
  const fixture = nativeSuccessorFixture();
  const wrongFamily = resignNativeIndex(fixture.v3SplitIndex, (index) => {
    index.sourceContractFamily = 'CALIBRATION_V3';
  });
  assert.ok(validatePublicForwardLiquiditySuccessorV3SplitIndex(wrongFamily).blockers
    .includes('SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY_INVALID'));

  const wrongHorizon = resignNativeIndex(fixture.v3SplitIndex, (index) => {
    index.successorNativePolicy.oosOutcomeHorizonMs = 60_000;
  });
  assert.ok(validatePublicForwardLiquiditySuccessorV3SplitIndex(wrongHorizon).blockers
    .includes('SUCCESSOR_V3_NATIVE_POLICY_LINEAGE_MISMATCH'));

  const wrongSplit = resignNativeIndex(fixture.v3SplitIndex, (index) => {
    index.observations[0].split = 'TRAIN';
    index.counts = {
      TRAIN: 1, TRAIN_BUY: 1, TRAIN_SELL: 0,
      VALIDATION: 0, VALIDATION_BUY: 0, VALIDATION_SELL: 0,
      OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
    };
  });
  assert.ok(validatePublicForwardLiquiditySuccessorV3SplitIndex(wrongSplit).blockers
    .includes('SUCCESSOR_V3_INDEX_ASSIGNMENT_FROZEN_SPLIT_MISMATCH'));
});

test('native Successor V3 producer rejects tampered receipt lineage and never promotes economics', () => {
  const fixture = nativeSuccessorFixture();
  fixture.sources[0].ingestReceipts[0].sourceV3Lineage.artifactReceiptDigest = sha256('forged');
  const result = produceNative(fixture);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('SUCCESSOR_V3_OOS_OUTCOMES_MISSING'));
  assert.ok(result.blockers.includes('OOS_OUTCOME_REJECTED'));
  assert.equal(result.genuineOosOutcomeN, 0);
  assert.equal(result.calibrationArtifactProduced, false);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.evidenceCompleteCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
});
