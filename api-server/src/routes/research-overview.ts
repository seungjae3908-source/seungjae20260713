import { Router, type RequestHandler } from 'express';
import { sanitizeResearchCenterOverview } from '../services/research-center-readonly-contract.service';
import { createRuleValidationHandler } from './research-rule-validation';

const URL = 'http://127.0.0.1:18090/api/research/overview';
export const createResearchOverviewHandler = (read: typeof fetch = fetch): RequestHandler => async (_req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Authorization, Cookie');
  try {
    const upstream = await read(URL, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    const payload = upstream.ok ? sanitizeResearchCenterOverview(await upstream.json()) : null;
    if (!payload) return void res.status(503).json({ error: 'RESEARCH_DASHBOARD_UNAVAILABLE', message: '연구 상태를 불러오지 못했습니다.' });
    // Shared research only: the sanitizer rejects private paths/credentials and
    // whitelists the evidence fields. No account, member, or order data is read.
    res.json(payload);
  } catch {
    res.status(503).json({ error: 'RESEARCH_DASHBOARD_UNAVAILABLE', message: '연구 상태를 불러오지 못했습니다.' });
  } finally {
    clearTimeout(timeout);
  }
};
const router = Router();
router.get('/overview', createResearchOverviewHandler());
router.get('/rule-validation', createRuleValidationHandler());
export default router;
