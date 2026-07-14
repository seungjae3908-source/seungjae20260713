import { Router, type IRouter } from "express";
import {
  MarketDataService,
  type QuoteRow,
} from "../services/market-data.service";
import * as naver from "../providers/naver";
import * as yahoo from "../providers/yahoo";
import {
  getKiwoomRankings,
  type KiwoomRankingRow,
} from "../providers/kiwoom";
import { ThemesService } from "../services/themes.service";

const router: IRouter = Router();

type MarketScope = "ALL" | "KR" | "US";
type ConcreteMarket = "KR" | "US";

interface BasicStock {
  ticker: string;
  name: string;
  market: ConcreteMarket;
  currency: "KRW" | "USD";
}

const FALLBACK_UNIVERSE: BasicStock[] = [
  { ticker: "005930", name: "�쇱꽦�꾩옄", market: "KR", currency: "KRW" },
  { ticker: "000660", name: "SK�섏씠�됱뒪", market: "KR", currency: "KRW" },
  { ticker: "005380", name: "�꾨�李�", market: "KR", currency: "KRW" },
  { ticker: "000270", name: "湲곗븘", market: "KR", currency: "KRW" },
  { ticker: "035420", name: "NAVER", market: "KR", currency: "KRW" },
  { ticker: "035720", name: "移댁뭅��", market: "KR", currency: "KRW" },
  { ticker: "AAPL", name: "Apple", market: "US", currency: "USD" },
  { ticker: "MSFT", name: "Microsoft", market: "US", currency: "USD" },
  { ticker: "NVDA", name: "NVIDIA", market: "US", currency: "USD" },
  { ticker: "AMZN", name: "Amazon", market: "US", currency: "USD" },
  { ticker: "META", name: "Meta Platforms", market: "US", currency: "USD" },
  { ticker: "TSLA", name: "Tesla", market: "US", currency: "USD" },
];

function normalizeTicker(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeMarket(value: unknown): MarketScope {
  const raw = String(value ?? "ALL").toUpperCase();
  if (raw === "KR") return "KR";
  if (raw === "US") return "US";
  return "ALL";
}

function uniqueTickers(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeTicker(value)).filter(Boolean)),
  );
}

function isKrTicker(ticker: string): boolean {
  return /^\d{6}$/.test(ticker);
}

function numberFromSeed(ticker: string, min: number, max: number): number {
  const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return min + (seed % (max - min));
}

function findFallbackStock(ticker: string): BasicStock {
  const clean = normalizeTicker(ticker);
  return (
    FALLBACK_UNIVERSE.find((stock) => stock.ticker === clean) ?? {
      ticker: clean,
      name: clean,
      market: isKrTicker(clean) ? "KR" : "US",
      currency: isKrTicker(clean) ? "KRW" : "USD",
    }
  );
}

function fallbackQuote(stock: BasicStock): QuoteRow {
  const seed = [...stock.ticker].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  const basePrice =
    stock.market === "KR"
      ? numberFromSeed(stock.ticker, 3500, 300000)
      : numberFromSeed(stock.ticker, 20, 900);
  const changePercent = Number((((seed % 1800) - 900) / 100).toFixed(2));
  const price =
    stock.market === "KR"
      ? Math.round(basePrice / 50) * 50
      : Number(basePrice.toFixed(2));
  const previousClose = price / (1 + changePercent / 100);
  const changeAmount = price - previousClose;
  const volume = numberFromSeed(stock.ticker, 100000, 9000000);

  return {
    ticker: stock.ticker,
    name: stock.name,
    market: stock.market,
    currency: stock.currency,
    assetType: "stock" as any,
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue: price * volume,
    open: previousClose,
    high: Math.max(price, previousClose) * 1.02,
    low: Math.min(price, previousClose) * 0.98,
    previousClose,
    updatedAt: new Date().toISOString(),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
    } as any,
    reason: "�꾩떆 fallback �쒖꽭�낅땲��.",
  };
}

function providerQuoteToRow(
  providerQuote: any,
  stock: BasicStock,
  provider: "naver" | "yahoo",
): QuoteRow {
  const price = Number(
    providerQuote.price ??
      providerQuote.currentPrice ??
      providerQuote.regularMarketPrice ??
      0,
  );
  const previousClose = Number(
    providerQuote.previousClose ?? providerQuote.prevClose ?? price,
  );
  const changeAmount = Number(
    providerQuote.changeAmount ?? providerQuote.change ?? price - previousClose,
  );
  const changePercent = Number(
    providerQuote.changePercent ??
      providerQuote.regularMarketChangePercent ??
      (previousClose ? (changeAmount / previousClose) * 100 : 0),
  );
  const volume = Number(providerQuote.volume ?? 0);
  const tradingValue = Number(providerQuote.tradingValue ?? price * volume);

  return {
    ticker: stock.ticker,
    name: String(providerQuote.name ?? stock.name),
    market: stock.market,
    currency: stock.currency,
    assetType: "stock" as any,
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    open: Number(providerQuote.open ?? 0),
    high: Number(providerQuote.high ?? 0),
    low: Number(providerQuote.low ?? 0),
    previousClose,
    updatedAt: String(providerQuote.updatedAt ?? new Date().toISOString()),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
    } as any,
    reason:
      provider === "naver"
        ? "�ㅼ씠踰� �ㅼ떆媛� �쒖꽭�낅땲��."
        : "Yahoo �ㅼ떆媛� �쒖꽭�낅땲��.",
  };
}

function kiwoomRankingToQuoteRow(row: KiwoomRankingRow): QuoteRow {
  const price = Number(row.price ?? 0);
  const changePercent = Number(row.changePercent ?? 0);
  const previousClose =
    price > 0 && changePercent !== -100
      ? price / (1 + changePercent / 100)
      : price;
  const changeAmount = price - previousClose;

  return {
    ticker: row.ticker,
    name: row.name,
    market: row.market,
    currency: row.currency,
    assetType: row.assetType.toLowerCase() as any,
    price,
    changeAmount,
    changePercent,
    volume: Number(row.volume ?? 0),
    tradingValue: Number(row.tradingValue ?? 0),
    open: previousClose,
    high: price,
    low: price,
    previousClose,
    updatedAt: new Date().toISOString(),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
    } as any,
    reason: row.reason,
  };
}

async function getProviderQuote(ticker: string): Promise<QuoteRow | null> {
  const stock = findFallbackStock(ticker);

  try {
    if (stock.market === "KR") {
      const q = await naver.getQuote(stock.ticker);
      if (q && Number((q as any).price ?? 0) > 0) {
        return providerQuoteToRow(q, stock, "naver");
      }
    }

    const q = await yahoo.getQuote(stock.ticker);
    if (q && Number((q as any).price ?? 0) > 0) {
      return providerQuoteToRow(q, stock, "yahoo");
    }
  } catch {
    // fallback below
  }

  return null;
}

function filterUniverseByMarket(market: MarketScope): BasicStock[] {
  if (market === "ALL") return FALLBACK_UNIVERSE;
  return FALLBACK_UNIVERSE.filter((stock) => stock.market === market);
}

function sortByRecommended(rows: QuoteRow[]): QuoteRow[] {
  return [...rows].sort((a, b) => {
    const bScore = (b.rating as any)?.score ?? Math.abs(b.changePercent ?? 0);
    const aScore = (a.rating as any)?.score ?? Math.abs(a.changePercent ?? 0);
    return bScore - aScore;
  });
}

async function getRowsForTickers(tickers: string[]): Promise<QuoteRow[]> {
  const cleanTickers = uniqueTickers(tickers);
  if (cleanTickers.length === 0) return [];

  return Promise.all(
    cleanTickers.map(async (ticker) => {
      const providerRow = await getProviderQuote(ticker);
      if (providerRow) return providerRow;

      try {
        const serviceRow = await MarketDataService.getQuoteRow(ticker);
        if (serviceRow && Number(serviceRow.price ?? 0) > 0) {
          const suspiciousFallback =
            serviceRow.price === 3800 ||
            serviceRow.reason?.includes("fallback") ||
            serviceRow.name === serviceRow.ticker;
          if (!suspiciousFallback) return serviceRow;
        }
      } catch {
        // fallback below
      }

      return fallbackQuote(findFallbackStock(ticker));
    }),
  );
}

async function searchNaverStocks(query: string) {
  const q = query.trim();
  if (!q) return [];

  try {
    const response = await fetch(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 seungjae-stock-app/1.0",
          Accept: "application/json,text/plain,*/*",
          Referer: "https://finance.naver.com/",
        },
      },
    );
    if (!response.ok) return [];

    const data: any = await response.json();
    const candidates = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.result?.items)
        ? data.result.items
        : Array.isArray(data?.stocks)
          ? data.stocks
          : [];

    return candidates
      .map((item: any) => {
        const ticker = String(
          item.code ?? item.stockCode ?? item.localCode ?? item.symbol ?? "",
        )
          .replace(/\D/g, "")
          .slice(-6);
        const name = String(
          item.name ?? item.stockName ?? item.koreanName ?? item.label ?? "",
        ).trim();
        const marketText = String(
          item.typeCode ?? item.typeName ?? item.market ?? item.exchange ?? "",
        ).toUpperCase();
        if (!/^\d{6}$/.test(ticker) || !name) return null;

        return {
          ticker,
          name,
          market: "KR" as const,
          currency: "KRW" as const,
          assetType: /ETF/.test(marketText)
            ? "ETF"
            : /ETN/.test(marketText)
              ? "ETN"
              : "stock",
          exchange: marketText.includes("KOSDAQ")
            ? "KOSDAQ"
            : marketText.includes("KONEX")
              ? "KONEX"
              : "KOSPI",
          aliases: [],
        };
      })
      .filter(Boolean)
      .slice(0, 80);
  } catch {
    return [];
  }
}

router.get("/config", (_req, res) => {
  res.json({
    ok: true,
    service: "seungjae-stock-api",
    time: new Date().toISOString(),
    providers: {
      kiwoom: true,
      naver: true,
      yahoo: true,
      quotes: true,
      search: true,
      movers: true,
    },
  });
});

router.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();

  try {
    const results = await MarketDataService.search(q, 80);
    if (results.length > 0) {
      res.json({ q, results });
      return;
    }
  } catch {
    // fallback below
  }

  const naverResults = await searchNaverStocks(q);
  if (naverResults.length > 0) {
    res.json({ q, results: naverResults });
    return;
  }

  const needle = q.replace(/\s+/g, "").toLowerCase();
  const results = FALLBACK_UNIVERSE.filter((stock) => {
    const target = `${stock.ticker}${stock.name}`
      .replace(/\s+/g, "")
      .toLowerCase();
    return !needle || target.includes(needle);
  }).map((stock) => ({
    ticker: stock.ticker,
    name: stock.name,
    market: stock.market,
    currency: stock.currency,
    assetType: "stock",
    aliases: [],
  }));

  res.json({ q, results });
});

router.get("/quotes", async (req, res) => {
  const raw =
    req.query.tickers ??
    req.query.symbols ??
    req.query.symbol ??
    req.query.ticker ??
    "";
  const tickers = uniqueTickers(String(raw).split(","));
  const quotes = await getRowsForTickers(tickers);
  res.json({ quotes });
});

router.get("/market/movers", async (req, res) => {
  const scope = normalizeMarket(req.query.market);

  try {
    const markets: ConcreteMarket[] =
      scope === "ALL" ? ["KR", "US"] : [scope];

    const results = await Promise.all(
      markets.map(async (market) => {
        const [popularRows, volumeRows, gainerRows, loserRows] =
          await Promise.all([
            getKiwoomRankings(market, "tradingValue", 30, {
              excludeHighRisk: true,
            }),
            getKiwoomRankings(market, "volume", 30, {
              excludeHighRisk: true,
            }),
            getKiwoomRankings(market, "gainers", 30, {
              excludeHighRisk: true,
            }),
            getKiwoomRankings(market, "losers", 30, {
              excludeHighRisk: true,
            }),
          ]);

        return {
          popular: popularRows.map(kiwoomRankingToQuoteRow),
          volume: volumeRows.map(kiwoomRankingToQuoteRow),
          gainers: gainerRows.map(kiwoomRankingToQuoteRow),
          losers: loserRows.map(kiwoomRankingToQuoteRow),
        };
      }),
    );

    const popular = results
      .flatMap((result) => result.popular)
      .sort(
        (a, b) =>
          Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0),
      )
      .slice(0, 30)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const volume = results
      .flatMap((result) => result.volume)
      .sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
      .slice(0, 30)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const gainers = results
      .flatMap((result) => result.gainers)
      .sort(
        (a, b) =>
          Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0),
      )
      .slice(0, 30)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const losers = results
      .flatMap((result) => result.losers)
      .sort(
        (a, b) =>
          Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0),
      )
      .slice(0, 30)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const recommended = [...gainers]
      .sort(
        (a, b) =>
          Number((b.rating as any)?.score ?? 0) -
          Number((a.rating as any)?.score ?? 0),
      )
      .slice(0, 30)
      .map((row, index) => ({
        ...row,
        rank: index + 1,
        reason: "�ㅼ� �ㅼ떆媛� �곗씠�� 湲곕컲 異붿쿇 醫낅ぉ�낅땲��.",
      }));

    res.json({
      market: scope,
      provider: "kiwoom",
      popular,
      volume,
      recommended,
      gainers,
      losers,
      risky: losers,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Kiwoom market movers error:", error);
    res.status(502).json({
      ok: false,
      provider: "kiwoom",
      error:
        error instanceof Error
          ? error.message
          : "�ㅼ� �쒖옣 �쒖쐞 議고쉶�� �ㅽ뙣�덉뒿�덈떎.",
    });
  }
});

router.get("/market/summary", (_req, res) => {
  res.json({
    ok: true,
    summary: "�쒖옣 �붿빟 �곗씠�곕뒗 以鍮� 以묒엯�덈떎.",
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/briefing", (_req, res) => {
  res.json({
    ok: true,
    items: [
      {
        sector: "諛섎룄泥�",
        title: "諛섎룄泥�",
        summary: "AI 諛섎룄泥댁� 怨좎꽦�� 硫붾え由� �섏슂 �먮쫫�� �뺤씤�⑸땲��.",
      },
      {
        sector: "諛붿씠��",
        title: "諛붿씠��",
        summary: "�꾩긽쨌�뱀씤쨌怨꾩빟 �댁뒪�� �곕Ⅸ 醫낅ぉ蹂� 蹂�숈꽦�� �뺤씤�⑸땲��.",
      },
      {
        sector: "�먮룞李�",
        title: "�먮룞李�",
        summary: "�꾩꽦李� �먮ℓ� �꾧린李� �꾪솚 �먮쫫�� �뺤씤�⑸땲��.",
      },
      {
        sector: "��났",
        title: "��났",
        summary: "�ы뻾 �섏슂� �좉�, �섏쑉�� �곕Ⅸ ��났二� �먮쫫�� �뺤씤�⑸땲��.",
      },
      {
        sector: "嫄댁꽕",
        title: "嫄댁꽕",
        summary: "遺�숈궛 �뺤콉怨� �섏＜ �먮쫫�� �뺤씤�⑸땲��.",
      },
    ],
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/themes", async (req, res) => {
  const market =
    String(req.query.market ?? "KR").toUpperCase() === "US" ? "US" : "KR";

  try {
    const data = await ThemesService.getThemes(market);
    res.json(data);
  } catch (error) {
    console.error("market themes route error:", error);
    res.status(500).json({
      error: "MARKET_THEMES_ROUTE_ERROR",
      market,
      themes: [],
    });
  }
});

router.get("/market/scan", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const rows = await getRowsForTickers(
    filterUniverseByMarket(scope).map((stock) => stock.ticker),
  );

  res.json({
    market: scope,
    results: sortByRecommended(rows).slice(0, 30),
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/alerts", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const rows = await getRowsForTickers(
    filterUniverseByMarket(scope).map((stock) => stock.ticker),
  );

  const alerts = [...rows]
    .sort((a, b) => Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0))
    .slice(0, 20);

  res.json({
    market: scope,
    alerts,
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/undervalued", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const rows = await getRowsForTickers(
    filterUniverseByMarket(scope).map((stock) => stock.ticker),
  );

  res.json({
    market: scope,
    results: sortByRecommended(rows).slice(0, 20),
    updatedAt: new Date().toISOString(),
  });
});

export default router;