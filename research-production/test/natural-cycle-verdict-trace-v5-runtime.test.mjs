import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNaturalPaperFirstZeroTraceFromRuntime } from '../src/natural-cycle-verdict-trace.mjs';

const SHA = '8b337eb22cf943a71e56158de4ae5fa5893aaa09';
const DATASET = 'natural-paper-v5-dataset-identity';

function measurements(overrides = {}, statusOverrides = {}) {
  const values = {
    UNIVERSE: 4500,
    SCANNER_EVALUATED: 2800,
    CANDIDATE: 26,
    EVIDENCE_COMPLETE: 14,
    ADMISSION_PASS: 9,
    RISK_PASS: 6,
    COST_PASS: 4,
    ACCOUNT_READY: 4,
    PAPER_ENTRY: 3,
    POSITION: 3,
    SETTLEMENT: 2,
    OUTCOME: 2,
    ...overrides,
  };
  return Object.entries(values).map(([stage, count]) => ({
    stage,
    status: statusOverrides[stage] ?? 'MEASURED',
    count,
  }));
}

test('CLI v5 natural funnel and natural identity fields drive canonical FIRST_ZERO', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'paper-forward-public-evidence-4h-v1:999',
    naturalScheduleInvocation: true,
    naturalStrategySha: SHA,
    naturalRuntimeSha: SHA,
    naturalDatasetIdentity: DATASET,
    naturalFunnelMeasurements: measurements({
      PAPER_ENTRY: 0,
      POSITION: 0,
      SETTLEMENT: 0,
      OUTCOME: 0,
    }),
    naturalFirstZeroStage: 'CANDIDATE',
    naturalFirstZeroReason: 'UNTRUSTED_RUNTIME_VERDICT',
    authoritativeStageMeasurements: [{ stage: 'Scanner Candidate', count: 999 }],
  });

  assert.equal(trace.status, 'BLOCKED');
  assert.equal(trace.naturalCycle, true);
  assert.equal(trace.identity.complete, true);
  assert.equal(trace.firstZeroStageName, 'PAPER_ENTRY');
  assert.equal(trace.firstZeroReason, 'UNKNOWN');
  assert.equal(trace.runtimeAdapter.selectedMeasurementSource, 'NATURAL_FUNNEL');
  assert.equal(trace.runtimeAdapter.naturalMeasurementsPresent, true);
  assert.equal(trace.runtimeAdapter.authoritativeMeasurementsPresent, true);
  assert.equal(trace.runtimeAdapter.suppliedFirstZeroStageIgnored, true);
  assert.equal(trace.runtimeAdapter.suppliedFirstZeroReasonIgnored, true);
});

test('CLI v5 PARTIAL upstream measurement remains UNKNOWN and blocks later zero', () => {
  const trace = buildNaturalPaperFirstZeroTraceFromRuntime({
    cycleId: 'paper-forward-public-evidence-4h-v1:1000',
    naturalScheduleInvocation: true,
    naturalStrategySha: SHA,
    naturalRuntimeSha: SHA,
    naturalDatasetIdentity: DATASET,
    naturalFunnelMeasurements: measurements(
      { EVIDENCE_COMPLETE: 0, PAPER_ENTRY: 0, POSITION: 0, SETTLEMENT: 0, OUTCOME: 0 },
      { EVIDENCE_COMPLETE: 'PARTIAL' },
    ),
  });

  assert.equal(trace.status, 'WAITING_EVIDENCE');
  assert.equal(trace.firstUnknownStage, 'EVIDENCE_COMPLETE');
  assert.equal(trace.firstZeroStageName, 'UNKNOWN');
  assert.equal(trace.counts.evidenceCompleteCount, null);
});
