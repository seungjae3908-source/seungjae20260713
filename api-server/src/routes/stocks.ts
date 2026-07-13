import { Router, type IRouter } from "express";
import { MarketDataService } from "../services/market-data.service";

const router: IRouter = Router();

function normalizeTicker(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeTimeframe(value: unknown) {
  const raw = String(value ?? "1D").trim();

  if (!raw) return "1D";

  return raw;
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function xmlTag(block: string, tag: string) {
  const match = block.match(
    new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i"),
  );
  return match ? decodeXml(match[1]) : "";
}

function companyNameFromProfile(profile: any, ticker: string) {
  return String(
    profile?.name ??
      profile?.companyName ??
      profile?.corp_name ??
      profile?.company?.name ??
      ticker,
  ).trim();
}

let dartCorpMapCache: Map<string, string> | null = null;

async function getDartCorpCode(ticker: string, apiKey: string) {
  if (!dartCorpMapCache) {
    const response = await fetch(
      "https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=" +
        encodeURIComponent(apiKey),
    );
    if (!response.ok) throw new Error("DART_CORP_CODE_HTTP_" + response.status);
    const xml = await response.text();
    const map = new Map<string, string>();
    for (const block of xml.match(/<list>[\s\S]*?<\/list>/g) ?? []) {
      const stockCode = xmlTag(block, "stock_code");
      const corpCode = xmlTag(block, "corp_code");
      if (stockCode && corpCode) map.set(stockCode, corpCode);
    }
    dartCorpMapCache = map;
  }
  return dartCorpMapCache.get(ticker) ?? "";
}

async function fetchDartFilings(ticker: string) {
  const apiKey = String(process.env.DART_API_KEY ?? "").trim();
  const fallback = {
    title: "DART에서 " + ticker + " 공시 전체보기",
    report_nm: "공식 전자공시 검색",
    date: "실시간",
    rcept_dt: "",
    url: "https://dart.fss.or.kr/dsab001/main.do",
    source: "DART",
  };

  if (!apiKey || !/^\d{6}$/.test(ticker)) return [fallback];

  const corpCode = await getDartCorpCode(ticker, apiKey);
  if (!corpCode) return [fallback];

  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const bgnDe = from.toISOString().slice(0, 10).replace(/-/g, "");
  const url =
    "https://opendart.fss.or.kr/api/list.json?crtfc_key=" +
    encodeURIComponent(apiKey) +
    "&corp_code=" +
    encodeURIComponent(corpCode) +
    "&bgn_de=" +
    bgnDe +
    "&last_reprt_at=Y&page_count=100&sort=date&sort_mth=desc";
  const response = await fetch(url);
  if (!response.ok) throw new Error("DART_LIST_HTTP_" + response.status);
  const data: any = await response.json();
  if (!Array.isArray(data?.list)) return [fallback];

  return data.list.map((item: any) => ({
    ...item,
    title: item.report_nm,
    date: item.rcept_dt,
    url: item.rcept_no
      ? "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + item.rcept_no
      : fallback.url,
    source: "DART",
  }));
}

function simpleDartSummary(item: any) {
  const title = String(item?.title ?? item?.report_nm ?? "").trim();
  if (
    !title ||
    title.includes("공시 전체보기") ||
    title.includes("공식 전자공시 검색")
  ) {
    return "DART에서 이 종목의 전체 공시 원문을 확인할 수 있습니다.";
  }
  if (/주주총회|주총/.test(title))
    return "주주총회 개최 또는 관련 일정이 공시되었습니다.";
  if (/현금.*배당|배당.*결정|배당금/.test(title))
    return "주주 배당과 관련된 내용이 공시되었습니다.";
  if (/유상증자/.test(title))
    return "유상증자 계획 또는 진행 내용이 공시되었습니다.";
  if (/무상증자/.test(title))
    return "무상증자 계획 또는 진행 내용이 공시되었습니다.";
  if (/자기주식|자사주/.test(title))
    return "자사주 취득·처분과 관련된 내용이 공시되었습니다.";
  if (/단일판매|공급계약|수주/.test(title))
    return "신규 계약 또는 수주 관련 내용이 공시되었습니다.";
  if (/잠정.*실적|영업.*실적|매출액.*손익/.test(title))
    return "최근 경영실적과 관련된 내용이 공시되었습니다.";
  if (/사업보고서/.test(title))
    return "사업보고서가 제출되어 회사의 주요 실적과 현황을 확인할 수 있습니다.";
  if (/분기보고서/.test(title))
    return "분기보고서가 제출되어 최근 분기 실적을 확인할 수 있습니다.";
  if (/반기보고서/.test(title))
    return "반기보고서가 제출되어 상반기 실적을 확인할 수 있습니다.";
  if (/최대주주/.test(title))
    return "최대주주 또는 주요 지분 변동 내용이 공시되었습니다.";
  const shortTitle = title.length > 58 ? title.slice(0, 58) + "…" : title;
  return shortTitle + " 관련 공시가 등록되었습니다.";
}

function simpleNewsSummary(item: any) {
  const source = String(item?.source ?? "").trim();
  let title = String(item?.title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const suffix = source ? " - " + source : "";
  if (suffix && title.endsWith(suffix))
    title = title.slice(0, -suffix.length).trim();
  const shortTitle = title.length > 70 ? title.slice(0, 70) + "…" : title;
  return shortTitle
    ? shortTitle + " 관련 소식입니다."
    : "최근 관련 뉴스를 확인했습니다.";
}

async function fetchGoogleNews(ticker: string) {
  let profile: any = null;
  try {
    profile = await MarketDataService.getCompanyProfile(ticker);
  } catch {
    profile = null;
  }
  const companyName = companyNameFromProfile(profile, ticker);
  const isKorean = /^\d{6}$/.test(ticker);
  const query = isKorean
    ? '"' + companyName + '" 주식'
    : '"' + companyName + '" stock';
  const feedUrl =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=" +
    (isKorean ? "ko" : "en-US") +
    "&gl=" +
    (isKorean ? "KR" : "US") +
    "&ceid=" +
    (isKorean ? "KR:ko" : "US:en");
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "seungjae-stock-app/1.0" },
  });
  if (!response.ok) throw new Error("NEWS_RSS_HTTP_" + response.status);
  const xml = await response.text();

  return (xml.match(/<item>[\s\S]*?<\/item>/g) ?? [])
    .slice(0, 30)
    .map((block) => ({
      title: xmlTag(block, "title"),
      url: xmlTag(block, "link"),
      link: xmlTag(block, "link"),
      publishedAt: xmlTag(block, "pubDate"),
      date: xmlTag(block, "pubDate"),
      source: xmlTag(block, "source") || "Google News",
    }))
    .filter((item) => item.title && item.url);
}

// GET /api/stocks/:ticker/quote
router.get("/:ticker/quote", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER",
    });
    return;
  }

  try {
    const quote = await MarketDataService.getQuoteRow(ticker);

    if (!quote) {
      res.status(404).json({
        error: "QUOTE_NOT_FOUND",
        ticker,
      });
      return;
    }

    res.json(quote);
  } catch (error) {
    console.error("stock quote route error:", error);

    res.status(500).json({
      error: "STOCK_QUOTE_ROUTE_ERROR",
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/profile
router.get("/:ticker/profile", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER",
    });
    return;
  }

  try {
    const profile = await MarketDataService.getCompanyProfile(ticker);

    res.json(profile);
  } catch (error) {
    console.error("stock profile route error:", error);

    res.status(500).json({
      error: "STOCK_PROFILE_ROUTE_ERROR",
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/company
router.get("/:ticker/company", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER",
    });
    return;
  }

  try {
    const profile = await MarketDataService.getCompanyProfile(ticker);

    res.json(profile);
  } catch (error) {
    console.error("stock company route error:", error);

    res.status(500).json({
      error: "STOCK_COMPANY_ROUTE_ERROR",
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/candles?tf=1D
router.get("/:ticker/candles", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  const timeframe = normalizeTimeframe(req.query.tf ?? req.query.timeframe);

  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER",
    });
    return;
  }

  try {
    const candles = await MarketDataService.getCandles(
      ticker,
      timeframe as any,
    );

    res.json({
      ticker,
      timeframe,
      candles,
    });
  } catch (error) {
    console.error("stock candles route error:", error);

    res.status(500).json({
      error: "STOCK_CANDLES_ROUTE_ERROR",
      ticker,
      timeframe,
    });
  }
});

// GET /api/stocks/:ticker/rating
router.get("/:ticker/rating", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER",
    });
    return;
  }

  try {
    const rating = await MarketDataService.getRating(ticker);

    res.json({
      ticker,
      rating,
    });
  } catch (error) {
    console.error("stock rating route error:", error);

    res.status(500).json({
      error: "STOCK_RATING_ROUTE_ERROR",
      ticker,
    });
  }
});

// GET /api/stocks/:ticker/financials
router.get("/:ticker/financials", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    items: [],
    summary: "재무제표 데이터는 연결 준비 중입니다.",
  });
});

// GET /api/stocks/:ticker/risk
router.get("/:ticker/risk", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);

  res.json({
    ticker,
    delistingRisk: false,
    riskLevel: "normal",
    summary: "현재 확인된 상장폐지 고위험 신호는 없습니다.",
  });
});

// GET /api/stocks/:ticker/filings
router.get("/:ticker/filings", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  try {
    const items = await fetchDartFilings(ticker);
    res.json({
      ticker,
      filings: items,
      items,
      summary:
        simpleDartSummary(items[0]) +
        (items.length > 1
          ? " 최근 1년 공시 " + items.length + "건을 불러왔습니다."
          : ""),
    });
  } catch (error) {
    console.error("stock filings route error:", error);
    const items = await fetchDartFilings("").catch(() => []);
    res.json({
      ticker,
      filings: items,
      items,
      summary: "DART 연결을 확인해 주세요.",
    });
  }
});

// GET /api/stocks/:ticker/disclosures
router.get("/:ticker/disclosures", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  try {
    const items = await fetchDartFilings(ticker);
    res.json({
      ticker,
      disclosures: items,
      items,
      summary: simpleDartSummary(items[0]),
    });
  } catch (error) {
    console.error("stock disclosures route error:", error);
    res.json({
      ticker,
      disclosures: [],
      items: [],
      summary: "DART 연결을 확인해 주세요.",
    });
  }
});

// GET /api/stocks/:ticker/news
router.get("/:ticker/news", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  try {
    const items = await fetchGoogleNews(ticker);
    res.json({
      ticker,
      news: items,
      items,
      summary: items.length
        ? simpleNewsSummary(items[0])
        : "최근 관련 뉴스가 없습니다.",
    });
  } catch (error) {
    console.error("stock news route error:", error);
    res.status(502).json({
      ticker,
      news: [],
      items: [],
      summary: "뉴스 제공처 연결이 잠시 지연되고 있습니다.",
    });
  }
});

function cleanFinanceCell(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function financeNumber(value: string | undefined) {
  if (!value) return 0;
  const normalized = value
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/[^0-9+\-.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function financeTableRows(html: string) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) =>
      [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        cleanFinanceCell(cell[1]),
      ),
    )
    .filter((cells) => cells.length > 0);
}

function groupInvestorRows(rows: any[], period: string) {
  const size =
    period === "weekly"
      ? 5
      : period === "monthly"
        ? 20
        : period === "yearly"
          ? 240
          : 1;
  if (size === 1) return rows.slice(0, 30);
  const grouped = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (!chunk.length) continue;
    grouped.push({
      date: chunk[0].date,
      individual: chunk.reduce((sum, row) => sum + row.individual, 0),
      institution: chunk.reduce((sum, row) => sum + row.institution, 0),
      foreign: chunk.reduce((sum, row) => sum + row.foreign, 0),
    });
  }
  return grouped.slice(0, 30);
}

router.get("/:ticker/market-flow", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  const period = String(req.query.period ?? "daily");
  if (!/^\d{6}$/.test(ticker)) {
    return res.json({
      ticker,
      period,
      available: false,
      rows: [],
      totals: { individual: 0, institution: 0, foreign: 0 },
      message: "해외 종목의 투자자별 수급은 현재 제공처에서 지원하지 않습니다.",
    });
  }
  try {
    const response = await fetch(
      `https://finance.naver.com/item/frgn.naver?code=${ticker}&page=1`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://finance.naver.com/",
        },
      },
    );
    const html = await response.text();
    const dailyRows = financeTableRows(html)
      .filter(
        (cells) =>
          /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 7,
      )
      .map((cells) => {
        const institution = financeNumber(cells[5]);
        const foreign = financeNumber(cells[6]);
        return {
          date: cells[0],
          individual: -(institution + foreign),
          institution,
          foreign,
        };
      });
    const rows = groupInvestorRows(dailyRows, period);
    const totals = rows.reduce(
      (acc, row) => ({
        individual: acc.individual + row.individual,
        institution: acc.institution + row.institution,
        foreign: acc.foreign + row.foreign,
      }),
      { individual: 0, institution: 0, foreign: 0 },
    );
    res.json({
      ticker,
      period,
      available: rows.length > 0,
      rows,
      totals,
      note: "개인은 기관·외국인 순매매의 반대값으로 추정한 참고치입니다.",
    });
  } catch (error) {
    console.error("investor flow route error:", error);
    res.json({
      ticker,
      period,
      available: false,
      rows: [],
      totals: { individual: 0, institution: 0, foreign: 0 },
      message: "투자자별 수급 데이터를 불러오지 못했습니다.",
    });
  }
});

router.get("/:ticker/short-selling", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!/^\d{6}$/.test(ticker)) {
    return res.json({
      ticker,
      available: false,
      rows: [],
      latest: null,
      message: "해외 공매도 데이터는 별도 제공처 연동이 필요합니다.",
    });
  }
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://finance.naver.com/",
    };
    const [tradeResponse, balanceResponse] = await Promise.all([
      fetch(`https://finance.naver.com/item/short_trade.naver?code=${ticker}`, {
        headers,
      }),
      fetch(
        `https://finance.naver.com/item/short_balance.naver?code=${ticker}`,
        { headers },
      ),
    ]);
    const [tradeHtml, balanceHtml] = await Promise.all([
      tradeResponse.text(),
      balanceResponse.text(),
    ]);
    const tradeRows = financeTableRows(tradeHtml)
      .filter(
        (cells) =>
          /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6,
      )
      .map((cells) => ({
        date: cells[0],
        shortVolume: financeNumber(cells[cells.length - 2]),
        ratio: financeNumber(cells[cells.length - 1]),
      }));
    const balanceMap = new Map(
      financeTableRows(balanceHtml)
        .filter(
          (cells) =>
            /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6,
        )
        .map((cells) => [
          cells[0],
          {
            balance: financeNumber(cells[cells.length - 4]),
            balanceAmount: financeNumber(cells[cells.length - 3]),
            balanceRatio: financeNumber(cells[cells.length - 1]),
          },
        ]),
    );
    const rows = tradeRows
      .slice(0, 30)
      .map((row) => ({ ...row, ...(balanceMap.get(row.date) ?? {}) }));
    const latestBalance = [...balanceMap.values()][0] ?? {};
    const latest = rows.length
      ? { ...rows[0], ...latestBalance, borrowRate: null }
      : null;
    res.json({
      ticker,
      available: rows.length > 0,
      rows,
      latest,
      note: "대차 이자율은 현재 제공처가 공개하지 않아 미제공으로 표시됩니다.",
    });
  } catch (error) {
    console.error("short selling route error:", error);
    res.json({
      ticker,
      available: false,
      rows: [],
      latest: null,
      message: "공매도 데이터를 불러오지 못했습니다.",
    });
  }
});

export default router;
