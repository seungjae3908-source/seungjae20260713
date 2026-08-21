import { Router, type IRouter } from 'express';
import { CoinSpecialFeedService, type CoinSpecialFeedMarket } from '../services/coin-special-feed.service';

const router: IRouter = Router();

router.get('/', async (req, res, next) => {
  const asset = String(req.query.asset ?? 'stock').trim().toLowerCase();
  if (asset !== 'coin') {
    next();
    return;
  }

  const market: CoinSpecialFeedMarket = String(req.query.market ?? 'spot').trim().toLowerCase() === 'futures'
    ? 'futures'
    : 'spot';
  const requestedLimit = Number(req.query.limit ?? 120);
  const limit = Math.max(1, Math.min(120, Math.trunc(requestedLimit) || 120));

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const result = await CoinSpecialFeedService.getFeed(market, limit);
    return res.status(200).json(result);
  } catch (error) {
    console.error('coin special feed error:', error);
    return res.status(200).json({
      ok: false,
      asset: 'coin',
      market,
      items: [],
      count: 0,
      catalogSize: 0,
      scannedNow: 0,
      updatedAt: new Date().toISOString(),
      message: market === 'spot'
        ? '업비트 공개 특이정보 데이터를 불러오지 못했습니다.'
        : '비트겟 공개 특이정보 데이터를 불러오지 못했습니다.',
      error: market === 'spot'
        ? 'UPBIT_SPECIAL_FEED_UNAVAILABLE'
        : 'BITGET_SPECIAL_FEED_UNAVAILABLE',
    });
  }
});

export default router;
