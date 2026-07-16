import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { AssetSwitch } from '@/components/asset-switch';
import { useAssetMode } from '@/lib/asset-mode';
import { api, apiGet, type QuoteRow, type SectorPopularData, type SectorPopularRow } from '@/lib/api';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

function formatDateTime(now: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(now);
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const mode = useAssetMode();
  const [now, setNow] = useState(() => new Date());

  // 딥링크(?asset=coin|stock&marketMode=KR|US) 지원 — 검증·공유용, 기본 동작 불변.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const asset = p.get('asset');
    const mk = p.get('marketMode');
    if (asset === 'coin' || asset === 'stock') mode.setAsset(asset);
    if (mk === 'US' || mk === 'KR') mode.setStockMarket(mk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const summary = useQuery({
    queryKey: ['home-market-summary'],
    queryFn: () => api.summary(),
    enabled: mode.asset === 'stock',
    refetchInterval: 10_000,
  });
  const sectorPopular = useQuery({
    queryKey: ['home-sector-popular', mode.stockMarket],
    queryFn: () => api.sectorPopular(mode.stockMarket),
    enabled: mode.asset === 'stock',
    refetchInterval: 30_000,
  });
  const cryptoStatus = useQuery({
    queryKey: ['home-crypto-status'],
    queryFn: () => apiGet<AnyObj>('/crypto/status'),
    enabled: mode.asset === 'coin',
    refetchInterval: 30_000,
  });
  const spotTickers = useQuery({
    queryKey: ['home-crypto-spot-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'spot',
    refetchInterval: 10_000,
  });
  const futuresTickers = useQuery({
    queryKey: ['home-crypto-futures-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'futures',
    refetchInterval: 8_000,
  });

  const cryptoRows = useMemo(() => {
    const source = mode.coinMarket === 'spot'
      ? ((spotTickers.data?.tickers ?? []) as AnyObj[])
      : ((futuresTickers.data?.tickers ?? []) as AnyObj[]);
    return [...source]
      .sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0))
      .slice(0, 10);
  }, [futuresTickers.data, mode.coinMarket, spotTickers.data]);

  const refresh = () => {
    if (mode.asset === 'stock') {
      void Promise.all([summary.refetch(), sectorPopular.refetch()]);
    } else {
      void Promise.all([cryptoStatus.refetch(), mode.coinMarket === 'spot' ? spotTickers.refetch() : futuresTickers.refetch()]);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black">지식정보</h1>
            <p className="mt-1 text-[11px] font-bold text-muted-foreground">{formatDateTime(now)}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => navigate('/alerts')} aria-label="알림" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"><Bell className="h-4 w-4" /></button>
            <button type="button" onClick={refresh} aria-label="새로고침" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"><RefreshCw className={cn('h-4 w-4', (summary.isFetching || sectorPopular.isFetching || spotTickers.isFetching || futuresTickers.isFetching) && 'animate-spin')} /></button>
          </div>
        </div>
        <AssetSwitch className="mt-3" />
        <button type="button" onClick={() => navigate('/stocks')} className="mt-3 flex w-full items-center gap-2 rounded-2xl border border-card-border bg-card px-4 py-3 text-left">
          <Search className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-black text-muted-foreground">{mode.asset === 'stock' ? '종목 검색' : '코인 검색'}</span>
        </button>
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
        {mode.asset === 'stock' ? (
          <StockHome mode={mode.stockMarket} summary={summary.data?.items ?? []} sectorData={sectorPopular.data} summaryLoading={summary.isLoading} summaryError={summary.isError} sectorLoading={sectorPopular.isLoading} sectorError={sectorPopular.isError} onNavigate={navigate} />
        ) : (
          <CryptoHome mode={mode.coinMarket} status={cryptoStatus.data} rows={cryptoRows} loading={mode.coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading} error={mode.coinMarket === 'spot' ? spotTickers.isError : futuresTickers.isError} onNavigate={navigate} />
        )}
      </main>
      <BottomNav />
    </div>
  );
}

function StockHome({ mode, summary, sectorData, summaryLoading, summaryError, sectorLoading, sectorError, onNavigate }: { mode: 'KR' | 'US'; summary: AnyObj[]; sectorData?: SectorPopularData; summaryLoading: boolean; summaryError: boolean; sectorLoading: boolean; sectorError: boolean; onNavigate: (to: string) => void }) {
  const wanted = mode === 'KR' ? ['kospi', 'kosdaq'] : ['nasdaq'];
  const indices = summary.filter((item) => wanted.includes(String(item.key).toLowerCase()));
  const sectors = sectorData?.sectors ?? [];
  // 실제 인기(섹터 내 종목의 거래대금 합, 없으면 거래량 합) 기준 상위 5개만 세로 목록으로.
  const topSectors = useMemo(() => {
    const scored = sectors.map((sector) => ({
      sector,
      score: sector.rows.reduce((sum, row) => sum + (finite(row.tradingValue) ?? finite(row.volume) ?? 0), 0),
      count: sector.rows.length,
    }));
    scored.sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0) || b.score - a.score || b.count - a.count);
    return scored.slice(0, 5).map((item) => item.sector);
  }, [sectors]);
  // 딥링크(?sector=키) 지원 — 해당 섹터 팝업을 바로 연다. 기본은 팝업 닫힘.
  const [openSector, setOpenSector] = useState<string | null>(() => new URLSearchParams(window.location.search).get('sector'));
  const selected = sectors.find((sector) => sector.key === openSector) ?? null;
  return (
    <>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-sm font-black">시장현황</h2><span className="text-[10px] font-bold text-muted-foreground">실제 제공기관 기준</span></div>
        {summaryLoading && <State>시장 데이터를 불러오는 중입니다.</State>}
        {summaryError && <State error>시장 데이터 제공기관이 지연되고 있습니다.</State>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {indices.map((item) => {
            const change = finite(item.changePercent);
            return <InfoCard key={String(item.key)} label={String(item.label ?? item.key)} value={finite(item.price) == null ? '데이터 없음' : Number(item.price).toLocaleString(undefined, { maximumFractionDigits: 2 })} sub={change == null ? '등락 데이터 없음' : formatAppPercent(change)} tone={change == null ? undefined : change >= 0 ? 'up' : 'down'} />;
          })}
          {!summaryLoading && indices.length === 0 && <div className="col-span-2"><State>현재 제공된 지수 데이터가 없습니다.</State></div>}
        </div>
      </section>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-black">섹터별 인기종목</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">{sectorData?.sortBasis ?? '거래대금 기준'}</p></div><button type="button" onClick={() => onNavigate('/stocks')} className="text-xs font-black text-primary">전체보기</button></div>
        {sectorLoading && <State>섹터 데이터를 불러오는 중입니다.</State>}
        {sectorError && <State error>섹터 데이터 제공기관이 지연되고 있습니다.</State>}
        {/* 인기 섹터 상위 5개 — 세로 목록(가로 스크롤 없음). 종목은 팝업에서만 표시. */}
        <div className="mt-3 space-y-2">
          {topSectors.map((sector) => <SectorListButton key={sector.key} label={sector.label} onClick={() => setOpenSector(sector.key)} />)}
        </div>
        {!sectorLoading && !sectorError && topSectors.length === 0 && <State>현재 표시할 실제 섹터 데이터가 없습니다.</State>}
      </section>
      {selected && (
        <SectorPopup title={`${selected.label} 인기종목`} sortBasis={sectorData?.sortBasis ?? '거래대금 기준'} onViewAll={() => onNavigate('/stocks')} onClose={() => setOpenSector(null)}>
          {selected.rows.slice(0, 5).map((row, index) => <StockRow key={`${row.market}:${row.ticker}`} row={row} rank={row.rank ?? index + 1} onClick={() => onNavigate(`/stock/${encodeURIComponent(row.ticker)}`)} />)}
          {selected.rows.length === 0 && <State>현재 표시할 실제 종목 데이터가 없습니다.</State>}
        </SectorPopup>
      )}
    </>
  );
}

// 검증 가능한 코인 분야 분류(정적). 근거가 명확한 널리 알려진 코인만 포함하며,
// 근거 불명 코인은 어떤 분야에도 넣지 않는다. 가격·등락률은 실데이터에서 채운다.
const COIN_SECTORS: { key: string; label: string; symbols: string[] }[] = [
  { key: 'major', label: '주요 코인', symbols: ['BTC', 'ETH', 'XRP'] },
  { key: 'smart-contract', label: '스마트계약', symbols: ['ETH', 'SOL', 'ADA'] },
  { key: 'payment', label: '결제', symbols: ['XRP', 'BTC'] },
  { key: 'defi', label: '디파이', symbols: ['UNI', 'AAVE', 'LINK'] },
  { key: 'meme', label: '밈', symbols: ['DOGE', 'SHIB', 'PEPE'] },
  { key: 'ai-data', label: 'AI·데이터', symbols: ['FET', 'GRT'] },
  { key: 'gaming', label: '게임·메타버스', symbols: ['SAND', 'MANA', 'AXS'] },
  { key: 'layer2', label: '레이어2', symbols: ['ARB', 'OP', 'POL'] },
];

// 심볼(KRW-BTC, BTCUSDT 등)에서 기초 심볼(BTC)만 추출.
function baseCoinSymbol(symbol: string): string {
  const raw = String(symbol ?? '').toUpperCase().trim();
  const dashed = raw.includes('-') ? raw.split('-').pop() ?? raw : raw;
  return dashed.replace(/(USDT|USDC|KRW|BTC)$/u, (m) => (dashed === m ? m : '')) || dashed;
}

function CryptoHome({ mode, status, rows, loading, error, onNavigate }: { mode: 'spot' | 'futures'; status?: AnyObj; rows: AnyObj[]; loading: boolean; error: boolean; onNavigate: (to: string) => void }) {
  const exchange = mode === 'spot' ? 'UPBIT' : 'BITGET';
  const ok = mode === 'spot' ? status?.upbit?.ok : status?.bitget?.ok;
  const btc = rows.find((row) => String(row.symbol).startsWith('BTC'));
  const eth = rows.find((row) => String(row.symbol).startsWith('ETH'));
  const xrp = rows.find((row) => String(row.symbol).startsWith('XRP'));

  const bySymbol = useMemo(() => {
    const map = new Map<string, AnyObj>();
    for (const row of rows) {
      const base = baseCoinSymbol(String(row.symbol));
      if (!map.has(base)) map.set(base, row);
    }
    return map;
  }, [rows]);

  // 실제 거래대금 합 기준 상위 5개 분야만 세로 목록으로.
  const rankedSectors = useMemo(() => {
    const scored = COIN_SECTORS.map((sector) => {
      const sectorRows = sector.symbols.map((symbol) => bySymbol.get(symbol)).filter((row): row is AnyObj => Boolean(row));
      return { sector, sectorRows, score: sectorRows.reduce((sum, row) => sum + (finite(row.tradingValue24h) ?? 0), 0) };
    });
    // 실데이터가 있는 분야만 후보로 삼는다 — 시세가 전혀 없으면 목록 대신 정직한 안내 문구를 보여준다.
    const withData = scored.filter((item) => item.sectorRows.length > 0);
    withData.sort((a, b) => b.score - a.score);
    return withData.slice(0, 5);
  }, [bySymbol]);
  // 딥링크(?coinCat=키) 지원 — 해당 분야 팝업을 바로 연다. 기본은 팝업 닫힘.
  const [openSector, setOpenSector] = useState<string | null>(() => new URLSearchParams(window.location.search).get('coinCat'));
  const selected = COIN_SECTORS.find((sector) => sector.key === openSector) ?? null;
  const selectedRows = useMemo(
    () => (selected ? selected.symbols.map((symbol) => bySymbol.get(symbol)).filter((row): row is AnyObj => Boolean(row)) : []),
    [bySymbol, selected],
  );

  return (
    <>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-sm font-black">{mode === 'spot' ? '코인 현물 시장' : '코인 선물 시장'}</h2><span className={cn('rounded-full px-2 py-1 text-[10px] font-black', ok ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive')}>{exchange} · {ok ? '정상' : '오류'}</span></div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <CryptoSummary row={btc} label={`비트코인 (${mode === 'spot' ? 'BTC/KRW' : 'BTCUSDT'})`} currency={mode === 'spot' ? 'KRW' : 'USDT'} />
          <CryptoSummary row={eth} label={`이더리움 (${mode === 'spot' ? 'ETH/KRW' : 'ETHUSDT'})`} currency={mode === 'spot' ? 'KRW' : 'USDT'} />
          <CryptoSummary row={xrp} label={`리플 (${mode === 'spot' ? 'XRP/KRW' : 'XRPUSDT'})`} currency={mode === 'spot' ? 'KRW' : 'USDT'} />
        </div>
        <p className="mt-2 text-[10px] font-bold text-muted-foreground">
          {mode === 'spot' ? '업비트 공개 API' : '비트겟 공개 API'} 실시간 시세 기준
        </p>
        {mode === 'futures' && btc && <div className="mt-2 grid grid-cols-2 gap-2"><InfoCard label="BTC 펀딩비" value={finite(btc.fundingRate) == null ? '데이터 없음' : `${(Number(btc.fundingRate) * 100).toFixed(4)}%`} /><InfoCard label="BTC 미결제약정" value={finite(btc.openInterest) == null ? '데이터 없음' : Number(btc.openInterest).toLocaleString()} /></div>}
      </section>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between"><div><h2 className="text-sm font-black">분야별 인기코인</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">거래대금 기준</p></div><button type="button" onClick={() => onNavigate('/stocks')} className="text-xs font-black text-primary">전체보기</button></div>
        {loading && <State>코인 시세를 불러오는 중입니다.</State>}
        {error && <State error>거래소 시세를 불러오지 못했습니다.</State>}
        {/* 인기 분야 상위 5개 — 세로 목록(가로 스크롤 없음). 코인은 팝업에서만 표시. */}
        <div className="mt-3 space-y-2">
          {rankedSectors.map(({ sector }) => <SectorListButton key={sector.key} label={sector.label} onClick={() => setOpenSector(sector.key)} />)}
        </div>
        {!loading && !error && rankedSectors.length === 0 && <State>현재 표시할 실제 분야 데이터가 없습니다.</State>}
      </section>
      {selected && (
        <SectorPopup title={`${selected.label} 인기코인`} sortBasis="거래대금 기준" onViewAll={() => onNavigate('/stocks')} onClose={() => setOpenSector(null)}>
          {selectedRows.slice(0, 5).map((row, index) => <CryptoRow key={String(row.symbol)} row={row} rank={index + 1} currency={mode === 'spot' ? 'KRW' : 'USDT'} onClick={() => onNavigate(`/stock-info?asset=coin&coinMarket=${mode}&symbol=${encodeURIComponent(String(row.symbol))}`)} />)}
          {selectedRows.length === 0 && <State>현재 표시할 실제 종목 데이터가 없습니다.</State>}
        </SectorPopup>
      )}
    </>
  );
}

// 섹터 세로 목록의 한 줄 버튼 — 이름과 화살표 그룹을 카드 정중앙에 배치.
function SectorListButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-card-border bg-secondary/60 px-4 py-3 text-center">
      <span className="min-w-0 break-keep text-sm font-black leading-tight">{label}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

// 섹터를 눌렀을 때 뜨는 작은 하단 팝업 — 페이지 이동 없음, 하단 메뉴보다 위(z-[70]).
function SectorPopup({ title, sortBasis, children, onViewAll, onClose }: { title: string; sortBasis: string; children: React.ReactNode; onViewAll: () => void; onClose: () => void }) {
  // 키보드(Esc) 닫기 지원.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-4 pb-24" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md overflow-hidden rounded-3xl border border-card-border bg-card shadow-lg" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-card-border px-4 py-3 text-center">
          <h3 className="break-keep text-sm font-black leading-tight">{title}</h3>
          <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{sortBasis}</p>
        </div>
        <div className="max-h-[45vh] space-y-2 overflow-y-auto p-3">{children}</div>
        <div className="grid grid-cols-2 gap-2 border-t border-card-border p-3">
          <button type="button" onClick={onViewAll} className="inline-flex items-center justify-center rounded-xl border border-primary bg-primary px-3 py-2 text-center text-xs font-black text-primary-foreground">전체보기</button>
          <button type="button" onClick={onClose} className="inline-flex items-center justify-center rounded-xl border border-card-border bg-secondary/60 px-3 py-2 text-center text-xs font-black">닫기</button>
        </div>
      </div>
    </div>
  );
}

function StockRow({ row, rank, onClick }: { row: QuoteRow | SectorPopularRow; rank: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 p-3 text-left"><span className="w-6 text-center text-sm font-black text-primary">{rank}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayStockName(row.ticker, row.name, row.market)}</p><p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{row.ticker}</p></div><div className="text-right"><p className="text-xs font-black">{formatAppPrice(row.price, row.currency)}</p><p className={cn('text-[10px] font-black', row.changePercent >= 0 ? 'text-positive' : 'text-destructive')}>{formatAppPercent(row.changePercent)}</p></div></button>;
}

function CryptoRow({ row, rank, currency, onClick }: { row: AnyObj; rank: number; currency: string; onClick: () => void }) {
  const change = finite(row.changePercent ?? row.changePercent24h);
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 p-3 text-left"><span className="w-6 text-center text-sm font-black text-primary">{rank}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{row.symbol}</p></div><div className="text-right"><p className="text-xs font-black">{formatAppPrice(Number(row?.price), currency)}</p><p className={cn('text-[10px] font-black', change == null ? 'text-muted-foreground' : change >= 0 ? 'text-positive' : 'text-destructive')}>{change == null ? '데이터 없음' : formatAppPercent(change)}</p></div></button>;
}

function CryptoSummary({ row, label, currency }: { row?: AnyObj; label: string; currency: string }) {
  const change = finite(row?.changePercent ?? row?.changePercent24h);
  return <InfoCard label={label} value={finite(row?.price) == null ? '데이터 없음' : formatAppPrice(Number(row?.price), currency)} sub={change == null ? '등락 데이터 없음' : formatAppPercent(change)} tone={change == null ? undefined : change >= 0 ? 'up' : 'down'} />;
}

function InfoCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return <div className="rounded-2xl bg-secondary/60 p-3"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 text-sm font-black">{value}</p>{sub && <p className={cn('mt-1 text-[10px] font-black', tone === 'up' ? 'text-positive' : tone === 'down' ? 'text-destructive' : 'text-muted-foreground')}>{sub}</p>}</div>;
}

function State({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <p className={cn('mt-3 rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground', error && 'bg-destructive/10 text-destructive')}>{children}</p>;
}
