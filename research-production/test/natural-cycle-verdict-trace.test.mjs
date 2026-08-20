import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNaturalPaperFirstZeroTrace,
  NATURAL_PAPER_STAGE_ORDER,
} from '../src/natural-cycle-verdict-trace.mjs';

const SHA = '8b337eb22cf943a71e56158de4ae5fa5893aaa09';

function counts(overrides = {}) {
  return {
    scannerCandidateCount: 3,
    profitGatePassCount: 2,
    exactIdentityPassCount: 2,
    paperAdmissionCount: 2,
    entryCreatedCount: 1,
    positionOpenedCount: 1,
    exitConditionReachedCount: 1,
    settlementCompletedCount: 1,
    ...overrides,
  };
}

test('records the exact eight-stage natural Paper ladder', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:1',
    researchCodeSha: SHA,
    triggerSource: 'cron',
    ...counts(),
  });
  assert.deepEqual(trace.stages.map((stage) => stage.stage), [...NATURAL_PAPER_STAGE_ORDER]);
  assert.equal(trace.status, 'COMPLETE');
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.firstUnknownStage, null);
});

test('current public-evidence-only runtime is classified at scanner candidate zero when bridge is absent', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:current-main',
    researchCodeSha: SHA,
    triggerSource: 'cron',
    scannerCandidateCount: 0,
    profitGatePassCount: null,
    exactIdentityPassCount: null,
    paperAdmissionCount: null,
    entryCreatedCount: null,
    positionOpenedCount: null,
    exitConditionReachedCount: null,
    settlementCompletedCount: null,
    scannerToPaperBridgeConnected: false,
    outcomeAccumulationEnabled: false,
  });
  assert.equal(trace.status, 'BLOCKED');
  assert.equal(trace.firstZeroStage.code, 'SCANNER_CANDIDATE_ZERO');
  assert.equal(trace.firstZeroStage.blockerReason, 'SCANNER_TO_PAPER_BRIDGE_MISSING');
});

test('unknown earlier evidence never lets a later zero masquerade as FIRST_ZERO_STAGE', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:unknown',
    researchCodeSha: SHA,
    triggerSource: 'cron',
    scannerCandidateCount: null,
    profitGatePassCount: 0,
    exactIdentityPassCount: 0,
    paperAdmissionCount: 0,
    entryCreatedCount: 0,
    positionOpenedCount: 0,
    exitConditionReachedCount: 0,
    settlementCompletedCount: 0,
  });
  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'SCANNER_CANDIDATE');
  assert.equal(trace.firstZeroStage, null);
});

test('outcome accumulation disabled is an entry-stage blocker only after earlier stages pass', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:admitted',
    researchCodeSha: SHA,
    triggerSource: 'cron',
    ...counts({
      scannerCandidateCount: 2,
      profitGatePassCount: 1,
      exactIdentityPassCount: 1,
      paperAdmissionCount: 1,
      entryCreatedCount: 0,
      positionOpenedCount: 0,
      exitConditionReachedCount: 0,
      settlementCompletedCount: 0,
    }),
    outcomeAccumulationEnabled: false,
  });
  assert.equal(trace.firstZeroStage.code, 'ENTRY_NOT_CREATED');
  assert.equal(trace.firstZeroStage.blockerReason, 'OUTCOME_ACCUMULATION_DISABLED');
});

test('profit gate missing evidence is preserved as the first explicit blocker', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:profit',
    researchCodeSha: SHA,
    triggerSource: 'cron',
    ...counts({ profitGatePassCount: 0, exactIdentityPassCount: 0, paperAdmissionCount: 0, entryCreatedCount: 0, positionOpenedCount: 0, exitConditionReachedCount: 0, settlementCompletedCount: 0 }),
    profitGateEvidenceConnected: false,
  });
  assert.equal(trace.firstZeroStage.code, 'PROFIT_GATE_ZERO');
  assert.equal(trace.firstZeroStage.blockerReason, 'PROFIT_GATE_EVIDENCE_MISSING');
});

test('manual evidence is never accepted as a natural cycle and safety stays hard-off', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:manual',
    researchCodeSha: SHA,
    triggerSource: 'manual-readonly-test',
    ...counts(),
  });
  assert.equal(trace.status, 'NOT_NATURAL_CYCLE');
  assert.equal(trace.naturalCycle, false);
  assert.equal(trace.safety.executionAuthority, 'NONE');
  assert.equal(trace.safety.liveTrading, false);
  assert.equal(trace.safety.autoTrading, false);
  assert.equal(trace.safety.realOrderEnabled, false);
  assert.equal(trace.safety.privateTradingApiAllowed, false);
  assert.equal(trace.safety.orderCount, 0);
});

test('zero is never fabricated from missing evidence', () => {
  const trace = buildNaturalPaperFirstZeroTrace({
    cycleId: 'paper-cycle:missing',
    researchCodeSha: SHA,
    triggerSource: 'cron',
  });
  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'SCANNER_CANDIDATE');
  assert.equal(trace.firstZeroStage, null);
  assert.equal(trace.counts.scannerCandidateCount, null);
  assert.equal(trace.counts.settlementCompletedCount, null);
});
