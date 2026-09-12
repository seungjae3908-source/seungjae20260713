import { Router } from 'express';
import { requireAdmin, requireAuthenticated, type AuthenticatedRequest } from '../middleware/auth';
import {
  AGENT_HUB_ISSUE,
  AGENT_HUB_REPOSITORY,
  buildAgentHubWorkerReport,
  normalizeWorkerHint,
  sanitizeAgentHubCommand,
} from './agent-hub-control-contract';
import { resolveAgentHubCommandStatus, type AgentHubComment } from './agent-hub-command-status';

const router = Router();
const STATUS_PAGE_SIZE = 100;
const STATUS_PAGE_LIMIT = 3;
router.use(requireAuthenticated, requireAdmin);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function githubRequest(path: string, init?: RequestInit): Promise<unknown> {
  const credential = process.env.AGENT_HUB_GITHUB_TOKEN?.trim();
  if (!credential) throw new Error('NOT_CONFIGURED');
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${credential}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GITHUB_${response.status}`);
  return payload;
}

router.get('/status', (req: AuthenticatedRequest, res) => {
  const configured = Boolean(process.env.AGENT_HUB_GITHUB_TOKEN?.trim());
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.json({
    ok: true,
    configured,
    executionState: configured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    repository: AGENT_HUB_REPOSITORY,
    hubIssue: AGENT_HUB_ISSUE,
    authority: 'NONE',
    liveTrading: false,
    privateTradingApi: false,
    paidFallback: false,
    requestedBy: req.member?.id ?? null,
  });
});

router.get('/commands/:commentId/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!process.env.AGENT_HUB_GITHUB_TOKEN?.trim()) {
    return res.status(503).json({
      ok: false,
      error: 'AGENT_HUB_BRIDGE_NOT_CONFIGURED',
      executionState: 'NOT_CONFIGURED',
    });
  }

  const rawCommentId = String(req.params.commentId ?? '').trim();
  if (!/^[1-9][0-9]{0,18}$/u.test(rawCommentId)) {
    return res.status(400).json({ ok: false, error: 'INVALID_AGENT_HUB_COMMENT_ID' });
  }
  const sourceCommentId = Number(rawCommentId);
  if (!Number.isSafeInteger(sourceCommentId)) {
    return res.status(400).json({ ok: false, error: 'INVALID_AGENT_HUB_COMMENT_ID' });
  }

  try {
    const source = asRecord(await githubRequest(`/repos/${AGENT_HUB_REPOSITORY}/issues/comments/${sourceCommentId}`));
    const sourceBody = typeof source.body === 'string' ? source.body : '';
    const sourceIssueUrl = typeof source.issue_url === 'string' ? source.issue_url : '';
    const sourceCreatedAt = typeof source.created_at === 'string' ? source.created_at : '';
    if (
      !sourceIssueUrl.endsWith(`/issues/${AGENT_HUB_ISSUE}`) ||
      !sourceBody.startsWith('[WORKER_REPORT][APP_CONTROL_COMMAND]') ||
      !sourceCreatedAt
    ) {
      return res.status(404).json({ ok: false, error: 'AGENT_HUB_COMMAND_NOT_FOUND' });
    }

    const comments: AgentHubComment[] = [];
    let evidenceWindowComplete = true;
    const since = encodeURIComponent(sourceCreatedAt);
    for (let page = 1; page <= STATUS_PAGE_LIMIT; page += 1) {
      const payload = await githubRequest(
        `/repos/${AGENT_HUB_REPOSITORY}/issues/${AGENT_HUB_ISSUE}/comments?per_page=${STATUS_PAGE_SIZE}&page=${page}&since=${since}`,
      );
      if (!Array.isArray(payload)) throw new Error('GITHUB_COMMENT_LIST_INVALID');
      comments.push(...payload.map((item) => asRecord(item)));
      if (payload.length < STATUS_PAGE_SIZE) break;
      if (page === STATUS_PAGE_LIMIT) evidenceWindowComplete = false;
    }

    const status = resolveAgentHubCommandStatus(sourceCommentId, comments);
    const executionState = evidenceWindowComplete ? status.executionState : 'NEEDS_CONTEXT';
    return res.json({
      ok: true,
      configured: true,
      commentId: sourceCommentId,
      executionState,
      normalizedCommentId: status.normalizedCommentId,
      latestEvidenceCommentId: status.latestEvidenceCommentId,
      evidenceWindowComplete,
      repository: AGENT_HUB_REPOSITORY,
      hubIssue: AGENT_HUB_ISSUE,
      authority: 'NONE',
      liveTrading: false,
      privateTradingApi: false,
    });
  } catch (cause) {
    return res.status(502).json({
      ok: false,
      error: 'AGENT_HUB_STATUS_READBACK_FAILED',
      reason: cause instanceof Error ? cause.message : 'UNKNOWN',
      executionState: 'FAILED_CLOSED',
    });
  }
});

router.post('/commands', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!process.env.AGENT_HUB_GITHUB_TOKEN?.trim()) {
    return res.status(503).json({
      ok: false,
      error: 'AGENT_HUB_BRIDGE_NOT_CONFIGURED',
      executionState: 'NOT_CONFIGURED',
    });
  }

  const command = sanitizeAgentHubCommand(req.body?.command);
  if (!command) return res.status(400).json({ ok: false, error: 'INVALID_AGENT_HUB_COMMAND' });
  const workerHint = normalizeWorkerHint(req.body?.workerHint);

  try {
    const branch = asRecord(await githubRequest(`/repos/${AGENT_HUB_REPOSITORY}/branches/main`));
    const commit = asRecord(branch.commit);
    const currentMainSha = typeof commit.sha === 'string' ? commit.sha : '';
    if (!/^[0-9a-f]{40}$/.test(currentMainSha)) {
      return res.status(503).json({ ok: false, error: 'AGENT_HUB_MAIN_SHA_UNAVAILABLE' });
    }

    const body = buildAgentHubWorkerReport({
      command,
      workerHint,
      currentMainSha,
      requestedBy: req.member?.id ?? 'admin',
    });
    const created = asRecord(await githubRequest(`/repos/${AGENT_HUB_REPOSITORY}/issues/${AGENT_HUB_ISSUE}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }));
    const commentId = typeof created.id === 'number' ? created.id : null;
    if (!commentId) return res.status(502).json({ ok: false, error: 'AGENT_HUB_COMMENT_ID_MISSING' });

    return res.status(202).json({
      ok: true,
      accepted: true,
      executionState: 'QUEUED_FOR_COORDINATOR',
      repository: AGENT_HUB_REPOSITORY,
      hubIssue: AGENT_HUB_ISSUE,
      commentId,
      currentMainSha,
      workerHint,
      authority: 'NONE',
    });
  } catch (cause) {
    return res.status(502).json({
      ok: false,
      error: 'AGENT_HUB_GITHUB_BRIDGE_FAILED',
      reason: cause instanceof Error ? cause.message : 'UNKNOWN',
      executionState: 'FAILED_CLOSED',
    });
  }
});

export default router;
