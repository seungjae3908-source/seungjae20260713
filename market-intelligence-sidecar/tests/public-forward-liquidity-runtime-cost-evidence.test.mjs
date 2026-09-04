import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  LIQUIDITY_IMPACT_COST_OWNERS,
  LIQUIDITY_IMPACT_EVIDENCE_SCHEMA,
  LIQUIDITY_IMPACT_EVIDENCE_VERSION,
  computeLiquidityImpactArtifactDigest,
} from '../src/liquidity-impact-evidence-firewall.mjs';
import {
  computePublicForwardLiquidityCalibrationMethodologyDigest,
  validatePublicForwardLiquidityCalibrationArtifact,
} from '../src/public-forward-liquidity-calibration-artifact.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
} from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';
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
import {
  AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY,
  PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION,
  buildPublicForwardLiquidityRuntimeCostEvidence,
  computePublicForwardLiquidityRuntimeCostBridgeDigest,
} from '../src/public-forward-liquidity-runtime-cost-evidence.mjs';

const NOW = 20_000;
const CALIBRATION_SHA = 'a'.repeat(40);
const COLLECTOR_SHA = 'b'.repeat(40);
const RUNTIME_COST_SHA = 'd'.repeat(40);
const BRIDGE_SHA = 'e'.repeat(40);
const MEASUREMENT_SHA = 'f'.repeat(40);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  return createHash('sha256').update(payload).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function nativePolicy() {
  const contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT;
  const outcome = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  const splits = Object.fromEntries(['TRAIN', 'VALIDATION', 'OOS'].map((name) => {
    const split = contract.policyCore.splits[name];
    return [name, {
      startIndexInclusive: split.startIndexInclusive,
      endIndexInclusive: split.endIndexInclusive,
      expectedSlotN: split.expectedSlotN,
    }];
  }));
  return {
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    scheduleReliabilityContractVersion: contract.contractVersion,
    scheduleReliabilityNumericFreezeSha256: contract.numericFreezeSha256,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    splitMode: contract.policyCore.splits.mode,
    splits,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    oosOutcomeHorizonMs: outcome.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: outcome.outcomeSelectionPolicy,
  };
}

function assignment({ slotIndex, split, side, suffix }) {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex);
  return {
    observationId: `bound-observation-${suffix}`,
    sourceObservationId: `source-observation-${suffix}`,
    sourceIdentity: 'successor-v3-source',
    ingestSourceIdentity: 'successor-v3-ingest-source',
    eventIdentity: `public-event-${suffix}`,
    sourceFrameIdentity: `public-frame-${suffix}`,
    eventTimestampMs: 1_000 + slotIndex,
    aggressiveSide: side,
    split,
    slotIndex,
    canonicalSlotKeyDigest: sha256(slot.canonicalSlotKey),
    collectorCodeSha: COLLECTOR_SHA,
    datasetDigest: sha256('native-source-dataset'),
    ingestReceiptRelativePath: `receipts/${slotIndex}.json`,
    ingestReceiptDigest: sha256(`ingest-${suffix}`),
    captureReceiptDigest: sha256(`capture-${suffix}`),
    artifactReceiptDigest: sha256(`artifact-${suffix}`),
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
  };
}

function countsFor(observations) {
  const counts = {
    TRAIN: 0, TRAIN_BUY: 0, TRAIN_SELL: 0,
    VALIDATION: 0, VALIDATION_BUY: 0, VALIDATION_SELL: 0,
    OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
  };
  for (const item of observations) {
    counts[item.split] += 1;
    counts[`${item.split}_${item.aggressiveSide}`] += 1;
  }
  return counts;
}

function resignIndex(index) {
  const body = Object.fromEntries(Object.entries(index).filter(([key]) => key !== 'indexDigest'));
  return { ...body, indexDigest: sha256(body) };
}

function v3Index(overrides = {}) {
  const observations = [
    assignment({ slotIndex: 20, split: 'TRAIN', side: 'BUY', suffix: 'train' }),
    assignment({ slotIndex: 600, split: 'VALIDATION', side: 'SELL', suffix: 'validation' }),
    assignment({ slotIndex: 768, split: 'OOS', side: 'BUY', suffix: 'oos' }),
  ];
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
    kind: 'PUBLIC_FORWARD_LIQUIDITY_V3_FROZEN_SPLIT_PROPAGATION',
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    successorNativePolicy: nativePolicy(),
    producerCodeSha: CALIBRATION_SHA,
    sourceInventoryDigest: sha256('native-inventory'),
    independenceAuditDigest: sha256('native-independence'),
    independentSplitSourceDigest: sha256('native-independent-split-source'),
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    targetSlotIndex: 768,
    genuineScheduledSlotN: 3,
    creditedReceiptN: 3,
    sourceDatasetDigests: [sha256('native-source-dataset')],
    observations,
    effectiveIndependentN: observations.length,
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
    counts: countsFor(observations),
    ...overrides,
  };
  return resignIndex(body);
}

function resignValidation(validation) {
  const body = Object.fromEntries(Object.entries(validation).filter(([key]) => key !== 'validationDigest'));
  return { ...body, validationDigest: sha256(body) };
}

function nativeValidation(index, overrides = {}) {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    v3IndependentSplitIndexDigest: index.indexDigest,
    sourceInventoryDigest: index.sourceInventoryDigest,
    independenceAuditDigest: index.independenceAuditDigest,
    independentSplitSourceDigest: index.independentSplitSourceDigest,
    scheduleReliabilityContractVersion: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.contractVersion,
    scheduleReliabilityNumericFreezeSha256: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.numericFreezeSha256,
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    outcomeHorizonMs: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs,
    genuineScheduledSlotN: index.genuineScheduledSlotN,
    effectiveIndependentN: index.effectiveIndependentN,
    genuineV3OosSlotN: 1,
    genuineOosOutcomeN: 1,
    buyOosOutcomeN: 1,
    sellOosOutcomeN: 0,
    outcomeIds: ['native-oos-outcome'],
    outcomeDigest: sha256('native-oos-outcome-set'),
    exactOosCoverage: true,
    heldOut: true,
    contaminationFree: true,
    retrospectiveSplitSelection: false,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
    ...overrides,
  };
  return resignValidation(body);
}

function methodology(overrides = {}) {
  const body = {
    methodologyIdentity: 'successor-v3-liquidity-calibration-method',
    methodologyVersion: 'v1',
    methodologyFrozenAtMs: 1_000,
    fitSplits: ['TRAIN', 'VALIDATION'],
    oosUsedForFit: false,
    noRetuningAssertion: true,
    estimatorIdentity: 'frozen-liquidity-estimator-v1',
    estimatorDigest: sha256('native-estimator'),
    parameterSchemaIdentity: 'frozen-liquidity-parameter-schema-v1',
    parameterSchemaDigest: sha256('native-parameter-schema'),
    ...overrides,
  };
  return { ...body, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(body) };
}

function candidate(validation, method, overrides = {}) {
  return {
    artifactIdentity: 'successor-v3-liquidity-calibration-artifact',
    artifactVersion: 'v1',
    artifactProducerCodeSha: CALIBRATION_SHA,
    producedAtMs: 10_000,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    oosValidationSchemaVersion: PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_V3_OOS_VALIDATION_VERSION,
    oosValidationDigest: validation.validationDigest,
    v3IndependentSplitIndexDigest: validation.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: validation.sourceInventoryDigest,
    independenceAuditDigest: validation.independenceAuditDigest,
    independentSplitSourceDigest: validation.independentSplitSourceDigest,
    scheduleReliabilityNumericFreezeSha256: validation.scheduleReliabilityNumericFreezeSha256,
    policyDigest: validation.policyDigest,
    cohortDigest: validation.cohortDigest,
    oosHorizonPolicyDigest: validation.oosHorizonPolicyDigest,
    oosHorizonContractDigest: validation.oosHorizonContractDigest,
    oosOutcomeHorizonMs: validation.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy,
    calibrationMethodologyDigest: method.methodologyDigest,
    estimatorIdentity: method.estimatorIdentity,
    estimatorDigest: method.estimatorDigest,
    parameterSchemaIdentity: method.parameterSchemaIdentity,
    parameterSchemaDigest: method.parameterSchemaDigest,
    parameterPayloadDigest: sha256('native-parameters'),
    fitEvidenceDigest: sha256('native-fit-evidence'),
    trainObservationCount: 1,
    validationObservationCount: 1,
    oosObservationCount: validation.genuineOosOutcomeN,
    acceptedGenuineOosN: validation.genuineOosOutcomeN,
    buyOosOutcomeN: validation.buyOosOutcomeN,
    sellOosOutcomeN: validation.sellOosOutcomeN,
    rejectedOosN: 0,
    rejectionReasons: [],
    oosUsedForFit: false,
    noRetuningAssertion: true,
    historicalBackfillCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    runtimeLiquidityImpactCoefficient: null,
    liquidityImpactCostBps: null,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function calibrationArtifactInput() {
  const index = v3Index();
  const validation = nativeValidation(index);
  const method = methodology();
  return {
    oosValidationResult: { status: 'PRESENT', blockers: [], validation },
    v3SplitIndex: index,
    calibrationMethodology: method,
    candidate: candidate(validation, method),
    expectedArtifactProducerCodeSha: CALIBRATION_SHA,
  };
}

function competingCostEvidence() {
  return [
    ['VISIBLE_L2_BOOK_WALK_SLIPPAGE', 'book-walk'],
    ['LATENCY_ADVERSE_MOVE', 'latency'],
    ['SPREAD', 'spread'],
  ].map(([costOwner, seed]) => ({
    costOwner,
    evidenceIdentity: `${seed}-evidence-v1`,
    evidenceDigest: sha256(`${seed}-evidence`),
    sourceIdentity: `${seed}-source-v1`,
    sourceDigest: sha256(`${seed}-source`),
    sourceObservationLineageId: `${seed}-lineage-v1`,
    sourceObservationLineageDigest: sha256(`${seed}-lineage`),
  }));
}

function resealFirewall(artifact, overrides = {}) {
  const body = {
    ...artifact,
    ...overrides,
  };
  delete body.artifactDigest;
  return { ...body, artifactDigest: computeLiquidityImpactArtifactDigest(body) };
}

function firewallArtifact(calibrationAdmission) {
  const calibration = calibrationAdmission.artifact;
  const value = {
    schema: LIQUIDITY_IMPACT_EVIDENCE_SCHEMA,
    version: LIQUIDITY_IMPACT_EVIDENCE_VERSION,
    evidenceClass: 'CALIBRATION_ARTIFACT',
    testOnly: false,
    artifactId: 'residual-liquidity-impact-btc-v1',
    artifactDigest: null,
    methodologyVersion: calibration.calibrationMethodologyVersion,
    producerCodeSha: RUNTIME_COST_SHA,
    calibrationCodeSha: calibration.artifactProducerCodeSha,
    datasetIdentity: 'residual-liquidity-dataset-v1',
    datasetDigest: sha256('residual-liquidity-dataset'),
    sampleN: 48,
    trainDatasetIdentity: 'residual-liquidity-train-v1',
    trainDatasetDigest: sha256('residual-liquidity-train'),
    trainSampleN: 30,
    validationDatasetIdentity: 'residual-liquidity-validation-v1',
    validationDatasetDigest: sha256('residual-liquidity-validation'),
    validationSampleN: 15,
    oosDatasetIdentity: 'residual-liquidity-oos-v1',
    oosDatasetDigest: sha256('residual-liquidity-oos'),
    oosSampleN: 3,
    marketScopes: ['CRYPTO_FUTURES'],
    symbolScopes: ['BTCUSDT'],
    sideScopes: ['LONG'],
    quantityNotionalBucketIdentity: 'btc-usdt-notional-10k-25k-v1',
    volatilityRegimeIdentity: 'btc-realized-volatility-medium-v1',
    liquidityRegimeIdentity: 'btc-visible-depth-medium-v1',
    calibratedAt: 15_000,
    maximumAge: 10_000,
    provenance: {
      sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
      sourceProvider: 'BITGET_PUBLIC_UTA_V3',
      sourceIdentity: 'bitget-public-forward-residual-depth-trades-v1',
      sourceDigest: sha256('residual-provenance-source'),
      immutable: true,
    },
    sourceObservationLineage: {
      lineageId: 'residual-liquidity-lineage-v1',
      lineageDigest: sha256('residual-liquidity-lineage'),
      sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
      sourceIdentity: 'bitget-public-forward-residual-depth-trades-v1',
      observationCount: 48,
      firstObservedAt: 11_000,
      lastObservedAt: 14_500,
    },
    outOfSampleValidationReference: {
      referenceId: 'residual-liquidity-oos-validation-v1',
      referenceDigest: sha256('residual-liquidity-oos-validation'),
      trainDatasetIdentity: 'residual-liquidity-train-v1',
      trainDatasetDigest: sha256('residual-liquidity-train'),
      validationDatasetIdentity: 'residual-liquidity-validation-v1',
      validationDatasetDigest: sha256('residual-liquidity-validation'),
      oosDatasetIdentity: 'residual-liquidity-oos-v1',
      oosDatasetDigest: sha256('residual-liquidity-oos'),
      sampleN: 3,
      status: 'PASS',
      heldOut: true,
      contaminationFree: true,
      evaluatedAt: 14_000,
    },
    estimatedImpactPercent: 0.02,
    estimatedImpactBps: 2,
    zeroEvidenceReason: null,
    zeroEvidenceReference: null,
    costOwnership: {
      owner: LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY,
      excludedCostOwners: [
        LIQUIDITY_IMPACT_COST_OWNERS.BOOK_WALK,
        LIQUIDITY_IMPACT_COST_OWNERS.LATENCY,
        LIQUIDITY_IMPACT_COST_OWNERS.PARTIAL_FILL,
        LIQUIDITY_IMPACT_COST_OWNERS.SPREAD,
      ],
      sourceIdentity: 'residual-liquidity-calibration-output-v1',
      sourceDigest: sha256('residual-liquidity-calibration-output'),
    },
    independenceEvidence: {
      status: 'VERIFIED',
      targetVariable: 'RESIDUAL_PRICE_IMPACT_AFTER_SPREAD_VISIBLE_BOOK_WALK_LATENCY_AND_PARTIAL_FILL',
      bookWalkExcluded: true,
      latencyAdverseMoveExcluded: true,
      partialFillExcluded: true,
      spreadExcluded: true,
      implementationShortfallDecomposed: true,
      fullImplementationShortfallUsed: false,
      sharedObservationLineageAllowed: false,
      validationReferenceId: 'residual-liquidity-oos-validation-v1',
    },
  };
  value.artifactDigest = computeLiquidityImpactArtifactDigest(value);
  return value;
}

function firewallInput(artifact) {
  return {
    artifact,
    expected: {
      nowMs: NOW,
      maximumAge: 10_000,
      producerCodeSha: RUNTIME_COST_SHA,
      calibrationCodeSha: CALIBRATION_SHA,
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantityNotionalBucketIdentity: artifact.quantityNotionalBucketIdentity,
      volatilityRegimeIdentity: artifact.volatilityRegimeIdentity,
      liquidityRegimeIdentity: artifact.liquidityRegimeIdentity,
      provenance: {
        sourceType: artifact.provenance.sourceType,
        sourceProvider: artifact.provenance.sourceProvider,
        sourceIdentity: artifact.provenance.sourceIdentity,
        sourceDigest: artifact.provenance.sourceDigest,
      },
      competingCostEvidence: competingCostEvidence(),
    },
  };
}

function producerOutput(calibrationAdmission, artifact, expected) {
  const calibration = calibrationAdmission.artifact;
  return {
    schemaVersion: AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION,
    status: 'PRESENT',
    producerStatus: 'PRESENT',
    liquidityImpactStatus: 'BLOCKED_DATA',
    firewallValidationRequired: true,
    firewallArtifact: clone(artifact),
    nativeCalibrationBinding: {
      sourceContractFamily: calibration.sourceContractFamily,
      calibrationArtifactIdentity: calibration.artifactIdentity,
      calibrationArtifactDigest: calibration.artifactDigest,
      v3IndependentSplitIndexDigest: calibration.v3IndependentSplitIndexDigest,
      sourceInventoryDigest: calibration.sourceInventoryDigest,
      sourceDatasetDigests: [...calibration.sourceDatasetDigests],
      independenceAuditDigest: calibration.independenceAuditDigest,
      independentSplitSourceDigest: calibration.independentSplitSourceDigest,
      nativeOosValidationDigest: calibration.oosValidationDigest,
      nativeOosOutcomeDigest: calibration.oosOutcomeDigest,
      policyDigest: calibration.policyDigest,
      cohortDigest: calibration.cohortDigest,
      parameterPayloadDigest: calibration.parameterPayloadDigest,
      fitEvidenceDigest: calibration.fitEvidenceDigest,
      trainObservationCount: calibration.trainObservationCount,
      validationObservationCount: calibration.validationObservationCount,
      oosObservationCount: calibration.oosObservationCount,
      acceptedGenuineOosN: calibration.acceptedGenuineOosN,
      heldOutOosValidated: true,
      contaminationFree: true,
      oosUsedForFit: false,
      noRetuningAssertion: true,
    },
    runtimeMeasurementBinding: {
      measurementIdentity: 'residual-runtime-measurement-v1',
      measurementDigest: sha256('residual-runtime-measurement'),
      measurementProducerCodeSha: MEASUREMENT_SHA,
      datasetReceiptIdentity: 'residual-runtime-dataset-receipt-v1',
      datasetReceiptDigest: sha256('residual-runtime-dataset-receipt'),
      residualDatasetIdentity: artifact.datasetIdentity,
      residualDatasetDigest: artifact.datasetDigest,
      residualOosValidationReferenceDigest: artifact.outOfSampleValidationReference.referenceDigest,
      competingCostEvidence: clone(expected.competingCostEvidence),
    },
    runtimeEligible: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    fullCostReady: false,
    netAlphaReady: false,
    profitabilityProven: false,
    currentValidatedChampion: 'NONE',
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    blockers: [],
  };
}

function sealBridge(body) {
  const value = clone(body);
  delete value.bridgeDigest;
  return { ...value, bridgeDigest: computePublicForwardLiquidityRuntimeCostBridgeDigest(value) };
}

function bridge(calibrationAdmission, producer, artifact, expected, overrides = {}) {
  const calibration = calibrationAdmission.artifact;
  const native = producer.nativeCalibrationBinding;
  const runtime = producer.runtimeMeasurementBinding;
  return sealBridge({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION,
    producerSchemaVersion: AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION,
    bridgeIdentity: 'native-v3-liquidity-runtime-cost-bridge-v2',
    bridgeProducerCodeSha: BRIDGE_SHA,
    bridgedAtMs: 16_000,
    costOwner: LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY,
    sourceContractFamily: SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
    calibrationArtifactIdentity: calibration.artifactIdentity,
    calibrationArtifactDigest: calibration.artifactDigest,
    v3IndependentSplitIndexDigest: native.v3IndependentSplitIndexDigest,
    sourceInventoryDigest: native.sourceInventoryDigest,
    sourceDatasetDigests: [...native.sourceDatasetDigests],
    independenceAuditDigest: native.independenceAuditDigest,
    independentSplitSourceDigest: native.independentSplitSourceDigest,
    nativeOosValidationDigest: native.nativeOosValidationDigest,
    nativeOosOutcomeDigest: native.nativeOosOutcomeDigest,
    policyDigest: native.policyDigest,
    cohortDigest: native.cohortDigest,
    parameterPayloadDigest: native.parameterPayloadDigest,
    fitEvidenceDigest: native.fitEvidenceDigest,
    nativeTrainObservationCount: native.trainObservationCount,
    nativeValidationObservationCount: native.validationObservationCount,
    nativeOosObservationCount: native.oosObservationCount,
    acceptedGenuineOosN: native.acceptedGenuineOosN,
    runtimeMeasurementIdentity: runtime.measurementIdentity,
    runtimeMeasurementDigest: runtime.measurementDigest,
    datasetReceiptIdentity: runtime.datasetReceiptIdentity,
    datasetReceiptDigest: runtime.datasetReceiptDigest,
    residualDatasetIdentity: artifact.datasetIdentity,
    residualDatasetDigest: artifact.datasetDigest,
    residualOosValidationReferenceDigest: artifact.outOfSampleValidationReference.referenceDigest,
    residualTrainSampleN: artifact.trainSampleN,
    residualValidationSampleN: artifact.validationSampleN,
    residualOosSampleN: artifact.oosSampleN,
    liquidityImpactArtifactId: artifact.artifactId,
    liquidityImpactArtifactDigest: artifact.artifactDigest,
    calibrationMethodologyVersion: calibration.calibrationMethodologyVersion,
    market: expected.market,
    symbol: expected.symbol,
    side: expected.side,
    quantityNotionalBucketIdentity: expected.quantityNotionalBucketIdentity,
    volatilityRegimeIdentity: expected.volatilityRegimeIdentity,
    liquidityRegimeIdentity: expected.liquidityRegimeIdentity,
    testOnly: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  });
}

function validInput() {
  const calibrationInput = calibrationArtifactInput();
  const admission = validatePublicForwardLiquidityCalibrationArtifact(calibrationInput);
  assert.equal(admission.status, 'PRESENT', JSON.stringify(admission.blockers));
  const artifact = firewallArtifact(admission);
  const firewall = firewallInput(artifact);
  const producer = producerOutput(admission, artifact, firewall.expected);
  return {
    calibrationArtifactInput: calibrationInput,
    producerOutput: producer,
    liquidityImpactFirewallInput: firewall,
    bridge: bridge(admission, producer, artifact, firewall.expected),
    nowMs: NOW,
  };
}

function rebuildBridge(input, overrides) {
  const admission = validatePublicForwardLiquidityCalibrationArtifact(input.calibrationArtifactInput);
  const artifact = input.liquidityImpactFirewallInput.artifact;
  input.bridge = bridge(admission, input.producerOutput, artifact, input.liquidityImpactFirewallInput.expected, overrides);
}

test('maps Native V3 plus a separately measured residual dataset into PercentCostEvidence without cross-count equality', () => {
  const input = validInput();
  assert.notEqual(input.bridge.nativeTrainObservationCount, input.bridge.residualTrainSampleN);
  assert.notEqual(input.bridge.nativeValidationObservationCount, input.bridge.residualValidationSampleN);
  assert.notEqual(input.bridge.nativeOosObservationCount, input.bridge.residualOosSampleN);
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.liquidityImpactStatus, 'PRESENT');
  assert.equal(result.evidence.valuePercent, 0.02);
  assert.equal(result.evidence.quality, 'ESTIMATED');
  assert.equal(result.estimatedImpactBps, 2);
  assert.equal(result.runtimeLiquidityImpactCoefficient, null);
  assert.equal(result.runtimeCostCredit, 0);
  assert.equal(result.evidenceComplete, 0);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.currentValidatedChampion, 'NONE');
  assert.equal(result.executionAuthority, 'NONE');
});

test('legacy single datasetDigest bridge field is forbidden', () => {
  const input = validInput();
  rebuildBridge(input, { datasetDigest: input.liquidityImpactFirewallInput.artifact.datasetDigest });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LEGACY_SINGLE_DATASET_BRIDGE_FIELD_FORBIDDEN'));
});

test('legacy generic observation count bridge fields are forbidden', () => {
  const input = validInput();
  rebuildBridge(input, { trainObservationCount: 1, validationObservationCount: 1, oosObservationCount: 1 });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LEGACY_SINGLE_DATASET_BRIDGE_FIELD_FORBIDDEN'));
});

test('Native source dataset lineage mismatch fails closed before runtime credit', () => {
  const input = validInput();
  input.producerOutput.nativeCalibrationBinding.sourceDatasetDigests = [sha256('wrong-native-source')];
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NATIVE_CALIBRATION_BINDING_MISMATCH'));
});

test('Native OOS validation lineage mismatch fails closed', () => {
  const input = validInput();
  input.producerOutput.nativeCalibrationBinding.nativeOosValidationDigest = sha256('wrong-native-oos');
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NATIVE_CALIBRATION_BINDING_MISMATCH'));
});

test('a Native source digest cannot be overloaded as the residual measurement dataset', () => {
  const input = validInput();
  const admission = validatePublicForwardLiquidityCalibrationArtifact(input.calibrationArtifactInput);
  const nativeDigest = admission.artifact.sourceDatasetDigests[0];
  const original = input.liquidityImpactFirewallInput.artifact;
  const artifact = resealFirewall(original, { datasetDigest: nativeDigest });
  input.liquidityImpactFirewallInput.artifact = artifact;
  input.producerOutput.firewallArtifact = clone(artifact);
  input.producerOutput.runtimeMeasurementBinding.residualDatasetDigest = nativeDigest;
  rebuildBridge(input, { residualDatasetDigest: nativeDigest });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('NATIVE_SOURCE_DIGEST_AS_RESIDUAL_DATASET_FORBIDDEN'));
});

test('producer firewall candidate must be byte-semantically identical to the raw #775 artifact', () => {
  const input = validInput();
  input.producerOutput.firewallArtifact = {
    ...input.producerOutput.firewallArtifact,
    datasetIdentity: 'different-residual-dataset',
  };
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PRODUCER_FIREWALL_ARTIFACT_MISMATCH'));
});

test('residual sample counts are bound to the residual firewall artifact, not to Native counts', () => {
  const input = validInput();
  rebuildBridge(input, { residualTrainSampleN: 31 });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_COST_RESIDUAL_SAMPLE_MISMATCH'));
});

test('Native sample counts are bound to #805 independently of residual sample counts', () => {
  const input = validInput();
  rebuildBridge(input, { nativeTrainObservationCount: 2 });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_COST_NATIVE_SAMPLE_MISMATCH'));
});

test('bridge scope must remain bound to the raw firewall validation context', () => {
  const input = validInput();
  rebuildBridge(input, { symbol: 'ETHUSDT' });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_COST_SCOPE_BINDING_MISMATCH'));
});

test('tampered bridge digest is rejected', () => {
  const input = validInput();
  input.bridge.bridgeDigest = sha256('tampered-bridge');
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_COST_BRIDGE_DIGEST_MISMATCH'));
});

test('test-only firewall artifact cannot receive runtime cost evidence', () => {
  const input = validInput();
  const artifact = resealFirewall(input.liquidityImpactFirewallInput.artifact, {
    evidenceClass: 'TEST_FIXTURE',
    testOnly: true,
  });
  input.liquidityImpactFirewallInput.artifact = artifact;
  input.producerOutput.firewallArtifact = clone(artifact);
  rebuildBridge(input, { liquidityImpactArtifactDigest: artifact.artifactDigest });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_IMPACT_FIREWALL_REVALIDATION_FAILED'));
});

test('unproved zero liquidity impact remains blocked by the raw #775 firewall', () => {
  const input = validInput();
  const artifact = resealFirewall(input.liquidityImpactFirewallInput.artifact, {
    estimatedImpactPercent: 0,
    estimatedImpactBps: 0,
    zeroEvidenceReason: null,
    zeroEvidenceReference: null,
  });
  input.liquidityImpactFirewallInput.artifact = artifact;
  input.producerOutput.firewallArtifact = clone(artifact);
  rebuildBridge(input, { liquidityImpactArtifactDigest: artifact.artifactDigest });
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_IMPACT_FIREWALL_REVALIDATION_FAILED'));
});

test('missing genuine Native OOS still fails closed before producer/runtime promotion', () => {
  const input = validInput();
  input.calibrationArtifactInput = {
    oosValidationResult: {
      status: 'BLOCKED_DATA',
      blockers: ['SUCCESSOR_V3_OOS_OUTCOMES_MISSING'],
    },
  };
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_CALIBRATION_ARTIFACT_REVALIDATION_FAILED'));
  assert.equal(result.evidence, null);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.profitabilityProven, false);
});

test('premature producer economic or execution promotion is rejected', () => {
  const input = validInput();
  input.producerOutput = {
    ...input.producerOutput,
    runtimeCostCredit: 1,
    fullCostReady: true,
    executionAuthority: 'LIVE',
  };
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(input);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_COST_PRODUCER_AUTHORITY_BOUNDARY_INVALID'));
});

test('safety contract permanently separates code readiness from economic readiness', () => {
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.rawCalibrationArtifactRevalidated, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.rawProducerOutputRevalidated, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.rawLiquidityFirewallRevalidated, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.nativeSuccessorV3Only, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.nativeAndResidualLineageSeparated, true);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.legacySingleDatasetDigestBridgeAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.nativeSourceDigestAsResidualDatasetAllowed, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.nativeResidualSampleCountEqualityRequired, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.coefficientInventedByThisAdapter, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.unknownCostIsZero, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.runtimeCostCredit, 0);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.evidenceComplete, 0);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.netAlphaReady, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.profitabilityProven, false);
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.currentValidatedChampion, 'NONE');
  assert.equal(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY.executionAuthority, 'NONE');
});
