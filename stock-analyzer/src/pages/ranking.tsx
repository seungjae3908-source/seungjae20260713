// 순위 전용 전체 화면 — 20개씩, 최대 100개(5페이지), 실제 데이터만 표시한다.
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { BottomNav } from '@/components/bottom-nav';
import { memberGradeLabel, useMemberPermissions } from '@/lib/permissions';
import { useAuth } from '@/lib/auth';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
type SortMode = 'default' | 'changePercent_desc' | 'changePercent_asc';

const PAGE_SIZE = 20;
const MAX_ROWS = 100;

const CATEGORY_LABEL: Record<string, string> = {
  marketCap: '시가총액 순위',
  tradingValue: '거래대금 순위',
  volume: '거래량 순위',
  gainers: '급상승 순위',
  losers: '급하락 순위',
  ai: 'AI 분석 순위',
};

const SORT_TABS: Array<{ key: SortMode; label: string }> = [
  { key: 'default', label: '기본' },
  { key: 'changePercent_desc', label: '등락률 높은순' },
  { key: 'changePercent_asc', label: '등락률 낮은순' },
];

function parsePath(path: string): {
  kind: 'stock' | 'coin';
  market: 'KR' | 'US' | 'spot' | 'futures';
  category: string;
} | null {
  const m = path.match(/^\/(stocks|coins)\/([a-z]+)\/ranking\/([A-Za-z]+)/);
  if (!m) return null;
  if (m[1] === 'stocks') {
    const market = m[2] === 'us' ? 'US' : 'KR';
    return { kind: 'stock', market, category: m[3] };
  }
  const market = m[2] === 'futures' ? 'futures' : 'spot';
  return { kind: 'coin', market, category: m[3] };
}

function baseValue(row: AnyObj, category: string): string {
  const market = row.market === 'US' ? 'US' : 'KR';
  const fmt = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '데이터 없음';
    if (market === 'KR') {
      if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
      if (n >= 1e8) return `${(n / 1e8).toFixed(0)}억`;
      if (n >= 1e4) return `${(n / 1e4).toFixed(0)}만`;
    } else {
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    }
    return Math.round(n).toLocaleString();
  };
  if (category === 'marketCap') return `시총 ${fmt(row.marketCap)}`;
  if (category === 'volume') return `거래량 ${fmt(row.volume)}`;
  if (category === 'ai') return row.rating?.score != null ? `분석 점수 ${Math.round(Number(row.rating.score))}점` : '참고용 분석';
  if (category === 'gainers' || category === 'losers') return `등락률 ${formatAppPercent(Number(row.changePercent ?? 0))}`;
  return `거래대금 ${fmt(row.tradingValue)}`;
}

export default function RankingPage() {
  const [location, navigate] = useLocation();
  const parsed = parsePath(location.split('?')[0]);
  const permissions = useMemberPermissions();
  const auth = useAuth() as AnyObj;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortMode>('default');

  const isCoin = parsed?.kind === 'coin';
  const isFutures = isCoin && parsed?.market === 'futures';
  const canUseFutures = permissions.has('futures');
  const category = parsed?.category ?? 'tradingValue';

  const stockQuery = useQuery({
    queryKey: ['ranking', parsed?.market, category, page, sort],
    queryFn: () =>
      apiGet<AnyObj>(
        `/market/rankings?market=${parsed?.market}&category=${category}&page=${page}&limit=${PAGE_SIZE}&sort=${sort}`,
      ),
    enabled: !!parsed && !isCoin,
    refetchInterval: 60_000,
  });

  const coinQuery = useQuery({
    queryKey: ['ranking-coin', parsed?.market],
    queryFn: () => apiGet<AnyObj>(`/crypto/${parsed?.market}/tickers`),
    enabled: !!parsed && isCoin && (!isFutures || canUseFutures),
    refetchInterval: 15_000,
  });

  const coinRows = useMemo(() => {
    if (!isCoin) return [];
    const raw = (coinQuery.data?.tickers ?? []) as AnyObj[];
    let rows = raw.map((row) => ({
      ...row,
      ticker: String(row.symbol ?? ''),
      name: displayCoinName(String(row.symbol ?? ''), row.koreanName, row.englishName),
      market: parsed?.market === 'futures' ? 'USDT' : 'KRW',
      currency: parsed?.market === 'futures' ? 'USDT' : 'KRW',
      changePercent: Number(row.changePercent ?? row.changePercent24h ?? 0),
      tradingValue: Number(row.tradingValue24h ?? 0),
      volume: Number(row.volume24h ?? row.volume ?? 0),
      marketCap: Number(row.marketCap ?? 0),
    }));
    if (category === 'ai') return [];
    if (category === 'marketCap') rows = rows.filter((r) => r.marketCap > 0).sort((a, b) => b.marketCap - a.marketCap);
    else if (category === 'volume') rows = rows.sort((a, b) => b.volume - a.volume);
    else if (category === 'gainers') rows = rows.filter((r) => r.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent);
    else if (category === 'losers') rows = rows.filter((r) => r.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent);
    else rows = rows.sort((a, b) => b.tradingValue - a.tradingValue);
    let ranked = rows.slice(0, MAX_ROWS).map((row, index) => ({ ...row, rank: index + 1 }));
    if (sort === 'changePercent_desc') ranked = [...ranked].sort((a, b) => b.changePercent - a.changePercent);
    if (sort === 'changePercent_asc') ranked = [...ranked].sort((a, b) => a.changePercent - b.changePercent);
    return ranked;
  }, [category, coinQuery.data, isCoin, parsed?.market, sort]);

  if (!parsed) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <p className="text-center text-sm font-bold text-muted-foreground">잘못된 경로입니다.</p>
      </div>
    );
  }

  const title = CATEGORY_LABEL[category] ?? '순위';
  const marketLabel = parsed.kind === 'stock'
    ? parsed.market === 'KR' ? '국내주식' : '해외주식'
    : parsed.market === 'spot' ? '코인 현물' : '코인 선물';
  const backHref = parsed.kind === 'stock'
    ? parsed.market === 'KR' ? '/stocks/kr' : '/stocks/us'
    : parsed.market === 'spot' ? '/coins/spot' : '/coins/futures';

  const query = isCoin ? coinQuery : stockQuery;
  const total = isCoin ? coinRows.length : Math.min(MAX_ROWS, Number(stockQuery.data?.total ?? 0));
  const totalPages = Math.max(1, Math.min(5, Math.ceil(total / PAGE_SIZE)));
  const pageRows: AnyObj[] = isCoin
    ? coinRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    : ((stockQuery.data?.rows ?? []) as AnyObj[]);
  const updatedAt = isCoin ? coinQuery.dataUpdatedAt : stockQuery.dataUpdatedAt;

  const futuresLocked = isFutures && !canUseFutures;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto max-w-md px-4 pb-28 pt-4">
        <header className="grid grid-cols-[40px_1fr_40px] items-center gap-3">
          <button type="button" onClick={() => navigate(backHref)} aria-label="뒤로" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-center">
            <h1 className="text-lg font-extrabold">{title}</h1>
            <p className="text-[11px] font-bold text-muted-foreground">{marketLabel}</p>
          </div>
          <button type="button" onClick={() => void query.refetch()} aria-label="새로고침" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card">
            <RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />
          </button>
        </header>

        {!futuresLocked && category !== 'ai' && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {SORT_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setSort(tab.key)}
                className={cn(
                  'rounded-xl border px-2 py-2 text-center text-[11px] font-extrabold',
                  sort === tab.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card text-muted-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {updatedAt > 0 && (
          <p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">
            마지막 업데이트 {new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(updatedAt))}
          </p>
        )}

        <div className="mt-3 space-y-2">
          {futuresLocked ? (
            <StateBox>
              코인 선물은 정회원 전용입니다. 현재 등급: {memberGradeLabel(auth?.profile ?? null)} · 등급 변경은 관리자에게 문의해 주세요.
            </StateBox>
          ) : isCoin && category === 'ai' ? (
            <StateBox>분석 가능한 데이터가 없습니다.</StateBox>
          ) : query.isLoading ? (
            <StateBox>데이터를 불러오는 중입니다.</StateBox>
          ) : query.isError ? (
            <StateBox error>
              데이터를 불러오지 못했습니다.
              <button type="button" onClick={() => void query.refetch()} className="mt-2 block w-full rounded-xl border border-card-border bg-card py-2 text-xs font-black text-foreground">다시 시도</button>
            </StateBox>
          ) : pageRows.length === 0 ? (
            <StateBox>해당 종목 없음</StateBox>
          ) : (
            pageRows.map((row) => (
              <button
                key={`${row.market}:${row.ticker}`}
                type="button"
                onClick={() =>
                  isCoin
                    ? navigate(`/stock-info?asset=coin&coinMarket=${parsed.market}&symbol=${encodeURIComponent(String(row.ticker))}`)
                    : navigate(`/stock/${encodeURIComponent(String(row.ticker))}?back=${encodeURIComponent(location)}`)
                }
                className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left"
              >
                <span className="w-7 shrink-0 text-center text-sm font-black text-primary">{row.rank}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black">
                    {isCoin ? row.name : displayStockName(String(row.ticker), String(row.name ?? row.ticker), row.market)}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] font-bold text-muted-foreground">
                    {row.ticker} · {marketLabel} · {baseValue(row, category)}
                  </p>
                  {category === 'ai' && row.reason && (
                    <p className="mt-0.5 line-clamp-2 text-[10px] font-bold text-muted-foreground">{String(row.reason)}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-black">{formatAppPrice(Number(row.price), String(row.currency ?? 'KRW'))}</p>
                  <p className={cn('text-[10px] font-black', Number(row.changePercent ?? 0) >= 0 ? 'text-positive' : 'text-destructive')}>
                    {formatAppPercent(Number(row.changePercent ?? 0))}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>

        {!futuresLocked && !(isCoin && category === 'ai') && total > 0 && (
          <div className="mt-4 flex items-center justify-center gap-1.5">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                className={cn(
                  'h-9 w-9 rounded-xl border text-sm font-extrabold',
                  page === p
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card text-muted-foreground',
                )}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        {category === 'ai' && !isCoin && (
          <p className="mt-3 text-center text-[10px] font-bold text-muted-foreground">
            규칙 기반 참고용 분석입니다. 투자 판단과 책임은 본인에게 있습니다.
          </p>
        )}
      </div>
      <BottomNav />
    </div>
  );
}

function StateBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={cn('rounded-2xl border p-4 text-center text-xs font-bold', error ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-card-border bg-card text-muted-foreground')}>
      {children}
    </div>
  );
}
