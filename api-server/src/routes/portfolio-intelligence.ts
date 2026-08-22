import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.ts';
import {
  buildMonthlyInvestmentPlan,
  simulateAdditionalInvestment,
} from '../modules/portfolio/index.ts';
import { buildPortfolioIntelligence } from '../services/portfolio-intelligence.service.ts';

const router: IRouter = Router();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function portfolioFailure(cause: unknown, res: Parameters<Parameters<IRouter['get']>[1]>[1]) {
  const message = cause instanceof Error ? cause.message : 'PORTFOLIO_INTELLIGENCE_FAILED';
  const readFailure = message.startsWith('PORTFOLIO_HOLDINGS_READ_FAILED:');
  return res.status(readFailure ? 503 : 500).json({
    ok: false,
    error: readFailure ? 'PORTFOLIO_HOLDINGS_UNAVAILABLE' : 'PORTFOLIO_INTELLIGENCE_FAILED',
    message: readFailure ? '포트폴리오 보유 데이터를 읽지 못했습니다.' : '포트폴리오 분석 데이터를 구성하지 못했습니다.',
  });
}

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
    return portfolioFailure(cause, res);
  }
});

router.post('/portfolio/intelligence/additional-buy', async (req: AuthenticatedRequest, res) => {
  if (!req.accessToken) return res.status(401).json({ ok: false, error: 'LOGIN_REQUIRED' });
  const body = asRecord(req.body);
  const ticker = String(body.ticker ?? '').trim().toUpperCase();
  const additionalAmountKRW = positiveNumber(body.additionalAmountKRW);
  const additionalQuantity = positiveNumber(body.additionalQuantity);
  if (!ticker || (additionalAmountKRW == null) === (additionalQuantity == null)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SIMULATION_INPUT', message: '종목과 추가 금액 또는 추가 수량 중 하나만 입력해 주세요.' });
  }

  try {
    const portfolio = await buildPortfolioIntelligence({ accessToken: req.accessToken });
    const holding = portfolio.holdings.find((row) => row.ticker === ticker);
    if (!holding) return res.status(404).json({ ok: false, error: 'HOLDING_NOT_FOUND' });

    const quantity = holding.quantity;
    const currentPositionValueKRW = holding.normalizedKRW;
    const currentCostKRW = holding.normalizedCostKRW;
    const portfolioValueKRW = portfolio.totalAssets.knownNormalizedKRW;
    const currentPriceKRW = currentPositionValueKRW != null && quantity > 0 ? currentPositionValueKRW / quantity : Number.NaN;
    const currentAveragePriceKRW = currentCostKRW != null && quantity > 0 ? currentCostKRW / quantity : Number.NaN;

    const result = simulateAdditionalInvestment({
      currentQuantity: quantity,
      currentAveragePrice: currentAveragePriceKRW,
      currentPrice: currentPriceKRW,
      currentPositionValueKRW: currentPositionValueKRW ?? Number.NaN,
      portfolioValueKRW,
      additionalAmountKRW: additionalAmountKRW ?? undefined,
      additionalQuantity: additionalQuantity ?? undefined,
      stopLoss: null,
      targets: [],
    });

    return res.json({
      ok: true,
      status: result.status,
      holding: {
        ticker: holding.ticker,
        name: holding.name,
        market: holding.market,
        nativeCurrency: holding.currency,
        currentAveragePriceNative: holding.averagePrice,
        currentPriceNative: holding.currentPrice,
        currentPositionValueKRW,
      },
      priceBasis: 'NORMALIZED_KRW',
      result,
      evidence: {
        stopLoss: 'UNAVAILABLE',
        targets: 'UNAVAILABLE',
        source: null,
      },
      safety: portfolio.safety,
    });
  } catch (cause) {
    return portfolioFailure(cause, res);
  }
});

router.post('/portfolio/intelligence/monthly-contribution', async (req: AuthenticatedRequest, res) => {
  if (!req.accessToken) return res.status(401).json({ ok: false, error: 'LOGIN_REQUIRED' });
  const body = asRecord(req.body);
  const monthlyAmountKRW = positiveNumber(body.monthlyAmountKRW);
  const monthsValue = positiveNumber(body.months);
  const months = monthsValue == null ? null : Math.floor(monthsValue);
  if (monthlyAmountKRW == null || months == null || months <= 0 || months > 120) {
    return res.status(400).json({ ok: false, error: 'INVALID_MONTHLY_PLAN_INPUT' });
  }

  try {
    const portfolio = await buildPortfolioIntelligence({
      accessToken: req.accessToken,
      profile: body.profile,
    });
    const allocation = Object.entries(portfolio.allocation.buckets)
      .filter((entry): entry is [string, number] => entry[1] != null && Number.isFinite(entry[1]) && entry[1] >= 0)
      .map(([key, weight]) => ({ key, weight: weight / 100 }));
    const plan = buildMonthlyInvestmentPlan({ monthlyAmountKRW, months, allocation });

    return res.json({
      ok: true,
      status: plan ? portfolio.allocation.status : 'UNAVAILABLE',
      plan,
      assumption: 'NO_VALIDATED_RETURN_ASSUMPTION',
      unavailableOutputs: ['FUTURE_RETURN', 'FUTURE_ASSET_VALUE', 'EXPECTED_CAGR'],
      safety: portfolio.safety,
    });
  } catch (cause) {
    return portfolioFailure(cause, res);
  }
});

export default router;
