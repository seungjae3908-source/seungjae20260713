'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectProductionTradingGateConflicts,
} = require('./production-trading-gate-conflicts.cjs');

function fixture(runsByWorkflow, runId = 100) {
  const listWorkflowRuns = () => undefined;
  return {
    github: {
      rest: { actions: { listWorkflowRuns } },
      paginate: async (fn, args) => {
        assert.equal(fn, listWorkflowRuns);
        return runsByWorkflow[args.workflow_id] ?? [];
      },
    },
    context: {
      runId,
      repo: { owner: 'example', repo: 'repo' },
    },
  };
}

test('ignores a newer queued duplicate from the same serialized workflow', async () => {
  const input = fixture({
    'production-live-trading-gate.yml': [{ id: 101, status: 'pending' }],
  });
  const result = await inspectProductionTradingGateConflicts({
    ...input,
    currentWorkflowId: 'production-live-trading-gate.yml',
    workflowIds: ['production-live-trading-gate.yml'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.ignoredNewerSameWorkflow, [{
    workflowId: 'production-live-trading-gate.yml',
    runId: 101,
    status: 'pending',
  }]);
});

test('still blocks an older active run in the same workflow', async () => {
  const input = fixture({
    'production-live-trading-gate.yml': [{ id: 99, status: 'waiting' }],
  });
  const result = await inspectProductionTradingGateConflicts({
    ...input,
    currentWorkflowId: 'production-live-trading-gate.yml',
    workflowIds: ['production-live-trading-gate.yml'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].runId, 99);
});

test('still blocks a newer active run from a different trading gate', async () => {
  const input = fixture({
    'production-live-trading-gate.yml': [],
    'production-automatic-trading-gate.yml': [{ id: 102, status: 'pending' }],
  });
  const result = await inspectProductionTradingGateConflicts({
    ...input,
    currentWorkflowId: 'production-live-trading-gate.yml',
    workflowIds: [
      'production-live-trading-gate.yml',
      'production-automatic-trading-gate.yml',
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].workflowId, 'production-automatic-trading-gate.yml');
});

test('never ignores an in-progress same-workflow run', async () => {
  const input = fixture({
    'production-live-trading-gate.yml': [{ id: 101, status: 'in_progress' }],
  });
  const result = await inspectProductionTradingGateConflicts({
    ...input,
    currentWorkflowId: 'production-live-trading-gate.yml',
    workflowIds: ['production-live-trading-gate.yml'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].status, 'in_progress');
});