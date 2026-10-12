import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runDurableMinuteBackfillCycle, QUEUE_LIMITS,
} from '../src/four-market-minute-backfill-queue-v1.mjs';
import {
  assessMinuteArchiveCapacity,
} from '../src/four-market-minute-roster-capacity-v1.mjs';
import {
  AI_FORMULA_TRAIN_PRODUCER_CONTRACT_V1,
  prepareAiFormulaTrainProposalsV1,
} from '../src/ai-formula-train-producer-v1.mjs';
import {
  AI_FORMULA_ITERATION_REVIEW_CONTRACT_V1,
  previewAiFormulaNextIterationV1,
} from '../src/ai-formula-iteration-review-v1.mjs';
import {
  EXPECTED_FORWARD_TASK_IDS, assessForwardCycleEvidence,
  classifyNaturalCycleEvidence,
} from '../src/natural-cycle-verdict-trace.mjs';

test('unapproved 1-minute collection cannot contact public providers or write', async () => {
  let providerCalls = 0;
  const result = await runDurableMinuteBackfillCycle({
    enabled: false,
    fetchImpl: () => { providerCalls++; throw Error('UNEXPECTED_PROVIDER_GET'); },
  });
  assert.equal(result.status, 'DISABLED');
  assert.equal(result.providerCalls, 0);
  assert.equal(result.filesWritten, 0);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(providerCalls, 0);
});

test('dense 4-market crypto intake capacity cannot be misreported sustainable', () => {
  const cap = assessMinuteArchiveCapacity({
    cryptoSpotSymbols: 294, cryptoFuturesSymbols: 466,
    actionsPerCycle: QUEUE_LIMITS.maxActionsPerCycle,
  });
  assert.equal(cap.dailyRequired, 9120);
  assert.equal(cap.dailyAvailable, 4608);
  assert.equal(cap.minActionsPerCycleWithHeadroom, 38);
  assert.equal(cap.status, 'CAPACITY_MODEL_INSUFFICIENT');
  assert.equal(cap.modeledCapacitySufficient, false);
  assert.equal(cap.providerRateBudgetVerified, false);
  assert.equal(cap.continuous24hProven, false);
  assert.equal(cap.executionAuthority, 'NONE');
});

test('frozen AI research intake remains a separate bounded non-trading path', () => {
  assert.equal(AI_FORMULA_TRAIN_PRODUCER_CONTRACT_V1,
    'research-ai-formula-train-producer/v1');
  assert.equal(AI_FORMULA_ITERATION_REVIEW_CONTRACT_V1,
    'research-ai-formula-iteration-review/v1');
  assert.equal(typeof prepareAiFormulaTrainProposalsV1, 'function');
  assert.equal(typeof previewAiFormulaNextIterationV1, 'function');
});

test('current natural three-task forward cannot promote missing data or stale releases', () => {
  assert.deepEqual(EXPECTED_FORWARD_TASK_IDS, [
    'formula-backtest-queue', 'shadow-forward', 'paper-forward',
  ]);
  const base = {
    timersHealthy: true,
    forward: {
      observed: true, clockFresh: true, sourceExact: true,
      exactTasks: true, hasBlockedData: true, allSucceeded: false,
    },
    paperSafe: true, historicalComplete: true,
  };
  assert.equal(classifyNaturalCycleEvidence({ ...base, releaseMatch: true }),
    'blocked_data');
  assert.equal(classifyNaturalCycleEvidence({ ...base, releaseMatch: false }),
    'stale_release');
  assert.equal(classifyNaturalCycleEvidence({
    ...base, releaseMatch: true, forward: { ...base.forward, clockFresh: false },
  }), 'stale_cycle');
});

test('wrong Research SHA cannot be a proven scheduled forward cycle', () => {
  const sha = 'a'.repeat(40);
  const observedAt = Date.parse('2026-10-12T14:00:00Z');
  const status = assessForwardCycleEvidence({
    expectedSha: sha,
    nowMs: observedAt + 60_000,
    timer: { last_trigger: new Date(observedAt).toISOString() },
    cycle: {
      present: 'true', generated_at: new Date(observedAt).toISOString(),
      research_sha: 'b'.repeat(40), failed_count: '0',
    },
    tasks: EXPECTED_FORWARD_TASK_IDS.map(id => ({
      id, profile: 'forward', status: 'success',
    })),
  });
  assert.equal(status.exactTasks, true);
  assert.equal(status.sourceExact, false);
  assert.equal(status.observed, false);
});
