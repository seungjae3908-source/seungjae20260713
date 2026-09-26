import { Router, type IRouter } from 'express';
import { resolve } from 'node:path';
import { requireAuthenticated, requireCapability, type AuthenticatedRequest } from '../middleware/auth';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import { createProviderReadinessHandler } from '../../../packages/external-research/src/research-workspace-providers-v8.js';
import { createResearchWorkerQueue } from '../../../packages/external-research/src/research-workspace-worker-v9.js';
import { readResearchOrchestratorStatusV10 } from '../../../packages/external-research/src/research-workspace-orchestrator-v10.js';
import { createStoredWorkspaceHandler } from '../../../packages/external-research/src/research-workspace-store-v2.js';
import { loadVideoResearchRuntimeEvidenceSnapshot, sanitizeVideoResearchRuntimeEvidence } from './video-research-source-evidence';

/** Research results are admin-shared, not member/account records. No data root is accepted from HTTP. */
export function createResearchWorkspaceRouter(): IRouter {
  const router: IRouter = Router();
  const read = createStoredWorkspaceHandler({
    root: resolve(process.cwd(), 'data', 'research-workspace-v2'),
    authorize: async (req: AuthenticatedRequest) => Boolean(req.member && req.accessToken && hasCapability(req.member, 'canManageMembers')),
    loadSanitizedSnapshot: async () => {
      const raw = await loadVideoResearchRuntimeEvidenceSnapshot();
      if (raw == null) return null;
      const value = sanitizeVideoResearchRuntimeEvidence(raw);
      if (value === null) throw new Error('VIDEO_SNAPSHOT_INVALID');
      return value;
    },
  });
  router.use(requireAuthenticated, requireCapability('canManageMembers'));
  // The effective API process supplies configuration; clients never submit env data.
  const providers = createProviderReadinessHandler({
    authorize: async (req: AuthenticatedRequest) => Boolean(req.member && req.accessToken && hasCapability(req.member, 'canManageMembers')),
  });
  router.all('/providers', (req, res) => { void providers(req, res); });
  const workerRoot = resolve(process.cwd(), 'data', 'research-workspace-worker-v9');
  const workerQueue = createResearchWorkerQueue(workerRoot);
  router.all('/worker', async (req, res) => {
    res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Vary','Authorization, Cookie');res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'READ_ONLY'}); }
    try { return res.status(200).json(await workerQueue.status()); }
    catch { return res.status(503).json({schemaVersion:'research-worker-status-v9',available:false,reason:'WORKER_STATUS_UNAVAILABLE'}); }
  });
  router.all('/orchestrator', async (req, res) => {
    res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Vary','Authorization, Cookie');res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'READ_ONLY'}); }
    try { return res.status(200).json(await readResearchOrchestratorStatusV10(workerRoot)); }
    catch { return res.status(503).json({schemaVersion:'research-orchestrator-status-v10',available:false,reason:'ORCHESTRATOR_STATUS_UNAVAILABLE'}); }
  });
  // .all intentionally rejects HEAD and all write verbs before touching research files.
  router.all('/', (req, res) => { void read(req, res); });
  return router;
}
export default createResearchWorkspaceRouter();
