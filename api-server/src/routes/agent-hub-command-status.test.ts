import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAgentHubCommandStatus } from './agent-hub-command-status';

const sourceCommentId = 6000000001;
const normalizedId = 6000000002;
const rootTaskId = `manual-${sourceCommentId}-APP_CONTROL_COMMAND`;

describe('Agent Hub app command status readback', () => {
  it('stays queued until canonical normalization evidence exists', () => {
    assert.deepEqual(resolveAgentHubCommandStatus(sourceCommentId, []), {
      executionState: 'QUEUED_FOR_COORDINATOR',
      normalizedCommentId: null,
      latestEvidenceCommentId: null,
      rootTaskId,
    });
  });

  it('binds normalization, command, and worker evidence to the exact source comment', () => {
    const normalized = `[WORKER_REPORT]\nroot_task_id: ${rootTaskId}\nstatus: partial\n<!-- agent-hub-manual-source:${sourceCommentId} -->`;
    const ready = `[HUB_COMMAND]\nsource_report_comment_id: ${normalizedId}\nstatus: ready`;
    const completed = `[WORKER_REPORT]\nroot_task_id: ${rootTaskId}\nstatus: completed\nsummary: done`;
    const result = resolveAgentHubCommandStatus(sourceCommentId, [
      { id: normalizedId + 2, body: completed },
      { id: normalizedId, body: normalized },
      { id: normalizedId + 1, body: ready },
    ]);
    assert.equal(result.executionState, 'COMPLETED');
    assert.equal(result.normalizedCommentId, normalizedId);
    assert.equal(result.latestEvidenceCommentId, normalizedId + 2);
  });

  it('does not accept another command lineage as evidence', () => {
    const normalized = `[WORKER_REPORT]\nroot_task_id: ${rootTaskId}\nstatus: partial\n<!-- agent-hub-manual-source:${sourceCommentId} -->`;
    const unrelatedReady = `[HUB_COMMAND]\nsource_report_comment_id: ${normalizedId + 99}\nstatus: ready`;
    const unrelatedCompleted = `[WORKER_REPORT]\nroot_task_id: manual-7-APP_CONTROL_COMMAND\nstatus: completed`;
    const result = resolveAgentHubCommandStatus(sourceCommentId, [
      { id: normalizedId, body: normalized },
      { id: normalizedId + 1, body: unrelatedReady },
      { id: normalizedId + 2, body: unrelatedCompleted },
    ]);
    assert.equal(result.executionState, 'NORMALIZED_FOR_COORDINATOR');
  });

  it('surfaces adapter blocking as fail-closed and rejects invalid source ids', () => {
    const blocked = resolveAgentHubCommandStatus(sourceCommentId, [
      { id: normalizedId, body: `[AUTO_LOOP_HANDOFF_BLOCKED]\n<!-- agent-hub-error:${sourceCommentId} -->` },
    ]);
    assert.equal(blocked.executionState, 'FAILED_CLOSED');
    assert.throws(() => resolveAgentHubCommandStatus(0, []), /INVALID_SOURCE_COMMENT_ID/u);
  });
});
