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

