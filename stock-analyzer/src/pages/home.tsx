import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BarChart3, BriefcaseBusiness, Radar, Star } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { api, apiGet, type SummaryItem } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { unifiedAssetDetailPath, type UnifiedAssetSuggestion } from '@/lib/unified-asset-search';
import {
  formatAppPercent,
  formatAppPrice,
  readWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from '@/lib/stock-display';

interface CryptoTickerRow {
  symbol?: unknown;
  price?: unknown;
  changePercent?: unknown;
  changePercent24h?: unknown;
  tradePrice?: unknown;
}

interface CryptoTickerResponse {
  tickers?: CryptoTickerRow[];
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketSummaryRows(items: SummaryItem[]): SummaryItem[] {
  const preferred = ['kospi', 'kosdaq', 'nasdaq', 'sp500', 'dow'];
  const map = new Map(items.map((item) => [String(item.key ?? '').trim().toLowerCase(), item]));
  return preferred.map((key) => map.get(key)).filter((item): item is SummaryItem => Boolean(item)).slice(0, 4);
}

function baseCoinSymbol(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw.startsWith('KRW-')) return raw.slice(4);
  return raw.replace(/(?:USDT|USDC)$/u, '');
}

function isTodaySeoul(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(new Date(parsed)) === formatter.format(new Date());
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const { selection } = useAnalysisSelection();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() => readWatchlistItems().slice(0, 8));

  useEffect(() => {
    const refresh = () => setWatchlist(readWatchlistItems().slice(0, 8));
    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const market = useQuery({
    queryKey: ['home-dashboard-market'],
    queryFn: () => api.summary(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const bitcoin = useQuery({
    queryKey: ['home-dashboard-btc'],
    queryFn: () => apiGet<CryptoTickerResponse>('/crypto/spot/tickers'),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const indices = useMemo(() => marketSummaryRows(market.data?.items ?? []), [market.data?.items]);
  const btc = useMemo(() => (bitcoin.data?.tickers ?? []).find((row) => baseCoinSymbol(row.symbol) === 'BTC') ?? null, [bitcoin.data?.tickers]);
  const signalIsCurrent = isTodaySeoul(selection?.selectedAt);
  const warnings = [
    market.isError ? '주식 시장 요약 공급자 응답을 확인하지 못했습니다.' : '',
    bitcoin.isError ? '코인 공개 시세 공급자 응답을 확인하지 못했습니다.' : '',
  ].filter(Boolean);

  const openAsset = (item: UnifiedAssetSuggestion) => {
    if (item.assetType === 'stock') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(item.market === 'US' ? 'US' : 'KR');
    } else {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(item.market === 'futures' ? 'futures' : 'spot');
    }
    navigate(unifiedAssetDetailPath(item, '/home'));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader
        title="오늘 시장과 관심사항"
        eyebrow="홈"
        infoTitle="홈 화면 안내"
        infoItems={[
          '시장·최근 신호·관심종목을 먼저 보여주며 Scanner를 중복 실행하지 않습니다.',
          '국내주식·미국주식·코인 현물·코인 선물을 아래 한 검색창에서 찾을 수 있습니다.',
        ]}
      />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5 lg:py-6">
          <section className="rounded-2xl border border-card-border bg-card p-3 sm:p-4" data-testid="home-single-search">
            <UnifiedAssetSearch placeholder="삼성전자 · AAPL · KRW-BTC · BTCUSDT 검색" onSelect={openAsset} />
          </section>

          {warnings.length > 0 && (
            <details role="alert" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs font-black text-amber-500 [&::-webkit-details-marker]:hidden">
                <AlertTriangle className="h-4 w-4 shrink-0" />일부 시장 데이터 확인 필요
              </summary>
              <ul className="border-t border-amber-500/20 pt-2 text-xs font-bold leading-5 text-muted-foreground">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul>
            </details>
          )}

          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-market-summary">
            <div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-extrabold text-primary">오늘의 시장</p><h2 className="mt-1 text-base font-black">핵심 시장 요약</h2></div><button type="button" onClick={() => navigate('/market-overview')} className="shrink-0 text-xs font-black text-primary">시황 보기</button></div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              {market.isLoading && indices.length === 0 ? <DashboardPlaceholder label="시장 핵심 데이터를 불러오는 중입니다." /> : indices.map((item) => <MetricCard key={item.key} label={item.label} value={item.ok ? item.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '데이터 부족'} sub={item.ok ? formatAppPercent(item.changePercent) : '공급자 확인 필요'} />)}
              <MetricCard label="BTC · Upbit" value={btc ? formatAppPrice(finite(btc.price ?? btc.tradePrice), 'KRW') : bitcoin.isLoading ? '불러오는 중' : '데이터 부족'} sub={btc ? formatAppPercent(finite(btc.changePercent ?? btc.changePercent24h)) : bitcoin.isError ? '공급자 확인 필요' : '공개 현물 시세'} />
            </div>
          </section>

          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-signal-summary">
            <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Radar className="h-4 w-4 text-primary" /><div><p className="text-[11px] font-extrabold text-primary">오늘의 신호</p><h2 className="text-base font-black">최근 검증 선택</h2></div></div><button type="button" onClick={() => navigate('/scanner')} className="shrink-0 text-xs font-black text-primary">Scanner 열기</button></div>
            {selection && signalIsCurrent && selection.signalScore != null ? (
              <button type="button" onClick={() => navigate('/scanner')} className="mt-3 flex min-h-16 w-full min-w-0 items-center justify-between gap-3 rounded-2xl border border-card-border bg-background p-3 text-left"><div className="min-w-0"><p className="truncate text-sm font-black">{selection.displayName}</p><p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">{selection.ticker} · {selection.market} · {selection.timeframe}</p></div><div className="shrink-0 text-right"><p className="text-sm font-black">{selection.action && selection.action !== 'NONE' ? selection.action : '관찰'}</p><p className="text-[10px] font-bold text-muted-foreground">Score {selection.signalScore}</p></div></button>
            ) : <p className="mt-3 rounded-2xl bg-background p-4 break-keep text-xs font-bold text-muted-foreground">오늘 선택한 Scanner 신호가 없습니다. Home이 별도 Scanner 요청을 만들지 않으므로 중복 분석이 발생하지 않습니다.</p>}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-watchlist-summary">
              <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Star className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">관심종목</h2></div><button type="button" onClick={() => navigate('/watchlist')} className="text-xs font-black text-primary">전체보기</button></div>
              <div className="mt-3 space-y-2">{watchlist.length ? watchlist.slice(0, 5).map((item) => <div key={item.ticker} className="flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-background px-3 py-2"><div className="min-w-0"><p className="truncate text-sm font-black">{item.name || item.ticker}</p><p className="truncate text-[10px] font-bold text-muted-foreground">{item.ticker} · {item.market ?? '시장 미확인'}</p></div><div className="shrink-0 text-right text-xs font-black"><p>{item.price == null ? '가격 미확인' : formatAppPrice(item.price, item.currency ?? 'KRW')}</p><p className="text-[10px] text-muted-foreground">{item.changePercent == null ? '등락 미확인' : formatAppPercent(item.changePercent)}</p></div></div>) : <p className="rounded-2xl bg-background p-4 text-xs font-bold text-muted-foreground">관심종목이 없습니다. 검색 결과에서 관심종목에 추가하면 여기에 표시됩니다.</p>}</div>
            </section>

            <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-portfolio-summary">
              <div className="flex items-center gap-2"><BriefcaseBusiness className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">Portfolio</h2></div>
              <p className="mt-3 break-keep text-xs font-bold leading-5 text-muted-foreground">Home에서는 private 계좌·잔고·포지션 API를 새로 호출하지 않습니다. 포트폴리오 권한이 있는 경우 기존 전용 화면에서 자산·손익·Risk를 확인하세요.</p>
              <button type="button" onClick={() => navigate('/portfolio')} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-card-border bg-background text-sm font-black">포트폴리오 열기 <ArrowRight className="h-4 w-4" /></button>
            </section>
          </div>

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="빠른 이동">
            <QuickLink label="국내" onClick={() => navigate('/stocks/kr')} />
            <QuickLink label="미국" onClick={() => navigate('/stocks/us')} />
            <QuickLink label="코인 현물" onClick={() => navigate('/coins/spot')} />
            <QuickLink label="코인 선물" onClick={() => navigate('/coins/futures')} />
          </section>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="min-w-0 rounded-2xl bg-background p-3"><p className="truncate text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-black">{value}</p><p className="mt-1 truncate text-[10px] font-bold text-muted-foreground">{sub}</p></div>;
}
function DashboardPlaceholder({ label }: { label: string }) {
  return <div className="col-span-2 flex min-h-20 items-center justify-center rounded-2xl bg-background px-3 text-center text-xs font-bold text-muted-foreground md:col-span-4">{label}</div>;
}
function QuickLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-2xl border border-card-border bg-card px-2 text-sm font-black"><BarChart3 className="h-4 w-4 shrink-0 text-primary" /><span className="break-keep">{label}</span></button>;
}
