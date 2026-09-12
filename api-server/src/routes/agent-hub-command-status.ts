export type AgentHubCommandExecutionState =
  | 'QUEUED_FOR_COORDINATOR'
  | 'NORMALIZED_FOR_COORDINATOR'
  | 'READY_FOR_EXECUTOR'
  | 'IN_PROGRESS'
  | 'WAITING_APPROVAL'
  | 'NEEDS_CONTEXT'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED_CLOSED';

export type AgentHubComment = {
  id?: unknown;
  body?: unknown;
};

export type AgentHubCommandStatus = {
  executionState: AgentHubCommandExecutionState;
  normalizedCommentId: number | null;
  latestEvidenceCommentId: number | null;
  rootTaskId: string;
};

function commentId(comment: AgentHubComment) {
  return typeof comment.id === 'number' && Number.isSafeInteger(comment.id) && comment.id > 0
    ? comment.id
    : 0;
}

function commentBody(comment: AgentHubComment) {
  return typeof comment.body === 'string' ? comment.body : '';
}

function parseFields(body: string) {
  const fields: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('[') || line.startsWith('<!--') || !line.includes(':')) continue;
    const index = line.indexOf(':');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key && !(key in fields)) fields[key] = value;
  }
  return fields;
}

function reportState(status: string): AgentHubCommandExecutionState | null {
  switch (status.trim().toLowerCase()) {
    case 'completed': return 'COMPLETED';
    case 'failed': return 'FAILED_CLOSED';
    case 'blocked': return 'BLOCKED';
    case 'waiting_approval': return 'WAITING_APPROVAL';
    case 'partial': return 'IN_PROGRESS';
    case 'stale': return 'NEEDS_CONTEXT';
    case 'expired': return 'BLOCKED';
    default: return null;
  }
}

function commandState(status: string): AgentHubCommandExecutionState | null {
  switch (status.trim().toLowerCase()) {
    case 'ready': return 'READY_FOR_EXECUTOR';
    case 'waiting_approval': return 'WAITING_APPROVAL';
    case 'needs_context': return 'NEEDS_CONTEXT';
    case 'blocked': return 'BLOCKED';
    default: return null;
  }
}

export function applyAgentHubEvidenceWindow(
  status: AgentHubCommandStatus,
  evidenceWindowComplete: boolean,
): AgentHubCommandStatus {
  return evidenceWindowComplete
    ? status
    : { ...status, executionState: 'NEEDS_CONTEXT' };
}

export function resolveAgentHubCommandStatus(
  sourceCommentId: number,
  comments: AgentHubComment[],
): AgentHubCommandStatus {
  if (!Number.isSafeInteger(sourceCommentId) || sourceCommentId <= 0) {
    throw new Error('INVALID_SOURCE_COMMENT_ID');
  }

  const rootTaskId = `manual-${sourceCommentId}-APP_CONTROL_COMMAND`;
  const normalizedMarker = `<!-- agent-hub-manual-source:${sourceCommentId} -->`;
  const errorMarker = `<!-- agent-hub-error:${sourceCommentId} -->`;
  const ordered = [...comments].sort((a, b) => commentId(a) - commentId(b));

  let executionState: AgentHubCommandExecutionState = 'QUEUED_FOR_COORDINATOR';
  let normalizedCommentId: number | null = null;
  let latestEvidenceCommentId: number | null = null;

  for (const comment of ordered) {
    const id = commentId(comment);
    const body = commentBody(comment);
    if (!id || !body) continue;

    if (body.includes(errorMarker)) {
      executionState = 'FAILED_CLOSED';
      latestEvidenceCommentId = id;
      continue;
    }

    if (body.includes(normalizedMarker)) {
      normalizedCommentId = id;
      executionState = 'NORMALIZED_FOR_COORDINATOR';
      latestEvidenceCommentId = id;
      continue;
    }

    if (!normalizedCommentId) continue;
    const fields = parseFields(body);

    if (
      body.includes('[HUB_COMMAND]') &&
      fields.source_report_comment_id === String(normalizedCommentId)
    ) {
      const state = commandState(fields.status ?? '');
      if (state) {
        executionState = state;
        latestEvidenceCommentId = id;
      }
      continue;
    }

    if (body.includes('[WORKER_REPORT]') && fields.root_task_id === rootTaskId) {
      const state = reportState(fields.status ?? '');
      if (state) {
        executionState = state;
        latestEvidenceCommentId = id;
      }
    }
  }

  return { executionState, normalizedCommentId, latestEvidenceCommentId, rootTaskId };
}
