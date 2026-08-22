import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNaturalPaperFirstZeroTrace,
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

test('records the exact twelve-stage Natural Paper funnel', () => {
  const trace = buildNaturalPaperFirstZeroTrace({ cycleId: 'cycle:complete', ...identity(), ...counts() });
  assert.deepEqual(trace.stages.map((stage) => stage.stage), [...NATURAL_PAPER_STAGE_ORDER]);
  assert.equal(trace.status, 'COMPLETE');
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.firstZeroStageName, 'NONE');
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
    },
    {
      executionAuthority: 'NONE',
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      transferEnabled: false,
      withdrawalEnabled: false,
    },
  );
});
