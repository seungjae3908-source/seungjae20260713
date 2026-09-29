import { Router } from 'express';
import { requireAdmin, requireAuthenticated, type AuthenticatedRequest } from '../middleware/auth';
import {
  AGENT_HUB_ISSUE,
  AGENT_HUB_REPOSITORY,
  buildAgentHubWorkerReport,
  normalizeWorkerHint,
  sanitizeAgentHubCommand,
} from './agent-hub-control-contract';

const router = Router();
router.use(requireAuthenticated, requireAdmin);

async function githubRequest(path: string, init?: RequestInit) {
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
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GITHUB_${response.status}`);
  return payload as Record<string, unknown>;
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
    const branch = await githubRequest(`/repos/${AGENT_HUB_REPOSITORY}/branches/main`);
    const commit = branch.commit as Record<string, unknown> | undefined;
    const currentMainSha = typeof commit?.sha === 'string' ? commit.sha : '';
    if (!/^[0-9a-f]{40}$/.test(currentMainSha)) {
      return res.status(503).json({ ok: false, error: 'AGENT_HUB_MAIN_SHA_UNAVAILABLE' });
    }

    const body = buildAgentHubWorkerReport({
      command,
      workerHint,
      currentMainSha,
      requestedBy: req.member?.id ?? 'admin',
    });
    const created = await githubRequest(`/repos/${AGENT_HUB_REPOSITORY}/issues/${AGENT_HUB_ISSUE}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
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
