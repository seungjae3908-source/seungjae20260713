import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runDurableMinuteBackfillCycle, QUEUE_LIMITS,
} from '../src/four-market-minute-backfill-queue-v1.mjs';
import {
  assessMinuteArchiveCapacity,
} from '../src/four-market-minute-roster-capacity-v1.mjs';
import {
  assessMinuteCollectorPacingPreflightV1,
} from '../src/four-market-minute-pacing-preflight-v1.mjs';
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

test('collector + AI integration cannot turn a 38-action proposal into authorized collection', () => {
  const startMs = Date.parse('2026-10-12T10:00:00.000Z');
  const manifest = { schemaVersion: 'research-minute-backfill-scope/v1',
    ranges: [
      ...Array.from({length:294},(_,i)=>({
        market:'CRYPTO_SPOT',symbol:'S'+i,mode:'CONTINUOUS',startMs,
      })),
      ...Array.from({length:466},(_,i)=>({
        market:'CRYPTO_FUTURES',symbol:'F'+i+'USDT',mode:'CONTINUOUS',startMs,
      })),
    ],
  };
  const pacing=assessMinuteCollectorPacingPreflightV1({
    manifest, proposedActionsPerCycle:38,
  });
  assert.equal(pacing.capacity.status, 'CAPACITY_MODEL_POSSIBLE');
  assert.equal(pacing.minimumActionsPerCycleWithHeadroom, 38);
  assert.ok(pacing.proposedSequentialWorstCaseMs > pacing.usableSequentialWorkerMs);
  assert.equal(pacing.actualRuntimeMaximumActionsPerCycle, 16);
  assert.ok(pacing.reasons.includes('EXISTING_WORKER_HARD_CAP_NOT_CHANGED'));
  assert.equal(pacing.currentTimerActivated, false);
  assert.equal(pacing.providerRateBudgetVerified, false);
  assert.equal(pacing.hostCapacityVerified, false);
  assert.equal(pacing.executionAuthority, 'NONE');
});
