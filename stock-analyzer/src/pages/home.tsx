import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { resolveAutoRun } from '@/components/auto-trading-run-control';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';
import { useQuotes } from '@/hooks/use-stock-data';
import { ADAPTIVE_VIEWPORT_BREAKPOINTS } from '@/lib/adaptive-layout';
import { useAnalysisSelection, type AnalysisSelection, type AnalysisTradeAction } from '@/lib/analysis-selection';
import { api, apiGet, type Briefing, type SummaryItem } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { useAuth } from '@/lib/auth';
import { authorizedFetch } from '@/lib/auth-fetch';
import { getMarketSummary, validMarketSummaryItems } from '@/lib/market-summary';
import { unifiedAssetDetailPath, type UnifiedAssetSuggestion } from '@/lib/unified-asset-search';
import {
  formatAppPercent,
  formatAppPrice,
  readWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from '@/lib/stock-display';

// Home follows the STOCK AI 시안: numbers first, one list per subject, no
// section tabs. Mobile stacks the same blocks the PC grid shows.

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

interface PortfolioTotals {
  totalAssets: { status: string; normalizedKRW: number | null; knownNormalizedKRW: number };
  valuationPnl: { status: string; normalizedKRW: number | null; returnPercent: number | null };
}

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '').replace(/%$/u, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketSummaryRows(items: SummaryItem[]): SummaryItem[] {
  const preferred = ['kospi', 'kosdaq', 'nasdaq', 'sp500', 'dow'];
  const map = new Map(
    validMarketSummaryItems(items).map((item) => [String(item.key ?? '').trim().toLowerCase(), item]),
  );
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

function actionLabel(action: AnalysisTradeAction | undefined): string {
  if (action === 'BUY') return '매수';
  if (action === 'SELL') return '매도';
  if (action === 'LONG') return '상승';
  if (action === 'SHORT') return '하락';
  if (action === 'NO_TRADE' || action === 'NONE') return '거래안함';
  return '관찰';
}

function actionTone(action: AnalysisTradeAction | undefined): string {
  if (action === 'BUY' || action === 'LONG') return 'bg-rise-surface text-rise';
  if (action === 'SELL' || action === 'SHORT') return 'bg-fall-surface text-fall';
  return 'bg-secondary text-muted-foreground';
}

function directionClass(change: number | null | undefined): string {
  if (change == null || !Number.isFinite(change) || change === 0) return 'text-muted-foreground';
  return change > 0 ? 'text-rise' : 'text-fall';
}

function krw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function signedKrw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.round(Math.abs(value)).toLocaleString('ko-KR')}`;
}

function planPrice(value: number | null | undefined, currency: string): string {
  return value == null || !Number.isFinite(value) ? '미확인' : formatAppPrice(value, currency);
}

function selectionCurrency(selection: AnalysisSelection): string {
  const market = String(selection.market ?? '').toUpperCase();
  if (market === 'US') return 'USD';
  if (market.includes('FUTURES') || market.includes('BITGET')) return 'USDT';
  return 'KRW';
}

function timeSeoul(value: string | undefined): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(parsed));
}

function useDesktopHome(): boolean {
  const query = `(min-width: ${ADAPTIVE_VIEWPORT_BREAKPOINTS.desktopMin}px)`;
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return desktop;
}

async function readAutomationStatus(): Promise<TradeAutomationStatus | null> {
  const response = await authorizedFetch('/api/trade-automation/status', { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as TradeAutomationStatus | null;
  return response.ok && payload ? payload : null;
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const assetMode = useAssetMode();
  const { selection } = useAnalysisSelection();
  const desktop = useDesktopHome();
  const [storedWatchlist, setStoredWatchlist] = useState<WatchlistItem[]>(() => readWatchlistItems().slice(0, 6));

  useEffect(() => {
    const refresh = () => setStoredWatchlist(readWatchlistItems().slice(0, 6));
    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const canSeePortfolio = auth.can('canAccessBasicInfo');
  const canSeeAutomation = auth.can('canAccessAutoTrading');

  const market = useQuery({
    queryKey: ['home-dashboard-market'],
    queryFn: getMarketSummary,
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
  const briefing = useQuery({
    queryKey: ['home-dashboard-briefing'],
    queryFn: api.briefing,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const portfolio = useQuery({
    queryKey: ['home-dashboard-portfolio'],
    queryFn: () => apiGet<PortfolioTotals>('/portfolio/intelligence?profile=BALANCED'),
    enabled: canSeePortfolio,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const automation = useQuery({
    queryKey: ['home-dashboard-automation'],
    queryFn: readAutomationStatus,
    enabled: canSeeAutomation,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const tickers = useMemo(() => storedWatchlist.map((item) => item.ticker.toUpperCase()), [storedWatchlist]);
  const quotes = useQuotes(tickers);
  const watchlist = useMemo(() => {
    const quoteMap = new Map((quotes.data?.quotes ?? []).map((quote) => [String(quote.ticker).toUpperCase(), quote]));
    return storedWatchlist.map((item) => ({ ...item, ...(quoteMap.get(item.ticker.toUpperCase()) ?? {}) }));
  }, [storedWatchlist, quotes.data?.quotes]);

  const indices = useMemo(() => marketSummaryRows(market.data?.items ?? []), [market.data?.items]);
  const btc = useMemo(() => (bitcoin.data?.tickers ?? []).find((row) => baseCoinSymbol(row.symbol) === 'BTC') ?? null, [bitcoin.data?.tickers]);
  const btcPrice = btc ? finite(btc.price ?? btc.tradePrice) : null;
  const btcChangePercent = btc ? finite(btc.changePercent ?? btc.changePercent24h) : null;
  const signalIsCurrent = isTodaySeoul(selection?.selectedAt);
  const currentSignal = selection && signalIsCurrent && selection.signalScore != null ? selection : null;
  const marketWarning = market.isError
    ? '주식 시장 정보 확인 실패'
    : market.data?.dataState === 'provider_error'
      ? '주식 시장 공급자 확인 필요'
      : market.data?.dataState === 'partial'
        ? '일부 시장 정보 지연'
        : '';
  const warnings = [
    marketWarning,
    bitcoin.isError ? '코인 시세 공급자 확인 필요' : '',
  ].filter(Boolean);
  const marketState = market.isLoading
    ? '확인 중'
    : market.isError || market.data?.dataState === 'provider_error'
      ? '확인 필요'
      : '데이터 없음';

  // Treat a malformed or partial payload like a fetch failure instead of rendering a broken number.
  const totals = portfolio.data && portfolio.data.totalAssets && portfolio.data.valuationPnl ? portfolio.data : null;
  const brief = briefing.data && typeof briefing.data.headline === 'string' ? briefing.data : null;
  const strongSectors = Array.isArray(brief?.strongSectors) ? brief.strongSectors : [];
  const weakSectors = Array.isArray(brief?.weakSectors) ? brief.weakSectors : [];
  const gainers = Array.isArray(brief?.gainers) ? brief.gainers : [];
  const losers = Array.isArray(brief?.losers) ? brief.losers : [];
  const autoRun = resolveAutoRun(automation.data ?? null);
  const autoState = autoRun?.state ?? null;
  const autoMarkets = autoRun ? Object.values(autoRun.markets).filter((row) => row.enabled).length : 0;

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

  const assetSection = (
    <Panel testId="home-asset-summary" title="총 평가자산" action="자산 보기" onAction={() => navigate('/portfolio')} compactTitle>
      {!canSeePortfolio ? (
        <p className="mt-2 text-sm font-medium text-muted-foreground">자산 조회 권한이 필요합니다.</p>
      ) : portfolio.isLoading ? (
        <p className="num mt-1 text-2xl font-semibold text-muted-foreground">확인 중</p>
      ) : portfolio.isError || !totals ? (
        <p className="mt-2 text-sm font-medium text-muted-foreground">자산 정보를 불러오지 못했습니다.</p>
      ) : (
        <>
          <p className="num mt-1 text-[28px] font-semibold leading-tight tracking-tight">
            {totals.totalAssets.normalizedKRW == null ? '미확정' : krw(totals.totalAssets.normalizedKRW)}
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {totals.totalAssets.normalizedKRW == null
              ? `확인된 자산 ${krw(totals.totalAssets.knownNormalizedKRW)} · 누락 계좌 있음`
              : `평가손익 `}
            {totals.totalAssets.normalizedKRW != null ? (
              <span className={`num font-semibold ${directionClass(totals.valuationPnl.normalizedKRW)}`}>
                {signedKrw(totals.valuationPnl.normalizedKRW)}
                {totals.valuationPnl.returnPercent == null ? '' : ` (${formatAppPercent(totals.valuationPnl.returnPercent)})`}
              </span>
            ) : null}
          </p>
        </>
      )}
    </Panel>
  );

  const marketSection = (
    <section className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="home-market-summary" aria-label="주요 지수">
      {indices.length === 0
        ? <div className="col-span-3 rounded-xl border border-card-border bg-card px-3 py-4 text-center text-xs font-medium text-muted-foreground sm:col-span-4">{marketState}</div>
        : indices.map((item) => <IndexTile key={item.key} label={item.label} value={item.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} change={item.changePercent} />)}
      <IndexTile
        label="비트코인"
        value={btc ? btcPrice == null ? '가격 미확인' : formatAppPrice(btcPrice, 'KRW') : bitcoin.isLoading ? '확인 중' : '미확인'}
        change={btcChangePercent}
        sub={btc ? btcChangePercent == null ? '등락 미확인' : formatAppPercent(btcChangePercent) : bitcoin.isError ? '확인 필요' : '업비트'}
      />
    </section>
  );

  const watchlistSection = (
    <Panel testId="home-watchlist-summary" title="관심종목" action="전체" onAction={() => navigate('/watchlist')}>
      {watchlist.length ? (
        <ul className="mt-1 divide-y divide-card-border">
          {watchlist.map((item) => {
            const watchlistPrice = finite(item.price);
            const watchlistChangePercent = finite(item.changePercent);
            const watchlistCurrency = typeof item.currency === 'string' && item.currency.trim()
              ? item.currency.trim().toUpperCase()
              : null;
            return (
              <li key={item.ticker}>
                <button
                  type="button"
                  onClick={() => navigate(`/stock/${item.ticker}?back=${encodeURIComponent('/home')}`)}
                  className="flex min-h-[52px] w-full items-center justify-between gap-3 py-2 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.name || item.ticker}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">{item.ticker} · {item.market ?? '시장 미확인'}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num block text-sm font-medium">{watchlistPrice == null ? '가격 미확인' : watchlistCurrency == null ? '통화 미확인' : formatAppPrice(watchlistPrice, watchlistCurrency)}</span>
                    <span className={`num block text-xs ${directionClass(watchlistChangePercent)}`}>{watchlistChangePercent == null ? '등락 미확인' : formatAppPercent(watchlistChangePercent)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="mt-2 py-3 text-center text-xs font-medium text-muted-foreground">관심종목 없음 · 전체에서 추가</p>}
    </Panel>
  );

  const signalSection = (
    <Panel testId="home-signal-summary" title="오늘의 AI 신호" action="검색기" onAction={() => navigate('/scanner')}>
      {currentSignal ? (
        <button type="button" onClick={() => navigate('/scanner')} className="mt-2 block w-full rounded-xl border border-card-border bg-background p-3 text-left">
          <span className="flex items-center justify-between gap-3">
            <span className="truncate text-sm font-semibold">{currentSignal.displayName ?? currentSignal.ticker}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${actionTone(currentSignal.action)}`}>{actionLabel(currentSignal.action)} · 점수 {currentSignal.signalScore}</span>
          </span>
          <span className="num mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>진입 {currentSignal.pricePlan?.entryZone ? planPrice(currentSignal.pricePlan.entryZone.from, selectionCurrency(currentSignal)) : '미확인'}</span>
            <span>손절 {planPrice(currentSignal.pricePlan?.stopLoss, selectionCurrency(currentSignal))}</span>
            <span>목표 {planPrice(currentSignal.pricePlan?.targets?.[0], selectionCurrency(currentSignal))}</span>
          </span>
          <span className="mt-1.5 block truncate text-xs text-muted-foreground">{currentSignal.reasons?.[0] ?? `${currentSignal.market} · ${currentSignal.timeframe}`}</span>
        </button>
      ) : <p className="mt-2 py-3 text-center text-xs font-medium text-muted-foreground">오늘 선택한 신호 없음</p>}
    </Panel>
  );

  const automationSection = canSeeAutomation ? (
    <Panel testId="home-automation-summary" title="자동매매" action="열기" onAction={() => navigate('/auto-trading')} compactTitle>
      <p className="mt-1 text-lg font-semibold">
        {automation.isLoading ? '확인 중' : autoState == null ? '상태 미확인' : autoState === 'RUNNING' ? '실행 중' : autoState === 'KILL_SWITCH' ? '긴급 정지' : autoState === 'GLOBAL_STOP' ? '전체 정지' : '꺼짐'}
      </p>
      <p className="mt-1 text-xs font-medium text-muted-foreground">
        {autoRun ? `시장 ${autoMarkets}개 켜짐 · 주문마다 승인 없음` : '서버 상태를 확인하면 표시됩니다'}
      </p>
    </Panel>
  ) : null;

  const briefingSection = (
    <section className="grid gap-3 sm:grid-cols-3" data-testid="home-briefing-summary">
      <Panel title="급등 상위" action="순위" onAction={() => navigate('/market-rankings')}>
        <MoverList rows={gainers} loading={briefing.isLoading} error={briefing.isError} tone="up" onOpen={(ticker) => navigate(`/stock/${ticker}?back=${encodeURIComponent('/home')}`)} />
      </Panel>
      <Panel title="급락 상위" action="순위" onAction={() => navigate('/market-rankings')}>
        <MoverList rows={losers} loading={briefing.isLoading} error={briefing.isError} tone="down" onOpen={(ticker) => navigate(`/stock/${ticker}?back=${encodeURIComponent('/home')}`)} />
      </Panel>
      <Panel title="시황 요약" action="시황" onAction={() => navigate('/market-overview')} meta={timeSeoul(brief?.asOf)}>
        {briefing.isLoading ? (
          <p className="mt-2 text-xs font-medium text-muted-foreground">확인 중</p>
        ) : briefing.isError || !brief ? (
          <p className="mt-2 text-xs font-medium text-muted-foreground">시황 요약을 불러오지 못했습니다.</p>
        ) : (
          <>
            <p className="mt-2 text-[13px] leading-6">{brief.headline}</p>
            {strongSectors.length || weakSectors.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {strongSectors.slice(0, 2).map((sector) => <span key={`s-${sector.sector}`} className="num rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-foreground">{sector.sector} {formatAppPercent(sector.changePercent)}</span>)}
                {weakSectors.slice(0, 2).map((sector) => <span key={`w-${sector.sector}`} className="num rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-foreground">{sector.sector} {formatAppPercent(sector.changePercent)}</span>)}
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader title="홈" />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl space-y-3 px-3 py-3 sm:px-5 lg:py-5">
          {!desktop ? (
            <section className="rounded-xl border border-card-border bg-card p-2" data-testid="home-single-search">
              <UnifiedAssetSearch placeholder="종목·코인 검색" onSelect={openAsset} />
            </section>
          ) : null}

          {warnings.length > 0 && (
            <details role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-amber-500 [&::-webkit-details-marker]:hidden">
                <AlertTriangle className="h-4 w-4 shrink-0" />데이터 확인 필요
              </summary>
              <ul className="border-t border-amber-500/20 pt-2 text-xs font-medium leading-5 text-muted-foreground">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul>
            </details>
          )}

          {desktop ? (
            <div className="space-y-3" data-testid="home-desktop-workspace">
              <div className={`grid gap-3 ${automationSection ? 'xl:grid-cols-[2fr_1fr_1fr]' : 'xl:grid-cols-[2fr_1fr]'}`}>
                {assetSection}
                {signalSection}
                {automationSection}
              </div>
              {marketSection}
              {watchlistSection}
              {briefingSection}
            </div>
          ) : (
            <div className="space-y-3" data-testid="home-mobile-stack">
              {assetSection}
              {marketSection}
              {watchlistSection}
              {signalSection}
              {briefingSection}
              {automationSection}
            </div>
          )}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}

function Panel({ title, action, onAction, meta, compactTitle = false, testId, children }: {
  title: string;
  action?: string;
  onAction?: () => void;
  meta?: string;
  compactTitle?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-card-border bg-card px-4 py-3" data-testid={testId}>
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h2 className={compactTitle ? 'text-xs font-medium text-muted-foreground' : 'text-sm font-semibold'}>{title}</h2>
        <span className="flex items-center gap-2">
          {meta ? <span className="num text-[11px] text-muted-foreground">{meta}</span> : null}
          {action && onAction ? (
            <button type="button" onClick={onAction} className="flex min-h-11 min-w-11 items-center justify-center px-1 text-xs font-semibold text-primary">{action}</button>
          ) : null}
        </span>
      </div>
      {children}
    </section>
  );
}

function IndexTile({ label, value, change, sub }: { label: string; value: string; change: number | null | undefined; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-card px-2.5 py-2">
      <p className="truncate text-[11.5px] text-muted-foreground">{label}</p>
      <p className="num mt-0.5 truncate text-sm font-semibold">{value}</p>
      <p className={`num truncate text-xs ${directionClass(change)}`}>{sub ?? formatAppPercent(change)}</p>
    </div>
  );
}

function MoverList({ rows, loading, error, tone, onOpen }: {
  rows: Briefing['gainers'];
  loading: boolean;
  error: boolean;
  tone: 'up' | 'down';
  onOpen: (ticker: string) => void;
}) {
  if (loading) return <p className="mt-2 text-xs font-medium text-muted-foreground">확인 중</p>;
  if (error) return <p className="mt-2 text-xs font-medium text-muted-foreground">순위를 불러오지 못했습니다.</p>;
  if (!rows.length) return <p className="mt-2 text-xs font-medium text-muted-foreground">데이터 없음</p>;
  return (
    <ul className="mt-1 divide-y divide-card-border">
      {rows.slice(0, 4).map((row) => (
        <li key={row.ticker}>
          <button type="button" onClick={() => onOpen(row.ticker)} className="flex min-h-11 w-full items-center justify-between gap-3 py-1.5 text-left text-sm">
            <span className="truncate">{row.name || row.ticker}</span>
            <span className={`num shrink-0 ${tone === 'up' ? 'text-rise' : 'text-fall'}`}>{formatAppPercent(row.changePercent)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
