import { Router, type IRouter } from 'express';
import { requireAdmin } from '../middleware/auth';
import {
  getForwardShadowEvaluations,
  getForwardShadowStatus,
  getForwardShadowTrades,
  resetForwardShadow,
  runForwardShadowOnce,
} from '../services/bitget-forward-shadow.service';

const router: IRouter = Router();

router.get('/status', async (_req, res) => {
  return res.json({ ok: true, ...(await getForwardShadowStatus()) });
});

router.get('/evaluations', async (req, res) => {
  const limit = Number(req.query.limit ?? 500);
  const evaluations = await getForwardShadowEvaluations(Number.isFinite(limit) ? limit : 500);
  return res.json({
    ok: true,
    mode: 'FORWARD_SHADOW',
    realOrdersEnabled: false,
    evaluations,
    count: evaluations.length,
    updatedAt: new Date().toISOString(),
  });
});

router.get('/trades', async (req, res) => {
  const limit = Number(req.query.limit ?? 500);
  const trades = await getForwardShadowTrades(Number.isFinite(limit) ? limit : 500);
  return res.json({
    ok: true,
    mode: 'FORWARD_SHADOW',
    realOrdersEnabled: false,
    trades,
    count: trades.length,
    updatedAt: new Date().toISOString(),
  });
});

router.post('/run', requireAdmin, async (_req, res) => {
  try {
    const result = await runForwardShadowOnce();
    return res.json({
      ok: true,
      mode: 'FORWARD_SHADOW',
      realOrdersEnabled: false,
      result,
      status: await getForwardShadowStatus(),
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      mode: 'FORWARD_SHADOW',
      realOrdersEnabled: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post('/reset', requireAdmin, async (req, res) => {
  try {
    await resetForwardShadow(String(req.body?.confirmation ?? ''));
    return res.json({ ok: true, ...(await getForwardShadowStatus()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(message === 'OPEN_POSITION_EXISTS' ? 409 : 400).json({
      ok: false,
      mode: 'FORWARD_SHADOW',
      realOrdersEnabled: false,
      error: message,
    });
  }
});

export default router;
