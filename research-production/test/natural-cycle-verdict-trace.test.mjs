import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNaturalPaperFirstZeroTrace,
  buildNaturalPaperFirstZeroTraceFromRuntime,
  NATURAL_PAPER_STAGE_ORDER,
} from '../src/natural-cycle-verdict-trace.mjs';

const STRATEGY_SHA = '8b337eb22cf943a71e56158de4ae5fa5893aaa09';
const RUNTIME_SHA = '28ecd6caf448d53a6bcdc02ce32c23a4745327c7';
const DATASET = 'natural-paper:cycle:2026-08-23T00:00:00+09:00';

function identity(overrides = {}) {
  return {
    strategySha: STRATEGY_SHA,
    runtimeSha: RUNTIME_SHA,
    datasetIdentity: DATASET,
    triggerSource: 'systemd-timer',
    ...overrides,
  };
}

function counts(overrides = {}) {
  return {
    universeCount: 4500,
    scannerEvaluatedCount: 2800,
    scannerCandidateCount: 26,
    evidenceCompleteCount: 14,
    admissionPassCount: 9,
    riskPassCount: 6,
    costPassCount: 4,
    accountReadyCount: 4,
    paperEntryCount: 3,
    paperPositionCount: 3,
    settlementCount: 2,
    outcomeCount: 2,
    ...overrides,
  };
}

function runtimeMeasurements(overrides = {}) {
  const values = counts(overrides);
  return [
    ['Universe', 'universeCount'],
    ['Scanner Evaluated', 'scannerEvaluatedCount'],
    ['Scanner Candidate', 'scannerCandidateCount'],
    ['Evidence Complete', 'evidenceCompleteCount'],
    ['Admission Pass', 'admissionPassCount'],
    ['Risk Pass', 'riskPassCount'],
    ['Cost Pass', 'costPassCount'],
    ['Account Ready', 'accountReadyCount'],
    ['Paper Entry', 'paperEntryCount'],
    ['Paper Position', 'paperPositionCount'],
    ['Settlement', 'settlementCount'],
    ['Outcome', 'outcomeCount'],
  ].map(([stage, field]) => ({ stage, field, count: values[field] }));
}

test('records the exact twelve-stage Natural Paper funnel', () => {
  const trace = buildNaturalPaperFirstZeroTrace({ cycleId: 'cycle:complete', ...identity(), ...counts() });
  assert.deepEqual(trace.stages.map((stage) => stage.stage), [...NATURAL_PAPER_STAGE_ORDER]);
  assert.equal(trace.status, 'COMPLETE');
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.firstZeroStageName, 'NONE');
  assert.equal(trace.firstZeroReason, 'UNKNOWN');
});

test('classifies PAPER_ENTRY only after every prior stage is positively observed', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:paper-entry-zero',
    ...identity(),
    ...counts({ paperEntryCount: 0, paperPositionCount: 0, settlementCount: 0, outcomeCount: 0 }),
  });
  assert.equal(trace.status, 'BLOCKED');
  assert.equal(trace.firstZeroStage.stage, 'PAPER_ENTRY');
  assert.equal(trace.firstZeroStage.code, 'PAPER_ENTRY_NOT_CREATED');
  assert.equal(trace.firstZeroStageName, 'PAPER_ENTRY');
  assert.equal(trace.firstZeroReason, 'UNKNOWN');
  assert.equal(trace.firstZeroReasonEvidenceStatus, 'MISSING');
});

test('unknown earlier evidence never lets a later zero masquerade as FIRST_ZERO_STAGE', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:unknown-upstream',
    ...identity(),
    ...counts({ evidenceCompleteCount: null, admissionPassCount: 0, paperEntryCount: 0 }),
  });
  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'EVIDENCE_COMPLETE');
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.firstZeroStageName, 'UNKNOWN');
});

test('missing Strategy/Runtime/Dataset identity blocks a zero classification', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:missing-identity',
    triggerSource: 'cron',
    ...counts({ scannerCandidateCount: 0 }),
  });
  assert.equal(trace.status, 'WAITING_IDENTITY');
  assert.equal(trace.identity.complete, false);
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.firstZeroStageName, 'UNKNOWN');
});

test('stage evidence from a different SHA fails closed instead of mixing identities', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:mixed-sha',
    ...identity(),
    ...counts(),
    stageEvidence: {
      CANDIDATE: {
        count: 0,
        strategySha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        runtimeSha: RUNTIME_SHA,
        datasetIdentity: DATASET,
      },
    },
  });
  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'CANDIDATE');
  assert.equal(trace.stages.find((stage) => stage.stage === 'CANDIDATE').status, 'IDENTITY_MISMATCH');
  assert.equal(trace.firstZeroStage, null);
});

test('synthetic, historical, replay and duplicate evidence are rejected as Natural Paper evidence', () => {
  for (const flag of ['synthetic', 'historical', 'replay', 'duplicateReplay', 'testFixture', 'manualExpiry', 'futureTimeCompression', 'clockAdvanced']) {
    const trace = buildNaturalPaperFirstZeroTrace({
      cycleId: `cycle:reject:${flag}`,
      ...identity(),
      ...counts(),
      stageEvidence: { PAPER_ENTRY: { count: 1, [flag]: true } },
    });
    assert.equal(trace.status, 'WAITING_EVIDENCE');
    assert.equal(trace.firstUnknownStage, 'PAPER_ENTRY');
    assert.equal(trace.firstZeroStage, null);
  }
});

test('duplicate observation ids are rejected instead of being double counted', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:duplicate-observation',
    ...identity(),
    ...counts(),
    stageEvidence: { CANDIDATE: { count: 2, observationIds: ['obs-1', 'obs-1'] } },
  });
  const candidate = trace.stages.find((stage) => stage.stage === 'CANDIDATE');
  assert.equal(candidate.status, 'DUPLICATE_OBSERVATION_REJECTED');
  assert.equal(candidate.count, null);
  assert.equal(trace.firstZeroStage, null);
});

test('manual invocation cannot become Natural Paper evidence', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:manual',
    ...identity({ triggerSource: 'manual-readonly-test' }),
    ...counts(),
  });
  assert.equal(trace.status, 'NOT_NATURAL_CYCLE');
  assert.equal(trace.naturalCycle, false);
  assert.equal(trace.firstZeroStage, null);
});

test('missing counts remain unknown and never become zero', () => {
  const trace = buildNaturalPaperFirstZeroTrace({ cycleId: 'cycle:missing', ...identity() });
  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'UNIVERSE');
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.counts.universeCount, null);
  assert.equal(trace.counts.outcomeCount, null);
});

test('safety contract is hard-off for execution and mutation authority', () => {
  const trace = buildNaturalPaperFirstZeroTrace({ cycleId: 'cycle:safety', ...identity(), ...counts() });
  assert.deepEqual(
    {
      executionAuthority: trace.safety.executionAuthority,
      liveTrading: trace.safety.liveTrading,
      autoTrading: trace.safety.autoTrading,
      realOrderEnabled: trace.safety.realOrderEnabled,
      privateTradingApiAllowed: trace.safety.privateTradingApiAllowed,
      transferEnabled: trace.safety.transferEnabled,
      withdrawalEnabled: trace.safety.withdrawalEnabled,
      runtimeVerdictTrusted: trace.safety.runtimeVerdictTrusted,
    },
    {
      executionAuthority: 'NONE',
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      transferEnabled: false,
      withdrawalEnabled: false,
      runtimeVerdictTrusted: false,
    },
  );
});

test('accepts FIRST_ZERO_REASON only from fresh authoritative matching evidence', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'cycle:reason-accepted',
    ...identity(),
    ...counts({ evidenceCompleteCount: 0, admissionPassCount: 0, riskPassCount: 0 }),
    reasonEvidenceByStage: {
      EVIDENCE_COMPLETE: {
        reasonCode: 'EVIDENCE_STALE',
        authoritative: true,
        freshness: 'FRESH',
        strategySha: STRATEGY_SHA,
        runtimeSha: RUNTIME_SHA,
        datasetIdentity: DATASET,
      },
    },
  });
  assert.equal(trace.firstZeroStageName, 'EVIDENCE_COMPLETE');
  assert.equal(trace.firstZeroReason, 'EVIDENCE_STALE');
  assert.equal(trace.firstZeroReasonEvidenceStatus, 'ACCEPTED');
});

test('stale or identity-mismatched reason evidence never becomes FIRST_ZERO_REASON', () => {
  for (const evidence of [
    { reasonCode: 'RISK_MODEL_STALE', authoritative: true, freshness: 'STALE' },
    { reasonCode: 'RISK_MODEL_STALE', authoritative: false, freshness: 'FRESH' },
    {
      reasonCode: 'RISK_MODEL_STALE', authoritative: true, freshness: 'FRESH',
      strategySha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', runtimeSha: RUNTIME_SHA, datasetIdentity: DATASET,
    },
  ]) {
    const trace = buildNaturalPaperFirstZeroTrace({
      cycleId: 'cycle:reason-rejected',
      ...identity(),
      ...counts({ riskPassCount: 0, costPassCount: 0, paperEntryCount: 0 }),
      reasonEvidenceByStage: { RISK_PASS: evidence },
    });
    assert.equal(trace.firstZeroStageName, 'RISK_PASS');
    assert.equal(trace.firstZeroReason, 'UNKNOWN');
    assert.notEqual(trace.firstZeroReasonEvidenceStatus, 'ACCEPTED');
  }
});

test('runtime adapter recomputes the twelve-stage verdict from authoritative counts', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'cycle:runtime-paper-entry-zero',
    ...identity(),
    authoritativeStageMeasurements: runtimeMeasurements({ paperEntryCount: 0, paperPositionCount: 0, settlementCount: 0, outcomeCount: 0 }),
  });
  assert.equal(trace.firstZeroStageName, 'PAPER_ENTRY');
  assert.equal(trace.firstZeroReason, 'UNKNOWN');
  assert.equal(trace.runtimeAdapter.verdictRecomputedFromCounts, true);
  assert.equal(trace.runtimeAdapter.authoritativeMeasurementsPresent, true);
});

test('runtime adapter ignores supplied FIRST_ZERO verdicts and recomputes from counts', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'cycle:runtime-forged-verdict',
    ...identity(),
    firstZeroStage: 'CANDIDATE',
    firstZeroReason: 'FORCED_CANDIDATE_FAILURE',
    authoritativeStageMeasurements: runtimeMeasurements({ settlementCount: 0, outcomeCount: 0 }),
  });
  assert.equal(trace.firstZeroStageName, 'SETTLEMENT');
  assert.equal(trace.firstZeroReason, 'UNKNOWN');
  assert.equal(trace.runtimeAdapter.suppliedFirstZeroStageIgnored, true);
  assert.equal(trace.runtimeAdapter.suppliedFirstZeroReasonIgnored, true);
});

test('legacy runtime without the complete standardized twelve-stage ladder stays UNKNOWN', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'cycle:legacy-v3',
    ...identity(),
    firstZeroStage: 'Entry',
    firstZeroReason: 'ENTRY_ZERO',
    authoritativeStageMeasurements: [
      { stage: 'Scanner Candidate', count: 2 },
      { stage: 'Identity', count: 2 },
      { stage: 'Entry', count: 0 },
      { stage: 'Settlement', count: 0 },
    ],
  });
  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'UNIVERSE');
  assert.equal(trace.firstZeroStageName, 'UNKNOWN');
  assert.equal(trace.firstZeroReason, 'UNKNOWN');
});

test('runtime adapter fails closed when complete Strategy/Runtime/Dataset identity is absent', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'cycle:runtime-missing-identity',
    triggerSource: 'cron',
    authoritativeStageMeasurements: runtimeMeasurements({ scannerCandidateCount: 0 }),
  });
  assert.equal(trace.status, 'WAITING_IDENTITY');
  assert.equal(trace.firstZeroStageName, 'UNKNOWN');
  assert.equal(trace.runtimeAdapter.completeIdentityPresent, false);
});

test('duplicate runtime measurements reject the affected stage instead of choosing a count', () => {
  const measurements = runtimeMeasurements();
  measurements.push({ stage: 'Scanner Candidate', count: 0 });
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'cycle:runtime-duplicate-stage',
    ...identity(),
    authoritativeStageMeasurements: measurements,
  });
  const candidate = trace.stages.find((stage) => stage.stage === 'CANDIDATE');
  assert.equal(candidate.status, 'DUPLICATE_STAGE_MEASUREMENT_REJECTED');
  assert.equal(candidate.count, null);
  assert.equal(trace.firstZeroStageName, 'UNKNOWN');
});

test('runtime authoritative reason evidence must still pass the independent reason gate', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'cycle:runtime-authoritative-reason',
    ...identity(),
    firstZeroReason: 'UNTRUSTED_RUNTIME_REASON',
    authoritativeStageMeasurements: runtimeMeasurements({ costPassCount: 0, accountReadyCount: 0, paperEntryCount: 0 }),
    authoritativeFirstZeroReasonEvidenceByStage: {
      COST_PASS: {
        reasonCode: 'SPREAD_EXCEEDS_COST_POLICY',
        authoritative: true,
        freshness: 'FRESH',
        strategySha: STRATEGY_SHA,
        runtimeSha: RUNTIME_SHA,
        datasetIdentity: DATASET,
      },
    },
  });
  assert.equal(trace.firstZeroStageName, 'COST_PASS');
  assert.equal(trace.firstZeroReason, 'SPREAD_EXCEEDS_COST_POLICY');
  assert.equal(trace.firstZeroReasonEvidenceStatus, 'ACCEPTED');
  assert.equal(trace.runtimeAdapter.suppliedFirstZeroReasonIgnored, true);
});
