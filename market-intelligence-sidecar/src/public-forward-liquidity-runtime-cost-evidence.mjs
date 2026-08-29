import { createHash } from 'node:crypto';

import {
  LIQUIDITY_IMPACT_COST_OWNERS,
  admitValidatedLiquidityImpactEvidenceForRuntime,
} from './liquidity-impact-evidence-firewall.mjs';
import {
  validatePublicForwardLiquidityCalibrationArtifact,
} from './public-forward-liquidity-calibration-artifact.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION =
  'public-forward-liquidity-runtime-cost-evidence-v1';

export const PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY = Object.freeze({
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

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 && normalized.length <= 320 ? normalized : null;
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

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function withoutKey(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
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
    liquidityImpactArtifactDigest: null,
    bridgeDigest: null,
    blockers: Object.freeze([...new Set(blockers)]),
    calibrationArtifactProduced: false,
    runtimeLiquidityImpactCoefficient: null,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    unknownCostIsZero: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY,
  });
}

function validateBridge(bridge, calibrationArtifact, runtimeArtifact, nowMs) {
  const blockers = [];
  if (!object(bridge)) return ['LIQUIDITY_RUNTIME_COST_BRIDGE_REQUIRED'];
  if (bridge.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_VERSION) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_VERSION_INVALID');
  }
  if (!text(bridge.bridgeIdentity)) add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_IDENTITY_INVALID');
  if (!commitSha(bridge.bridgeProducerCodeSha)) add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_PRODUCER_SHA_INVALID');
  if (!positiveFinite(bridge.bridgedAtMs) || bridge.bridgedAtMs > nowMs) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGED_AT_INVALID');
  }
  if (bridge.costOwner !== LIQUIDITY_IMPACT_COST_OWNERS.LIQUIDITY) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_OWNER_INVALID');
  }
  if (bridge.testOnly !== false) add(blockers, 'LIQUIDITY_RUNTIME_COST_TEST_ONLY_FORBIDDEN');
  if (bridge.naturalEntryCredit !== 0 || bridge.runtimeCostCredit !== 0) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_PREMATURE_CREDIT_FORBIDDEN');
  }
  if (bridge.executionAuthority !== 'NONE' || bridge.privateApiUsed !== false
    || bridge.liveTrading !== false || bridge.orderSubmitted !== false) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_EXECUTION_SAFETY_INVALID');
  }
  if (!digest(bridge.bridgeDigest)) add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_DIGEST_INVALID');
  else if (bridge.bridgeDigest !== computePublicForwardLiquidityRuntimeCostBridgeDigest(bridge)) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_DIGEST_MISMATCH');
  }

  if (bridge.calibrationArtifactIdentity !== calibrationArtifact.artifactIdentity) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_CALIBRATION_ARTIFACT_IDENTITY_MISMATCH');
  }
  if (bridge.calibrationArtifactDigest !== calibrationArtifact.artifactDigest) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_CALIBRATION_ARTIFACT_DIGEST_MISMATCH');
  }
  if (bridge.liquidityImpactArtifactId !== runtimeArtifact.artifactId) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_FIREWALL_ARTIFACT_IDENTITY_MISMATCH');
  }
  if (bridge.liquidityImpactArtifactDigest !== runtimeArtifact.artifactDigest) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_FIREWALL_ARTIFACT_DIGEST_MISMATCH');
  }
  if (bridge.datasetDigest !== calibrationArtifact.datasetDigest
    || bridge.datasetDigest !== runtimeArtifact.datasetDigest) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_DATASET_DIGEST_MISMATCH');
  }
  if (bridge.oosValidationDigest !== calibrationArtifact.oosValidationDigest
    || bridge.oosValidationDigest !== runtimeArtifact.outOfSampleValidationReference?.referenceDigest) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_OOS_VALIDATION_DIGEST_MISMATCH');
  }
  if (bridge.calibrationMethodologyVersion !== calibrationArtifact.calibrationMethodologyVersion
    || bridge.calibrationMethodologyVersion !== runtimeArtifact.methodologyVersion) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_METHODOLOGY_VERSION_MISMATCH');
  }
  if (bridge.calibrationProducerCodeSha !== calibrationArtifact.artifactProducerCodeSha
    || bridge.calibrationProducerCodeSha !== runtimeArtifact.calibrationCodeSha) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_CALIBRATION_PRODUCER_SHA_MISMATCH');
  }
  if (bridge.runtimeEvidenceProducerCodeSha !== runtimeArtifact.producerCodeSha) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_RUNTIME_PRODUCER_SHA_MISMATCH');
  }
  if (bridge.parameterPayloadDigest !== calibrationArtifact.parameterPayloadDigest) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_PARAMETER_PAYLOAD_DIGEST_MISMATCH');
  }
  if (bridge.fitEvidenceDigest !== calibrationArtifact.fitEvidenceDigest) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_FIT_EVIDENCE_DIGEST_MISMATCH');
  }
  if (!positiveInteger(bridge.trainObservationCount)
    || bridge.trainObservationCount !== calibrationArtifact.trainObservationCount
    || bridge.trainObservationCount !== runtimeArtifact.trainSampleN) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_TRAIN_SAMPLE_MISMATCH');
  }
  if (!positiveInteger(bridge.validationObservationCount)
    || bridge.validationObservationCount !== calibrationArtifact.validationObservationCount
    || bridge.validationObservationCount !== runtimeArtifact.validationSampleN) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_VALIDATION_SAMPLE_MISMATCH');
  }
  if (!positiveInteger(bridge.oosObservationCount)
    || bridge.oosObservationCount !== calibrationArtifact.oosObservationCount
    || bridge.oosObservationCount !== runtimeArtifact.oosSampleN) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_OOS_SAMPLE_MISMATCH');
  }
  if (positiveFinite(bridge.bridgedAtMs)
    && bridge.bridgedAtMs < Math.max(calibrationArtifact.producedAtMs, runtimeArtifact.calibratedAt)) {
    add(blockers, 'LIQUIDITY_RUNTIME_COST_BRIDGE_PRECEDES_EVIDENCE');
  }
  return blockers;
}

export function buildPublicForwardLiquidityRuntimeCostEvidence({
  calibrationArtifactInput,
  liquidityImpactFirewallInput,
  bridge,
  nowMs = Date.now(),
} = {}) {
  if (!positiveFinite(nowMs)) return blocked(['LIQUIDITY_RUNTIME_COST_CLOCK_INVALID']);

  const calibration = validatePublicForwardLiquidityCalibrationArtifact(calibrationArtifactInput ?? {});
  if (calibration.status !== 'PRESENT' || !calibration.artifact) {
    return blocked([
      'LIQUIDITY_CALIBRATION_ARTIFACT_REVALIDATION_FAILED',
      ...(Array.isArray(calibration.blockers) ? calibration.blockers.map((code) => `CALIBRATION:${code}`) : []),
    ]);
  }

  const runtimeAdmission = admitValidatedLiquidityImpactEvidenceForRuntime(liquidityImpactFirewallInput ?? {});
  if (runtimeAdmission.validationStatus !== 'PASS'
    || runtimeAdmission.liquidityImpactStatus !== 'PRESENT'
    || runtimeAdmission.runtimeEligible !== true
    || !runtimeAdmission.artifact) {
    return blocked([
      'LIQUIDITY_IMPACT_FIREWALL_REVALIDATION_FAILED',
      ...(Array.isArray(runtimeAdmission.blockers) ? runtimeAdmission.blockers.map((code) => `FIREWALL:${code}`) : []),
    ]);
  }

  const bridgeBlockers = validateBridge(bridge, calibration.artifact, runtimeAdmission.artifact, nowMs);
  if (bridgeBlockers.length > 0) return blocked(bridgeBlockers);

  const estimatedImpactPercent = runtimeAdmission.estimatedImpactPercent;
  const estimatedImpactBps = runtimeAdmission.estimatedImpactBps;
  if (typeof estimatedImpactPercent !== 'number' || !Number.isFinite(estimatedImpactPercent)
    || estimatedImpactPercent < 0 || typeof estimatedImpactBps !== 'number'
    || !Number.isFinite(estimatedImpactBps) || estimatedImpactBps < 0
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
    liquidityImpactArtifactDigest: runtimeAdmission.artifact.artifactDigest,
    bridgeDigest: bridge.bridgeDigest,
    blockers: Object.freeze([]),
    calibrationArtifactProduced: true,
    runtimeLiquidityImpactCoefficient: null,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    unknownCostIsZero: false,
    safety: PUBLIC_FORWARD_LIQUIDITY_RUNTIME_COST_EVIDENCE_SAFETY,
  });
}
