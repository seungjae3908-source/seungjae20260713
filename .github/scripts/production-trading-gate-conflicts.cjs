'use strict';

const ACTIVE_GATE_STATES = Object.freeze([
  'requested',
  'queued',
  'pending',
  'waiting',
  'in_progress',
]);

const NON_EXECUTING_SAME_WORKFLOW_STATES = new Set([
  'requested',
  'queued',
  'pending',
]);

async function inspectProductionTradingGateConflicts({
  github,
  context,
  currentWorkflowId,
  workflowIds,
  eventByWorkflow = {},
}) {
  const currentRunId = Number(context?.runId);
  if (!Number.isSafeInteger(currentRunId) || currentRunId <= 0) {
    throw new Error('PRODUCTION_TRADING_GATE_CURRENT_RUN_ID_INVALID');
  }
  if (!currentWorkflowId || !Array.isArray(workflowIds) || workflowIds.length === 0) {
    throw new Error('PRODUCTION_TRADING_GATE_WORKFLOW_SCOPE_INVALID');
  }

  const activeStates = new Set(ACTIVE_GATE_STATES);
  const conflicts = [];
  const ignoredNewerSameWorkflow = [];

  for (const workflowId of workflowIds) {
    const event = Object.prototype.hasOwnProperty.call(eventByWorkflow, workflowId)
      ? eventByWorkflow[workflowId]
      : 'issue_comment';
    const request = {
      owner: context.repo.owner,
      repo: context.repo.repo,
      workflow_id: workflowId,
      per_page: 30,
    };
    if (event) request.event = event;
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, request);

    for (const run of runs) {
      const runId = Number(run?.id);
      const status = String(run?.status ?? '');
      if (!Number.isSafeInteger(runId) || runId === currentRunId || !activeStates.has(status)) continue;

      const isSameWorkflow = workflowId === currentWorkflowId;
      const isNewer = runId > currentRunId;
      if (isSameWorkflow && isNewer && NON_EXECUTING_SAME_WORKFLOW_STATES.has(status)) {
        ignoredNewerSameWorkflow.push({ workflowId, runId, status });
        continue;
      }

      conflicts.push({ workflowId, runId, status });
    }
  }

  return {
    ok: conflicts.length === 0,
    conflicts,
    ignoredNewerSameWorkflow,
  };
}

module.exports = {
  ACTIVE_GATE_STATES,
  inspectProductionTradingGateConflicts,
};