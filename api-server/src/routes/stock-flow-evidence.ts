import { Router, type IRouter } from 'express';
import {
  loadStockFlowEvidence,
  StockFlowEvidenceError,
  type StockFlowMarket,
} from '../services/scanner-stock-flow-evidence.service';

const router: IRouter = Router();

router.get('/', async (req, res) => {
  const market = String(req.query.market ?? '').trim().toUpperCase();
  const symbol = String(req.query.symbol ?? '').trim();
  if (market !== 'KR' && market !== 'US') {
    return res.status(400).json({ ok: false, error: 'STOCK_FLOW_MARKET_UNSUPPORTED' });
  }
  try {
    const evidence = await loadStockFlowEvidence({ market: market as StockFlowMarket, symbol });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      ok: true,
      evidence,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  } catch (cause) {
    if (cause instanceof StockFlowEvidenceError) {
      return res.status(cause.code === 'STOCK_FLOW_INVALID_SYMBOL' ? 400 : 502).json({
        ok: false,
        error: cause.code,
        message: cause.message,
        orderSubmitted: false,
        exchangeRequestSent: false,
      });
    }
    return res.status(502).json({
      ok: false,
      error: 'STOCK_FLOW_PROVIDER_ERROR',
      message: '주식 수급 근거를 확인하지 못했습니다.',
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
});

export default router;
