import { Router, type IRouter } from 'express';
import { resilientCall } from '../lib/api-resilience';
import {
  getKiwoomRankings,
  type KiwoomRankingRow,
} from '../providers/kiwoom';
import { RankingMoversService } from '../services/ranking-movers.service';
import { RecommendationService } from '../services/recommendation.service';

type ConcreteMarket = 'KR' | 'US';

type RankingCategory =
  | 'marketCap'
  | 'tradingValue'
  | 'volume'
  | 'gainers'
  | 'losers'
  | 'ai';

type RankingRow = {
  ticker: string;
  name: string;
  market: ConcreteMarket;
  currency: 'KRW' | 'USD';
  assetType: string;
  price: number;
  changeAmount: number;
  changePercent: number;
  volume: number | null;
  tradingValue: number | null;
  marketCap: number | null;
  updatedAt: string;
  reason?: string;
  rating?: {
    score: number;
  };
};

type LoadedRows = {
  rows: RankingRow[];
  provider: string;
  isStale: boolean;
  partial: boolean;
};

const router: IRouter = Router();

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function numberValue(
  value: unknown,
  fallback = 0,
): number {
  const parsed = Number(
    String(value ?? '')
      .replace(/,/g, '')
      .trim(),
  );

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function optionalNumber(
  value: unknown,
): number | null {
  const parsed = numberValue(value, Number.NaN);
  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function categoryValue(
  value: unknown,
): RankingCategory {
  const raw = String(value ?? '');

  if (
    raw === 'marketCap' ||
    raw === 'volume' ||
    raw === 'gainers' ||
    raw === 'losers' ||
    raw === 'ai'
  ) {
    return raw;
  }

  return 'tradingValue';
}

function kiwoomRow(
  row: KiwoomRankingRow,
): RankingRow {
  const price = Number(row.price ?? 0);
  const changePercent =
    Number(row.changePercent ?? 0);

  const previousClose =
    price > 0 && changePercent !== -100
      ? price / (1 + changePercent / 100)
      : price;

  return {
    ticker: row.ticker,
    name: row.name,
    market: row.market,
    currency: row.currency,
    assetType: row.assetType.toLowerCase(),
    price,
    changeAmount: price - previousClose,
    changePercent,
    volume:
      row.volume == null
        ? null
        : Number(row.volume),
    tradingValue:
      row.tradingValue == null
        ? null
        : Number(row.tradingValue),
    marketCap: null,
    updatedAt: new Date().toISOString(),
    reason: row.reason,
    rating: {
      score: Math.max(
        1,
        Math.min(
          100,
          50 + changePercent * 3,
        ),
      ),
    },
  };
}

function normalizeListingRow(
  value: unknown,
  market: ConcreteMarket,
): RankingRow | null {
  const row = asRecord(value);
  const ticker = String(
    row.ticker ?? row.symbol ?? '',
  ).trim().toUpperCase();

  const price = numberValue(
    row.price ?? row.currentPrice,
  );

  if (!ticker || price <= 0) return null;

  const changePercent = numberValue(
    row.changePercent ?? row.changeRate,
  );

  const volume = optionalNumber(
    row.volume ?? row.tradingVolume,
  );

  const tradingValue =
    optionalNumber(
      row.tradingValue ??
      row.tradingAmount,
    ) ??
    (
      volume != null
        ? volume * price
        : null
    );

  return {
    ticker,
    name: String(
      row.name ??
      row.stockName ??
      ticker,
    ).trim(),
    market,
    currency:
      market === 'KR'
        ? 'KRW'
        : 'USD',
    assetType: String(
      row.assetType ?? 'stock',
    ),
    price,
    changeAmount: numberValue(
      row.changeAmount,
    ),
    changePercent,
    volume,
    tradingValue,
    marketCap: optionalNumber(row.marketCap),
    updatedAt: String(
      row.updatedAt ??
      new Date().toISOString(),
    ),
    reason:
      typeof row.reason === 'string'
        ? row.reason
        : undefined,
    rating: {
      score: Math.max(
        1,
        Math.min(
          100,
          50 + changePercent * 3,
        ),
      ),
    },
  };
}

async function loadKiwoomRows(
  market: ConcreteMarket,
  category: RankingCategory,
): Promise<LoadedRows> {
  const type =
    category === 'volume' ||
    category === 'gainers' ||
    category === 'losers'
      ? category
      : 'tradingValue';

  const result = await resilientCall({
    provider: 'kiwoom-rankings',
    key: `${market}:${type}`,
    operation: () =>
      getKiwoomRankings(
        market,
        type,
        100,
        {
          excludeHighRisk: true,
        },
      ),
    timeoutMs: 12_000,
    retries: 0,
    cacheTtlMs: 60_000,
    staleTtlMs: 15 * 60_000,
    circuitFailureThreshold: 3,
    circuitResetMs: 60_000,
    validate: (rows) =>
      Array.isArray(rows) &&
      rows.length > 0,
  });

  return {
    rows: result.value.map(kiwoomRow),
    provider:
      `kiwoom-${result.source}`,
    isStale: result.isStale,
    partial: false,
  };
}

async function loadFallbackRows(
  market: ConcreteMarket,
): Promise<LoadedRows> {
  const markets =
    market === 'KR'
      ? (['KRX'] as const)
      : (['NASDAQ', 'NYSE'] as const);

  const settled = await Promise.allSettled(
    markets.map(async (marketKey) => {
      const result = await resilientCall({
        provider:
          `market-listings-${marketKey}`,
        key: `rankings:${marketKey}`,
        operation: () =>
          RankingMoversService
            .getMarketListings(marketKey),
        timeoutMs: 8_000,
        retries: 0,
        cacheTtlMs: 2 * 60_000,
        staleTtlMs: 15 * 60_000,
        circuitFailureThreshold: 3,
        circuitResetMs: 60_000,
      });

      return result;
    }),
  );

  const rows: RankingRow[] = [];
  const seen = new Set<string>();
  let isStale = false;
  let failed = 0;

  for (const item of settled) {
    if (item.status !== 'fulfilled') {
      failed += 1;
      continue;
    }

    isStale =
      isStale ||
      item.value.isStale;

    const listings =
      item.value.value.listings;

    const candidates: unknown[] = [
      ...listings.popular,
      ...listings.gainers,
      ...listings.losers,
      ...listings.recommended,
    ];

    for (const candidate of candidates) {
      const row =
        normalizeListingRow(
          candidate,
          market,
        );

      if (!row) continue;

      const key =
        `${row.market}:${row.ticker}`;

      if (seen.has(key)) continue;

      seen.add(key);
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    throw new Error(
      'MARKET_RANKING_FALLBACK_EMPTY',
    );
  }

  return {
    rows,
    provider: 'market-fallback',
    isStale,
    partial: failed > 0,
  };
}

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 seungjae-stock-app/1.0',
      accept: 'application/json',
    },
    signal:
      AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `UPSTREAM_HTTP_${response.status}`,
    );
  }

  return response.json();
}

async function loadMarketCapRows(
  market: ConcreteMarket,
): Promise<LoadedRows> {
  if (market === 'KR') {
    const result = await resilientCall({
      provider: 'naver-market-cap',
      key: 'rankings:market-cap:KR',
      operation: async () => {
        const codes =
          ['KOSPI', 'KOSDAQ'] as const;

        const settled =
          await Promise.allSettled(
            codes.map(async (code) => {
              const payload = asRecord(
                await fetchJson(
                  `https://m.stock.naver.com/api/stocks/marketValue/${code}?page=1&pageSize=100`,
                  7_000,
                ),
              );

              return Array.isArray(
                payload.stocks,
              )
                ? payload.stocks
                : [];
            }),
          );

        const rows: RankingRow[] = [];
        let failed = 0;

        for (const item of settled) {
          if (item.status !== 'fulfilled') {
            failed += 1;
            continue;
          }

          for (const value of item.value) {
            const stock = asRecord(value);

            const ticker = String(
              stock.itemCode ?? '',
            ).trim();

            const name = String(
              stock.stockName ?? '',
            ).trim();

            const price = numberValue(
              stock.closePrice,
            );

            const marketCap =
              numberValue(
                stock.marketValue,
              ) * 100_000_000;

            if (
              !ticker ||
              !name ||
              price <= 0 ||
              marketCap <= 0
            ) {
              continue;
            }

            const volume =
              numberValue(
                stock.accumulatedTradingVolume,
              );

            rows.push({
              ticker,
              name,
              market: 'KR',
              currency: 'KRW',
              assetType: 'stock',
              price,
              changeAmount: 0,
              changePercent:
                numberValue(
                  stock.fluctuationsRatio,
                ),
              volume,
              tradingValue:
                numberValue(
                  stock.accumulatedTradingValue,
                ) * 1_000_000,
              marketCap,
              updatedAt:
                new Date().toISOString(),
            });
          }
        }

        return {
          rows,
          partial: failed > 0,
        };
      },
      timeoutMs: 9_000,
      retries: 0,
      cacheTtlMs: 2 * 60_000,
      staleTtlMs: 30 * 60_000,
      circuitFailureThreshold: 3,
      circuitResetMs: 60_000,
      validate: (value) =>
        value.rows.length > 0,
    });

    return {
      rows: result.value.rows,
      provider:
        `naver-${result.source}`,
      isStale: result.isStale,
      partial: result.value.partial,
    };
  }

  const result = await resilientCall({
    provider: 'yahoo-market-cap',
    key: 'rankings:market-cap:US',
    operation: async () => {
      const payload = asRecord(
        await fetchJson(
          'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100&sortField=intradaymarketcap&sortType=DESC',
          7_000,
        ),
      );

      const finance =
        asRecord(payload.finance);

      const results =
        Array.isArray(finance.result)
          ? finance.result
          : [];

      const first =
        asRecord(results[0]);

      const quotes =
        Array.isArray(first.quotes)
          ? first.quotes
          : [];

      const rows: RankingRow[] = [];

      for (const value of quotes) {
        const quote = asRecord(value);

        const ticker = String(
          quote.symbol ?? '',
        ).trim().toUpperCase();

        const price = numberValue(
          quote.regularMarketPrice,
        );

        const marketCap =
          numberValue(quote.marketCap);

        if (
          !ticker ||
          price <= 0 ||
          marketCap <= 0
        ) {
          continue;
        }

        const volume =
          numberValue(
            quote.regularMarketVolume,
          );

        rows.push({
          ticker,
          name: String(
            quote.shortName ??
            quote.longName ??
            ticker,
          ).trim(),
          market: 'US',
          currency: 'USD',
          assetType: 'stock',
          price,
          changeAmount:
            numberValue(
              quote.regularMarketChange,
            ),
          changePercent:
            numberValue(
              quote.regularMarketChangePercent,
            ),
          volume,
          tradingValue:
            volume * price,
          marketCap,
          updatedAt:
            new Date().toISOString(),
        });
      }

      return rows;
    },
    timeoutMs: 9_000,
    retries: 0,
    cacheTtlMs: 2 * 60_000,
    staleTtlMs: 30 * 60_000,
    circuitFailureThreshold: 3,
    circuitResetMs: 60_000,
    validate: (rows) =>
      rows.length > 0,
  });

  return {
    rows: result.value,
    provider:
      `yahoo-${result.source}`,
    isStale: result.isStale,
    partial: false,
  };
}

async function loadAiRows(
  market: ConcreteMarket,
): Promise<LoadedRows> {
  const result = await resilientCall({
    provider: 'recommendation-rankings',
    key: `rankings:ai:${market}`,
    operation: () =>
      RecommendationService
        .getRecommendations(market),
    timeoutMs: 12_000,
    retries: 0,
    cacheTtlMs: 5 * 60_000,
    staleTtlMs: 30 * 60_000,
    circuitFailureThreshold: 3,
    circuitResetMs: 60_000,
    validate: (value) =>
      Array.isArray(value.rows),
  });

  const rows: RankingRow[] =
    result.value.rows.map((value) => ({
      ticker: value.ticker,
      name: value.name,
      market: value.market,
      currency: value.currency,
      assetType: 'stock',
      price: value.price,
      changeAmount: 0,
      changePercent:
        value.changePercent,
      volume: null,
      tradingValue: null,
      marketCap: null,
      updatedAt:
        new Date().toISOString(),
      reason:
        value.reasons[0] ??
        value.categoryLabel,
      rating: {
        score: value.score,
      },
    }));

  return {
    rows,
    provider:
      `${result.value.provider}-${result.source}`,
    isStale: result.isStale,
    partial: false,
  };
}

function sortRows(
  rows: RankingRow[],
  category: RankingCategory,
): RankingRow[] {
  if (category === 'marketCap') {
    return [...rows].sort(
      (left, right) =>
        Number(right.marketCap ?? 0) -
        Number(left.marketCap ?? 0),
    );
  }

  if (category === 'volume') {
    return [...rows].sort(
      (left, right) =>
        Number(right.volume ?? 0) -
        Number(left.volume ?? 0),
    );
  }

  if (category === 'gainers') {
    return [...rows]
      .filter(
        (row) =>
          row.changePercent > 0,
      )
      .sort(
        (left, right) =>
          right.changePercent -
          left.changePercent,
      );
  }

  if (category === 'losers') {
    return [...rows]
      .filter(
        (row) =>
          row.changePercent < 0,
      )
      .sort(
        (left, right) =>
          left.changePercent -
          right.changePercent,
      );
  }

  if (category === 'ai') {
    return [...rows].sort(
      (left, right) =>
        Number(right.rating?.score ?? 0) -
        Number(left.rating?.score ?? 0),
    );
  }

  return [...rows].sort(
    (left, right) =>
      Number(right.tradingValue ?? 0) -
      Number(left.tradingValue ?? 0),
  );
}

router.get(
  '/market/rankings',
  async (req, res) => {
    const market: ConcreteMarket =
      String(
        req.query.market ?? 'KR',
      ).toUpperCase() === 'US'
        ? 'US'
        : 'KR';

    const category =
      categoryValue(
        req.query.category ??
        req.query.type,
      );

    const page = Math.max(
      1,
      Math.min(
        5,
        Math.floor(
          Number(req.query.page ?? 1),
        ) || 1,
      ),
    );

    const limit = Math.max(
      1,
      Math.min(
        20,
        Math.floor(
          Number(req.query.limit ?? 20),
        ) || 20,
      ),
    );

    const sort =
      String(
        req.query.sort ?? 'default',
      );

    res.setHeader(
      'Cache-Control',
      'no-store, max-age=0',
    );

    try {
      let loaded: LoadedRows;

      if (category === 'marketCap') {
        loaded =
          await loadMarketCapRows(market);
      } else if (category === 'ai') {
        loaded =
          await loadAiRows(market);
      } else {
        try {
          loaded =
            await loadKiwoomRows(
              market,
              category,
            );
        } catch {
          loaded =
            await loadFallbackRows(market);
        }
      }

      let rows =
        sortRows(
          loaded.rows,
          category,
        ).slice(0, 100);

      rows = rows.map(
        (row, index) => ({
          ...row,
          rank: index + 1,
        }),
      );

      if (sort === 'changePercent_desc') {
        rows = [...rows].sort(
          (left, right) =>
            right.changePercent -
            left.changePercent,
        );
      } else if (
        sort === 'changePercent_asc'
      ) {
        rows = [...rows].sort(
          (left, right) =>
            left.changePercent -
            right.changePercent,
        );
      }

      const total = rows.length;
      const start =
        (page - 1) * limit;

      res.json({
        ok: true,
        provider: loaded.provider,
        source: loaded.provider,
        isStale: loaded.isStale,
        partial: loaded.partial,
        market,
        category,
        page,
        limit,
        sort,
        total,
        totalPages: Math.max(
          1,
          Math.ceil(total / limit),
        ),
        rows:
          rows.slice(
            start,
            start + limit,
          ),
        updatedAt:
          new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        'resilient rankings route error:',
        error,
      );

      res.status(503).json({
        ok: false,
        provider: null,
        isStale: false,
        partial: false,
        market,
        category,
        page,
        limit,
        sort,
        total: 0,
        totalPages: 0,
        rows: [],
        error:
          'MARKET_RANKINGS_UNAVAILABLE',
        message:
          error instanceof Error
            ? error.message
            : '순위 데이터를 불러오지 못했습니다.',
        updatedAt:
          new Date().toISOString(),
      });
    }
  },
);

export default router;
