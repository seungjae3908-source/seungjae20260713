import { Router, type IRouter, type Response } from 'express';
import {
  FuturesMarketDataError,
  getFuturesCandles,
  getFuturesMarketSnapshot,
  getFuturesMarketStatus,
} from '../services/futures-market-data.service';
import { getFuturesContractRules } from '../services/futures-contract-rules.service';

const router: IRouter = Router();

function sendError(res: Response, error: unknown) {
  if (error instanceof FuturesMarketDataError) {
    return res.status(error.statusCode).json({
      ok: false,
      code: error.code,
      message: error.message,
    });
  }
  return res.status(500).json({
    ok: false,
    code: 'FUTURES_MARKET_DATA_ERROR',
    message: '선물 시장 데이터를 처리하지 못했습니다.',
  });
}

router.use('/crypto/futures', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

router.get('/crypto/futures/status', async (_req, res) => {
  try {
    const [registry, probe] = await Promise.all([
      getFuturesMarketStatus(),
      getFuturesMarketSnapshot('BTCUSDT'),
    ]);
    return res.json({
      ...registry,
      status: probe.status,
      connection: probe.status,
      updatedAt: probe.updatedAt,
      warnings: [...new Set([...registry.warnings, ...probe.warnings])],
      publicDataOnly: true,
      orderCapability: false,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/crypto/futures/:symbol/snapshot', async (req, res) => {
  try {
    const data = await getFuturesMarketSnapshot(req.params.symbol);
    return res.json({ ok: true, data });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/crypto/futures/:symbol/contract-rules', async (req, res) => {
  try {
    const data = await getFuturesContractRules(req.params.symbol);
    return res.json({
      ok: true,
      publicDataOnly: true,
      orderCapability: false,
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/crypto/futures/:symbol/candles', async (req, res) => {
  try {
    const result = await getFuturesCandles({
      symbol: req.params.symbol,
      timeframe: req.query.timeframe ?? req.query.granularity ?? '15m',
      limit: req.query.limit ?? 200,
    });
    return res.json({
      ok: true,
      symbol: result.symbol,
      timeframe: result.timeframe,
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      updatedAt: result.updatedAt,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
