// ThemesService — classifies the ENTIRE market universe into investment themes
// (반도체, AI·인공지능, 전기차, ...) plus ETP buckets (ETF / ETN / 레버리지 /
// 인버스) and dynamic, live-quote-driven themes (급등주 / 급락주 / 대형주 /
// 중소형주) and ETF-name-keyword themes (금·은 / 원자재 / 채권).
//
// Classification priority:
//   1. asset-type (LEVERAGED_* / INVERSE_* / ETN / ETF) for the ETP buckets,
//   2. curated SECTOR_MAP (by ticker),
//   3. name-keyword fallback.
// A stock may belong to more than one sector theme. Each theme's stocks are
// filled with real live quotes; names without a live quote are dropped rather
// than fabricated. Empty themes are never emitted.
//
// 배당주 / 고배당 are intentionally OMITTED: the live Quote payload carries no
// dividend data, and we never fabricate values.
import { CATALOG, type CatalogEntry } from "../data/catalog";
import {
  classifyAssetType,
  isLeveraged,
  isInverse,
  isEtn,
  isEtp,
  type AssetType,
} from "../data/asset-type";
import { SECTOR_MAP } from "../data/sectors";
import { MarketDataService } from "./market-data.service";
import { cached, TTL } from "../lib/cache";
import type { Market, Currency } from "../data/catalog";
import type { Quote } from "../sample/types";

export interface ThemeStock {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number;
  changePercent: number;
  marketCap?: number;
  assetType?: AssetType;
}

export interface ThemeGroup {
  key: string;
  label: string;
  count: number;
  stocks: ThemeStock[];
}

export interface ThemesData {
  market: "KR" | "US";
  themes: ThemeGroup[];
}

// Generous per-theme cap so large themes surface a full list.
const THEME_STOCK_LIMIT = 100;

// Dynamic-theme thresholds (applied to real live quote fields).
const SURGE_PCT = 3; // 급등주: +3% 이상
const PLUNGE_PCT = -3; // 급락주: -3% 이하
// 대형주 임계값은 통화별로 다르다. 시총은 원(KRW) / 달러(USD) 원단위로 들어오므로
// 동일 상수로 비교하면 KR 종목이 잘못 분류된다.
const LARGE_CAP_MIN_USD = 10_000_000_000; // $10B 이상
const LARGE_CAP_MIN_KRW = 10_000_000_000_000; // 10조원 이상
function largeCapMin(currency: Currency): number {
  return currency === "USD" ? LARGE_CAP_MIN_USD : LARGE_CAP_MIN_KRW;
}
const DYNAMIC_LIMIT = 40;

interface ThemeDef {
  key: string;
  label: string;
  // Curated SECTOR_MAP labels that belong to this theme.
  sectors: string[];
  // Name keywords (case-insensitive) used as a fallback classifier.
  keywords: string[];
}

// Sector/keyword themes covering the full universe. A stock may match many.
const THEME_DEFS: ThemeDef[] = [
  {
    key: "semiconductor",
    label: "반도체",
    sectors: ["반도체", "전자부품"],
    keywords: [
      "semiconductor",
      "semi",
      "chip",
      "foundry",
      "micron",
      "nvidia",
      "broadcom",
      "반도체",
      "하이닉스",
      "디비하이텍",
      "db하이텍",
      "한미반도체",
      "이노텍",
      "전기",
    ],
  },
  {
    key: "ai",
    label: "AI·인공지능",
    sectors: ["양자·신기술"],
    keywords: [
      "ai",
      "artificial intelligence",
      "palantir",
      "nvidia",
      "quantum",
      "rigetti",
      "인공지능",
      "양자",
    ],
  },
  {
    key: "ev",
    label: "전기차",
    sectors: ["전기차·모빌리티"],
    keywords: [
      "ev",
      "electric vehicle",
      "tesla",
      "rivian",
      "lucid",
      "nio",
      "전기차",
      "차이나전기차",
    ],
  },
  {
    key: "battery",
    label: "2차전지·배터리",
    sectors: ["2차전지", "화학·2차전지"],
    keywords: [
      "battery",
      "lithium",
      "배터리",
      "2차전지",
      "이차전지",
      "전지",
      "에너지솔루션",
      "에스디아이",
      "sdi",
      "엘앤에프",
      "포스코퓨처엠",
      "퓨처엠",
    ],
  },
  {
    key: "bio",
    label: "바이오·제약",
    sectors: ["제약·바이오"],
    keywords: [
      "bio",
      "pharma",
      "therapeut",
      "genom",
      "drug",
      "lilly",
      "pfizer",
      "moderna",
      "바이오",
      "제약",
      "팜",
      "생명과학",
      "신약",
      "셀트리온",
      "유한양행",
      "한미약품",
      "종근당",
      "대웅",
      "녹십자",
      "바이오사이언스",
      "바이오로직스",
    ],
  },
  {
    key: "medical",
    label: "의료기기",
    sectors: ["의료기기"],
    keywords: [
      "medical device",
      "diagnostic",
      "thermo fisher",
      "abbott",
      "의료기기",
      "휴젤",
      "클래시스",
      "루닛",
      "메디톡스",
    ],
  },
  {
    key: "robot",
    label: "로봇",
    sectors: [],
    keywords: [
      "robot",
      "robotics",
      "automation",
      "로봇",
      "로보",
      "레인보우",
      "두산로보틱스",
    ],
  },
  {
    key: "defense",
    label: "방산",
    sectors: ["방산·항공우주", "방산·철도"],
    keywords: [
      "defense",
      "aerospace",
      "lockheed",
      "rtx",
      "boeing",
      "방산",
      "방위",
      "항공우주",
      "에어로스페이스",
      "한화시스템",
      "한국항공우주",
      "현대로템",
      "k방산",
    ],
  },
  {
    key: "shipbuilding",
    label: "조선",
    sectors: ["조선"],
    keywords: [
      "shipbuild",
      "marine",
      "조선",
      "중공업",
      "한화오션",
      "현대중공업",
      "현대미포",
      "삼성중공업",
    ],
  },
  {
    key: "auto",
    label: "자동차",
    sectors: ["자동차", "자동차부품", "전기차·모빌리티"],
    keywords: [
      "motor",
      "auto",
      "vehicle",
      "ford",
      "general motors",
      "자동차",
      "모비스",
      "현대차",
      "기아",
    ],
  },
  {
    key: "bank",
    label: "금융·은행",
    sectors: ["금융"],
    keywords: [
      "bank",
      "financial",
      "jpmorgan",
      "wells fargo",
      "citigroup",
      "금융",
      "은행",
      "지주",
      "카드",
      "캐피탈",
      "카카오뱅크",
      "기업은행",
    ],
  },
  {
    key: "insurance",
    label: "보험",
    sectors: ["보험"],
    keywords: [
      "insurance",
      "보험",
      "화재",
      "생명",
      "해상",
      "메리츠화재",
      "삼성생명",
      "한화생명",
      "현대해상",
    ],
  },
  {
    key: "securities",
    label: "증권",
    sectors: ["증권"],
    keywords: [
      "securities",
      "goldman",
      "morgan stanley",
      "schwab",
      "blackrock",
      "증권",
      "투자증권",
      "금융지주",
      "키움",
    ],
  },
  {
    key: "construction",
    label: "건설",
    sectors: ["지주·건설"],
    keywords: [
      "construction",
      "engineering",
      "건설",
      "엔지니어링",
      "현대건설",
      "대우건설",
      "gs건설",
      "삼성물산",
    ],
  },
  {
    key: "steel",
    label: "철강",
    sectors: ["철강·소재"],
    keywords: [
      "steel",
      "metal",
      "철강",
      "제철",
      "posco",
      "포스코",
      "고려아연",
      "현대제철",
    ],
  },
  {
    key: "chemical",
    label: "화학",
    sectors: ["화학·2차전지"],
    keywords: [
      "chemical",
      "chem",
      "화학",
      "lg화학",
      "금호석유",
      "한화솔루션",
      "oci",
      "skc",
      "롯데케미칼",
    ],
  },
  {
    key: "oil-energy",
    label: "정유·에너지",
    sectors: ["에너지·정유", "에너지"],
    keywords: [
      "oil",
      "gas",
      "petroleum",
      "exxon",
      "chevron",
      "conocophillips",
      "schlumberger",
      "occidental",
      "정유",
      "석유",
      "가스",
      "s-oil",
      "sk이노베이션",
      "가스공사",
    ],
  },
  {
    key: "nuclear",
    label: "원전",
    sectors: [],
    keywords: [
      "nuclear",
      "uranium",
      "원전",
      "원자력",
      "두산에너빌리티",
      "한전기술",
    ],
  },
  {
    key: "solar",
    label: "태양광·신재생",
    sectors: ["태양광·신재생"],
    keywords: [
      "solar",
      "renewable",
      "태양광",
      "신재생",
      "한화솔루션",
      "oci",
      "풍력",
    ],
  },
  {
    key: "power",
    label: "전력·전선",
    sectors: ["전력·유틸리티"],
    keywords: [
      "power",
      "utility",
      "electric power",
      "전력",
      "전선",
      "한국전력",
      "한전",
      "대한전선",
      "ls",
    ],
  },
  {
    key: "food",
    label: "음식·식품",
    sectors: ["음식·식품"],
    keywords: [
      "food",
      "beverage",
      "coca-cola",
      "pepsi",
      "mcdonald",
      "starbucks",
      "식품",
      "제당",
      "음료",
      "제과",
      "농심",
      "오리온",
      "진로",
      "제일제당",
    ],
  },
  {
    key: "cosmetics",
    label: "화장품",
    sectors: ["화장품"],
    keywords: [
      "cosmetic",
      "beauty",
      "화장품",
      "아모레",
      "생활건강",
      "코스메틱",
    ],
  },
  {
    key: "game",
    label: "게임",
    sectors: ["게임"],
    keywords: [
      "game",
      "gaming",
      "게임",
      "엔씨",
      "넷마블",
      "펄어비스",
      "카카오게임즈",
      "크래프톤",
      "위메이드",
    ],
  },
  {
    key: "entertainment",
    label: "엔터",
    sectors: ["엔터·미디어"],
    keywords: [
      "entertainment",
      "엔터",
      "하이브",
      "에스엠",
      "와이지",
      "jyp",
      "기획사",
    ],
  },
  {
    key: "media",
    label: "미디어",
    sectors: ["미디어·콘텐츠"],
    keywords: [
      "media",
      "content",
      "studio",
      "netflix",
      "disney",
      "warner",
      "comcast",
      "미디어",
      "콘텐츠",
      "방송",
      "cj enm",
    ],
  },
  {
    key: "telecom",
    label: "통신",
    sectors: ["통신"],
    keywords: [
      "telecom",
      "wireless",
      "communications",
      "verizon",
      "t-mobile",
      "통신",
      "skt",
      "sk텔레콤",
      "kt",
      "lg유플러스",
    ],
  },
  {
    key: "internet",
    label: "인터넷·플랫폼",
    sectors: ["인터넷·플랫폼"],
    keywords: [
      "internet",
      "platform",
      "commerce",
      "인터넷",
      "플랫폼",
      "naver",
      "네이버",
      "카카오",
      "kakao",
      "amazon",
      "alphabet",
      "meta",
      "uber",
    ],
  },
  {
    key: "cloud-software",
    label: "클라우드·소프트웨어",
    sectors: ["소프트웨어", "IT·서비스", "IT·하드웨어"],
    keywords: [
      "cloud",
      "software",
      "oracle",
      "adobe",
      "salesforce",
      "servicenow",
      "intuit",
      "snowflake",
      "microsoft",
      "소프트웨어",
      "클라우드",
      "에스디에스",
    ],
  },
  {
    key: "cybersecurity",
    label: "사이버보안",
    sectors: ["사이버보안"],
    keywords: ["cybersecurity", "security", "palo alto", "보안", "사이버"],
  },
  {
    key: "travel",
    label: "항공·여행",
    sectors: ["항공·여행"],
    keywords: [
      "airline",
      "air lines",
      "travel",
      "delta",
      "united airlines",
      "southwest",
      "항공",
      "여행",
      "대한항공",
      "아시아나",
      "여행레저",
    ],
  },
  {
    key: "logistics",
    label: "해운·물류",
    sectors: ["운송·해운", "운송·물류"],
    keywords: [
      "shipping",
      "logistics",
      "parcel",
      "fedex",
      "해운",
      "물류",
      "택배",
      "hmm",
      "대한통운",
    ],
  },
  {
    key: "retail",
    label: "유통",
    sectors: ["유통·소비재"],
    keywords: [
      "retail",
      "wholesale",
      "walmart",
      "costco",
      "target",
      "home depot",
      "nike",
      "유통",
      "리테일",
      "이마트",
      "백화점",
    ],
  },
  {
    key: "reit",
    label: "리츠·부동산",
    sectors: [],
    keywords: ["reit", "realty", "real estate", "리츠", "부동산"],
  },
];

// ETP buckets (asset-type driven) — kept SEPARATE from sector themes.
const ETP_KEYS = {
  etf: "etf",
  etn: "etn",
  leverage: "leverage",
  inverse: "inverse",
} as const;

// ETF/ETN name-keyword themes (금·은 / 원자재 / 채권). Applied only to ETP names.
interface EtpKeywordTheme {
  key: string;
  label: string;
  keywords: string[];
}

const ETP_KEYWORD_THEMES: EtpKeywordTheme[] = [
  {
    key: "commodity",
    label: "원자재",
    keywords: [
      "commodity",
      "natural gas",
      "crude",
      "oil",
      "copper",
      "agriculture",
      "원자재",
      "천연가스",
      "원유",
      "구리",
      "농산물",
      "bloomberg",
    ],
  },
  {
    key: "gold-silver",
    label: "금·은",
    keywords: ["gold", "silver", "금", "은", "골드", "실버"],
  },
  {
    key: "bond",
    label: "채권",
    keywords: [
      "bond",
      "treasury",
      "aggregate",
      "채권",
      "국채",
      "회사채",
      "만기",
    ],
  },
];

// Dynamic (live-quote) theme definitions.
const DYNAMIC_THEMES: { key: string; label: string }[] = [
  { key: "surge", label: "급등주" },
  { key: "plunge", label: "급락주" },
  { key: "large-cap", label: "대형주" },
  { key: "mid-small-cap", label: "중소형주" },
];

function inferSector(entry: CatalogEntry): string | undefined {
  return SECTOR_MAP[entry.ticker];
}

// Returns ALL sector/keyword themes an entry matches (sector map by ticker
// first, then name keyword). A stock may appear in more than one theme.
function matchThemes(entry: CatalogEntry): ThemeDef[] {
  const sector = inferSector(entry);
  const name = entry.name.toLowerCase();
  const matched: ThemeDef[] = [];

  for (const def of THEME_DEFS) {
    const bySector = sector != null && def.sectors.includes(sector);
    const byKeyword = def.keywords.some((kw) =>
      name.includes(kw.toLowerCase()),
    );

    if (bySector || byKeyword) matched.push(def);
  }

  return matched;
}

// ETP-name-keyword themes (금·은 / 원자재 / 채권) for an ETP entry.
function matchEtpKeywordThemes(entry: CatalogEntry): EtpKeywordTheme[] {
  const name = entry.name.toLowerCase();
  return ETP_KEYWORD_THEMES.filter((t) =>
    t.keywords.some((kw) => name.includes(kw.toLowerCase())),
  );
}

function assetTypeOf(entry: CatalogEntry): AssetType {
  return classifyAssetType(entry.name, entry.market);
}

function toThemeStock(
  entry: CatalogEntry,
  quote: Quote | null,
  assetType: AssetType,
): ThemeStock {
  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    price: quote?.price ?? 0,
    changePercent: quote?.changePercent ?? 0,
    marketCap: quote?.marketCap,
    assetType,
  };
}

async function buildThemes(market: "KR" | "US"): Promise<ThemesData> {
  // Cache key bumped v2 → v3: taxonomy massively expanded (sector themes,
  // ETF/ETN/레버리지/인버스 buckets, ETF-keyword themes, dynamic quote themes)
  // and the ThemeStock shape gained an optional marketCap field.
  return cached(`themes:v4:${market}`, TTL.quote, async () => {
    const entries = CATALOG.filter((e) => e.market === market);

    // Every catalog entry stays in its sector. Live quotes enrich available
    // symbols, while temporarily unavailable quotes no longer hide the stock.
    const live = await Promise.all(
      entries.map(async (entry) => {
        let quote: Quote | null = null;
        try {
          quote = await MarketDataService.getQuote(entry.ticker);
        } catch {
          quote = null;
        }
        return { entry, quote, assetType: assetTypeOf(entry) };
      }),
    );

    // Bucket ThemeStocks by theme key.
    const buckets = new Map<string, ThemeStock[]>();
    const push = (key: string, stock: ThemeStock) => {
      const list = buckets.get(key) ?? [];
      list.push(stock);
      buckets.set(key, list);
    };

    for (const { entry, quote, assetType } of live) {
      const stock = toThemeStock(entry, quote, assetType);

      // ETP family → separate ETF/ETN/레버리지/인버스 buckets + keyword themes.
      if (isEtp(assetType)) {
        if (isLeveraged(assetType)) {
          push(ETP_KEYS.leverage, stock);
        } else if (isInverse(assetType)) {
          push(ETP_KEYS.inverse, stock);
        } else if (isEtn(assetType)) {
          push(ETP_KEYS.etn, stock);
        } else {
          push(ETP_KEYS.etf, stock);
        }

        for (const t of matchEtpKeywordThemes(entry)) {
          push(t.key, stock);
        }
        continue;
      }

      // Non-ETP → sector/keyword themes (a stock may match several).
      for (const theme of matchThemes(entry)) {
        push(theme.key, stock);
      }

      // Dynamic quote-field themes (stocks only).
      if (quote && Number.isFinite(quote.changePercent)) {
        if (quote.changePercent >= SURGE_PCT) push("surge", stock);
        if (quote.changePercent <= PLUNGE_PCT) push("plunge", stock);
      }

      if (quote && Number.isFinite(quote.marketCap) && quote.marketCap > 0) {
        const capMin = largeCapMin(entry.currency);
        if (quote.marketCap >= capMin) {
          push("large-cap", stock);
        } else {
          push("mid-small-cap", stock);
        }
      }
    }

    // Emission order: sector themes, ETF-keyword themes, ETP buckets, dynamics.
    const themeOrder: { key: string; label: string; dynamic?: boolean }[] = [
      ...THEME_DEFS.map((t) => ({ key: t.key, label: t.label })),
      ...ETP_KEYWORD_THEMES.map((t) => ({ key: t.key, label: t.label })),
      { key: ETP_KEYS.etf, label: "ETF" },
      { key: ETP_KEYS.etn, label: "ETN" },
      { key: ETP_KEYS.leverage, label: "레버리지" },
      { key: ETP_KEYS.inverse, label: "인버스" },
      ...DYNAMIC_THEMES.map((t) => ({
        key: t.key,
        label: t.label,
        dynamic: true,
      })),
    ];

    const themes: ThemeGroup[] = [];

    for (const { key, label, dynamic } of themeOrder) {
      const list = buckets.get(key) ?? [];
      if (list.length === 0) continue; // never emit empty themes

      // 일반 업종·테마는 시가총액이 큰 종목부터 보여준다.
      // 급등·급락만 등락률 순서가 더 의미 있으므로 예외 처리한다.
      const sorted = [...list];
      if (key === "plunge") {
        sorted.sort((a, b) => a.changePercent - b.changePercent);
      } else if (key === "surge") {
        sorted.sort((a, b) => b.changePercent - a.changePercent);
      } else {
        sorted.sort(
          (a, b) =>
            (b.marketCap ?? 0) - (a.marketCap ?? 0) ||
            b.changePercent - a.changePercent,
        );
      }

      const limit = dynamic ? DYNAMIC_LIMIT : THEME_STOCK_LIMIT;
      const stocks = sorted.slice(0, limit);

      themes.push({ key, label, count: stocks.length, stocks });
    }

    return { market, themes };
  });
}

export const ThemesService = {
  getThemes: buildThemes,
};
