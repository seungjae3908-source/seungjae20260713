import { Router, type IRouter } from 'express';
import {
  clearKiwoomTokenCache,
  getKiwoomDomesticOrderbook,
  getKiwoomRankings,
  getKiwoomStatus,
  getKiwoomToken,
  kiwoomRequest,
  type KiwoomMarket,
  type KiwoomRankingType,
} from '../providers/kiwoom';

const router: IRouter = Router();

function marketParam(value: unknown): KiwoomMarket {
  return String(value ?? '').toUpperCase() === 'US' ? 'US' : 'KR';
}

function rankingTypeParam(value: unknown): KiwoomRankingType {
  const normalized = String(value ?? 'volume');
  if (normalized === 'tradingValue') return 'tradingValue';
  if (normalized === 'gainers') return 'gainers';
  if (normalized === 'losers') return 'losers';
  return 'volume';
}

router.get('/status', (_req, res) => {
  res.json({ ok: true, ...getKiwoomStatus() });
});

router.get('/token-test', async (_req, res) => {
  try {
    const token = await getKiwoomToken();
    res.json({
      ok: true,
      provider: 'kiwoom',
      message: '키움 접근토큰 발급 성공',
      tokenReceived: Boolean(token),
      tokenLength: token.length,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      provider: 'kiwoom',
      error: error instanceof Error ? error.message : '키움 토큰 발급 실패',
    });
  }
});

router.get('/test', async (_req, res) => {
  try {
    const data = await getKiwoomDomesticOrderbook('005930');
    res.json({
      ok: true,
      provider: 'kiwoom',
      market: 'KR',
      ticker: '005930',
      name: '삼성전자',
      data,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      provider: 'kiwoom',
      error: error instanceof Error ? error.message : '키움 조회 실패',
    });
  }
});

router.get('/quote/:ticker', async (req, res) => {
  try {
    const ticker = String(req.params.ticker ?? '').trim().toUpperCase();
    const data = await getKiwoomDomesticOrderbook(ticker);
    res.json({ ok: true, provider: 'kiwoom', market: 'KR', ticker, data });
  } catch (error) {
    res.status(500).json({
      ok: false,
      provider: 'kiwoom',
      ticker: String(req.params.ticker ?? ''),
      error: error instanceof Error ? error.message : '키움 종목 조회 실패',
    });
  }
});

router.get('/rankings', async (req, res) => {
  const market = marketParam(req.query.market);
  const type = rankingTypeParam(req.query.type);
  const limit = Number(req.query.limit ?? 30);

  try {
    const rows = await getKiwoomRankings(market, type, limit);
    res.json({
      ok: true,
      provider: 'kiwoom',
      market,
      type,
      rows,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      provider: 'kiwoom',
      market,
      type,
      rows: [],
      error: error instanceof Error ? error.message : '키움 랭킹 조회 실패',
    });
  }
});

/**
 * Diagnostic endpoint. It returns a raw ranking response but never returns
 * credentials or the OAuth token.
 */
router.get('/raw-ranking', async (req, res) => {
  const market = marketParam(req.query.market);
  const type = rankingTypeParam(req.query.type);

  try {
    const request =
      market === 'KR'
        ? type === 'volume'
          ? {
              apiId: 'ka10030',
              path: '/api/dostk/rkinfo',
              body: {
                mrkt_tp: '000',
                sort_tp: '1',
                mang_stk_incls: '0',
                crd_tp: '0',
                trde_qty_tp: '0',
                pric_tp: '0',
                trde_prica_tp: '0',
                mrkt_open_tp: '0',
                stex_tp: '1',
              },
            }
          : type === 'tradingValue'
            ? {
                apiId: 'ka10032',
                path: '/api/dostk/rkinfo',
                body: { mrkt_tp: '000', mang_stk_incls: '0', stex_tp: '1' },
              }
            : {
                apiId: 'ka10027',
                path: '/api/dostk/rkinfo',
                body: {
                  mrkt_tp: '000',
                  sort_tp: type === 'losers' ? '2' : '1',
                  trde_qty_cnd: '0000',
                  stk_cnd: '0',
                  crd_cnd: '0',
                  updown_incls: '1',
                  pric_cnd: '0',
                  trde_prica_cnd: '0',
                  stex_tp: '1',
                },
              }
        : {
            apiId:
              type === 'volume'
                ? 'usa20530'
                : type === 'tradingValue'
                  ? 'usa20540'
                  : 'usa20910',
            path: '/api/us/rkinfo',
            body: {
              excd: '000',
              item_tp: '1',
              sort_tp: type === 'losers' ? '2' : '1',
            },
          };

    const result = await kiwoomRequest(request);
    res.json({ ok: true, market, type, request, data: result.data });
  } catch (error) {
    res.status(502).json({
      ok: false,
      market,
      type,
      error: error instanceof Error ? error.message : '키움 원문 조회 실패',
    });
  }
});

router.post('/token/refresh', async (_req, res) => {
  try {
    clearKiwoomTokenCache();
    const token = await getKiwoomToken();
    res.json({
      ok: true,
      provider: 'kiwoom',
      message: '키움 접근토큰 갱신 성공',
      tokenReceived: Boolean(token),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      provider: 'kiwoom',
      error: error instanceof Error ? error.message : '키움 토큰 갱신 실패',
    });
  }
});

export default router;
