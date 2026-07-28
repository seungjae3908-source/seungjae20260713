import { Router, type IRouter } from 'express';
import {
  getKiwoomRankings,
  type KiwoomRankingRow,
  type KiwoomRankingType,
} from '../providers/kiwoom';

const router: IRouter = Router();
const MAX_ROWS = 100;

type Market = 'KR' | 'US';
type QuoteLike = {
  ticker: string;
  name: string;
  market: Market;
  currency: 'KRW' | 'USD';
  assetType: string;
  price: number;
  changeAmount: number;
  changePercent: number;
  volume: number;
  tradingValue: number;
  marketCap: number | null;
  previousClose: number;
  updatedAt: string;
  rating: { score: number; rating: 'BUY' | 'SELL' | 'HOLD' };
  reason: string;
  rank: number;
};

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[,+%₩$]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function marketCapOf(row: KiwoomRankingRow): number | null {
  const raw = row.raw ?? {};
  const keys = [
    'marketCap',
    'market_cap',
    'mkt_cap',
    'mrkt_tot_amt',
    'market_value',
    'marketValue',
    'total_market_value',
    'listed_market_cap',
    'tomv',
    '시가총액',
  ];

  for (const key of keys) {
    const value = numberValue(raw[key]);
    if (value == null) continue;

    // 일부 국내 응답은 시가총액을 억원 단위로 제공합니다.
    if (row.market === 'KR' && ['mrkt_tot_amt', 'tomv'].includes(key) && value < 1_000_000_000) {
      return value * 100_000_000;
    }
    return value;
  }

  return null;
}

function toQuote(row: KiwoomRankingRow): QuoteLike {
  const price = numberValue(row.price) ?? 0;
  const changePercent = numberValue(row.changePercent) ?? 0;
  const previousClose = price > 0 && changePercent !== -100
    ? price / (1 + changePercent / 100)
    : price;
  const changeAmount = price - previousClose;

  return {
    ticker: row.ticker,
    name: row.name,
    market: row.market,
    currency: row.currency,
    assetType: row.assetType.toLowerCase(),
    price,
    changeAmount,
    changePercent,
    volume: numberValue(row.volume) ?? 0,
    tradingValue: numberValue(row.tradingValue) ?? 0,
    marketCap: marketCapOf(row),
    previousClose,
    updatedAt: new Date().toISOString(),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? 'BUY' : changePercent < -3 ? 'SELL' : 'HOLD',
    },
    reason: row.reason,
    rank: row.rank,
  };
}

function unique(rows: QuoteLike[]): QuoteLike[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.market}:${row.ticker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ranked(rows: QuoteLike[], compare: (a: QuoteLike, b: QuoteLike) => number): QuoteLike[] {
  return unique(rows)
    .sort(compare)
    .slice(0, MAX_ROWS)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function ranking(market: Market, type: KiwoomRankingType): Promise<QuoteLike[]> {
  const rows = await getKiwoomRankings(market, type, MAX_ROWS, {
    excludeHighRisk: true,
  });
  return rows.map(toQuote);
}

router.get('/market/movers', async (req, res, next) => {
  const requestedLimit = Number(req.query.limit ?? 0);
  if (!Number.isFinite(requestedLimit) || requestedLimit < MAX_ROWS) {
    next();
    return;
  }

  const market = String(req.query.market ?? '').toUpperCase();
  if (market !== 'KR' && market !== 'US') {
    next();
    return;
  }

  try {
    const [tradingValueRows, volumeRows, gainerRows, loserRows] = await Promise.all([
      ranking(market, 'tradingValue'),
      ranking(market, 'volume'),
      ranking(market, 'gainers'),
      ranking(market, 'losers'),
    ]);

    const popular = ranked(
      tradingValueRows,
      (a, b) => b.tradingValue - a.tradingValue,
    );
    const volume = ranked(volumeRows, (a, b) => b.volume - a.volume);
    const gainers = ranked(
      gainerRows,
      (a, b) => b.changePercent - a.changePercent,
    );
    const losers = ranked(
      loserRows,
      (a, b) => a.changePercent - b.changePercent,
    );

    const combined = unique([
      ...tradingValueRows,
      ...volumeRows,
      ...gainerRows,
      ...loserRows,
    ]);
    const marketCap = ranked(combined, (a, b) => {
      if (a.marketCap == null && b.marketCap == null) return a.rank - b.rank;
      if (a.marketCap == null) return 1;
      if (b.marketCap == null) return -1;
      return b.marketCap - a.marketCap;
    });

    const recommended = ranked(
      gainers,
      (a, b) => b.rating.score - a.rating.score,
    );

    res.json({
      market,
      provider: 'kiwoom',
      requestedLimit: MAX_ROWS,
      popular,
      volume,
      marketCap,
      recommended,
      gainers,
      losers,
      risky: losers,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('100-row stock ranking route failed; falling back to existing route:', error);
    next();
  }
});

export default router;
