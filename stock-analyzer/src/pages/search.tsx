import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Search, TrendingDown, TrendingUp } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { cn } from '@/lib/utils';

type MarketScope = 'ALL' | 'KR' | 'US';
type RankKey = 'recommended' | 'tradingValue' | 'volume' | 'gainers' | 'losers';

interface StockRow {
  ticker: string;
  name: string;
  market?: string;
  currency?: string;
  price?: number | null;
  changePercent?: number | null;
  volume?: number | null;
  tradingValue?: number | null;
  reason?: string;
  rank?: number;
  rating?: {
    score?: number;
    rating?: string;
  };
}

interface MoversResponse {
  popular?: StockRow[];
  volume?: StockRow[];
  recommended?: StockRow[];
  gainers?: StockRow[];
  risky?: StockRow[];
  losers?: StockRow[];
}

const MARKET_TABS: { key: MarketScope; label: string }[] = [
  { key: 'ALL', label: '전체' },
  { key: 'KR', label: '국내주식' },
  { key: 'US', label: '해외주식' },
];

const RANK_TABS: { key: RankKey; label: string }[] = [
  { key: 'recommended', label: 'AI추천' },
  { key: 'tradingValue', label: '거래대금' },
  { key: 'volume', label: '거래량' },
  { key: 'gainers', label: '급상승' },
  { key: 'losers', label: '급하락' },
];

const BASE_STOCK_UNIVERSE: StockRow[] = [
  { ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW' },
  { ticker: '000660', name: 'SK하이닉스', market: 'KR', currency: 'KRW' },
  { ticker: '005380', name: '현대차', market: 'KR', currency: 'KRW' },
  { ticker: '000270', name: '기아', market: 'KR', currency: 'KRW' },
  { ticker: '035420', name: 'NAVER', market: 'KR', currency: 'KRW' },
  { ticker: '035720', name: '카카오', market: 'KR', currency: 'KRW' },
  { ticker: '373220', name: 'LG에너지솔루션', market: 'KR', currency: 'KRW' },
  { ticker: '207940', name: '삼성바이오로직스', market: 'KR', currency: 'KRW' },
  { ticker: '068270', name: '셀트리온', market: 'KR', currency: 'KRW' },
  { ticker: '051910', name: 'LG화학', market: 'KR', currency: 'KRW' },
  { ticker: '006400', name: '삼성SDI', market: 'KR', currency: 'KRW' },
  { ticker: '005490', name: 'POSCO홀딩스', market: 'KR', currency: 'KRW' },
  { ticker: '003670', name: '포스코퓨처엠', market: 'KR', currency: 'KRW' },
  { ticker: '012330', name: '현대모비스', market: 'KR', currency: 'KRW' },
  { ticker: '028260', name: '삼성물산', market: 'KR', currency: 'KRW' },
  { ticker: '055550', name: '신한지주', market: 'KR', currency: 'KRW' },
  { ticker: '105560', name: 'KB금융', market: 'KR', currency: 'KRW' },
  { ticker: '086790', name: '하나금융지주', market: 'KR', currency: 'KRW' },
  { ticker: '316140', name: '우리금융지주', market: 'KR', currency: 'KRW' },
  { ticker: '066570', name: 'LG전자', market: 'KR', currency: 'KRW' },
  { ticker: '096770', name: 'SK이노베이션', market: 'KR', currency: 'KRW' },
  { ticker: '017670', name: 'SK텔레콤', market: 'KR', currency: 'KRW' },
  { ticker: '030200', name: 'KT', market: 'KR', currency: 'KRW' },
  { ticker: '032830', name: '삼성생명', market: 'KR', currency: 'KRW' },
  { ticker: '000810', name: '삼성화재', market: 'KR', currency: 'KRW' },
  { ticker: '033780', name: 'KT&G', market: 'KR', currency: 'KRW' },
  { ticker: '015760', name: '한국전력', market: 'KR', currency: 'KRW' },
  { ticker: '034020', name: '두산에너빌리티', market: 'KR', currency: 'KRW' },
  { ticker: '010130', name: '고려아연', market: 'KR', currency: 'KRW' },
  { ticker: '009540', name: 'HD한국조선해양', market: 'KR', currency: 'KRW' },
  { ticker: '010140', name: '삼성중공업', market: 'KR', currency: 'KRW' },
  { ticker: '329180', name: 'HD현대중공업', market: 'KR', currency: 'KRW' },
  { ticker: '000720', name: '현대건설', market: 'KR', currency: 'KRW' },
  { ticker: '006360', name: 'GS건설', market: 'KR', currency: 'KRW' },
  { ticker: '047040', name: '대우건설', market: 'KR', currency: 'KRW' },
  { ticker: '003490', name: '대한항공', market: 'KR', currency: 'KRW' },
  { ticker: '089590', name: '제주항공', market: 'KR', currency: 'KRW' },
  { ticker: '086520', name: '에코프로', market: 'KR', currency: 'KRW' },
  { ticker: '247540', name: '에코프로비엠', market: 'KR', currency: 'KRW' },
  { ticker: '196170', name: '알테오젠', market: 'KR', currency: 'KRW' },
  { ticker: '028300', name: 'HLB', market: 'KR', currency: 'KRW' },
  { ticker: '277810', name: '레인보우로보틱스', market: 'KR', currency: 'KRW' },
  { ticker: '042700', name: '한미반도체', market: 'KR', currency: 'KRW' },
  { ticker: '352820', name: '하이브', market: 'KR', currency: 'KRW' },
  { ticker: '259960', name: '크래프톤', market: 'KR', currency: 'KRW' },
  { ticker: '036570', name: '엔씨소프트', market: 'KR', currency: 'KRW' },
  { ticker: '251270', name: '넷마블', market: 'KR', currency: 'KRW' },
  { ticker: '011200', name: 'HMM', market: 'KR', currency: 'KRW' },
  { ticker: '018260', name: '삼성에스디에스', market: 'KR', currency: 'KRW' },
  { ticker: '090430', name: '아모레퍼시픽', market: 'KR', currency: 'KRW' },
  { ticker: '004020', name: '현대제철', market: 'KR', currency: 'KRW' },
  { ticker: '011070', name: 'LG이노텍', market: 'KR', currency: 'KRW' },

  { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD' },
  { ticker: 'MSFT', name: 'Microsoft', market: 'US', currency: 'USD' },
  { ticker: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD' },
  { ticker: 'GOOGL', name: 'Alphabet A', market: 'US', currency: 'USD' },
  { ticker: 'GOOG', name: 'Alphabet C', market: 'US', currency: 'USD' },
  { ticker: 'AMZN', name: 'Amazon', market: 'US', currency: 'USD' },
  { ticker: 'META', name: 'Meta Platforms', market: 'US', currency: 'USD' },
  { ticker: 'TSLA', name: 'Tesla', market: 'US', currency: 'USD' },
  { ticker: 'AVGO', name: 'Broadcom', market: 'US', currency: 'USD' },
  { ticker: 'NFLX', name: 'Netflix', market: 'US', currency: 'USD' },
  { ticker: 'AMD', name: 'AMD', market: 'US', currency: 'USD' },
  { ticker: 'INTC', name: 'Intel', market: 'US', currency: 'USD' },
  { ticker: 'PLTR', name: 'Palantir', market: 'US', currency: 'USD' },
  { ticker: 'SOFI', name: 'SoFi', market: 'US', currency: 'USD' },
  { ticker: 'COIN', name: 'Coinbase', market: 'US', currency: 'USD' },
  { ticker: 'UBER', name: 'Uber', market: 'US', currency: 'USD' },
  { ticker: 'AAL', name: 'American Airlines', market: 'US', currency: 'USD' },
  { ticker: 'DAL', name: 'Delta Air Lines', market: 'US', currency: 'USD' },
  { ticker: 'UAL', name: 'United Airlines', market: 'US', currency: 'USD' },
  { ticker: 'JPM', name: 'JPMorgan Chase', market: 'US', currency: 'USD' },
  { ticker: 'BAC', name: 'Bank of America', market: 'US', currency: 'USD' },
  { ticker: 'XOM', name: 'Exxon Mobil', market: 'US', currency: 'USD' },
  { ticker: 'CVX', name: 'Chevron', market: 'US', currency: 'USD' },
  { ticker: 'LLY', name: 'Eli Lilly', market: 'US', currency: 'USD' },
  { ticker: 'UNH', name: 'UnitedHealth', market: 'US', currency: 'USD' },
  { ticker: 'WMT', name: 'Walmart', market: 'US', currency: 'USD' },
  { ticker: 'COST', name: 'Costco', market: 'US', currency: 'USD' },
  { ticker: 'ORCL', name: 'Oracle', market: 'US', currency: 'USD' },
  { ticker: 'ADBE', name: 'Adobe', market: 'US', currency: 'USD' },
  { ticker: 'CRM', name: 'Salesforce', market: 'US', currency: 'USD' },
  { ticker: 'TXN', name: 'Texas Instruments', market: 'US', currency: 'USD' },
  { ticker: 'QCOM', name: 'Qualcomm', market: 'US', currency: 'USD' },
  { ticker: 'AMAT', name: 'Applied Materials', market: 'US', currency: 'USD' },
  { ticker: 'MU', name: 'Micron', market: 'US', currency: 'USD' },
  { ticker: 'SMCI', name: 'Super Micro Computer', market: 'US', currency: 'USD' },
  { ticker: 'ARM', name: 'Arm Holdings', market: 'US', currency: 'USD' },
  { ticker: 'TSM', name: 'TSMC', market: 'US', currency: 'USD' },
  { ticker: 'ASML', name: 'ASML', market: 'US', currency: 'USD' },
  { ticker: 'NVO', name: 'Novo Nordisk', market: 'US', currency: 'USD' },
  { ticker: 'MRNA', name: 'Moderna', market: 'US', currency: 'USD' },
  { ticker: 'PFE', name: 'Pfizer', market: 'US', currency: 'USD' },
  { ticker: 'JNJ', name: 'Johnson & Johnson', market: 'US', currency: 'USD' },
  { ticker: 'BA', name: 'Boeing', market: 'US', currency: 'USD' },
  { ticker: 'DIS', name: 'Disney', market: 'US', currency: 'USD' },
  { ticker: 'NKE', name: 'Nike', market: 'US', currency: 'USD' },
  { ticker: 'SHOP', name: 'Shopify', market: 'US', currency: 'USD' },
  { ticker: 'CRWD', name: 'CrowdStrike', market: 'US', currency: 'USD' },
  { ticker: 'SNOW', name: 'Snowflake', market: 'US', currency: 'USD' },
  { ticker: 'RGTI', name: 'Rigetti Computing', market: 'US', currency: 'USD' },
  { ticker: 'IONQ', name: 'IonQ', market: 'US', currency: 'USD' },
];

const KIWOOM_ORDER = new Map(
  BASE_STOCK_UNIVERSE.map((row, index) => [row.ticker.toUpperCase(), index]),
);

function readInitialMarket(): MarketScope {
  if (typeof window === 'undefined') return 'ALL';

  const params = new URLSearchParams(window.location.search);
  const market = params.get('market');

  if (market === 'KR' || market === 'US' || market === 'ALL') return market;

  return 'ALL';
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()［］\[\]{}·.,_-]/g, '');
}

function normalizeMarket(row: StockRow): 'KR' | 'US' {
  const market = String(row.market ?? '').toUpperCase();

  if (market.includes('KR')) return 'KR';
  if (market.includes('US')) return 'US';

  return /^\d/.test(row.ticker) ? 'KR' : 'US';
}

function normalizeCurrency(row: StockRow) {
  if (row.currency) return row.currency;

  return normalizeMarket(row) === 'KR' ? 'KRW' : 'USD';
}

function normalizeRow(row: StockRow): StockRow {
  return {
    ...row,
    ticker: String(row.ticker ?? '').trim(),
    name: String(row.name ?? row.ticker ?? '').trim(),
    market: normalizeMarket(row),
    currency: normalizeCurrency(row),
    price: typeof row.price === 'number' ? row.price : null,
    changePercent:
      typeof row.changePercent === 'number' ? row.changePercent : 0,
    tradingValue:
      typeof row.tradingValue === 'number' ? row.tradingValue : null,
    volume: typeof row.volume === 'number' ? row.volume : null,
  };
}

function dedupeRows(rows: StockRow[]) {
  const map = new Map<string, StockRow>();

  for (const raw of rows) {
    if (!raw?.ticker) continue;

    const row = normalizeRow(raw);
    const key = row.ticker.toUpperCase();
    const prev = map.get(key);

    map.set(key, {
      ...prev,
      ...row,
      name: row.name || prev?.name || row.ticker,
    });
  }

  return Array.from(map.values()).map(normalizeRow);
}

function filterByMarket(rows: StockRow[], market: MarketScope) {
  if (market === 'ALL') return rows;

  return rows.filter((row) => normalizeMarket(row) === market);
}

function orderIndex(row: StockRow) {
  return KIWOOM_ORDER.get(row.ticker.toUpperCase()) ?? 99999;
}

function tradingValueScore(row: StockRow) {
  return row.tradingValue ?? 0;
}

function volumeScore(row: StockRow) {
  return row.volume ?? 0;
}

function rankRows(rows: StockRow[], rank: RankKey) {
  const copied = [...rows];

  if (rank === 'gainers') {
    return copied.sort((a, b) => {
      const diff = (b.changePercent ?? 0) - (a.changePercent ?? 0);

      return diff !== 0 ? diff : orderIndex(a) - orderIndex(b);
    });
  }

  if (rank === 'losers') {
    return copied.sort((a, b) => {
      const diff = (a.changePercent ?? 0) - (b.changePercent ?? 0);

      return diff !== 0 ? diff : orderIndex(a) - orderIndex(b);
    });
  }

  if (rank === 'recommended') {
    return copied.sort((a, b) => {
      const scoreB = b.rating?.score ?? Math.abs(b.changePercent ?? 0);
      const scoreA = a.rating?.score ?? Math.abs(a.changePercent ?? 0);

      return scoreB !== scoreA ? scoreB - scoreA : orderIndex(a) - orderIndex(b);
    });
  }

  if (rank === 'tradingValue') {
    return copied.sort((a, b) => {
      const diff = tradingValueScore(b) - tradingValueScore(a);

      if (diff !== 0) return diff;

      return orderIndex(a) - orderIndex(b);
    });
  }

  if (rank === 'volume') {
    return copied.sort((a, b) => {
      const diff = volumeScore(b) - volumeScore(a);

      if (diff !== 0) return diff;

      return orderIndex(a) - orderIndex(b);
    });
  }

  return copied.sort((a, b) => orderIndex(a) - orderIndex(b));
}

async function hydrateQuotes(rows: StockRow[]) {
  const cleanRows = dedupeRows(rows).slice(0, 200);
  const tickers = cleanRows.map((row) => row.ticker).filter(Boolean);

  if (tickers.length === 0) return [];

  try {
    const res = await fetch(
      `/api/quotes?tickers=${encodeURIComponent(tickers.join(','))}`,
    );

    if (!res.ok) return cleanRows;

    const data = await res.json();
    const quotes = Array.isArray(data.quotes)
      ? (data.quotes as StockRow[])
      : [];

    const quoteMap = new Map(
      quotes.map((quote) => [String(quote.ticker).toUpperCase(), quote]),
    );

    return cleanRows.map((row) => {
      const quote = quoteMap.get(row.ticker.toUpperCase());

      return normalizeRow({
        ...row,
        ...quote,
        name: quote?.name ?? row.name,
        market: quote?.market ?? row.market,
        currency: quote?.currency ?? row.currency,
      });
    });
  } catch {
    return cleanRows;
  }
}

function localSearchRows(query: string) {
  const needle = normalizeText(query);

  if (!needle) return BASE_STOCK_UNIVERSE;

  return BASE_STOCK_UNIVERSE.filter((row) => {
    const name = normalizeText(row.name);
    const ticker = normalizeText(row.ticker);
    const target = `${name}${ticker}`;

    return (
      target.includes(needle) ||
      needle.includes(name) ||
      needle.includes(ticker)
    );
  });
}

async function fetchSearchRows(query: string, market: MarketScope, rank: RankKey) {
  const localMatches = localSearchRows(query);

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = res.ok ? await res.json() : null;
    const apiRows = Array.isArray(data?.results)
      ? (data.results as StockRow[])
      : [];

    const merged = dedupeRows([...apiRows, ...localMatches]);
    const filtered = filterByMarket(merged, market);
    const hydrated = await hydrateQuotes(filtered);

    return rankRows(hydrated, rank);
  } catch {
    const hydrated = await hydrateQuotes(filterByMarket(localMatches, market));

    return rankRows(hydrated, rank);
  }
}

async function fetchMoverRows(market: MarketScope, rank: RankKey) {
  const localRows = filterByMarket(BASE_STOCK_UNIVERSE, market);

  // 거래량·거래대금·급등·급락은 국내/미국 모두 키움 랭킹을 우선 사용한다.
  // 키움이 아직 설정되지 않았거나 해당 TR 호출이 실패하면 기존 데이터로 자동 대체한다.
  if (market !== 'ALL' && rank !== 'recommended') {
    try {
      const response = await fetch(
        `/api/kiwoom/rankings?market=${market}&type=${rank}&limit=30`,
      );
      const data = response.ok ? await response.json() : null;
      const kiwoomRows = Array.isArray(data?.rows)
        ? (data.rows as StockRow[])
        : [];

      if (kiwoomRows.length > 0) {
        const hydrated = await hydrateQuotes(kiwoomRows.slice(0, 30));
        return rankRows(hydrated, rank).slice(0, 30);
      }
    } catch {
      // Existing provider fallback below.
    }
  }

  try {
    const res = await fetch(`/api/market/movers?market=${market}`);
    const data = res.ok ? ((await res.json()) as MoversResponse) : {};

    let sourceRows: StockRow[] = [];

    if (rank === 'gainers') {
      sourceRows = data.gainers ?? [];
    } else if (rank === 'losers') {
      sourceRows = data.losers ?? data.risky ?? [];
    } else if (rank === 'tradingValue') {
      sourceRows = data.popular ?? [];
    } else if (rank === 'volume') {
      sourceRows = data.volume ?? data.popular ?? [];
    } else {
      sourceRows = data.recommended ?? [];
    }

    const merged = dedupeRows([...sourceRows, ...localRows]);
    const hydrated = await hydrateQuotes(filterByMarket(merged, market));

    return rankRows(hydrated, rank).slice(0, 30);
  } catch {
    const hydrated = await hydrateQuotes(localRows);

    return rankRows(hydrated, rank).slice(0, 30);
  }
}

function formatPrice(row: StockRow) {
  const price = row.price;

  if (price == null || !Number.isFinite(price)) return '확인중';

  if (normalizeMarket(row) === 'US') {
    return `$${price.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
  }

  return `${Math.round(price).toLocaleString()}원`;
}

function formatChangePercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '0.00%';

  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function changeClass(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.01) {
    return 'text-muted-foreground';
  }

  return value > 0 ? 'text-positive' : 'text-destructive';
}

function reasonText(rank: RankKey) {
  if (rank === 'recommended') return 'AI 기준 추천 종목입니다.';
  if (rank === 'tradingValue') return '거래대금 기준 상위 종목입니다.';
  if (rank === 'volume') return '거래량 기준 상위 종목입니다.';
  if (rank === 'gainers') return '등락률 기준 급상승 종목입니다.';
  if (rank === 'losers') return '등락률 기준 급하락 종목입니다.';

  return '전체 종목 목록입니다.';
}

export default function SearchPage() {
  const [, navigate] = useLocation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [market, setMarket] = useState<MarketScope>(() => readInitialMarket());
  const [rank, setRank] = useState<RankKey>('recommended');
  const [query, setQuery] = useState('');

  useEffect(() => {
    listRef.current?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }, [market, rank, query]);

  const rowsQuery = useQuery({
    queryKey: ['stock-list-page', market, rank, query],
    queryFn: () => {
      const trimmed = query.trim();

      if (trimmed) return fetchSearchRows(trimmed, market, rank);

      return fetchMoverRows(market, rank);
    },
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);

  function handleMarket(next: MarketScope) {
    setMarket(next);
    navigate(`/search?market=${next}`);
  }

  function handleStockClick(ticker: string) {
    const back = `/search?market=${market}`;

    navigate(`/stock/${ticker}?back=${encodeURIComponent(back)}`);
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background">
      <header className="border-b border-card-border px-5 pb-3 pt-6">
        <div className="grid grid-cols-3 gap-2">
          {MARKET_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => handleMarket(item.key)}
              className={cn(
                'rounded-[1.35rem] border px-3 py-3 text-sm font-black transition active:scale-[0.98]',
                market === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-5 gap-2">
          {RANK_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setRank(item.key)}
              className={cn(
                'rounded-[1.15rem] border px-1.5 py-2.5 text-[10px] font-black transition active:scale-[0.98]',
                rank === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="mt-3 flex items-center gap-2 rounded-[1.4rem] border border-card-border bg-card px-4 py-3">
          <Search className="h-5 w-5 shrink-0 text-muted-foreground" />

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="전체 검색"
            className="min-w-0 flex-1 bg-transparent text-sm font-extrabold outline-none placeholder:text-muted-foreground"
          />
        </label>
      </header>

      <main ref={listRef} className="flex-1 overflow-y-auto px-5 pb-24 pt-4">
        {rowsQuery.isLoading ? (
          <div className="rounded-[1.75rem] border border-card-border bg-card px-5 py-10 text-center">
            <p className="text-base font-black">종목을 불러오는 중입니다.</p>
            <p className="mt-2 text-sm font-bold text-muted-foreground">
              국내·해외 종목 데이터를 확인하고 있습니다.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-[1.75rem] border border-card-border bg-card px-5 py-10 text-center">
            <p className="text-base font-black">표시할 종목이 없습니다.</p>
            <p className="mt-2 text-sm font-bold text-muted-foreground">
              검색어를 바꾸거나 다른 탭을 선택해주세요.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row, index) => (
              <button
                key={`${row.ticker}:${index}`}
                type="button"
                onClick={() => handleStockClick(row.ticker)}
                className="w-full rounded-[1.45rem] border border-card-border bg-card px-4 py-3 text-left shadow-sm transition active:scale-[0.99]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-black text-muted-foreground">
                      {index + 1}
                    </div>

                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-base font-black">
                          {row.name}
                        </p>

                        <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-black text-muted-foreground">
                          {normalizeMarket(row)}
                        </span>
                      </div>

                      <p className="mt-0.5 text-xs font-bold text-muted-foreground">
                        {row.ticker}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-black">{formatPrice(row)}</p>

                    <p
                      className={cn(
                        'mt-1 flex items-center justify-end gap-1 text-sm font-black',
                        changeClass(row.changePercent),
                      )}
                    >
                      {(row.changePercent ?? 0) >= 0 ? (
                        <TrendingUp className="h-3.5 w-3.5" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5" />
                      )}
                      {formatChangePercent(row.changePercent)}
                    </p>
                  </div>
                </div>

                <p className="mt-2 truncate text-xs font-bold text-muted-foreground">
                  {reasonText(rank)}
                </p>
              </button>
            ))}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
}