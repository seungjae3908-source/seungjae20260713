import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.ts';
import { buildPortfolioIntelligence } from '../services/portfolio-intelligence.service.ts';

const router: IRouter = Router();

router.get('/portfolio/intelligence', async (req: AuthenticatedRequest, res) => {
  if (!req.accessToken) {
    return res.status(401).json({ ok: false, error: 'LOGIN_REQUIRED' });
  }
  try {
    const portfolio = await buildPortfolioIntelligence({
      accessToken: req.accessToken,
      profile: req.query.profile,
    });
    res.setHeader('Cache-Control', 'private, max-age=10, stale-while-revalidate=20');
    return res.json({ ok: true, portfolio });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'PORTFOLIO_INTELLIGENCE_FAILED';
    const readFailure = message.startsWith('PORTFOLIO_HOLDINGS_READ_FAILED:');
    return res.status(readFailure ? 503 : 500).json({
      ok: false,
      error: readFailure ? 'PORTFOLIO_HOLDINGS_UNAVAILABLE' : 'PORTFOLIO_INTELLIGENCE_FAILED',
      message: readFailure ? '포트폴리오 보유 데이터를 읽지 못했습니다.' : '포트폴리오 분석 데이터를 구성하지 못했습니다.',
    });
  }
});

export default router;
