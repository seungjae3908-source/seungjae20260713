import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  NATURAL_PAPER_OBSERVABILITY_STAGES,
  NATURAL_PAPER_REJECTION_REASONS,
  buildNaturalPaperEvidenceObservabilityArtifact,
  verifyNaturalPaperEvidenceObservabilityArtifact,
} from '../src/natural-paper-evidence-observability.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const DATASET_DIGEST = createHash('sha256').update('dataset-v1').digest('hex');
const PARAMETER_HASH = createHash('sha256').update('parameters-v1').digest('hex');
const VERIFIED_AT = 1_800_000_000_000;
const OBSERVED_AT = VERIFIED_AT - 1_000;

function ids(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

function reasonIdentity(observationId) {
  return {
    cycleId: 'paper-forward-public-evidence-4h-v1:42',
    triggerSource: 'cron',
    strategySha: SHA,
    runtimeSha: SHA,
    datasetIdentityDigest: DATASET_DIGEST,
    observationId,
  };
}

function stage(field, count, { status = 'MEASURED', observedAt = OBSERVED_AT, observationIds = ids(field, count) } = {}) {
  return {
    field,
    status,
    count,
    blocker: status === 'MEASURED' ? null : `UNMEASURED_${field.toUpperCase()}`,
    provenance: `fixture.${field}`,
    observedAt,
    observationIds,
    identity: reasonIdentity(null),
    naturalCredit: status === 'MEASURED' ? count : 0,
    replayCredit: 0,
    duplicateCredit: 0,
  };
}

function fixture({
  counts = {
    candidate: 8,
    evidence: 7,
    risk: 6,
    admission: 5,
    entry: 4,
    position: 4,
    exitEligible: 3,
    settlement: 2,
  },
  downstreamMeasured = true,
  reasons = [],
} = {}) {
  const canonicalStage = (field, value) => downstreamMeasured
    ? stage(field, value)
    : stage(field, null, { status: 'UNKNOWN', observationIds: [] });
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
      count: counts.evidence,
      provenance: 'authoritative Paper source completeness',
      measuredAtMs: OBSERVED_AT,
    }],
    canonicalNaturalStageEvidence: {
      schemaVersion: 'canonical-natural-paper-stage-evidence-v1',
      identity: {
        cycleId: 'paper-forward-public-evidence-4h-v1:42',
        strategySha: SHA,
        runtimeSha: SHA,
        datasetIdentityDigest: DATASET_DIGEST,
        triggerSource: 'cron',
      },
      stageCounts: {
        signalCandidate: stage('signalCandidate', counts.candidate),
        riskPassed: canonicalStage('riskPassed', counts.risk),
        entryEligible: canonicalStage('entryEligible', counts.admission),
        entry: canonicalStage('entry', counts.entry),
        position: canonicalStage('position', counts.position),
        exitEligible: canonicalStage('exitEligible', counts.exitEligible),
        settlement: canonicalStage('settlement', counts.settlement),
      },
      reasonObservations: reasons,
      naturalCredit: 1,
      replayCredit: 0,
      duplicateCredit: 0,
      historicalCredit: 0,
    },
    authoritativeFirstZeroReasonEvidenceByStage: {},
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

function build(input) {
  return buildNaturalPaperEvidenceObservabilityArtifact(input, { verifiedAtMs: VERIFIED_AT });
}

test('builds an immutable sanitized Natural funnel artifact with all requested counts', () => {
  const artifact = build(fixture());
  assert.equal(artifact.naturalFunnelObservable, true);
  assert.equal(artifact.naturalSampleCredit, 1);
  assert.deepEqual(artifact.funnel, {
    candidateCount: 8,
    authoritativeEvidenceReadyCount: 7,
    riskSizingReadyCount: 6,
    admissionReadyCount: 5,
    entryCreatedCount: 4,
    positionOpenCount: 4,
    exitEligibleCount: 3,
    settlementCreatedCount: 2,
  });
  assert.equal(artifact.firstZeroStage, 'NONE');
  assert.equal(artifact.lifecycleIdentity.entry.valid, true);
  assert.equal(artifact.lifecycleIdentity.position.valid, true);
  assert.equal(artifact.lifecycleIdentity.settlement.valid, true);
  assert.equal(artifact.sourceTimestamps.cycleEvaluatedAtMs, OBSERVED_AT);
  assert.equal(artifact.sourceTimestamps.stageSourceTimestampMs.ENTRY, OBSERVED_AT);
  assert.deepEqual(Object.keys(artifact.reasonCounts), NATURAL_PAPER_REJECTION_REASONS);
  assert.equal(artifact.safety.runtimeMutationCount, 0);
  assert.equal(artifact.safety.databaseMutationCount, 0);
  assert.equal(artifact.safety.privateApiCount, 0);
  assert.equal(artifact.safety.executionAuthority, 'NONE');
  assert.equal(artifact.safety.realOrderCount, 0);
  assert.equal(verifyNaturalPaperEvidenceObservabilityArtifact(artifact), true);
  assert.equal(Object.isFrozen(artifact), true);
});

test('reports EVIDENCE as the first zero and counts the authoritative missing-evidence loss', () => {
  const input = fixture({
    counts: { candidate: 5, evidence: 0, risk: 0, admission: 0, entry: 0, position: 0, exitEligible: 0, settlement: 0 },
    downstreamMeasured: false,
  });
  input.authoritativeFirstZeroReasonEvidenceByStage.EVIDENCE_COMPLETE = {
    reasonCode: 'P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING',
    authoritative: true,
    freshness: 'FRESH',
    observedAtMs: OBSERVED_AT,
    ...reasonIdentity('evidence-first-zero'),
  };
  const artifact = build(input);
  assert.equal(artifact.naturalFunnelObservable, true);
  assert.equal(artifact.funnel.candidateCount, 5);
  assert.equal(artifact.funnel.authoritativeEvidenceReadyCount, 0);
  assert.equal(artifact.firstZeroStage, 'EVIDENCE');
  assert.equal(artifact.firstZeroReason, 'MISSING_EVIDENCE');
  assert.equal(artifact.firstZeroReasonEvidenceStatus, 'AUTHORITATIVE');
  assert.equal(artifact.reasonCounts.MISSING_EVIDENCE, 5);
  assert.equal(artifact.funnel.entryCreatedCount, null);
});

test('does not let unknown evidence masquerade as a measured zero', () => {
  const input = fixture();
  input.naturalFunnelMeasurements = [{
    stage: 'EVIDENCE_COMPLETE',
    status: 'UNKNOWN',
    count: 0,
    blocker: 'AUTHORITATIVE_EVIDENCE_COMPLETENESS_NOT_FULLY_MEASURED',
    measuredAtMs: OBSERVED_AT,
  }];
  const artifact = build(input);
  assert.equal(artifact.naturalFunnelObservable, false);
  assert.equal(artifact.funnel.authoritativeEvidenceReadyCount, null);
  assert.equal(artifact.firstZeroStage, 'UNKNOWN');
  assert.equal(artifact.firstUnknownStage, 'EVIDENCE');
  assert.equal(artifact.firstZeroReason, 'MISSING_EVIDENCE');
});

for (const [name, mutate] of [
  ['TEST_ONLY', (input) => { input.evidenceClass = 'TEST_ONLY'; input.testOnly = true; }],
  ['synthetic', (input) => { input.synthetic = true; }],
  ['historical', (input) => { input.historical = true; }],
  ['replay', (input) => { input.replay = true; input.status = 'REPLAYED'; }],
]) {
  test(`${name} evidence receives zero Natural credit`, () => {
    const input = fixture();
    mutate(input);
    const artifact = build(input);
    assert.equal(artifact.naturalSampleCredit, 0);
    assert.equal(artifact.naturalFunnelObservable, false);
    assert.equal(artifact.funnel.candidateCount, null);
    assert.equal(artifact.excludedEvidence.naturalCreditGranted, false);
  });
}

for (const [stageField, funnelField, stageName, expectedReason] of [
  ['entry', 'entryCreatedCount', 'ENTRY', 'ENTRY_DUPLICATE'],
  ['position', 'positionOpenCount', 'POSITION', 'ENTRY_DUPLICATE'],
  ['settlement', 'settlementCreatedCount', 'SETTLEMENT', 'SETTLEMENT_DUPLICATE'],
]) {
  test(`rejects duplicate ${stageName} identities without counting them`, () => {
    const input = fixture();
    input.canonicalNaturalStageEvidence.stageCounts[stageField] = stage(stageField, 2, {
      observationIds: [`same-${stageField}`, `same-${stageField}`],
    });
    const artifact = build(input);
    assert.equal(artifact.naturalFunnelObservable, false);
    assert.equal(artifact.funnel[funnelField], null);
    assert.equal(artifact.lifecycleIdentity[stageField].valid, false);
    assert.equal(artifact.lifecycleIdentity[stageField].duplicateIdentityCount, 1);
    assert.equal(artifact.firstZeroStage, 'UNKNOWN');
    assert.equal(artifact.firstUnknownStage, stageName);
    assert.equal(artifact.firstZeroReason, expectedReason);
  });
}

test('fails closed on exact code SHA or canonical identity mismatch', () => {
  const wrongCode = fixture();
  wrongCode.naturalRuntimeSha = OTHER_SHA;
  const codeArtifact = build(wrongCode);
  assert.equal(codeArtifact.identity.shaMatches, false);
  assert.equal(codeArtifact.naturalSampleCredit, 0);
  assert.equal(codeArtifact.naturalFunnelObservable, false);

  const wrongDataset = fixture();
  wrongDataset.canonicalNaturalStageEvidence.identity.datasetIdentityDigest = 'c'.repeat(64);
  const datasetArtifact = build(wrongDataset);
  assert.equal(datasetArtifact.identity.complete, true);
  assert.equal(datasetArtifact.naturalFunnelObservable, false);
  assert.equal(datasetArtifact.firstZeroStage, 'UNKNOWN');
  assert.equal(datasetArtifact.firstZeroReason, 'IDENTITY_MISMATCH');
});

test('classifies all requested rejection families from authoritative reason observations', () => {
  const mappings = [
    ['NO_TRADE', 'NO_TRADE', 'ENTRY_ELIGIBLE'],
    ['MISSING_EVIDENCE', 'DATA_TIMESTAMP_REQUIRED', 'ENTRY_ELIGIBLE'],
    ['BLOCKED_DATA', 'BLOCKED_DATA', 'ENTRY_ELIGIBLE'],
    ['STALE_DATA', 'STALE_DATA_FORBIDDEN', 'ENTRY_ELIGIBLE'],
    ['IDENTITY_MISMATCH', 'STRATEGY_RESEARCH_SHA_MISMATCH', 'ENTRY_ELIGIBLE'],
    ['RISK_REJECTED', 'RISK_EVIDENCE_NOT_APPROVED', 'RISK_GATE'],
    ['COST_INCOMPLETE', 'LIQUIDITY_IMPACT_MISSING', 'ENTRY_ELIGIBLE'],
    ['POLICY_REJECTED', 'QUALITY_POLICY_REJECTED', 'QUALITY_GATE'],
    ['ENTRY_DUPLICATE', 'DUPLICATE_SIGNAL_ID', 'ENTRY_ELIGIBLE'],
    ['EXIT_NOT_REACHED', 'HOLDING_HORIZON_NOT_REACHED', 'EXIT_ELIGIBLE'],
    ['SETTLEMENT_DUPLICATE', 'DUPLICATE_SETTLEMENT', 'SETTLEMENT'],
    ['RUNTIME_ERROR', 'UNHANDLED_RUNTIME_ERROR', 'ENTRY'],
  ];
  const reasons = mappings.map(([category, sourceCode, sourceStage], index) => ({
    sourceStage,
    sourceCode,
    sourceReason: sourceCode,
    canonicalReason: category === 'NO_TRADE' ? 'NO_SIGNAL' : 'UNKNOWN',
    lossless: true,
    observedAt: OBSERVED_AT,
    identity: reasonIdentity(`reason-${index}`),
    naturalCredit: 1,
    replayCredit: 0,
    duplicateCredit: 0,
  }));
  const artifact = build(fixture({ reasons }));
  for (const [category] of mappings) assert.equal(artifact.reasonCounts[category], 1, category);
});

test('artifact contains digests but no raw lifecycle identities or forbidden private fields', () => {
  const input = fixture();
  input.secret = 'must-not-appear';
  input.accountId = 'must-not-appear';
  input.privateEndpoint = 'must-not-appear';
  const artifact = build(input);
  const serialized = JSON.stringify(artifact);
  assert.equal(serialized.includes('signalCandidate-1'), false);
  assert.equal(serialized.includes('entry-1'), false);
  assert.equal(serialized.includes('position-1'), false);
  assert.equal(serialized.includes('settlement-1'), false);
  assert.equal(serialized.includes('must-not-appear'), false);
  assert.match(artifact.stages[0].observationIdDigests[0], /^[0-9a-f]{64}$/u);
  assert.match(artifact.artifactDigest, /^[0-9a-f]{64}$/u);
  assert.equal(verifyNaturalPaperEvidenceObservabilityArtifact(artifact), true);
  const tampered = { ...artifact, firstZeroReason: 'RUNTIME_ERROR' };
  assert.equal(verifyNaturalPaperEvidenceObservabilityArtifact(tampered), false);
});

test('stage contract is exact and stable', () => {
  assert.deepEqual(NATURAL_PAPER_OBSERVABILITY_STAGES.map(({ name, field }) => ({ name, field })), [
    { name: 'CANDIDATE', field: 'candidateCount' },
    { name: 'EVIDENCE', field: 'authoritativeEvidenceReadyCount' },
    { name: 'RISK', field: 'riskSizingReadyCount' },
    { name: 'ADMISSION', field: 'admissionReadyCount' },
    { name: 'ENTRY', field: 'entryCreatedCount' },
    { name: 'POSITION', field: 'positionOpenCount' },
    { name: 'EXIT_ELIGIBLE', field: 'exitEligibleCount' },
    { name: 'SETTLEMENT', field: 'settlementCreatedCount' },
  ]);
});

test('probe and workflow remain manual, read-only, and artifact-only', () => {
  const probe = readFileSync(new URL('../../ops/research-production-natural-paper-observability.sh', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../../.github/workflows/research-production-natural-paper-observability.yml', import.meta.url), 'utf8');
  for (const marker of [
    'server_files_written=0',
    'server_processes_restarted=0',
    'runtime_mutations=0',
    'database_mutations=0',
    'private_api=0',
    'live_trading=false',
    'execution_authority=NONE',
    'real_order_count=0',
  ]) assert.match(probe, new RegExp(marker, 'u'));
  assert.doesNotMatch(probe, /(^|[\s;])(rm|mv|cp|install|mkdir|touch|tee|truncate)([\s]|$)/mu);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s+schedule:/mu);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.doesNotMatch(workflow, /issues\.createComment|pulls\.create|actions\/deploy|deploy-production|order\(/u);
});
