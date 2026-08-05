import { Router, type IRouter } from 'express';

import {
  getKiwoomDomesticOrderbook,
  type KiwoomApiResponse,
} from '../providers/kiwoom';

const router: IRouter = Router();

export type StockOrderbookMarket = 'KR' | 'US';
export type StockOrderbookStatus =
  | 'ready'
  | 'partial'
  | 'unavailable'
  | 'invalid'
  | 'provider_error';

export interface StockOrderbookLevel {
  rank: number;
  price: number;
  quantity: number;
  cumulativeQuantity: number;
}

export interface StockOrderbookPayload {
  ok: boolean;
  available: boolean;
  status: StockOrderbookStatus;
  market: StockOrderbookMarket;
  exchange: 'KRX' | 'US';
  ticker: string;
  currency: 'KRW' | 'USD';
  provider: 'kiwoom' | null;
  source: 'ka10004' | null;
  sourceTimestampRaw: string | null;
  updatedAt: string | null;
  receivedAt: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  stale: boolean;
  asks: StockOrderbookLevel[];
  bids: StockOrderbookLevel[];
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  spreadPercent: number | null;
  displayedAskQuantity: number;
  displayedBidQuantity: number;
  totalAskQuantity: number | null;
  totalBidQuantity: number | null;
  imbalance: number | null;
  warnings: string[];
  reason: string | null;
  orderSubmitted: false;
  exchangeRequestSent: false;
}

type RawOrderbook = Record<string, unknown>;

function cleanTicker(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .slice(0, 24);
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text || null;
}

function numericValue(
  value: unknown,
  options: { absolute?: boolean; allowZero?: boolean } = {},
): number | null {
  const text = textValue(value);
  if (text == null) return null;

  const normalized = text
    .replace(/,/g, '')
    .replace(/[₩원주]/g, '')
    .trim();

  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;

  const result = options.absolute ? Math.abs(parsed) : parsed;
  if (result < 0) return null;
  if (!options.allowZero && result === 0) return null;
  return result;
}

function sourceField(
  side: 'ask' | 'bid',
  rank: number,
): { price: string; quantity: string } {
  if (side === 'ask') {
    return rank === 1
      ? { price: 'sel_fpr_bid', quantity: 'sel_fpr_req' }
      : {
          price: `sel_${rank}th_pre_bid`,
          quantity: `sel_${rank}th_pre_req`,
        };
  }

  return rank === 1
    ? { price: 'buy_fpr_bid', quantity: 'buy_fpr_req' }
    : {
        price: `buy_${rank}th_pre_bid`,
        quantity: `buy_${rank}th_pre_req`,
      };
}

function normalizeSide(
  raw: RawOrderbook,
  side: 'ask' | 'bid',
  warnings: string[],
): Array<Omit<StockOrderbookLevel, 'cumulativeQuantity'>> {
  const levels: Array<Omit<StockOrderbookLevel, 'cumulativeQuantity'>> = [];
  const seenPrices = new Set<number>();

  for (let rank = 1; rank <= 10; rank += 1) {
    const fields = sourceField(side, rank);
    const rawPrice = raw[fields.price];
    const rawQuantity = raw[fields.quantity];
    const price = numericValue(rawPrice, { absolute: true });
    const quantity = numericValue(rawQuantity, { allowZero: true });

    const hasAnySourceValue =
      textValue(rawPrice) != null || textValue(rawQuantity) != null;

    if (price == null || quantity == null) {
      if (hasAnySourceValue) {
        warnings.push(
          `${side === 'ask' ? '매도' : '매수'} ${rank}호가의 가격 또는 수량이 유효하지 않아 제외했습니다.`,
        );
      }
      continue;
    }

    if (quantity === 0) continue;

    if (seenPrices.has(price)) {
      warnings.push(
        `${side === 'ask' ? '매도' : '매수'} 호가에 중복 가격 ${price}이 있어 뒤 순위를 제외했습니다.`,
      );
      continue;
    }

    seenPrices.add(price);
    levels.push({ rank, price, quantity });
  }

  return levels.sort((left, right) =>
    side === 'ask' ? left.price - right.price : right.price - left.price,
  );
}

function withCumulativeQuantity(
  levels: Array<Omit<StockOrderbookLevel, 'cumulativeQuantity'>>,
): StockOrderbookLevel[] {
  let cumulativeQuantity = 0;
  return levels.map((level) => {
    cumulativeQuantity += level.quantity;
    return { ...level, cumulativeQuantity };
  });
}

function parseProviderTimestamp(
  value: unknown,
  receivedAt: Date,
): string | null {
  const raw = textValue(value);
  if (!raw || !/^\d{14}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));

  const parsed = new Date(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+09:00`,
  );

  if (!Number.isFinite(parsed.getTime())) return null;
  if (parsed.getTime() > receivedAt.getTime() + 60_000) return null;
  return parsed.toISOString();
}

function emptyPayload(
  market: StockOrderbookMarket,
  ticker: string,
  receivedAt: Date,
  status: StockOrderbookStatus,
  reason: string,
): StockOrderbookPayload {
  return {
    ok: false,
    available: false,
    status,
    market,
    exchange: market === 'KR' ? 'KRX' : 'US',
    ticker,
    currency: market === 'KR' ? 'KRW' : 'USD',
    provider: market === 'KR' ? 'kiwoom' : null,
    source: market === 'KR' ? 'ka10004' : null,
    sourceTimestampRaw: null,
    updatedAt: null,
    receivedAt: receivedAt.toISOString(),
    freshness: 'unknown',
    stale: true,
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: null,
    warnings: [],
    reason,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

export function normalizeKiwoomOrderbook(
  ticker: string,
  response: KiwoomApiResponse,
  receivedAt = new Date(),
): StockOrderbookPayload {
  const normalizedTicker = cleanTicker(ticker);
  const raw = response as RawOrderbook;
  const warnings: string[] = [];
  const asks = withCumulativeQuantity(normalizeSide(raw, 'ask', warnings));
  const bids = withCumulativeQuantity(normalizeSide(raw, 'bid', warnings));
  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const displayedAskQuantity = asks.reduce(
    (sum, level) => sum + level.quantity,
    0,
  );
  const displayedBidQuantity = bids.reduce(
    (sum, level) => sum + level.quantity,
    0,
  );
  const totalAskQuantity = numericValue(raw.tot_sel_req, {
    allowZero: true,
  });
  const totalBidQuantity = numericValue(raw.tot_buy_req, {
    allowZero: true,
  });
  const sourceTimestampRaw = textValue(raw.bid_req_base_tm);
  const updatedAt = parseProviderTimestamp(
    sourceTimestampRaw,
    receivedAt,
  );
  const ageMs = updatedAt
    ? receivedAt.getTime() - new Date(updatedAt).getTime()
    : null;
  const stale = ageMs == null || ageMs > 30_000;
  const freshness = ageMs == null
    ? 'unknown'
    : stale
      ? 'stale'
      : 'fresh';

  if (updatedAt == null) {
    warnings.push(
      '공급자 응답에서 초 단위 갱신 시각을 확인할 수 없어 최신성을 보장하지 않습니다.',
    );
  }

  if (asks.length === 0 && bids.length === 0) {
    return {
      ...emptyPayload(
        'KR',
        normalizedTicker,
        receivedAt,
        'unavailable',
        'ORDERBOOK_LEVELS_EMPTY',
      ),
      provider: 'kiwoom',
      source: 'ka10004',
      sourceTimestampRaw,
      updatedAt,
      freshness,
      stale,
      warnings,
    };
  }

  if (bestAsk != null && bestBid != null && bestBid >= bestAsk) {
    return {
      ...emptyPayload(
        'KR',
        normalizedTicker,
        receivedAt,
        'invalid',
        'ORDERBOOK_CROSSED',
      ),
      provider: 'kiwoom',
      source: 'ka10004',
      sourceTimestampRaw,
      updatedAt,
      freshness,
      stale: true,
      warnings: [
        ...warnings,
        '최우선 매수호가가 최우선 매도호가 이상인 교차 호가여서 표시를 차단했습니다.',
      ],
    };
  }

  const spread =
    bestAsk != null && bestBid != null
      ? bestAsk - bestBid
      : null;
  const midpoint =
    bestAsk != null && bestBid != null
      ? (bestAsk + bestBid) / 2
      : null;
  const spreadPercent =
    spread != null && midpoint != null && midpoint > 0
      ? (spread / midpoint) * 100
      : null;
  const imbalanceDenominator =
    displayedBidQuantity + displayedAskQuantity;
  const imbalance =
    imbalanceDenominator > 0
      ? (displayedBidQuantity - displayedAskQuantity)
        / imbalanceDenominator
      : null;
  const partial = asks.length === 0 || bids.length === 0;

  if (partial) {
    warnings.push(
      '매도 또는 매수 한쪽 호가가 비어 있어 부분 데이터로 표시합니다.',
    );
  }

  return {
    ok: true,
    available: true,
    status: partial ? 'partial' : 'ready',
    market: 'KR',
    exchange: 'KRX',
    ticker: normalizedTicker,
    currency: 'KRW',
    provider: 'kiwoom',
    source: 'ka10004',
    sourceTimestampRaw,
    updatedAt,
    receivedAt: receivedAt.toISOString(),
    freshness,
    stale,
    asks,
    bids,
    bestAsk,
    bestBid,
    spread,
    spreadPercent,
    displayedAskQuantity,
    displayedBidQuantity,
    totalAskQuantity,
    totalBidQuantity,
    imbalance,
    warnings,
    reason: null,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function requestedMarket(value: unknown, ticker: string): StockOrderbookMarket {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'US') return 'US';
  if (normalized === 'KR') return 'KR';
  return /^\d{6}(?:_(?:NX|AL))?$/.test(ticker) ? 'KR' : 'US';
}

function providerFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/환경변수|등록되지 않았습니다/.test(message)) {
    return 'ORDERBOOK_PROVIDER_NOT_CONFIGURED';
  }
  if (/시간이 초과/.test(message)) {
    return 'ORDERBOOK_PROVIDER_TIMEOUT';
  }
  return 'ORDERBOOK_PROVIDER_UNAVAILABLE';
}

router.get('/:ticker/orderbook', async (req, res) => {
  const ticker = cleanTicker(req.params.ticker);
  const market = requestedMarket(req.query.market, ticker);
  const receivedAt = new Date();

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (market === 'US') {
    return res.status(200).json(
      emptyPayload(
        'US',
        ticker,
        receivedAt,
        'unavailable',
        'US_ORDERBOOK_PROVIDER_NOT_CONNECTED',
      ),
    );
  }

  if (!/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    return res.status(400).json(
      emptyPayload(
        'KR',
        ticker,
        receivedAt,
        'invalid',
        'INVALID_KR_TICKER',
      ),
    );
  }

  try {
    const raw = await getKiwoomDomesticOrderbook(ticker);
    return res.status(200).json(
      normalizeKiwoomOrderbook(ticker, raw, new Date()),
    );
  } catch (error) {
    const reason = providerFailureCode(error);
    console.error('[stock-orderbook]', reason);
    return res.status(200).json(
      emptyPayload(
        'KR',
        ticker,
        new Date(),
        'provider_error',
        reason,
      ),
    );
  }
});

export default router;
