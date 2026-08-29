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
import { PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION } from '../src/public-forward-liquidity-calibration-oos-outcome-validator.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY,
  PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION,
  buildPublicForwardLiquidityRuntimeCostEvidence,
  computePublicForwardLiquidityRuntimeCostBridgeDigest,
} from '../src/public-forward-liquidity-runtime-cost-evidence.mjs';

const NOW = 3_000;
const CALIBRATION_SHA = 'c'.repeat(40);
const RUNTIME_SHA = 'd'.repeat(40);
const BRIDGE_SHA = 'e'.repeat(40);
const COLLECTOR_SHA = 'a'.repeat(40);
const OUTCOME_SHA = 'b'.repeat(40);
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const D4 = '4'.repeat(64);
const D5 = '5'.repeat(64);
const D6 = '6'.repeat(64);
const D7 = '7'.repeat(64);

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function validOosValidation() {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_OOS_VALIDATION_VERSION,
    splitAuditDigest: D1,
    datasetContract: 'public-forward-liquidity-calibration-v1',
    datasetStoreContract: 'public-forward-liquidity-calibration-store-v1',
    datasetDigest: D2,
    collectorCodeSha: COLLECTOR_SHA,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    splitPolicyIdentity: 'liq-split-policy',
    splitPolicyVersion: 'v1',
    splitPolicyDigest: D3,
    methodologyIdentity: 'liq-oos-methodology',
    methodologyDigest: D4,
    methodologyFrozenAtMs: 1_000,
    outcomeHorizonIdentity: 'horizon-5m',
    outcomeProducerCodeSha: OUTCOME_SHA,
    oosAssignmentCount: 3,
    scoredOutcomeCount: 3,
    oosAssignmentDigest: D5,
    outcomeIds: ['o1', 'o2', 'o3'],
    outcomeDigest: D6,
    exactOosCoverage: true,
    heldOut: true,
    contaminationFree: true,
    genuinePublicForwardMarketData: true,
    causalMarketImpactClaim: false,
    oosValidationComplete: true,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return { ...body, validationDigest: digest(body) };
}

function validCalibrationMethodology() {
  const body = {
    methodologyIdentity: 'liq-calibration-methodology',
    methodologyVersion: 'v1',
    methodologyFrozenAtMs: 900,
    fitSplits: ['TRAIN', 'VALIDATION'],
    oosUsedForFit: false,
    estimatorIdentity: 'pre-registered-estimator',
    estimatorDigest: D7,
    parameterSchemaIdentity: 'liq-impact-parameter-payload-v1',
    parameterSchemaDigest: '8'.repeat(64),
  };
  return { ...body, methodologyDigest: computePublicForwardLiquidityCalibrationMethodologyDigest(body) };
}

function validCalibrationInput() {
  const oosValidation = validOosValidation();
  const calibrationMethodology = validCalibrationMethodology();
  const candidate = {
    artifactIdentity: 'liq-calibration-artifact-001',
    artifactVersion: 'v1',
    artifactProducerCodeSha: CALIBRATION_SHA,
    producedAtMs: 2_000,
    oosValidationDigest: oosValidation.validationDigest,
    datasetDigest: oosValidation.datasetDigest,
    splitPolicyDigest: oosValidation.splitPolicyDigest,
    calibrationMethodologyDigest: calibrationMethodology.methodologyDigest,
    estimatorIdentity: calibrationMethodology.estimatorIdentity,
    estimatorDigest: calibrationMethodology.estimatorDigest,
    parameterSchemaIdentity: calibrationMethodology.parameterSchemaIdentity,
    parameterSchemaDigest: calibrationMethodology.parameterSchemaDigest,
    parameterPayloadDigest: '9'.repeat(64),
    fitEvidenceDigest: 'f'.repeat(64),
    trainObservationCount: 30,
    validationObservationCount: 15,
    oosObservationCount: 3,
    oosUsedForFit: false,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    liquidityImpactCostBps: null,
    runtimeLiquidityImpactCoefficient: null,
  };
  return {
    oosValidation,
    calibrationMethodology,
    candidate,
    expectedArtifactProducerCodeSha: CALIBRATION_SHA,
  };
}

function competingCostEvidence() {
  return [
    {
      costOwner: LIQUIDITY_IMPACT_COST_OWNERS.BOOK_WALK,
      evidenceIdentity: 'book-walk-evidence',
      evidenceDigest: 'a'.repeat(64),
      sourceIdentity: 'book-walk-source',
      sourceDigest: 'b'.repeat(64),
      sourceObservationLineageId: 'book-walk-lineage',
      sourceObservationLineageDigest: 'c'.repeat(64),
    },
    {
      costOwner: LIQUIDITY_IMPACT_COST_OWNERS.LATENCY,
      evidenceIdentity: 'latency-evidence',
      evidenceDigest: 'd'.repeat(64),
      sourceIdentity: 'decision-arrival-source',
      sourceDigest: 'e'.repeat(64),
      sourceObservationLineageId: 'latency-lineage',
      sourceObservationLineageDigest: 'f'.repeat(64),
    },
    {
      costOwner: LIQUIDITY_IMPACT_COST_OWNERS.SPREAD,
      evidenceIdentity: 'spread-evidence',
      evidenceDigest: '0'.repeat(64),
      sourceIdentity: 'best-bid-ask-source',
      sourceDigest: '1'.repeat(64),
      sourceObservationLineageId: 'spread-lineage',
      sourceObservationLineageDigest: '2'.repeat(64),
    },
  ];
}

function validFirewallArtifact(calibrationInput = validCalibrationInput()) {
  const validation = calibrationInput.oosValidation;
  const value = {
    schema: LIQUIDITY_IMPACT_EVIDENCE_SCHEMA,
    version: LIQUIDITY_IMPACT_EVIDENCE_VERSION,
    evidenceClass: 'CALIBRATION_ARTIFACT',
    testOnly: false,
    artifactId: 'independent-liquidity-impact-btc-v1',
    artifactDigest: null,
    methodologyVersion: calibrationInput.calibrationMethodology.methodologyVersion,
    producerCodeSha: RUNTIME_SHA,
    calibrationCodeSha: CALIBRATION_SHA,
    datasetIdentity: 'bitget-btc-public-forward-dataset-v1',
    datasetDigest: validation.datasetDigest,
    sampleN: 48,
    trainDatasetIdentity: 'bitget-btc-train-v1',
    trainDatasetDigest: '5'.repeat(64),
    trainSampleN: 30,
    validationDatasetIdentity: 'bitget-btc-validation-v1',
    validationDatasetDigest: '6'.repeat(64),
    validationSampleN: 15,
    oosDatasetIdentity: 'bitget-btc-oos-v1',
    oosDatasetDigest: '7'.repeat(64),
    oosSampleN: 3,
    marketScopes: ['CRYPTO_FUTURES'],
    symbolScopes: ['BTCUSDT'],
    sideScopes: ['LONG'],
    quantityNotionalBucketIdentity: 'btc-usdt-notional-10k-25k-v1',
    volatilityRegimeIdentity: 'btc-realized-volatility-medium-v1',
    liquidityRegimeIdentity: 'btc-visible-depth-medium-v1',
    calibratedAt: 2_500,
    maximumAge: 10_000,
    provenance: {
      sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
      sourceProvider: 'BITGET_PUBLIC_UTA_V3',
      sourceIdentity: 'bitget-public-forward-depth-trades-v1',
      sourceDigest: '4'.repeat(64),
      immutable: true,
    },
    sourceObservationLineage: {
      lineageId: 'independent-residual-impact-lineage-v1',
      lineageDigest: '8'.repeat(64),
      sourceType: 'PUBLIC_FORWARD_MARKET_DATA',
      sourceIdentity: 'bitget-public-forward-depth-trades-v1',
      observationCount: 48,
      firstObservedAt: 1_100,
      lastObservedAt: 2_400,
    },
    outOfSampleValidationReference: {
      referenceId: 'liquidity-oos-validation-v1',
      referenceDigest: validation.validationDigest,
      trainDatasetIdentity: 'bitget-btc-train-v1',
      trainDatasetDigest: '5'.repeat(64),
      validationDatasetIdentity: 'bitget-btc-validation-v1',
      validationDatasetDigest: '6'.repeat(64),
      oosDatasetIdentity: 'bitget-btc-oos-v1',
      oosDatasetDigest: '7'.repeat(64),
      sampleN: 3,
      status: 'PASS',
      heldOut: true,
      contaminationFree: true,
      evaluatedAt: 1_900,
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
      sourceIdentity: 'independent-residual-impact-calibration-output-v1',
      sourceDigest: '3'.repeat(64),
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
      validationReferenceId: 'liquidity-oos-validation-v1',
    },
  };
  value.artifactDigest = computeLiquidityImpactArtifactDigest(value);
  return value;
}

function validFirewallInput(calibrationInput = validCalibrationInput(), artifact = validFirewallArtifact(calibrationInput)) {
  return {
    artifact,
    expected: {
      nowMs: NOW,
      maximumAge: 10_000,
      producerCodeSha: RUNTIME_SHA,
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

function validBridge(calibrationInput, firewallArtifact, overrides = {}) {
  const calibration = validatePublicForwardLiquidityCalibrationArtifact(calibrationInput);
  assert.equal(calibration.status, 'PRESENT');
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION,
    bridgeIdentity: 'liquidity-runtime-cost-bridge-v1',
    bridgeProducerCodeSha: BRIDGE_SHA,
    bridgedAtMs: 2_600,
    costOwner: LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY,
    calibrationArtifactIdentity: calibration.artifact.artifactIdentity,
    calibrationArtifactDigest: calibration.artifact.artifactDigest,
    liquidityImpactArtifactId: firewallArtifact.artifactId,
    liquidityImpactArtifactDigest: firewallArtifact.artifactDigest,
    datasetDigest: calibration.artifact.datasetDigest,
    oosValidationDigest: calibration.artifact.oosValidationDigest,
    calibrationMethodologyVersion: calibration.artifact.calibrationMethodologyVersion,
    calibrationProducerCodeSha: calibration.artifact.artifactProducerCodeSha,
    runtimeEvidenceProducerCodeSha: firewallArtifact.producerCodeSha,
    parameterPayloadDigest: calibration.artifact.parameterPayloadDigest,
    fitEvidenceDigest: calibration.artifact.fitEvidenceDigest,
    trainObservationCount: calibration.artifact.trainObservationCount,
    validationObservationCount: calibration.artifact.validationObservationCount,
    oosObservationCount: calibration.artifact.oosObservationCount,
    testOnly: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  };
  return { ...body, bridgeDigest: computePublicForwardLiquidityRuntimeCostBridgeDigest(body) };
}

function validInput() {
  const calibrationArtifactInput = validCalibrationInput();
  const firewallArtifact = validFirewallArtifact(calibrationArtifactInput);
  return {
    calibrationArtifactInput,
    liquidityImpactFirewallInput: validFirewallInput(calibrationArtifactInput, firewallArtifact),
    bridge: validBridge(calibrationArtifactInput, firewallArtifact),
    nowMs: NOW,
  };
}

test('maps a raw-revalidated independent liquidity impact artifact into PercentCostEvidence without inventing a coefficient', () => {
  const result = buildPublicForwardLiquidityRuntimeCostEvidence(validInput());
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.liquidityImpactStatus, 'PRESENT');
  assert.equal(result.evidence.valuePercent, 0.02);
  assert.equal(result.evidence.quality, 'ESTIMATED');
  assert.equal(result.evidence.observedAtMs, 2_500);
  assert.match(result.evidence.source, /^INDEPENDENT_LIQUIDITY_IMPACT:/u);
  assert.equal(result.estimatedImpactBps, 2);
  assert.equal(result.runtimeLiquidityImpactCoefficient, null);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.runtimeCostCredit, 0);
});

test('rejects a test-only firewall artifact from runtime cost credit', () => {
  const input = validInput();
  const artifact = { ...input.liquidityImpactFirewallInput.artifact, evidenceClass: 'TEST_FIXTURE', testOnly: true };
  artifact.artifactDigest = computeLiquidityImpactArtifactDigest(artifact);
  const result = buildPublicForwardLiquidityRuntimeCostEvidence({
    ...input,
    liquidityImpactFirewallInput: validFirewallInput(input.calibrationArtifactInput, artifact),
    bridge: validBridge(input.calibrationArtifactInput, artifact),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_IMPACT_FIREWALL_REVALIDATION_FAILED'));
});

test('rejects a forged bridge digest', () => {
  const input = validInput();
  const result = buildPublicForwardLiquidityRuntimeCostEvidence({
    ...input,
    bridge: { ...input.bridge, bridgeDigest: '0'.repeat(64) },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_COST_BRIDGE_DIGEST_MISMATCH'));
});

test('rejects cross-lineage dataset binding even with a valid bridge digest', () => {
  const input = validInput();
  const body = { ...input.bridge, datasetDigest: '0'.repeat(64) };
  delete body.bridgeDigest;
  const bridge = { ...body, bridgeDigest: computePublicForwardLiquidityRuntimeCostBridgeDigest(body) };
  const result = buildPublicForwardLiquidityRuntimeCostEvidence({ ...input, bridge });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_COST_DATASET_DIGEST_MISMATCH'));
});

test('rejects fabricated zero liquidity cost when the firewall lacks measured-zero evidence', () => {
  const input = validInput();
  const artifact = {
    ...input.liquidityImpactFirewallInput.artifact,
    estimatedImpactPercent: 0,
    estimatedImpactBps: 0,
    zeroEvidenceReason: null,
    zeroEvidenceReference: null,
  };
  artifact.artifactDigest = computeLiquidityImpactArtifactDigest(artifact);
  const result = buildPublicForwardLiquidityRuntimeCostEvidence({
    ...input,
    liquidityImpactFirewallInput: validFirewallInput(input.calibrationArtifactInput, artifact),
    bridge: validBridge(input.calibrationArtifactInput, artifact),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_IMPACT_FIREWALL_REVALIDATION_FAILED'));
  assert.ok(result.blockers.some((code) => code.includes('MEASURED_ZERO_EVIDENCE_REQUIRED')));
});

test('rejects calibration artifacts that attempt to inject runtime cost or a coefficient', () => {
  const input = validInput();
  const calibrationArtifactInput = {
    ...input.calibrationArtifactInput,
    candidate: {
      ...input.calibrationArtifactInput.candidate,
      liquidityImpactCostBps: 2,
      runtimeLiquidityImpactCoefficient: 0.5,
    },
  };
  const result = buildPublicForwardLiquidityRuntimeCostEvidence({
    ...input,
    calibrationArtifactInput,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_CALIBRATION_ARTIFACT_REVALIDATION_FAILED'));
});

test('safety remains paper-only and this adapter alone never marks Full Cost ready', () => {
  assert.deepEqual(PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY, {
    rawCalibrationArtifactRevalidated: true,
    rawLiquidityFirewallRevalidated: true,
    independentLiquidityOwnershipRequired: true,
    coefficientInventedByThisAdapter: false,
    unknownCostIsZero: false,
    testFixtureRuntimeCredit: 0,
    naturalEntryCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
  });
});
