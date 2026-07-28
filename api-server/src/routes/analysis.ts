// 3차 작업 신규 라우터: 시그널 스캔 / 차트 신호 / AI 차트 플랜 / 시장 분석.
// 기존 routes/market.ts 는 수정하지 않는다. 주문/자동매매 코드는 호출하지 않는다.

import { Router, type IRouter } from 'express';
import { requireMember, requireFullMember } from '../middleware/auth';
import { getSignalScan } from '../services/analysis/signal-scan.service';
import { getChartSignals } from '../services/analysis/chart-signals.service';
import { getAiChartPlan } from '../services/analysis/ai-chart-plan.service';
import { getMarketAnalysis } from '../services/analysis/market-analysis.service';

const router: IRouter = Router();

function normalizeAsset(value: unknown): 'stock' | 'coin' {
  return String(value ?? 'stock').toLowerCase() === 'coin' ? 'coin' : 'stock';
}

// 1) 시그널 스캔
// futures 시장만 정회원(futures 권한) 게이트, 나머지는 로그인 게이트(requireMember).
router.get('/market/signal-scan', requireMember, async (req, res, next) => {
  const asset = normalizeAsset(req.query.asset);
  const rawMarket = String(req.query.market ?? '').toLowerCase();

  if (asset === 'coin' && rawMarket === 'futures') {
    // 정회원(futures) 게이트: 기존 crypto futures 라우트 게이트 패턴 재사용.
    return requireFullMember(req as any, res, async () => {
      try {
        const result = await getSignalScan('coin', 'futures');
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    });
  }

  try {
    let market: string;
    if (asset === 'stock') {
      market = rawMarket === 'us' ? 'US' : 'KR';
    } else {
      market = rawMarket === 'futures' ? 'futures' : 'spot';
    }
    const result = await getSignalScan(asset, market);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// 2) 차트 신호 (실시간 재계산)
router.get('/market/chart-signals', requireMember, async (req, res, next) => {
  const asset = normalizeAsset(req.query.asset);
  const coinMarket = String(req.query.coinMarket ?? 'spot').toLowerCase();
  const symbol = String(req.query.symbol ?? '').trim();
  const interval = String(req.query.interval ?? '1D').trim();

  if (!symbol) {
    return res.status(400).json({ ok: false, error: 'SYMBOL_REQUIRED', message: '해당 종목 없음' });
  }

  // 코인 선물 차트 신호는 정회원(futures) 게이트. 정회원만 선물 소스 사용 허용(allowFutures).
  if (asset === 'coin' && coinMarket === 'futures') {
    return requireFullMember(req as any, res, async () => {
      try {
        const result = await getChartSignals('coin', 'futures', symbol, interval, { allowFutures: true });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    });
  }

  try {
    // 비정회원 경로: 선물 소스 폴백 금지(allowFutures=false).
    const result = await getChartSignals(asset, coinMarket, symbol, interval, { allowFutures: false });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// 3) AI 차트 플랜 (조회 전용)
router.get('/market/ai-chart-plan', requireMember, async (req, res, next) => {
  const asset = normalizeAsset(req.query.asset);
  const coinMarket = String(req.query.coinMarket ?? 'spot').toLowerCase();
  const symbol = String(req.query.symbol ?? '').trim();
  const interval = String(req.query.interval ?? '1D').trim();

  if (!symbol) {
    return res.status(400).json({ ok: false, error: 'SYMBOL_REQUIRED', message: '해당 종목 없음' });
  }

  // 코인 선물 AI 플랜은 정회원(futures) 게이트. 정회원만 선물 소스 사용 허용(allowFutures).
  if (asset === 'coin' && coinMarket === 'futures') {
    return requireFullMember(req as any, res, async () => {
      try {
        const result = await getAiChartPlan('coin', 'futures', symbol, interval, { allowFutures: true });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    });
  }

  try {
    // 비정회원 경로: 선물 소스 폴백 금지(allowFutures=false).
    const result = await getAiChartPlan(asset, coinMarket, symbol, interval, { allowFutures: false });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

// 4) 시장 분석 (kr / us / coin)
router.get('/market/analysis/kr', requireMember, async (_req, res, next) => {
  try {
    return res.json(await getMarketAnalysis('kr'));
  } catch (error) {
    return next(error);
  }
});

router.get('/market/analysis/us', requireMember, async (_req, res, next) => {
  try {
    return res.json(await getMarketAnalysis('us'));
  } catch (error) {
    return next(error);
  }
});

router.get('/market/analysis/coin', requireMember, async (_req, res, next) => {
  try {
    return res.json(await getMarketAnalysis('coin'));
  } catch (error) {
    return next(error);
  }
});

export default router;
