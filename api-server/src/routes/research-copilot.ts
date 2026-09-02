import { Router, type IRouter } from 'express';
import { requireAdmin, requireAuthenticated, type AuthenticatedRequest } from '../middleware/auth';
import { createResearchCopilotService, validateCopilotDsl, type ResearchCopilotService } from '../services/research-copilot.service';
import { ResearchDualFreeAiError } from '../services/research-dual-free-ai.service';
import type { CopilotTask } from '../services/research-copilot.contract';
import { ResearchBundleService } from '../services/research-bundle.service';
import { createResearchBundleFileStore } from '../services/research-bundle-file-store.service';
import { validateResearchSameCandidatePrewire } from '../services/research-same-candidate-prewire.service';

export function configuredResearchBundleService(stateRoot = process.env.RESEARCH_BUNDLE_STATE_ROOT): ResearchBundleService {
  return new ResearchBundleService(stateRoot ? createResearchBundleFileStore(stateRoot) : {});
}

export function createResearchCopilotRouter(service: ResearchCopilotService = createResearchCopilotService(), bundles = configuredResearchBundleService()): IRouter {
  const router: IRouter = Router();
  router.use(requireAuthenticated, requireAdmin);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    try { res.json(await service.snapshot(controller.signal)); }
    catch { res.status(503).json({ status: 'blocked', error: 'RESEARCH_SOURCE_UNAVAILABLE', executionAuthority: 'NONE' }); }
    finally { req.off('aborted', abort); }
  });
  router.post('/validate-dsl', async (req, res) => {
    if (JSON.stringify(req.body ?? null).length > 32_000) return res.status(413).json({ status: 'blocked', error: 'DSL_TOO_LARGE' });
    return res.json({ ...validateCopilotDsl(req.body), bundle: await bundles.resolve(req.body) });
  });
  router.post('/resolve-bundle', async (req, res) => {
    if (JSON.stringify(req.body ?? null).length > 32_000) return res.status(413).json({ error: 'DSL_TOO_LARGE' });
    return res.json(await bundles.resolve(req.body));
  });
  router.post('/submit-backtest', async (req: AuthenticatedRequest, res) => {
    if (!req.member) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    if (JSON.stringify(req.body ?? null).length > 33_000) return res.status(413).json({ error: 'RESEARCH_SUBMISSION_TOO_LARGE' });
    return res.json(await bundles.submit(req.member.id, req.body));
  });
  router.post('/read-backtest', async (req, res) => {
    if (JSON.stringify(req.body ?? null).length > 33_000) return res.status(413).json({ error: 'RESEARCH_READBACK_TOO_LARGE' });
    return res.json(await bundles.readback(req.body));
  });
  router.post('/prewire-same-candidate', async (req, res) => {
    if (JSON.stringify(req.body ?? null).length > 64_000) return res.status(413).json({ error: 'RESEARCH_PREWIRE_INPUT_TOO_LARGE' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'INVALID_RESEARCH_PREWIRE_INPUT' });
    const input = body as Record<string, unknown>;
    if (Object.keys(input).sort().join(',') !== 'researchReadback,stages') return res.status(400).json({ error: 'INVALID_RESEARCH_PREWIRE_INPUT' });
    const publication = await bundles.readback(input.researchReadback);
    return res.json(validateResearchSameCandidatePrewire(publication, input.stages));
  });
  router.post('/review', async (req: AuthenticatedRequest, res) => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'INVALID_RESEARCH_INPUT' });
    const row = body as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.task !== 'string' || typeof row.evidenceDigest !== 'string') return res.status(400).json({ error: 'INVALID_RESEARCH_INPUT' });
    try {
      if (!req.member) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
      const result = await service.review(req.member.id, row.task as CopilotTask, row.evidenceDigest);
      return res.json(result);
    } catch (cause) {
      const code = cause instanceof ResearchDualFreeAiError ? cause.code : 'AI_RESEARCH_UNAVAILABLE';
      const status = code === 'EVIDENCE_CHANGED' ? 409 : code === 'INVALID_RESEARCH_INPUT' ? 400 : code === 'RESEARCH_AI_BUSY' ? 429 : 503;
      return res.status(status).json({ status: 'blocked', error: code, executionAuthority: 'NONE', paidFallback: false });
    }
  });
  return router;
}
export default createResearchCopilotRouter();