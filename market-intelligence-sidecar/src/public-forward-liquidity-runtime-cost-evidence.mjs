import { createHash } from 'node:crypto';

import {
  LIQUIDITY_IMPACT_COST_OWNERS,
  admitValidatedLiquidityImpactEvidenceForRuntime,
} from './liquidity-impact-evidence-firewall.mjs';
import {
  validatePublicForwardLiquidityCalibrationArtifact,
} from './public-forward-liquidity-calibration-artifact.mjs';
import {
  SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY,
} from './public-forward-liquidity-calibration-oos-outcome-validator.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION =
  'public-forward-liquidity-runtime-cost-evidence-v2';
export const AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION =
  'authoritative-paper-liquidity-impact-cost-evidence-v1';

export const PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY = Object.freeze({
  rawCalibrationArtifactRevalidated: true,
  rawProducerOutputRevalidated: true,
  rawLiquidityFirewallRevalidated: true,
  nativeSuccessorV3Only: true,
  nativeAndResidualLineageSeparated: true,
  orderedNativeSourceDatasetLineageRequired: true,
  legacySingleDatasetDigestBridgeAllowed: false,
  nativeSourceDigestAsResidualDatasetAllowed: false,
  nativeResidualSampleCountEqualityRequired: false,
  coefficientInventedByThisAdapter: false,
  unknownCostIsZero: false,
  testFixtureRuntimeCredit: 0,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  evidenceComplete: 0,
  fullCostReady: false,
  netAlphaReady: false,
  profitabilityProven: false,
  currentValidatedChampion: 'NONE',
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
}

function digest(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && SHA256.test(normalized) ? normalized : null;
}

function commitSha(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && COMMIT_SHA.test(normalized) ? normalized : null;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function withoutKey(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

function sameDigest(left, right) {
  return digest(left) != null && digest(left) === digest(right);
}

function digestArray(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value.map(digest);
  if (normalized.some((item) => item == null)) return null;
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function sameOrderedDigestArray(left, right) {
  const leftDigests = digestArray(left);
  const rightDigests = digestArray(right);
  return leftDigests != null && rightDigests != null
    && leftDigests.length === rightDigests.length
    && leftDigests.every((value, index) => value === rightDigests[index]);
}

function sameCanonical(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function protectedNativeDigests(calibrationArtifact) {
  return new Set([
    ...(digestArray(calibrationArtifact?.sourceDatasetDigests) ?? []),
    calibrationArtifact?.v3IndependentSplitIndexDigest,
    calibrationArtifact?.sourceInventoryDigest,
    calibrationArtifact?.independenceAuditDigest,
    calibrationArtifact?.independentSplitSourceDigest,
    calibrationArtifact?.oosValidationDigest,
    calibrationArtifact?.oosOutcomeDigest,
    calibrationArtifact?.policyDigest,
    calibrationArtifact?.cohortDigest,
    calibrationArtifact?.parameterPayloadDigest,
    calibrationArtifact?.fitEvidenceDigest,
  ].map(digest).filter(Boolean));
}

export function computePublicForwardLiquidityRuntimeCostBridgeDigest(bridge) {
  if (!object(bridge)) throw new TypeError('LIQUIDITY_RUNTIME_COST_BRIDGE_REQUIRED');
  return sha256(withoutKey(bridge, 'bridgeDigest'));
}

function blocked(blockers) {
  return Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA',
    liquidityImpactStatus: 'BLOCKED_DATA',
    evidence: null,
    estimatedImpactBps: null,
    calibrationArtifactDigest: null,
    producerMeasurementDigest: null,
    residualDatasetDigest: null,
    liquidityImpactArtifactDigest: null,
    bridgeDigest: null,
    blockers: Object.freeze([...new Set(blockers)]),
    calibrationArtifactProduced: false,
    runtimeLiquidityImpactCoefficient: null,
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
    unknownCostIsZero: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY,
  });
}

function validateProducerNativeBinding(producerOutput, calibrationArtifact, blockers) {
  if (!object(producerOutput)) {
    add(blockers, 'LIQUIDITY_COST_PRODUCER_OUTPUT_REQUIRED');
    return null;
  }
  if (producerOutput.schemaVersion !== AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION
    || producerOutput.status !== 'PRESENT'
    || producerOutput.producerStatus !== 'PRESENT'
    || producerOutput.liquidityImpactStatus !== 'BLOCKED_DATA'
    || producerOutput.firewallValidationRequired !== true
    || producerOutput.runtimeEligible !== false) {
    add(blockers, 'LIQUIDITY_COST_PRODUCER_STATUS_INVALID');
  }
  if (producerOutput.naturalEntryCredit !== 0
    || producerOutput.runtimeCostCredit !== 0
    || producerOutput.evidenceComplete !== 0
    || producerOutput.fullCostReady !== false
    || producerOutput.netAlphaReady !== false
    || producerOutput.profitabilityProven !== false
    || producerOutput.currentValidatedChampion !== 'NONE'
    || producerOutput.executionAuthority !== 'NONE'
    || producerOutput.privateApiUsed !== false
    || producerOutput.liveTrading !== false
    || producerOutput.orderSubmitted !== false) {
    add(blockers, 'LIQUIDITY_COST_PRODUCER_AUTHORITY_BOUNDARY_INVALID');
  }

  const binding = object(producerOutput.nativeCalibrationBinding);
  if (!binding) {
    add(blockers, 'NATIVE_CALIBRATION_BINDING_REQUIRED');
    return null;
  }
  if (calibrationArtifact.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY
    || binding.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY) {
    add(blockers, 'NATIVE_SOURCE_CONTRACT_FAMILY_MISMATCH');
  }
  if (binding.calibrationArtifactIdentity !== calibrationArtifact.artifactIdentity
    || !sameDigest(binding.calibrationArtifactDigest, calibrationArtifact.artifactDigest)
    || !sameDigest(binding.v3IndependentSplitIndexDigest, calibrationArtifact.v3IndependentSplitIndexDigest)
    || !sameDigest(binding.sourceInventoryDigest, calibrationArtifact.sourceInventoryDigest)
    || !sameOrderedDigestArray(binding.sourceDatasetDigests, calibrationArtifact.sourceDatasetDigests)
    || !sameDigest(binding.independenceAuditDigest, calibrationArtifact.independenceAuditDigest)
    || !sameDigest(binding.independentSplitSourceDigest, calibrationArtifact.independentSplitSourceDigest)
    || !sameDigest(binding.nativeOosValidationDigest, calibrationArtifact.oosValidationDigest)
    || !sameDigest(binding.nativeOosOutcomeDigest, calibrationArtifact.oosOutcomeDigest)
    || !sameDigest(binding.policyDigest, calibrationArtifact.policyDigest)
    || !sameDigest(binding.cohortDigest, calibrationArtifact.cohortDigest)
    || !sameDigest(binding.parameterPayloadDigest, calibrationArtifact.parameterPayloadDigest)
    || !sameDigest(binding.fitEvidenceDigest, calibrationArtifact.fitEvidenceDigest)) {
    add(blockers, 'NATIVE_CALIBRATION_BINDING_MISMATCH');
  }
  if (!positiveInteger(binding.trainObservationCount)
    || binding.trainObservationCount !== calibrationArtifact.trainObservationCount
    || !positiveInteger(binding.validationObservationCount)
    || binding.validationObservationCount !== calibrationArtifact.validationObservationCount
    || !positiveInteger(binding.oosObservationCount)
    || binding.oosObservationCount !== calibrationArtifact.oosObservationCount
    || !positiveInteger(binding.acceptedGenuineOosN)
    || binding.acceptedGenuineOosN !== calibrationArtifact.acceptedGenuineOosN) {
    add(blockers, 'NATIVE_CALIBRATION_SAMPLE_BINDING_MISMATCH');
  }
  if (binding.heldOutOosValidated !== true
    || binding.contaminationFree !== true
    || binding.oosUsedForFit !== false
    || binding.noRetuningAssertion !== true) {
    add(blockers, 'NATIVE_CALIBRATION_SAFETY_BINDING_INVALID');
  }
  return binding;
}

function validateProducerRuntimeBinding(
  producerOutput,
  calibrationArtifact,
  runtimeArtifact,
  firewallExpected,
  blockers,
) {
  const producerArtifact = object(producerOutput?.firewallArtifact);
  if (!producerArtifact || !sameCanonical(producerArtifact, runtimeArtifact)) {
    add(blockers, 'PRODUCER_FIREWALL_ARTIFACT_MISMATCH');
  }

  const binding = object(producerOutput?.runtimeMeasurementBinding);
  if (!binding) {
    add(blockers, 'RUNTIME_MEASUREMENT_BINDING_REQUIRED');
    return null;
  }
  if (!text(binding.measurementIdentity)
    || !digest(binding.measurementDigest)
    || !commitSha(binding.measurementProducerCodeSha)
    || !text(binding.datasetReceiptIdentity)
    || !digest(binding.datasetReceiptDigest)) {
    add(blockers, 'RUNTIME_MEASUREMENT_BINDING_IDENTITY_INVALID');
  }
  if (binding.residualDatasetIdentity !== runtimeArtifact.datasetIdentity
    || !sameDigest(binding.residualDatasetDigest, runtimeArtifact.datasetDigest)
    || !sameDigest(
      binding.residualOosValidationReferenceDigest,
      runtimeArtifact.outOfSampleValidationReference?.referenceDigest,
    )) {
    add(blockers, 'RUNTIME_MEASUREMENT_RESIDUAL_LINEAGE_MISMATCH');
  }
  if (!sameCanonical(binding.competingCostEvidence, firewallExpected?.competingCostEvidence)) {
    add(blockers, 'RUNTIME_MEASUREMENT_COMPETING_COST_BINDING_MISMATCH');
  }

  const protectedDigests = protectedNativeDigests(calibrationArtifact);
  for (const candidate of [
    runtimeArtifact.datasetDigest,
    runtimeArtifact.trainDatasetDigest,
    runtimeArtifact.validationDatasetDigest,
    runtimeArtifact.oosDatasetDigest,
    binding.datasetReceiptDigest,
  ]) {
    const normalized = digest(candidate);
    if (normalized && protectedDigests.has(normalized)) {
      add(blockers, 'NATIVE_SOURCE_DIGEST_AS_RESIDUAL_DATASET_FORBIDDEN');
    }
  }
  if (runtimeArtifact.methodologyVersion !== calibrationArtifact.calibrationMethodologyVersion
    || runtimeArtifact.calibrationCodeSha !== calibrationArtifact.artifactProducerCodeSha) {
    add(blockers, 'RUNTIME_MEASUREMENT_CALIBRATION_AUTHORITY_MISMATCH');
  }
  return binding;
}

function validateBridge(
  bridge,
  producerOutput,
  calibrationArtifact,
  nativeBinding,
  runtimeArtifact,
  runtimeBinding,
  firewallExpected,
  nowMs,
) {
  const blockers = [];
  if (!object(bridge)) return ['LIQUIDITY_RUNTIME_COST_BRIDGE_REQUIRED'];
  if (bridge.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_VERSION_INVALID');
  }
  if (!text(bridge.bridgeIdentity)) add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_IDENTITY_INVALID');
  if (!commitSha(bridge.bridgeProducerCodeSha)) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_PRODUCER_SHA_INVALID');
  }
  if (!positiveFinite(bridge.bridgedAtMs) || bridge.bridgedAtMs > nowMs) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGED_AT_INVALID');
  }
  const earliestBridgeTime = Math.max(
    Number(calibrationArtifact.producedAtMs ?? calibrationArtifact.createdAtMs ?? 0),
    Number(runtimeArtifact.calibratedAt ?? 0),
  );
  if (positiveFinite(bridge.bridgedAtMs) && bridge.bridgedAtMs < earliestBridgeTime) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_PRECEDES_EVIDENCE');
  }
  if (bridge.costOwner !== LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_OWNER_INVALID');
  }
  if (bridge.testOnly !== false) add(blockers, 'LIQUIDITY_RUNTIME_COST_TEST_ONLY_FORBIDDEN');
  if (bridge.naturalEntryCredit !== 0
    || bridge.runtimeCostCredit !== 0
    || bridge.evidenceComplete !== 0) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_PREMATURE_CREDIT_FORBIDDEN');
  }
  if (bridge.executionAuthority !== 'NONE'
    || bridge.privateApiUsed !== false
    || bridge.liveTrading !== false
    || bridge.orderSubmitted !== false) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_EXECUTION_SAFETY_INVALID');
  }
  if (!digest(bridge.bridgeDigest)) add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_DIGEST_INVALID');
  else if (bridge.bridgeDigest !== computePublicForwardLiquidityRuntimeCostBridgeDigest(bridge)) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_DIGEST_MISMATCH');
  }

  for (const legacyField of [
    'datasetDigest',
    'trainObservationCount',
    'validationObservationCount',
    'oosObservationCount',
  ]) {
    if (Object.hasOwn(bridge, legacyField)) {
      add(blockers, 'LEGACY_SINGLE_DATASET_BRIDGE_FIELD_FORBIDDEN');
    }
  }

  if (bridge.producerSchemaVersion !== AUTHORITATIVE_PAPER_LIQUIDITY_IMPACT_COST_EVIDENCE_VERSION
    || producerOutput.schemaVersion !== bridge.producerSchemaVersion) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_PRODUCER_VERSION_MISMATCH');
  }
  if (bridge.sourceContractFamily !== SUCCESSOR_V3_SOURCE_CONTRACT_FAMILY
    || bridge.sourceContractFamily !== nativeBinding.sourceContractFamily
    || bridge.calibrationArtifactIdentity !== calibrationArtifact.artifactIdentity
    || !sameDigest(bridge.calibrationArtifactDigest, calibrationArtifact.artifactDigest)
    || !sameDigest(bridge.v3IndependentSplitIndexDigest, nativeBinding.v3IndependentSplitIndexDigest)
    || !sameDigest(bridge.sourceInventoryDigest, nativeBinding.sourceInventoryDigest)
    || !sameOrderedDigestArray(bridge.sourceDatasetDigests, nativeBinding.sourceDatasetDigests)
    || !sameDigest(bridge.independenceAuditDigest, nativeBinding.independenceAuditDigest)
    || !sameDigest(bridge.independentSplitSourceDigest, nativeBinding.independentSplitSourceDigest)
    || !sameDigest(bridge.nativeOosValidationDigest, nativeBinding.nativeOosValidationDigest)
    || !sameDigest(bridge.nativeOosOutcomeDigest, nativeBinding.nativeOosOutcomeDigest)
    || !sameDigest(bridge.policyDigest, nativeBinding.policyDigest)
    || !sameDigest(bridge.cohortDigest, nativeBinding.cohortDigest)
    || !sameDigest(bridge.parameterPayloadDigest, nativeBinding.parameterPayloadDigest)
    || !sameDigest(bridge.fitEvidenceDigest, nativeBinding.fitEvidenceDigest)) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_NATIVE_LINEAGE_MISMATCH');
  }
  if (bridge.nativeTrainObservationCount !== nativeBinding.trainObservationCount
    || bridge.nativeValidationObservationCount !== nativeBinding.validationObservationCount
    || bridge.nativeOosObservationCount !== nativeBinding.oosObservationCount
    || bridge.acceptedGenuineOosN !== nativeBinding.acceptedGenuineOosN) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_NATIVE_SAMPLE_MISMATCH');
  }

  if (bridge.runtimeMeasurementIdentity !== runtimeBinding.measurementIdentity
    || !sameDigest(bridge.runtimeMeasurementDigest, runtimeBinding.measurementDigest)
    || bridge.datasetReceiptIdentity !== runtimeBinding.datasetReceiptIdentity
    || !sameDigest(bridge.datasetReceiptDigest, runtimeBinding.datasetReceiptDigest)
    || bridge.residualDatasetIdentity !== runtimeArtifact.datasetIdentity
    || !sameDigest(bridge.residualDatasetDigest, runtimeArtifact.datasetDigest)
    || !sameDigest(
      bridge.residualOosValidationReferenceDigest,
      runtimeArtifact.outOfSampleValidationReference?.referenceDigest,
    )
    || bridge.liquidityImpactArtifactId !== runtimeArtifact.artifactId
    || !sameDigest(bridge.liquidityImpactArtifactDigest, runtimeArtifact.artifactDigest)) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_RESIDUAL_LINEAGE_MISMATCH');
  }
  if (bridge.residualTrainSampleN !== runtimeArtifact.trainSampleN
    || bridge.residualValidationSampleN !== runtimeArtifact.validationSampleN
    || bridge.residualOosSampleN !== runtimeArtifact.oosSampleN) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_RESIDUAL_SAMPLE_MISMATCH');
  }
  if (bridge.calibrationMethodologyVersion !== calibrationArtifact.calibrationMethodologyVersion
    || bridge.calibrationMethodologyVersion !== runtimeArtifact.methodologyVersion) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_METHODOLOGY_VERSION_MISMATCH');
  }

  if (bridge.market !== firewallExpected?.market
    || bridge.symbol !== firewallExpected?.symbol
    || bridge.side !== firewallExpected?.side
    || bridge.quantityNotionalBucketIdentity !== firewallExpected?.quantityNotionalBucketIdentity
    || bridge.volatilityRegimeIdentity !== firewallExpected?.volatilityRegimeIdentity
    || bridge.liquidityRegimeIdentity !== firewallExpected?.liquidityRegimeIdentity) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_SCOPE_BINDING_MISMATCH');
  }

  const protectedDigests = protectedNativeDigests(calibrationArtifact);
  if (protectedDigests.has(digest(bridge.residualDatasetDigest))) {
    add(blockers, 'NATIVE_SOURCE_DIGEST_AS_RESIDUAL_DATASET_FORBIDDEN');
  }
  return blockers;
}

export function buildPublicForwardLiquidityRuntimeCostEvidence({
  calibrationArtifactInput,
  producerOutput,
  liquidityImpactFirewallInput,
  bridge,
  nowMs = Date.now(),
} = {}) {
  if (!positiveFinite(nowMs)) return blocked(['LIQUIDITY_RUNTIME_COST_CLOCK_INVALID']);

  const calibration = validatePublicForwardLiquidityCalibrationArtifact(calibrationArtifactInput ?? {});
  if (calibration.status !== 'PRESENT'
    || calibration.calibrationStatus !== 'READY'
    || calibration.calibrationArtifactProduced !== true
    || !calibration.artifact) {
    return blocked([
      'LIQUIDITY_CALIBRATION_ARTIFACT_REVALIDATION_FAILED',
      ...(Array.isArray(calibration.blockers)
        ? calibration.blockers.map((code) => `CALIBRATION:${code}`)
        : []),
    ]);
  }

  const producerBlockers = [];
  const nativeBinding = validateProducerNativeBinding(
    producerOutput,
    calibration.artifact,
    producerBlockers,
  );
  if (producerBlockers.length > 0 || !nativeBinding) return blocked(producerBlockers);

  const runtimeAdmission = admitValidatedLiquidityImpactEvidenceForRuntime(
    liquidityImpactFirewallInput ?? {},
  );
  if (runtimeAdmission.validationStatus !== 'PASS'
    || runtimeAdmission.liquidityImpactStatus !== 'PRESENT'
    || runtimeAdmission.runtimeEligible !== true
    || !runtimeAdmission.artifact) {
    return blocked([
      'LIQUIDITY_IMPACT_FIREWALL_REVALIDATION_FAILED',
      ...(Array.isArray(runtimeAdmission.blockers)
        ? runtimeAdmission.blockers.map((code) => `FIREWALL:${code}`)
        : []),
    ]);
  }

  const runtimeBindingBlockers = [];
  const runtimeBinding = validateProducerRuntimeBinding(
    producerOutput,
    calibration.artifact,
    runtimeAdmission.artifact,
    liquidityImpactFirewallInput?.expected,
    runtimeBindingBlockers,
  );
  if (runtimeBindingBlockers.length > 0 || !runtimeBinding) {
    return blocked(runtimeBindingBlockers);
  }

  const bridgeBlockers = validateBridge(
    bridge,
    producerOutput,
    calibration.artifact,
    nativeBinding,
    runtimeAdmission.artifact,
    runtimeBinding,
    liquidityImpactFirewallInput?.expected,
    nowMs,
  );
  if (bridgeBlockers.length > 0) return blocked(bridgeBlockers);

  const estimatedImpactPercent = runtimeAdmission.estimatedImpactPercent;
  const estimatedImpactBps = runtimeAdmission.estimatedImpactBps;
  if (typeof estimatedImpactPercent !== 'number' || !Number.isFinite(estimatedImpactPercent)
    || estimatedImpactPercent < 0
    || typeof estimatedImpactBps !== 'number' || !Number.isFinite(estimatedImpactBps)
    || estimatedImpactBps < 0
    || Math.abs(estimatedImpactPercent * 100 - estimatedImpactBps) > 1e-9) {
    return blocked(['LIQUIDITY_RUNTIME_COST_VALUE_INVALID']);
  }

  const evidence = Object.freeze({
    valuePercent: estimatedImpactPercent,
    quality: 'ESTIMATED',
    source: [
      'INDEPENDENT_LIQUIDITY_IMPACT',
      runtimeAdmission.artifact.artifactId,
      runtimeAdmission.artifact.artifactDigest,
      calibration.artifact.artifactDigest,
      runtimeBinding.measurementDigest,
      bridge.bridgeDigest,
    ].join(':'),
    observedAtMs: runtimeAdmission.artifact.calibratedAt,
  });

  return Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION,
    status: 'PRESENT',
    liquidityImpactStatus: 'PRESENT',
    evidence,
    estimatedImpactBps,
    calibrationArtifactDigest: calibration.artifact.artifactDigest,
    producerMeasurementDigest: runtimeBinding.measurementDigest,
    residualDatasetDigest: runtimeAdmission.artifact.datasetDigest,
    liquidityImpactArtifactDigest: runtimeAdmission.artifact.artifactDigest,
    bridgeDigest: bridge.bridgeDigest,
    blockers: Object.freeze([]),
    calibrationArtifactProduced: true,
    runtimeLiquidityImpactCoefficient: null,
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
    unknownCostIsZero: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY,
  });
}
