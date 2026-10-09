import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_FORWARD_TASK_IDS,
  assessForwardCycleEvidence,
  classifyNaturalCycleEvidence,
} from '../src/production-natural-cycle-observer.mjs';

const SHA = 'a'.repeat(40);
const timer = { last_trigger: '2026-10-09T09:00:00Z' };
const cycle = { present: 'true', research_sha: SHA, failed_count: '0' };
const tasks = EXPECTED_FORWARD_TASK_IDS.map((id) => ({
  profile: 'forward', id, status: 'success',
}));
const observe = (patch = {}) => assessForwardCycleEvidence({
  expectedSha: SHA, timer, cycle, tasks, ...patch,
});
const classify = (forward, patch = {}) => classifyNaturalCycleEvidence({
  releaseMatch: true, timersHealthy: true, forward, paperSafe: true,
  historicalComplete: true, historicalRunning: false, ...patch,
});

test('a natural forward cycle requires all THREE actual production tasks', () => {
  assert.deepEqual(EXPECTED_FORWARD_TASK_IDS, [
    'formula-backtest-queue', 'shadow-forward', 'paper-forward',
  ]);
  assert.deepEqual(observe(), {
    observed: true, sourceExact: true, exactTasks: true,
    hasBlockedData: false, allSucceeded: true,
  });
  assert.equal(observe({ tasks: tasks.slice(1) }).observed, false);
  assert.equal(observe({ tasks: [...tasks, tasks[0]] }).observed, false);
  assert.equal(observe({ tasks: [...tasks.slice(0, 2),
    { ...tasks[2], id: 'unrecognized-task' }] }).observed, false);
});

test('wrong cycle SHA and untrusted last-trigger never count as observed', () => {
  assert.equal(observe({ cycle: { ...cycle, research_sha: 'b'.repeat(40) } }).observed, false);
  assert.equal(observe({ cycle: { ...cycle, failed_count: '1' } }).observed, false);
  assert.equal(observe({ timer: { last_trigger: 'n/a' } }).observed, false);
  assert.equal(observe({ timer: { last_trigger: 'unknown' } }).observed, false);
  assert.equal(observe({ tasks: tasks.map(row => ({...row, status:'skipped'})) }).observed, false);
});

test('blocked_data tasks are observed but never promoted to operational PASS', () => {
  const blocked = observe({ tasks: [
    { ...tasks[0], status: 'blocked_data' },
    { ...tasks[1], status: 'blocked_data' },
    { ...tasks[2], status: 'blocked_data' },
  ] });
  assert.equal(blocked.observed, true);
  assert.equal(blocked.hasBlockedData, true);
  assert.equal(blocked.allSucceeded, false);
  assert.equal(classify(blocked), 'blocked_data');
});

test('release SHA mismatch is a diagnosable stale release, not evidence unavailable or PASS', () => {
  const valid = observe();
  assert.equal(classify(valid, { releaseMatch: false }), 'stale_release');
  assert.equal(classify(valid, { releaseMatch: null }), 'stale_release');
  assert.equal(classify(valid, { paperSafe: false }), 'failed');
  assert.equal(classify(valid, { timersHealthy: false }), 'failed');
  assert.equal(classify(observe({ tasks: tasks.slice(1) })), 'failed');
});

test('only all-success forward tasks can report scheduled-cycle PASS', () => {
  assert.equal(classify(observe()), 'passed');
  assert.equal(classify(observe(), {
    historicalComplete: false, historicalRunning: true,
  }), 'forward_pass_historical_running');
  assert.equal(classify(observe(), {
    historicalComplete: false, historicalRunning: false,
  }), 'forward_pass_historical_unproven');
});
