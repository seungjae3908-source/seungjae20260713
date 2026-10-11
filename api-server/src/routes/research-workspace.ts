import { Router, type IRouter } from 'express';
import { isAbsolute, resolve } from 'node:path';
import { requireAuthenticated, requireCapability, type AuthenticatedRequest } from '../middleware/auth';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import { createProviderReadinessHandler } from '../../../packages/external-research/src/research-workspace-providers-v8.js';
import { createResearchWorkerQueue } from '../../../packages/external-research/src/research-workspace-worker-v9.js';
import { readResearchOrchestratorStatusV10 } from '../../../packages/external-research/src/research-workspace-orchestrator-v10.js';
import { readResearchOneShotReviewV15 } from '../../../packages/external-research/src/research-workspace-one-shot-review-v15.js';
import { createStoredWorkspaceHandler } from '../../../packages/external-research/src/research-workspace-store-v2.js';
import { loadVideoResearchRuntimeEvidenceSnapshot, sanitizeVideoResearchRuntimeEvidence } from './video-research-source-evidence';
import {
  readResearchPITMinuteCoverageV1,
  type ResearchPITMarket,
} from '../../../market-prediction-lab/src/research-pit-minute-coverage-readonly-v1.js';

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
  router.all('/one-shot-review', async (req, res) => {
    res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Vary','Authorization, Cookie');res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'READ_ONLY'}); }
    const root = process.env.RESEARCH_WORKSPACE_ONE_SHOT_ROOT?.trim() ?? '';
    if (!root || !isAbsolute(root) || resolve(root) !== root) {
      return res.status(200).json({schemaVersion:'research-one-shot-review-v15',available:false,reason:'ONE_SHOT_ROOT_NOT_CONFIGURED'});
    }
    try { return res.status(200).json(await readResearchOneShotReviewV15(root)); }
    catch { return res.status(503).json({schemaVersion:'research-one-shot-review-v15',available:false,reason:'ONE_SHOT_REVIEW_UNAVAILABLE'}); }
  });
  // Research 1m original-source COVERAGE ONLY. This does not use the existing
  // POST /backtests/run engine, create Paper handoffs or touch trading routes.
  // The only file root is server env; browser query never accepts paths.
  router.all('/pit-minute-coverage', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Vary', 'Authorization, Cookie');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({
        error: 'READ_ONLY', executionAuthority: 'NONE',
      });
    }
    const query = req.query as Record<string, unknown>;
    const allowed = new Set([
      'market', 'startDate', 'endDate', 'cursorDate', 'chunkDays',
    ]);
    const market = query.market, startDate = query.startDate,
      endDate = query.endDate, cursorDate = query.cursorDate,
      chunkDaysInput = query.chunkDays;
    const markets = new Set<ResearchPITMarket>([
      'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
    ]);
    const dateMs = (value: unknown): number | null => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const ms = Date.parse(value + 'T00:00:00.000Z');
      return Number.isSafeInteger(ms)
        && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
    };
    const startMs = dateMs(startDate);
    const endMs = dateMs(endDate);
    const cursorMs = cursorDate == null ? null : dateMs(cursorDate);
    const chunkDays = chunkDaysInput == null ? 7 :
      typeof chunkDaysInput === 'string'
        && /^(?:[1-9]|[12][0-9]|3[01])$/.test(chunkDaysInput)
        ? Number(chunkDaysInput) : Number.NaN;
    if (Object.keys(query).some(key => !allowed.has(key))
      || typeof market !== 'string'
      || !markets.has(market as ResearchPITMarket)
      || typeof startDate !== 'string' || typeof endDate !== 'string'
      || (cursorDate != null && typeof cursorDate !== 'string')
      || startMs == null || endMs == null || startMs > endMs
      || (cursorDate != null && (
        cursorMs == null || cursorMs < startMs || cursorMs > endMs))
      || !Number.isSafeInteger(chunkDays) || chunkDays < 1 || chunkDays > 31) {
      return res.status(400).json({
        schemaVersion: 'research-pit-minute-coverage-readonly-v1',
        available: false, reason: 'INVALID_SELECTION',
        executionAuthority: 'NONE', profitabilityProven: false,
      });
    }
    const root = process.env.RESEARCH_PIT_MINUTE_COVERAGE_ROOT?.trim() ?? '';
    if (!root || !isAbsolute(root) || resolve(root) !== root) {
      return res.status(200).json({
        schemaVersion: 'research-pit-minute-coverage-readonly-v1',
        available: false, status: 'BLOCKED_DATA',
        reason: 'SERVER_REPORT_ROOT_NOT_CONFIGURED',
        providerGETCount: 0, financialMutationCount: 0,
        historicalPITUniverseIndependentlyAuthenticated: false,
        fullMarketOpportunityDenominatorVerified: false,
        trueMarketWideRecall: null, actualFillCount: null,
        profitabilityProven: false, executionAuthority: 'NONE',
        liveTrading: false, autoTrading: false, realOrders: false,
      });
    }
    try {
      const report = await readResearchPITMinuteCoverageV1({
        root, market: market as ResearchPITMarket,
        startDate, endDate,
        cursorDate: cursorDate == null ? null : cursorDate as string,
        chunkDays,
      });
      return res.status(200).json(report);
    } catch {
      // Never echo filesystem paths, parsing failures or raw source material.
      return res.status(503).json({
        schemaVersion: 'research-pit-minute-coverage-readonly-v1',
        available: false, status: 'BLOCKED_DATA',
        reason: 'PRIVATE_COMPACT_SOURCE_READ_OR_VALIDATION_FAILED',
        providerGETCount: 0, financialMutationCount: 0,
        trueMarketWideRecall: null, actualFillCount: null,
        profitabilityProven: false, executionAuthority: 'NONE',
      });
    }
  });
  // .all intentionally rejects HEAD and all write verbs before touching research files.
  router.all('/', (req, res) => { void read(req, res); });
  return router;
}
export default createResearchWorkspaceRouter();
