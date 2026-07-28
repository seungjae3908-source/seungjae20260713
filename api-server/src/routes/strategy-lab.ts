import { Router } from 'express';
import { requireMember } from '../middleware/auth';
import { runRepeatedBacktest } from '../services/strategy-lab.service';

const router = Router();
router.use(requireMember);

router.post('/strategy-lab/backtest', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(runRepeatedBacktest({
      bars: req.body?.bars,
      feePct: req.body?.feePct,
      slippagePct: req.body?.slippagePct,
      maxRuns: req.body?.maxRuns,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'BACKTEST_FAILED';
    return res.status(message === 'BACKTEST_REQUIRES_120_BARS' ? 400 : 500).json({
      ok: false,
      simulationOnly: true,
      realOrdersBlocked: true,
      error: message,
    });
  }
});

// 실제 주문 엔드포인트가 아님을 명시하며 어떤 주문 요청도 거부합니다.
router.all('/strategy-lab/order', (_req, res) => res.status(405).json({
  ok: false,
  simulationOnly: true,
  realOrdersBlocked: true,
  error: 'REAL_ORDER_NOT_SUPPORTED',
}));

export default router;
