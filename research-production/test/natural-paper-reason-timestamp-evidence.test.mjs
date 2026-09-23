import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildNaturalPaperEvidenceObservabilityArtifact } from '../src/natural-paper-evidence-observability.mjs';

const SHA = 'a'.repeat(40);
const DATASET_DIGEST = createHash('sha256').update('dataset-v1').digest('hex');
const PARAMETER_HASH = createHash('sha256').update('parameters-v1').digest('hex');
const VERIFIED_AT = 1_800_000_000_000;
const OBSERVED_AT = VERIFIED_AT - 1_000;

function identity(observationId = null) {
  return {
    cycleId: 'paper-forward-public-evidence-4h-v1:42',
    triggerSource: 'cron',
    strategySha: SHA,
    runtimeSha: SHA,
    datasetIdentityDigest: DATASET_DIGEST,
    observationId,
  };
}

function stage(field, count, { status = 'MEASURED', observationIds = [] } = {}) {
  return {
    field,
    status,
    count,
    blocker: status === 'MEASURED' ? null : `UNMEASURED_${field.toUpperCase()}`,
    provenance: `fixture.${field}`,
    observedAt: OBSERVED_AT,
    observationIds,
    identity: identity(),
    naturalCredit: status === 'MEASURED' ? count : 0,
    replayCredit: 0,
    duplicateCredit: 0,
  };
}

function fixture(reason) {
  const unknown = (field) => stage(field, null, { status: 'UNKNOWN' });
  return {
    collectionStatus: 'READY',
    schemaVersion: 'paper-forward-schedule-cli-v5',
    status: 'COMPLETED',
    cycleId: 'paper-forward-public-evidence-4h-v1:42',
    triggerSource: 'cron',
    naturalScheduleInvocation: true,
    evidenceClass: 'NATURAL',
    expectedCodeSha: SHA,
    exactCodeSha: SHA,
    naturalStrategySha: SHA,
    naturalRuntimeSha: SHA,
    naturalDatasetIdentityDigest: DATASET_DIGEST,
    strategyIdentity: {
      strategyId: 'paper-forward-authoritative-account-v1',
      strategyVersion: '1.0.0',
      parameterHash: PARAMETER_HASH,
      researchCodeSha: SHA,
      costPolicyVersion: 'paper-forward-authoritative-accounting-v1',
      executionPolicyVersion: 'public-evidence-simulated-paper-v1',
    },
    cycleEvaluatedAtMs: OBSERVED_AT,
    recurringStateUpdatedAtMs: OBSERVED_AT,
    naturalFunnelMeasurements: [{
      stage: 'EVIDENCE_COMPLETE',
      status: 'MEASURED',
      count: 0,
      provenance: 'authoritative Paper source completeness',
      measuredAtMs: OBSERVED_AT,
      identity: identity(),
    }],
    canonicalNaturalStageEvidence: {
      schemaVersion: 'canonical-natural-paper-stage-evidence-v1',
      identity: identity(),
      stageCounts: {
        signalCandidate: stage('signalCandidate', 5, { observationIds: ['candidate-1', 'candidate-2', 'candidate-3', 'candidate-4', 'candidate-5'] }),
        riskPassed: unknown('riskPassed'),
        entryEligible: unknown('entryEligible'),
        entry: unknown('entry'),
        position: unknown('position'),
        exitEligible: unknown('exitEligible'),
        settlement: unknown('settlement'),
      },
      reasonObservations: [],
      naturalCredit: 1,
      replayCredit: 0,
      duplicateCredit: 0,
      historicalCredit: 0,
    },
    authoritativeFirstZeroReasonEvidenceByStage: { EVIDENCE_COMPLETE: reason },
    testOnly: false,
    synthetic: false,
    historical: false,
    replay: false,
    duplicateReplay: false,
    externalFinancialMutationAllowed: false,
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
    orderAuthority: false,
  };
}

function authoritativeReason(observedAtMs) {
  const reason = {
    reasonCode: 'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING',
    authoritative: true,
    freshness: 'FRESH',
    ...identity('reason-evidence-first-zero'),
  };
  if (observedAtMs !== undefined) reason.observedAtMs = observedAtMs;
  return reason;
}

for (const [name, observedAtMs] of [
  ['missing timestamp', undefined],
  ['future timestamp beyond bounded skew', VERIFIED_AT + 60_001],
]) {
  test(`fails closed on authoritative first-zero reason evidence with ${name}`, () => {
    const artifact = buildNaturalPaperEvidenceObservabilityArtifact(
      fixture(authoritativeReason(observedAtMs)),
      { verifiedAtMs: VERIFIED_AT },
    );

    assert.equal(artifact.naturalFunnelObservable, true);
    assert.equal(artifact.firstZeroStage, 'EVIDENCE');
    assert.equal(artifact.firstZeroReason, 'MISSING_EVIDENCE');
    assert.equal(artifact.firstZeroReasonEvidenceStatus, 'MISSING_OR_AMBIGUOUS');
    assert.equal(artifact.reasonEvidence.length, 0);
    assert.equal(artifact.reasonCounts.MISSING_EVIDENCE, 0);
  });
}

test('keeps fresh exact-identity reason evidence authoritative', () => {
  const artifact = buildNaturalPaperEvidenceObservabilityArtifact(
    fixture(authoritativeReason(OBSERVED_AT)),
    { verifiedAtMs: VERIFIED_AT },
  );

  assert.equal(artifact.firstZeroStage, 'EVIDENCE');
  assert.equal(artifact.firstZeroReason, 'MISSING_EVIDENCE');
  assert.equal(artifact.firstZeroReasonEvidenceStatus, 'AUTHORITATIVE');
  assert.equal(artifact.reasonEvidence.length, 1);
  assert.equal(artifact.reasonEvidence[0].sourceTimestampMs, OBSERVED_AT);
  assert.equal(artifact.reasonCounts.MISSING_EVIDENCE, 5);
});
