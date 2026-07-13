import { Router, type IRouter } from "express";
import {
  MarketDataService,
  type QuoteRow,
} from "../services/market-data.service";
import * as naver from "../providers/naver";
import * as yahoo from "../providers/yahoo";
import { ThemesService } from "../services/themes.service";

const router: IRouter = Router();

type MarketScope = "ALL" | "KR" | "US";

interface BasicStock {
  ticker: string;
  name: string;
  market: "KR" | "US";
  currency: "KRW" | "USD";
}

const FALLBACK_UNIVERSE: BasicStock[] = [
  { ticker: "005930", name: "삼성전자", market: "KR", currency: "KRW" },
  { ticker: "000660", name: "SK하이닉스", market: "KR", currency: "KRW" },
  { ticker: "005380", name: "현대차", market: "KR", currency: "KRW" },
  { ticker: "000270", name: "기아", market: "KR", currency: "KRW" },
  { ticker: "035420", name: "NAVER", market: "KR", currency: "KRW" },
  { ticker: "035720", name: "카카오", market: "KR", currency: "KRW" },
  { ticker: "373220", name: "LG에너지솔루션", market: "KR", currency: "KRW" },
  { ticker: "207940", name: "삼성바이오로직스", market: "KR", currency: "KRW" },
  { ticker: "068270", name: "셀트리온", market: "KR", currency: "KRW" },
  { ticker: "051910", name: "LG화학", market: "KR", currency: "KRW" },
  { ticker: "006400", name: "삼성SDI", market: "KR", currency: "KRW" },
  { ticker: "005490", name: "POSCO홀딩스", market: "KR", currency: "KRW" },
  { ticker: "003670", name: "포스코퓨처엠", market: "KR", currency: "KRW" },
  { ticker: "012330", name: "현대모비스", market: "KR", currency: "KRW" },
  { ticker: "028260", name: "삼성물산", market: "KR", currency: "KRW" },
  { ticker: "055550", name: "신한지주", market: "KR", currency: "KRW" },
  { ticker: "105560", name: "KB금융", market: "KR", currency: "KRW" },
  { ticker: "086790", name: "하나금융지주", market: "KR", currency: "KRW" },
  { ticker: "316140", name: "우리금융지주", market: "KR", currency: "KRW" },
  { ticker: "066570", name: "LG전자", market: "KR", currency: "KRW" },
  { ticker: "096770", name: "SK이노베이션", market: "KR", currency: "KRW" },
  { ticker: "017670", name: "SK텔레콤", market: "KR", currency: "KRW" },
  { ticker: "030200", name: "KT", market: "KR", currency: "KRW" },
  { ticker: "032830", name: "삼성생명", market: "KR", currency: "KRW" },
  { ticker: "000810", name: "삼성화재", market: "KR", currency: "KRW" },
  { ticker: "033780", name: "KT&G", market: "KR", currency: "KRW" },
  { ticker: "015760", name: "한국전력", market: "KR", currency: "KRW" },
  { ticker: "034020", name: "두산에너빌리티", market: "KR", currency: "KRW" },
  { ticker: "010130", name: "고려아연", market: "KR", currency: "KRW" },
  { ticker: "009540", name: "HD한국조선해양", market: "KR", currency: "KRW" },
  { ticker: "010140", name: "삼성중공업", market: "KR", currency: "KRW" },
  { ticker: "329180", name: "HD현대중공업", market: "KR", currency: "KRW" },
  { ticker: "000720", name: "현대건설", market: "KR", currency: "KRW" },
  { ticker: "006360", name: "GS건설", market: "KR", currency: "KRW" },
  { ticker: "047040", name: "대우건설", market: "KR", currency: "KRW" },
  { ticker: "003490", name: "대한항공", market: "KR", currency: "KRW" },
  { ticker: "089590", name: "제주항공", market: "KR", currency: "KRW" },
  { ticker: "086520", name: "에코프로", market: "KR", currency: "KRW" },
  { ticker: "247540", name: "에코프로비엠", market: "KR", currency: "KRW" },
  { ticker: "196170", name: "알테오젠", market: "KR", currency: "KRW" },
  { ticker: "028300", name: "HLB", market: "KR", currency: "KRW" },
  { ticker: "277810", name: "레인보우로보틱스", market: "KR", currency: "KRW" },
  { ticker: "042700", name: "한미반도체", market: "KR", currency: "KRW" },
  { ticker: "352820", name: "하이브", market: "KR", currency: "KRW" },
  { ticker: "259960", name: "크래프톤", market: "KR", currency: "KRW" },
  { ticker: "036570", name: "엔씨소프트", market: "KR", currency: "KRW" },
  { ticker: "251270", name: "넷마블", market: "KR", currency: "KRW" },
  { ticker: "011200", name: "HMM", market: "KR", currency: "KRW" },
  { ticker: "018260", name: "삼성에스디에스", market: "KR", currency: "KRW" },
  { ticker: "090430", name: "아모레퍼시픽", market: "KR", currency: "KRW" },
  { ticker: "004020", name: "현대제철", market: "KR", currency: "KRW" },
  { ticker: "011070", name: "LG이노텍", market: "KR", currency: "KRW" },

  { ticker: "AAPL", name: "Apple", market: "US", currency: "USD" },
  { ticker: "MSFT", name: "Microsoft", market: "US", currency: "USD" },
  { ticker: "NVDA", name: "NVIDIA", market: "US", currency: "USD" },
  { ticker: "GOOGL", name: "Alphabet A", market: "US", currency: "USD" },
  { ticker: "GOOG", name: "Alphabet C", market: "US", currency: "USD" },
  { ticker: "AMZN", name: "Amazon", market: "US", currency: "USD" },
  { ticker: "META", name: "Meta Platforms", market: "US", currency: "USD" },
  { ticker: "TSLA", name: "Tesla", market: "US", currency: "USD" },
  { ticker: "AVGO", name: "Broadcom", market: "US", currency: "USD" },
  { ticker: "NFLX", name: "Netflix", market: "US", currency: "USD" },
  { ticker: "AMD", name: "AMD", market: "US", currency: "USD" },
  { ticker: "INTC", name: "Intel", market: "US", currency: "USD" },
  { ticker: "PLTR", name: "Palantir", market: "US", currency: "USD" },
  { ticker: "SOFI", name: "SoFi", market: "US", currency: "USD" },
  { ticker: "COIN", name: "Coinbase", market: "US", currency: "USD" },
  { ticker: "UBER", name: "Uber", market: "US", currency: "USD" },
  { ticker: "AAL", name: "American Airlines", market: "US", currency: "USD" },
  { ticker: "DAL", name: "Delta Air Lines", market: "US", currency: "USD" },
  { ticker: "UAL", name: "United Airlines", market: "US", currency: "USD" },
  { ticker: "JPM", name: "JPMorgan Chase", market: "US", currency: "USD" },
  { ticker: "BAC", name: "Bank of America", market: "US", currency: "USD" },
  { ticker: "XOM", name: "Exxon Mobil", market: "US", currency: "USD" },
  { ticker: "CVX", name: "Chevron", market: "US", currency: "USD" },
  { ticker: "LLY", name: "Eli Lilly", market: "US", currency: "USD" },
  { ticker: "UNH", name: "UnitedHealth", market: "US", currency: "USD" },
  { ticker: "WMT", name: "Walmart", market: "US", currency: "USD" },
  { ticker: "COST", name: "Costco", market: "US", currency: "USD" },
  { ticker: "ORCL", name: "Oracle", market: "US", currency: "USD" },
  { ticker: "ADBE", name: "Adobe", market: "US", currency: "USD" },
  { ticker: "CRM", name: "Salesforce", market: "US", currency: "USD" },
  { ticker: "QCOM", name: "Qualcomm", market: "US", currency: "USD" },
  { ticker: "AMAT", name: "Applied Materials", market: "US", currency: "USD" },
  { ticker: "MU", name: "Micron", market: "US", currency: "USD" },
  {
    ticker: "SMCI",
    name: "Super Micro Computer",
    market: "US",
    currency: "USD",
  },
  { ticker: "ARM", name: "Arm Holdings", market: "US", currency: "USD" },
  { ticker: "TSM", name: "TSMC", market: "US", currency: "USD" },
  { ticker: "ASML", name: "ASML", market: "US", currency: "USD" },
  { ticker: "NVO", name: "Novo Nordisk", market: "US", currency: "USD" },
  { ticker: "MRNA", name: "Moderna", market: "US", currency: "USD" },
  { ticker: "PFE", name: "Pfizer", market: "US", currency: "USD" },
  { ticker: "JNJ", name: "Johnson & Johnson", market: "US", currency: "USD" },
  { ticker: "BA", name: "Boeing", market: "US", currency: "USD" },
  { ticker: "DIS", name: "Disney", market: "US", currency: "USD" },
  { ticker: "NKE", name: "Nike", market: "US", currency: "USD" },
  { ticker: "SHOP", name: "Shopify", market: "US", currency: "USD" },
  { ticker: "CRWD", name: "CrowdStrike", market: "US", currency: "USD" },
  { ticker: "SNOW", name: "Snowflake", market: "US", currency: "USD" },
  { ticker: "RGTI", name: "Rigetti Computing", market: "US", currency: "USD" },
  { ticker: "IONQ", name: "IonQ", market: "US", currency: "USD" },
];

function normalizeTicker(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeMarket(value: unknown): MarketScope {
  const raw = String(value ?? "ALL").toUpperCase();

  if (raw === "KR") return "KR";
  if (raw === "US") return "US";

  return "ALL";
}

function uniqueTickers(values: string[]) {
  return Array.from(
    new Set(values.map((value) => normalizeTicker(value)).filter(Boolean)),
  );
}

function isKrTicker(ticker: string) {
  return /^\d{6}$/.test(ticker);
}

function numberFromSeed(ticker: string, min: number, max: number) {
  const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const range = max - min;

  return min + (seed % range);
}

function findFallbackStock(ticker: string): BasicStock {
  const clean = normalizeTicker(ticker);

  return (
    FALLBACK_UNIVERSE.find((stock) => stock.ticker.toUpperCase() === clean) ?? {
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
  const tradingValue = price * volume;

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
    tradingValue,
    open: previousClose,
    high: Math.max(price, previousClose) * 1.02,
    low: Math.min(price, previousClose) * 0.98,
    previousClose,
    updatedAt: new Date().toISOString(),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
    } as any,
    reason: "임시 fallback 시세입니다.",
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
        ? "네이버 실시간 시세입니다."
        : "Yahoo 실시간 시세입니다.",
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

function filterUniverseByMarket(market: MarketScope) {
  if (market === "ALL") return FALLBACK_UNIVERSE;

  return FALLBACK_UNIVERSE.filter((stock) => stock.market === market);
}

function sortByTradingValue(rows: QuoteRow[]) {
  return [...rows].sort(
    (a, b) => (b.tradingValue ?? 0) - (a.tradingValue ?? 0),
  );
}

function sortByVolume(rows: QuoteRow[]) {
  return [...rows].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

function sortByGainers(rows: QuoteRow[]) {
  return [...rows].sort(
    (a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0),
  );
}

function sortByLosers(rows: QuoteRow[]) {
  return [...rows].sort(
    (a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0),
  );
}

function sortByRecommended(rows: QuoteRow[]) {
  return [...rows].sort((a, b) => {
    const bScore = (b.rating as any)?.score ?? Math.abs(b.changePercent ?? 0);
    const aScore = (a.rating as any)?.score ?? Math.abs(a.changePercent ?? 0);

    return bScore - aScore;
  });
}

async function getRowsForTickers(tickers: string[]) {
  const cleanTickers = uniqueTickers(tickers);

  if (cleanTickers.length === 0) return [];

  const rows = await Promise.all(
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

  return rows;
}

async function searchNaverStocks(query: string) {
  const q = query.trim();
  if (!q) return [];

  try {
    const response = await fetch(
      "https://ac.stock.naver.com/ac?q=" +
        encodeURIComponent(q) +
        "&target=stock",
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

  try {
    const naverResults = await searchNaverStocks(q);
    if (naverResults.length > 0) {
      res.json({ q, results: naverResults });
      return;
    }
  } catch {
    // fallback below
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
  const universe = filterUniverseByMarket(scope);
  const tickers = universe.map((stock) => stock.ticker);
  const rows = await getRowsForTickers(tickers);

  const popular = sortByTradingValue(rows)
    .slice(0, 30)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      reason: row.reason ?? "거래대금 기준 상위 종목입니다.",
    }));

  const volume = sortByVolume(rows)
    .slice(0, 30)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      reason: row.reason ?? "거래량 기준 상위 종목입니다.",
    }));

  const recommended = sortByRecommended(rows)
    .slice(0, 30)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      reason: row.reason ?? "AI 점수 기준 추천 종목입니다.",
    }));

  const gainers = sortByGainers(rows)
    .slice(0, 30)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      reason: row.reason ?? "등락률 기준 급상승 종목입니다.",
    }));

  const losers = sortByLosers(rows)
    .slice(0, 30)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      reason: row.reason ?? "등락률 기준 급하락 종목입니다.",
    }));

  res.json({
    market: scope,
    popular,
    volume,
    recommended,
    gainers,
    losers,
    risky: losers,
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/summary", (_req, res) => {
  res.json({
    ok: true,
    summary: "시장 요약 데이터는 준비 중입니다.",
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/briefing", (_req, res) => {
  res.json({
    ok: true,
    items: [
      {
        sector: "반도체",
        title: "반도체",
        summary: "AI 반도체와 고성능 메모리 수요 흐름을 확인합니다.",
      },
      {
        sector: "바이오",
        title: "바이오",
        summary: "임상·승인·계약 뉴스에 따른 종목별 변동성을 확인합니다.",
      },
      {
        sector: "자동차",
        title: "자동차",
        summary: "완성차 판매와 전기차 전환 흐름을 확인합니다.",
      },
      {
        sector: "항공",
        title: "항공",
        summary: "여행 수요와 유가, 환율에 따른 항공주 흐름을 확인합니다.",
      },
      {
        sector: "건설",
        title: "건설",
        summary: "부동산 정책과 수주 흐름을 확인합니다.",
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

  res.json({
    market: scope,
    alerts: sortByGainers(rows).slice(0, 20),
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
