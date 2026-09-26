import { Router, type IRouter } from 'express';
import { resolve } from 'node:path';
import { requireAuthenticated, requireCapability, type AuthenticatedRequest } from '../middleware/auth';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import { createProviderReadinessHandler } from '../../../packages/external-research/src/research-workspace-providers-v8.js';
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
  // .all intentionally rejects HEAD and all write verbs before touching research files.
  router.all('/', (req, res) => { void read(req, res); });
  return router;
}
export default createResearchWorkspaceRouter();
