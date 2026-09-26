import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { EmptyState, ErrorState, LoadingState } from '@/components/data-state';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { api, apiGet } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { useAuth } from '@/lib/auth';
import { requireMarketMoversResponse, type MarketMoversResponse } from '@/lib/market-movers-response';
import { requireRecommendationResponse } from '@/lib/recommendation-response';
import { requireThemesData } from '@/lib/theme-response';
import {
  displayCoinName,
  displayStockName,
  formatAppPercent,
  formatAppPrice,
  readWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
} from '@/lib/stock-display';
import { unifiedAssetDetailPath, type UnifiedAssetSuggestion } from '@/lib/unified-asset-search';
import { useAnalysisSelection, selectionQuery } from '@/lib/analysis-selection';
import { getPortfolioChartOverlay } from '@/lib/portfolio-overlay';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

type CategoryKey = 'ai' | 'theme' | 'tradingValue' | 'volume' | 'gainers' | 'losers';

type MarketPreview = {
  assetType: 'stock' | 'coin';
  market: 'KR' | 'US' | 'spot' | 'futures';
  ticker: string;
  displayName: string;
  currency: string;
  price: number | null;
  changePercent: number | null;
  detailPath: string;
};

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: 'ai', label: 'AI추천' },
  { key: 'theme', label: '테마종목' },
  { key: 'tradingValue', label: '거래대금' },
  { key: 'volume', label: '거래량' },
  { key: 'gainers', label: '급상승' },
  { key: 'losers', label: '급하락' },
];

// AI 추천 응답 행 (recommendations 화면과 동일 스키마)
interface RecoRow {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  category: 'undervalued' | 'breakout';
  categoryLabel: string;
  price: number;
  changePercent: number | null;
  reasons: string[];
  score: number;
}
interface RecoResponse {
  ok?: boolean;
  analysisMode?: string;
  analysisDescription?: string;
  market: 'KR' | 'US';
  rows: RecoRow[];
  error?: string;
}

function MarketButton({ label, active, disabled = false, onClick }: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 min-w-0 items-center justify-center rounded-xl px-1.5 text-center text-xs font-semibold transition sm:px-3',
        active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-35',
      )}
    >
      <span className="min-w-0 break-keep">{label}</span>
    </button>
  );
}

function useDesktopMarketBrowser() {
  const query = '(min-width: 1200px)';
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

function finitePercent(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace('%', '').replace(/,/g, '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function StocksPage() {
  const [, navigate] = useLocation();
  const mode = useAssetMode();
  const auth = useAuth();
  const analysisSelection = useAnalysisSelection();
  const desktop = useDesktopMarketBrowser();
  const [category, setCategory] = useState<CategoryKey>('ai');
  const [preview, setPreview] = useState<MarketPreview | null>(null);
  const [, setContextVersion] = useState(0);

  const chooseMarket = (target: 'KR' | 'US' | 'spot' | 'futures') => {
    if (target === 'KR' || target === 'US') {
      mode.setAsset('stock');
      mode.setStockMarket(target);
      return;
    }
    if (target === 'spot' && !auth.can('canAccessSpot')) return;
    if (target === 'futures' && !auth.can('canAccessFutures')) return;
    mode.setAsset('coin');
    mode.setCoinMarket(target);
    if (category === 'ai' || category === 'theme') setCategory('tradingValue');
  };

  const activeMarket = mode.asset === 'stock' ? mode.stockMarket : mode.coinMarket;

  useEffect(() => {
    const refresh = () => setContextVersion((value) => value + 1);
    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener('sa-portfolio-overlay-updated', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener('sa-portfolio-overlay-updated', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    setPreview(null);
  }, [activeMarket, category]);

  // ── 코인 검색용 데이터 (주식 검색은 canonical UnifiedAssetSearch 재사용) ──
  const spotMarkets = useQuery({
    queryKey: ['stocks-crypto-spot-markets'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/markets'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'spot',
    staleTime: 10 * 60_000,
  });
  const spotTickers = useQuery({
    queryKey: ['stocks-crypto-spot-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'spot',
    refetchInterval: 15_000,
  });
  const futuresTickers = useQuery({
    queryKey: ['stocks-crypto-futures-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'futures',
    refetchInterval: 10_000,
  });

  // ── 분류 데이터 (기존 API) ──────────────────────────────────────
  const isStock = mode.asset === 'stock';
  const coinCategorySupported = category === 'tradingValue' || category === 'volume' || category === 'gainers' || category === 'losers';
  const useMovers = isStock && (category === 'tradingValue' || category === 'volume' || category === 'gainers' || category === 'losers');

  const recommendations = useQuery({
    queryKey: ['stocks-cat-reco', mode.stockMarket],
    queryFn: async () =>
      requireRecommendationResponse<RecoResponse>(
        await apiGet<unknown>(`/market/recommendations?market=${mode.stockMarket}`),
        mode.stockMarket,
      ),
    enabled: isStock && category === 'ai',
    staleTime: 60_000,
  });
  const themes = useQuery({
    queryKey: ['stocks-cat-themes', mode.stockMarket],
    queryFn: async () => requireThemesData(await api.themes(mode.stockMarket), mode.stockMarket),
    enabled: isStock && category === 'theme',
    staleTime: 60_000,
  });
  const movers = useQuery({
    queryKey: ['stocks-cat-movers', mode.stockMarket],
    queryFn: async () => requireMarketMoversResponse(
      await apiGet<unknown>(`/market/movers?market=${mode.stockMarket}`),
      mode.stockMarket,
    ),
    enabled: useMovers,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // ── 코인 티커 정렬 (실제 데이터) ────────────────────────────────
  const spotNames = useMemo(
    () => new Map<string, AnyObj>(((spotMarkets.data?.markets ?? []) as AnyObj[]).map((row) => [String(row.symbol), row])),
    [spotMarkets.data],
  );
  const coinSource = useMemo<AnyObj[]>(() => {
    if (mode.asset !== 'coin') return [];
    return mode.coinMarket === 'spot'
      ? ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((row) => ({ ...row, ...(spotNames.get(String(row.symbol)) ?? {}) }))
      : ((futuresTickers.data?.tickers ?? []) as AnyObj[]);
  }, [futuresTickers.data, mode.asset, mode.coinMarket, spotNames, spotTickers.data]);

  const coinChange = (row: AnyObj) => Number(row.changePercent ?? row.changePercent24h);
  const sortedCoins = useMemo(() => {
    if (mode.asset !== 'coin' || !coinCategorySupported) return [] as AnyObj[];
    const rows = [...coinSource];
    if (category === 'tradingValue') rows.sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0));
    if (category === 'volume') rows.sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0));
    if (category === 'gainers') rows.sort((a, b) => (Number(coinChange(b)) || -Infinity) - (Number(coinChange(a)) || -Infinity));
    if (category === 'losers') rows.sort((a, b) => (Number(coinChange(a)) || Infinity) - (Number(coinChange(b)) || Infinity));
    return rows.slice(0, 100);
  }, [category, coinCategorySupported, coinSource, mode.asset]);

  // ── 코인 검색 로딩·오류 상태 ────────────────────────────────────
  const coinTickerQuery = mode.coinMarket === 'spot' ? spotTickers : futuresTickers;

  const openStock = (ticker: string, stock?: AnyObj) => {
    const normalized = ticker.trim().toUpperCase();
    const detailPath = `/stock/${encodeURIComponent(normalized)}`;
    if (!desktop) {
      navigate(detailPath);
      return;
    }
    setPreview({
      assetType: 'stock',
      market: mode.stockMarket,
      ticker: normalized,
      displayName: displayStockName(normalized, String(stock?.name ?? stock?.displayName ?? normalized), mode.stockMarket),
      currency: String(stock?.currency ?? (mode.stockMarket === 'US' ? 'USD' : 'KRW')),
      price: Number.isFinite(Number(stock?.price)) ? Number(stock?.price) : null,
      changePercent: finitePercent(stock?.changePercent),
      detailPath,
    });
  };

  const openCoin = (symbol: string, row?: AnyObj) => {
    const normalized = symbol.trim().toUpperCase();
    const detailPath = `/stock-info?asset=coin&coinMarket=${mode.coinMarket}&symbol=${encodeURIComponent(normalized)}`;
    if (!desktop) {
      navigate(detailPath);
      return;
    }
    setPreview({
      assetType: 'coin',
      market: mode.coinMarket,
      ticker: normalized,
      displayName: displayCoinName(normalized, row?.koreanName, row?.englishName),
      currency: mode.coinMarket === 'spot' ? 'KRW' : 'USDT',
      price: Number.isFinite(Number(row?.price)) ? Number(row?.price) : null,
      changePercent: finitePercent(row?.changePercent ?? row?.changePercent24h),
      detailPath,
    });
  };

  const selectSearchItem = (item: UnifiedAssetSuggestion) => {
    const detailPath = unifiedAssetDetailPath(item, '/market-browser');
    if (!desktop) {
      navigate(detailPath);
      return;
    }
    const ticker = String(item.ticker ?? item.productCode).trim().toUpperCase();
    setPreview({
      assetType: item.assetType,
      market: item.market,
      ticker,
      displayName: item.displayName,
      currency: item.quoteCurrency,
      price: null,
      changePercent: null,
      detailPath,
    });
  };

  const selectionForPreview = (item: MarketPreview) => ({
    assetType: item.assetType === 'stock' ? 'stock' as const : item.market === 'futures' ? 'coin_futures' as const : 'coin_spot' as const,
    market: item.market === 'KR' || item.market === 'US' ? item.market : item.market === 'futures' ? 'BITGET' as const : 'UPBIT' as const,
    symbol: item.ticker,
    ticker: item.ticker,
    displayName: item.displayName,
    timeframe: '1D',
    selectedAt: new Date().toISOString(),
  });

  const navigateWithPreviewSelection = (item: MarketPreview, target: 'chart' | 'scanner' | 'news') => {
    const selection = selectionForPreview(item);
    analysisSelection.select(selection);
    if (target === 'chart') {
      navigate(`/ai-chart?${selectionQuery(selection)}`);
      return;
    }
    navigate(target === 'scanner' ? '/scanner' : '/news-information');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="stocks-shell">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="stocks-scroll-content">
      {/* 제목·검색·시장·필터·목록은 하나의 vertical owner에서만 스크롤합니다. */}
      <header className="border-b border-card-border px-3 pb-4 pt-3 sm:px-5 min-[1200px]:px-6 min-[1200px]:pt-4">
        <div className="mx-auto w-full max-w-[90rem]">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-[0.08em] text-primary">MARKET</p>
              <h1 className="mt-0.5 text-xl font-bold tracking-[-0.015em] min-[1200px]:text-2xl">종목</h1>
            </div>
            <p className="hidden text-xs font-medium text-muted-foreground min-[768px]:block">검색 · 시장순위 · 추천을 한 곳에서 확인합니다.</p>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-1 rounded-2xl border border-card-border bg-card p-1" aria-label="시장 선택" data-testid="stocks-market-bar">
            <MarketButton label="국내" active={activeMarket === 'KR'} onClick={() => chooseMarket('KR')} />
            <MarketButton label="미국" active={activeMarket === 'US'} onClick={() => chooseMarket('US')} />
            <MarketButton label="코인 현물" active={activeMarket === 'spot'} disabled={!auth.can('canAccessSpot')} onClick={() => chooseMarket('spot')} />
            <MarketButton label="코인 선물" active={activeMarket === 'futures'} disabled={!auth.can('canAccessFutures')} onClick={() => chooseMarket('futures')} />
          </div>

          <div className="mt-3">
            <UnifiedAssetSearch
              key={mode.asset === 'stock' ? `stock:${mode.stockMarket}` : `coin:${mode.coinMarket}`}
              asset={mode.asset}
              market={mode.asset === 'stock' ? mode.stockMarket : mode.coinMarket}
              allowedMarkets={[mode.asset === 'stock' ? mode.stockMarket : mode.coinMarket]}
              placeholder={mode.asset === 'stock' ? '종목명·코드·영문명 검색' : '코인명·심볼 검색'}
              onSelect={selectSearchItem}
            />
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1.5 min-[600px]:grid-cols-6" aria-label="종목 분류" data-testid="stocks-category-bar">
            {CATEGORIES.map((item) => {
              const unsupported = mode.asset === 'coin' && (item.key === 'ai' || item.key === 'theme');
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={unsupported}
                  onClick={() => setCategory(item.key)}
                  className={cn(
                    'inline-flex min-h-10 min-w-0 items-center justify-center rounded-xl px-2 text-center text-xs font-semibold leading-4 transition',
                    category === item.key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    unsupported && 'cursor-not-allowed opacity-35',
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[90rem] px-3 pb-6 pt-4 sm:px-5 min-[1200px]:px-6">
        <div className="min-w-0 min-[1200px]:grid min-[1200px]:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.72fr)] min-[1200px]:gap-5" data-testid="stocks-master-detail">
          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold tracking-[-0.01em]">{CATEGORIES.find((c) => c.key === category)?.label}</h2>
            </div>
            <div className="hidden grid-cols-[minmax(0,1fr)_150px_100px] border-y border-card-border px-3 py-2 text-xs font-semibold text-muted-foreground min-[1200px]:grid" aria-hidden="true">
              <span>종목</span><span className="text-right">현재가</span><span className="text-right">등락</span>
            </div>
            {isStock ? (
              <StockCategoryResults
                category={category}
                recommendations={recommendations}
                themes={themes}
                movers={movers}
                stockMarket={mode.stockMarket}
                onOpenStock={openStock}
              />
            ) : (
              <CoinCategoryResults
                category={category}
                coinCategorySupported={coinCategorySupported}
                coinTickerQuery={coinTickerQuery}
                sortedCoins={sortedCoins}
                coinMarket={mode.coinMarket}
                onOpenCoin={openCoin}
              />
            )}
          </section>

          <aside className="hidden min-w-0 min-[1200px]:block" data-testid="stocks-preview-pane">
            <div className="sticky top-4">
              <MarketPreviewPanel
                preview={preview}
                onDetail={() => preview && navigate(preview.detailPath)}
                onChart={() => preview && navigateWithPreviewSelection(preview, 'chart')}
                onScanner={() => preview && navigateWithPreviewSelection(preview, 'scanner')}
                onNews={() => preview && navigateWithPreviewSelection(preview, 'news')}
              />
            </div>
          </aside>
        </div>
      </main>
      </div>
      <BottomNav />
    </div>
  );
}

function MarketPreviewPanel({
  preview,
  onDetail,
  onChart,
  onScanner,
  onNews,
}: {
  preview: MarketPreview | null;
  onDetail: () => void;
  onChart: () => void;
  onScanner: () => void;
  onNews: () => void;
}) {
  if (!preview) {
    return <EmptyState title="종목 미리보기" description="왼쪽 종목을 선택하면 가격·보유정보와 주요 이동 메뉴를 표시합니다." />;
  }

  const holding = preview.assetType === 'stock' ? getPortfolioChartOverlay(preview.ticker) : null;
  const watched = readWatchlistItems().some((item) => (
    item.ticker.trim().toUpperCase() === preview.ticker
    && (!item.market || item.market === preview.market)
  ));

  return (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" aria-label="선택 종목 미리보기">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h2 className="truncate text-lg font-bold tracking-[-0.015em]">{preview.displayName}</h2>
            {watched ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">관심</span> : null}
            {holding ? <span className="rounded-full bg-positive/10 px-2 py-0.5 text-xs font-semibold text-positive">보유</span> : null}
          </div>
          <p className="mt-1 text-xs font-medium text-muted-foreground">{preview.ticker} · {preview.market}</p>
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <p className="text-base font-bold">{formatAppPrice(preview.price, preview.currency)}</p>
          <p className={cn('mt-1 text-xs font-semibold', preview.changePercent != null && preview.changePercent > 0 ? 'text-positive' : preview.changePercent != null && preview.changePercent < 0 ? 'text-destructive' : 'text-muted-foreground')}>
            {preview.changePercent == null ? '등락 데이터 없음' : formatAppPercent(preview.changePercent)}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <PreviewMetric label="평단" value={holding ? formatAppPrice(holding.averagePrice, holding.currency) : '보유 기록 없음'} />
        <PreviewMetric label="수량" value={holding ? holding.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '-'} />
        <PreviewMetric label="보유 수익률" value={holding?.rate == null ? '-' : formatAppPercent(holding.rate)} />
        <PreviewMetric label="관심종목" value={watched ? '등록됨' : '미등록'} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <PreviewAction label="상세 보기" primary onClick={onDetail} />
        <PreviewAction label="AI 차트" onClick={onChart} />
        <PreviewAction label="신호 보기" onClick={onScanner} />
        <PreviewAction label="뉴스·공시" onClick={onNews} />
      </div>
      <p className="mt-3 text-xs font-medium leading-5 text-muted-foreground">신호·뉴스 개수는 별도 근거가 확인될 때만 표시하며, 이 화면에서 임의로 추정하지 않습니다.</p>
    </section>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-background p-3"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 truncate font-semibold tabular-nums">{value}</p></div>;
}

function PreviewAction({ label, primary = false, onClick }: { label: string; primary?: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={cn('min-h-11 rounded-xl px-3 text-sm font-semibold', primary ? 'bg-primary text-primary-foreground' : 'border border-card-border bg-background')}>{label}</button>;
}

// ── 공통 행 디자인 (기존 행 클래스 재사용) ──────────────────────────
function StockRow({ stock, onClick }: { stock: AnyObj; onClick: () => void }) {
  const change = finitePercent(stock.changePercent);
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-left transition hover:border-primary/30 min-[1200px]:rounded-none min-[1200px]:border-x-0 min-[1200px]:border-t-0 min-[1200px]:shadow-none">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Star className="h-4 w-4 text-primary" /></div>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-bold">{displayStockName(String(stock.ticker), String(stock.name ?? ''), String(stock.market))}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">{stock.market}</span></div><p className="mt-0.5 text-xs font-medium text-muted-foreground">{stock.ticker}</p></div>
      <div className="text-right"><p className="text-sm font-bold">{formatAppPrice(stock.price, String(stock.currency))}</p><p className={cn('mt-0.5 text-xs font-semibold', change !== null && change > 0 ? 'text-positive' : change !== null && change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{change === null ? '데이터 없음' : formatAppPercent(change)}</p></div>
    </button>
  );
}

function CoinRow({ row, coinMarket, onClick }: { row: AnyObj; coinMarket: 'spot' | 'futures'; onClick: () => void }) {
  const change = Number(row.changePercent ?? row.changePercent24h);
  const currency = coinMarket === 'spot' ? 'KRW' : 'USDT';
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-left transition hover:border-primary/30 min-[1200px]:rounded-none min-[1200px]:border-x-0 min-[1200px]:border-t-0 min-[1200px]:shadow-none">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Star className="h-4 w-4 text-primary" /></div>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-xs font-medium text-muted-foreground">{row.symbol} · {coinMarket === 'spot' ? 'UPBIT' : 'BITGET'}</p></div>
      <div className="text-right"><p className="text-sm font-bold">{formatAppPrice(Number(row.price), currency)}</p><p className={cn('mt-0.5 text-xs font-semibold', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
    </button>
  );
}

// ── 주식 분류 결과 ──────────────────────────────────────────────
function StockCategoryResults({
  category,
  recommendations,
  themes,
  movers,
  stockMarket,
  onOpenStock,
}: {
  category: CategoryKey;
  recommendations: ReturnType<typeof useQuery<RecoResponse>>;
  themes: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.themes>>>>;
  movers: UseQueryResult<MarketMoversResponse, Error>;
  stockMarket: 'KR' | 'US';
  onOpenStock: (ticker: string) => void;
}) {
  if (category === 'ai') {
    if (recommendations.isLoading) return <LoadingState label="규칙 기반 분석으로 추천을 계산하는 중입니다." />;
    if (recommendations.isError) return <ErrorState onRetry={() => { void recommendations.refetch(); }} />;
    const rows = recommendations.data?.rows ?? [];
    const undervalued = rows.filter((row) => row.category === 'undervalued');
    const breakout = rows.filter((row) => row.category === 'breakout');
    if (rows.length === 0) return <EmptyState compact title="현재 조건을 충족하는 추천 종목이 없습니다" description="조건 미달 종목으로 결과를 채우지 않습니다." />;
    return (
      <div className="space-y-4">
        <p className="text-center text-xs font-medium text-muted-foreground">규칙 기반 분석 · AI(LLM) 미연결</p>
        <RecoGroup title="저평가 회복" rows={undervalued} onOpenStock={onOpenStock} />
        <RecoGroup title="초기 추세돌파" rows={breakout} onOpenStock={onOpenStock} />
      </div>
    );
  }

  if (category === 'theme') {
    if (themes.isLoading) return <LoadingState label="실제 테마 데이터를 불러오는 중입니다." />;
    if (themes.isError) return <ErrorState onRetry={() => { void themes.refetch(); }} />;
    const groups = themes.data?.themes ?? [];
    if (groups.length === 0) return <EmptyState compact title="표시할 테마 데이터가 없습니다" />;
    return (
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.key} className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-bold">{group.label}</h3>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">{group.count}</span>
            </div>
            <div className="space-y-2">
              {group.stocks.map((stock) => (
                <StockRow key={`${group.key}:${stock.ticker}`} stock={stock as unknown as AnyObj} onClick={() => onOpenStock(stock.ticker)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // tradingValue / volume / gainers / losers
  if (movers.isLoading) return <LoadingState label="실제 순위 데이터를 불러오는 중입니다." />;
  if (movers.isError) return <ErrorState onRetry={() => { void movers.refetch(); }} />;
  const data = movers.data;
  const rows = category === 'tradingValue'
    ? data?.popular ?? []
    : category === 'volume'
      ? data?.volume ?? []
      : category === 'gainers'
        ? data?.gainers ?? []
        : data?.losers ?? [];
  if (rows.length === 0) return <EmptyState compact title="표시할 종목 데이터가 없습니다" />;
  return (
    <div className="space-y-2">
      {rows
        .filter((row) => row.market === stockMarket)
        .map((stock, index) => (
          <StockRankRow key={`${stock.market}:${stock.ticker}`} rank={index + 1} stock={stock} onClick={() => onOpenStock(String(stock.ticker))} />
        ))}
    </div>
  );
}

function StockRankRow({ rank, stock, onClick }: { rank: number; stock: AnyObj; onClick: () => void }) {
  const change = finitePercent(stock.changePercent);
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-left transition hover:border-primary/30 min-[1200px]:rounded-none min-[1200px]:border-x-0 min-[1200px]:border-t-0 min-[1200px]:shadow-none">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">{rank}</div>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-bold">{displayStockName(String(stock.ticker), String(stock.name ?? ''), String(stock.market))}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">{stock.market}</span></div><p className="mt-0.5 text-xs font-medium text-muted-foreground">{stock.ticker}</p></div>
      <div className="text-right"><p className="text-sm font-bold">{formatAppPrice(stock.price, String(stock.currency))}</p><p className={cn('mt-0.5 text-xs font-semibold', change !== null && change > 0 ? 'text-positive' : change !== null && change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{change === null ? '데이터 없음' : formatAppPercent(change)}</p></div>
    </button>
  );
}

function RecoGroup({ title, rows, onOpenStock }: { title: string; rows: RecoRow[]; onOpenStock: (ticker: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="px-1 text-sm font-bold">{title}</h3>
      <div className="space-y-2">
        {rows.map((row) => {
          const change = finitePercent(row.changePercent);
          return (
          <button key={`${row.market}:${row.ticker}`} type="button" onClick={() => onOpenStock(row.ticker)} className="w-full rounded-xl border border-card-border bg-card p-3 text-left transition hover:border-primary/30 min-[1200px]:rounded-none min-[1200px]:border-x-0 min-[1200px]:border-t-0 min-[1200px]:shadow-none">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><p className="truncate text-sm font-bold">{displayStockName(row.ticker, row.name, row.market)}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">{row.market}</span></div>
                <p className="mt-0.5 text-xs font-medium text-muted-foreground">{row.ticker} · 규칙 점수 {row.score}점</p>
              </div>
              <div className="shrink-0 text-right"><p className="text-sm font-bold">{formatAppPrice(row.price, row.currency)}</p><p className={cn('mt-0.5 text-xs font-semibold', change !== null && change > 0 ? 'text-positive' : change !== null && change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{change === null ? '데이터 없음' : formatAppPercent(change)}</p></div>
            </div>
            {row.reasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs font-medium text-foreground/90">
                {row.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
          </button>
          );
        })}
      </div>
    </div>
  );
}

// ── 코인 분류 결과 ──────────────────────────────────────────────
function CoinCategoryResults({
  category,
  coinCategorySupported,
  coinTickerQuery,
  sortedCoins,
  coinMarket,
  onOpenCoin,
}: {
  category: CategoryKey;
  coinCategorySupported: boolean;
  coinTickerQuery: ReturnType<typeof useQuery<AnyObj>>;
  sortedCoins: AnyObj[];
  coinMarket: 'spot' | 'futures';
  onOpenCoin: (symbol: string) => void;
}) {
  if (!coinCategorySupported) {
    // AI추천·테마종목은 코인 공급자가 없음
    return <EmptyState compact title="이 시장에서는 지원하지 않는 분류입니다" description="추천·테마 데이터는 현재 주식 시장에서만 제공합니다." />;
  }
  if (coinTickerQuery.isLoading) return <LoadingState label="실제 코인 시세를 불러오는 중입니다." />;
  if (coinTickerQuery.isError) return <ErrorState onRetry={() => { void coinTickerQuery.refetch(); }} />;
  if (sortedCoins.length === 0) return <EmptyState compact title="표시할 코인 데이터가 없습니다" />;
  return (
    <div className="space-y-2">
      {sortedCoins.map((row, index) => (
        <CoinRankRow key={String(row.symbol)} rank={index + 1} row={row} coinMarket={coinMarket} onClick={() => onOpenCoin(String(row.symbol))} />
      ))}
    </div>
  );
}

function CoinRankRow({ rank, row, coinMarket, onClick }: { rank: number; row: AnyObj; coinMarket: 'spot' | 'futures'; onClick: () => void }) {
  const change = Number(row.changePercent ?? row.changePercent24h);
  const currency = coinMarket === 'spot' ? 'KRW' : 'USDT';
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-left transition hover:border-primary/30 min-[1200px]:rounded-none min-[1200px]:border-x-0 min-[1200px]:border-t-0 min-[1200px]:shadow-none">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">{rank}</div>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-xs font-medium text-muted-foreground">{row.symbol} · {coinMarket === 'spot' ? 'UPBIT' : 'BITGET'}</p></div>
      <div className="text-right"><p className="text-sm font-bold">{formatAppPrice(Number(row.price), currency)}</p><p className={cn('mt-0.5 text-xs font-semibold', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
    </button>
  );
}
