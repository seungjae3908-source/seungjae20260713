import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Maximize2, Minimize2, Search, RefreshCw } from 'lucide-react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api, apiGet, type Candle, type ChartData } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  detectPatterns,
  detectSignals,
  emaSeries,
  macdSeries,
  rsiSeries,
  smaSeries,
  toStudyRows,
  type PatternKind,
  type PatternOccurrence,
  type SignalKind,
  type StudyOccurrence,
  type StudyRow,
} from '@/lib/study-detect';

// ── 공부 전용 인터랙티브 실데이터 차트 ─────────────────────
// 실제 캔들 데이터에서만 신호·패턴을 탐지한다. 가짜 캔들·임의 마커 금지.

const NOTICE = '교육 목적이며 매수·매도 권유가 아닙니다.';
const NO_SIGNAL = '현재 선택한 종목과 조회 기간에서는 해당 사례를 찾지 못했습니다.';
const NO_PATTERN = '명확한 실제 사례를 찾지 못했습니다.';
const NO_DATA = '현재 표시할 실제 종목 데이터가 없습니다.';
const CRYPTO_UNAVAILABLE = '코인 차트 데이터 공급자가 연결되어 있지 않습니다.';

export type StudyChartMode = 'signal' | 'pattern';

export interface StudyChartConfig {
  title: string; // 공부 중인 패턴·지표 이름
  mode: StudyChartMode;
  signalKind?: SignalKind;
  patternKind?: PatternKind;
  // 주제별 보조지표 표시 힌트
  showRsi?: boolean;
  showMacd?: boolean;
}

type AssetKind = 'stock' | 'crypto';
type Region = 'KR' | 'US';
type Tf = '1D' | '1W';

interface SearchTarget {
  id: string; // 종목코드 또는 코인 심볼
  name: string;
  assetKind: AssetKind;
  region: Region;
}

const DEFAULT_TARGET: SearchTarget = {
  id: '005930',
  name: '삼성전자',
  assetKind: 'stock',
  region: 'KR',
};

// 시간 변환 (detail.tsx 규칙 재사용)
function chartTimestamp(value: string, index: number, total: number): UTCTimestamp {
  const raw = String(value ?? '').trim();
  const d = raw.replace(/\D/g, '');
  if (/^\d{14}$/.test(d)) {
    return Math.floor(new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12), +d.slice(12, 14)).getTime() / 1000) as UTCTimestamp;
  }
  if (/^\d{8}$/.test(d)) {
    return Math.floor(new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)).getTime() / 1000) as UTCTimestamp;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) return Math.floor(numeric / 1000) as UTCTimestamp;
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) return Math.floor(numeric) as UTCTimestamp;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000) as UTCTimestamp;
  return Math.floor(Date.now() / 1000 - (total - index) * 86400) as UTCTimestamp;
}

interface TimedRow extends Omit<StudyRow, 'time'> {
  time: UTCTimestamp;
}

function withTimes(rows: StudyRow[]): TimedRow[] {
  let prev = 0;
  return rows.map((r, i) => {
    const raw = Number(chartTimestamp(r.time, i, rows.length));
    const next = raw <= prev ? prev + 1 : raw;
    prev = next;
    return { ...r, time: next as UTCTimestamp };
  });
}

interface CryptoCandlesResponse {
  ok?: boolean;
  candles?: Candle[];
  error?: string;
}

// ── 데이터 로더 ───────────────────────────────────────
async function loadCandles(target: SearchTarget, tf: Tf): Promise<{ chart: ChartData | null; rows: StudyRow[]; error: string | null }> {
  if (target.assetKind === 'crypto') {
    try {
      const res = await apiGet<CryptoCandlesResponse>(
        `/crypto/spot/candles?symbol=${encodeURIComponent(target.id)}&tf=${tf}&count=200`,
      );
      if (res.ok === false || !Array.isArray(res.candles) || res.candles.length < 5) {
        return { chart: null, rows: [], error: CRYPTO_UNAVAILABLE };
      }
      return { chart: null, rows: toStudyRows(res.candles), error: null };
    } catch {
      return { chart: null, rows: [], error: CRYPTO_UNAVAILABLE };
    }
  }
  const chart = await api.chart(target.id, tf === '1W' ? '1W' : '1D');
  const rows = toStudyRows(chart.candles);
  if (rows.length < 5) return { chart: null, rows: [], error: NO_DATA };
  return { chart, rows, error: null };
}

function baseOptions(height: number) {
  return {
    width: 0,
    height,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: 'inherit',
    },
    grid: {
      vertLines: { color: 'rgba(148,163,184,0.10)' },
      horzLines: { color: 'rgba(148,163,184,0.10)' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(148,163,184,0.6)', labelBackgroundColor: '#334155' },
      horzLine: { color: 'rgba(148,163,184,0.6)', labelBackgroundColor: '#334155' },
    },
    rightPriceScale: { borderColor: 'rgba(148,163,184,0.25)' },
    timeScale: { borderColor: 'rgba(148,163,184,0.25)', timeVisible: false, secondsVisible: false, rightOffset: 4, barSpacing: 8, minBarSpacing: 2 },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: { locale: 'ko-KR' },
  };
}

interface ActiveDetail {
  title: string;
  date: string;
  price: number;
  direction: 'up' | 'down';
  condition: string;
  indicatorText: string;
  description: string;
}

export function StudyChart({ config, onClose }: { config: StudyChartConfig; onClose: () => void }) {
  const [assetKind, setAssetKind] = useState<AssetKind>('stock');
  const [region, setRegion] = useState<Region>('KR');
  const [tf, setTf] = useState<Tf>('1D');
  const [target, setTarget] = useState<SearchTarget>(DEFAULT_TARGET);
  const [fullscreen, setFullscreen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showIndicators, setShowIndicators] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [caseIndex, setCaseIndex] = useState(0);
  const [activeDetail, setActiveDetail] = useState<ActiveDetail | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const dataQuery = useQuery({
    queryKey: ['study-chart', target.assetKind, target.id, tf],
    queryFn: () => loadCandles(target, tf),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => dataQuery.data?.rows ?? [], [dataQuery.data]);
  const timed = useMemo(() => withTimes(rows), [rows]);

  const signalOccurrences = useMemo<StudyOccurrence[]>(() => {
    if (config.mode !== 'signal' || !config.signalKind || rows.length < 5) return [];
    return detectSignals(config.signalKind, rows);
  }, [config.mode, config.signalKind, rows]);

  const patternOccurrences = useMemo<PatternOccurrence[]>(() => {
    if (config.mode !== 'pattern' || !config.patternKind || rows.length < 15) return [];
    return detectPatterns(config.patternKind, rows);
  }, [config.mode, config.patternKind, rows]);

  const totalCases = config.mode === 'signal' ? signalOccurrences.length : patternOccurrences.length;

  // 종목/사례 변경 시 사례 인덱스 초기화
  useEffect(() => {
    setCaseIndex(0);
  }, [target.id, target.assetKind, tf, config.signalKind, config.patternKind]);

  // 현재 사례를 상세 영역에 반영
  useEffect(() => {
    if (config.mode === 'signal' && signalOccurrences.length) {
      const o = signalOccurrences[Math.min(caseIndex, signalOccurrences.length - 1)];
      setActiveDetail({
        title: config.title,
        date: o.date,
        price: o.price,
        direction: o.direction,
        condition: o.condition,
        indicatorText: o.indicatorText,
        description: o.description,
      });
    } else if (config.mode === 'pattern' && patternOccurrences.length) {
      const o = patternOccurrences[Math.min(caseIndex, patternOccurrences.length - 1)];
      setActiveDetail({
        title: config.title,
        date: o.date,
        price: o.price,
        direction: o.direction,
        condition: o.condition,
        indicatorText: o.indicatorText,
        description: o.description,
      });
    } else {
      setActiveDetail(null);
    }
  }, [config, caseIndex, signalOccurrences, patternOccurrences]);

  const applyTarget = (t: SearchTarget) => {
    setTarget(t);
    setSearchOpen(false);
    setSearchTerm('');
  };

  const nextCase = () => {
    if (totalCases <= 1) return;
    setCaseIndex((i) => (i + 1) % totalCases);
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex flex-col bg-background',
        !fullscreen && 'sm:inset-x-0',
      )}
    >
      {/* 상단 컨트롤 */}
      <div className="flex-none border-b border-card-border bg-background/95 px-3 py-3 glass">
        <div className="flex items-center justify-between gap-2">
          <p className="flex-1 truncate text-center text-base font-black">{config.title}</p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="rounded-lg border border-card-border bg-card p-1.5 text-muted-foreground"
              aria-label="전체 화면"
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-card-border bg-card p-1.5 text-muted-foreground"
              aria-label="닫기"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          <Segmented
            options={[
              { key: 'stock', label: '주식' },
              { key: 'crypto', label: '코인' },
            ]}
            value={assetKind}
            onChange={(v) => {
              const kind = v as AssetKind;
              setAssetKind(kind);
              if (kind === 'crypto') applyTarget({ id: 'BTC', name: '비트코인', assetKind: 'crypto', region: 'KR' });
              else applyTarget(DEFAULT_TARGET);
            }}
          />
          {assetKind === 'stock' && (
            <Segmented
              options={[
                { key: 'KR', label: '국내' },
                { key: 'US', label: '해외' },
              ]}
              value={region}
              onChange={(v) => {
                const r = v as Region;
                setRegion(r);
                applyTarget(r === 'KR' ? DEFAULT_TARGET : { id: 'AAPL', name: 'Apple', assetKind: 'stock', region: 'US' });
              }}
            />
          )}
          <Segmented
            options={[
              { key: '1D', label: '일봉' },
              { key: '1W', label: '주봉' },
            ]}
            value={tf}
            onChange={(v) => setTf(v as Tf)}
          />
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className="flex items-center gap-1 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-xs font-black"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="max-w-[7rem] truncate">{target.name}</span>
          </button>
          <button
            type="button"
            onClick={nextCase}
            disabled={totalCases <= 1}
            className={cn(
              'flex items-center gap-1 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-xs font-black',
              totalCases <= 1 && 'opacity-50',
            )}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            다른 사례 찾기
          </button>
        </div>

        {/* 표시 토글 */}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          <Toggle label="마커" active={showMarkers} onClick={() => setShowMarkers((v) => !v)} />
          <Toggle label="보조지표" active={showIndicators} onClick={() => setShowIndicators((v) => !v)} />
          <Toggle label="거래량" active={showVolume} onClick={() => setShowVolume((v) => !v)} />
        </div>

        {searchOpen && (
          <SearchPanel
            assetKind={assetKind}
            region={region}
            term={searchTerm}
            onTerm={setSearchTerm}
            onPick={applyTarget}
          />
        )}
      </div>

      {/* 차트 영역 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {dataQuery.isLoading ? (
          <div className="flex h-52 items-center justify-center rounded-2xl bg-secondary/60 text-center text-sm font-bold text-muted-foreground">
            실제 차트를 불러오는 중...
          </div>
        ) : dataQuery.isError || dataQuery.data?.error || rows.length < 5 ? (
          <div className="flex h-52 items-center justify-center rounded-2xl bg-secondary/60 px-4 text-center text-sm font-bold leading-relaxed text-muted-foreground">
            {dataQuery.data?.error ?? NO_DATA}
          </div>
        ) : (
          <ChartCanvas
            timed={timed}
            config={config}
            fullscreen={fullscreen}
            showMarkers={showMarkers}
            showIndicators={showIndicators}
            showVolume={showVolume}
            signalOccurrences={signalOccurrences}
            patternOccurrences={patternOccurrences}
            caseIndex={caseIndex}
            onMarkerClick={(d) => setActiveDetail(d)}
          />
        )}

        {/* 사례 없음 안내 */}
        {!dataQuery.isLoading && !dataQuery.isError && !dataQuery.data?.error && rows.length >= 5 && totalCases === 0 && (
          <div className="mt-3 rounded-2xl bg-secondary/60 px-4 py-4 text-center">
            <p className="break-keep text-center text-sm font-bold leading-relaxed text-muted-foreground">
              {config.mode === 'pattern' ? NO_PATTERN : NO_SIGNAL}
            </p>
          </div>
        )}

        {/* 하단 상세 */}
        {activeDetail && (
          <div className="mt-3 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
            <div className="flex items-center justify-center gap-2">
              <span className="text-sm font-black">{activeDetail.title}</span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-black',
                  activeDetail.direction === 'up' ? 'bg-positive/15 text-positive' : 'bg-destructive/15 text-destructive',
                )}
              >
                {activeDetail.direction === 'up' ? '상승 신호' : '하락·위험 신호'}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-center gap-3">
              <span className="text-sm font-extrabold">{activeDetail.date}</span>
              <span className="text-sm font-extrabold text-primary">
                {activeDetail.price.toLocaleString()}
                {target.assetKind === 'stock' && target.region === 'US' ? '' : target.assetKind === 'crypto' ? '원' : '원'}
              </span>
            </div>
            <DetailRow label="판단 조건">{activeDetail.condition}</DetailRow>
            <DetailRow label="지표 값">{activeDetail.indicatorText || '해당 없음'}</DetailRow>
            <DetailRow label="설명">{activeDetail.description}</DetailRow>
            <p className="mt-2 text-center text-[11px] font-bold text-muted-foreground">{NOTICE}</p>
          </div>
        )}

        {(!activeDetail && totalCases === 0) && (
          <p className="mt-3 text-center text-[11px] font-bold text-muted-foreground">{NOTICE}</p>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2 rounded-xl bg-secondary/40 p-2 text-center">
      <p className="text-[11px] font-extrabold text-primary">{label}</p>
      <p className="mt-0.5 break-keep text-center text-xs font-semibold leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-card-border">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            'px-2.5 py-1.5 text-xs font-black transition',
            value === o.key ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-2.5 py-1 text-xs font-black transition',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {label} {active ? 'ON' : 'OFF'}
    </button>
  );
}

// ── 검색 패널 ─────────────────────────────────────────
interface CryptoMarket {
  market: string;
  symbol: string;
  koreanName: string;
}

function SearchPanel({
  assetKind,
  region,
  term,
  onTerm,
  onPick,
}: {
  assetKind: AssetKind;
  region: Region;
  term: string;
  onTerm: (v: string) => void;
  onPick: (t: SearchTarget) => void;
}) {
  const stockQuery = useQuery({
    queryKey: ['study-search-stock', term],
    queryFn: () => api.searchRows(term),
    enabled: assetKind === 'stock' && term.trim().length >= 1,
    staleTime: 30_000,
  });

  const cryptoQuery = useQuery({
    queryKey: ['study-search-crypto'],
    queryFn: () => apiGet<{ markets: CryptoMarket[]; error?: string }>('/crypto/spot/markets'),
    enabled: assetKind === 'crypto',
    staleTime: 300_000,
  });

  const stockResults = useMemo(() => {
    const rows = stockQuery.data?.results ?? [];
    return rows
      .filter((r) => (region === 'KR' ? r.market === 'KR' : r.market === 'US'))
      .slice(0, 20);
  }, [stockQuery.data, region]);

  const cryptoResults = useMemo(() => {
    const rows = cryptoQuery.data?.markets ?? [];
    const q = term.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.symbol.toLowerCase().includes(q) || r.koreanName.toLowerCase().includes(q))
      .slice(0, 20);
  }, [cryptoQuery.data, term]);

  return (
    <div className="mt-2 rounded-2xl border border-card-border bg-card p-2">
      <input
        value={term}
        onChange={(e) => onTerm(e.target.value)}
        placeholder={assetKind === 'crypto' ? '코인 이름·심볼 검색' : '종목명·코드 검색'}
        className="w-full rounded-lg border border-card-border bg-background px-3 py-2 text-sm font-semibold outline-none focus:border-primary"
      />
      <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
        {assetKind === 'stock' ? (
          stockQuery.isLoading && term.trim() ? (
            <p className="py-3 text-center text-xs font-bold text-muted-foreground">검색 중...</p>
          ) : stockQuery.isError ? (
            <p className="py-3 text-center text-xs font-bold text-muted-foreground">검색을 불러오지 못했습니다.</p>
          ) : term.trim() && stockResults.length === 0 ? (
            <p className="py-3 text-center text-xs font-bold text-muted-foreground">일치하는 종목이 없습니다.</p>
          ) : !term.trim() ? (
            <p className="py-3 text-center text-xs font-bold text-muted-foreground">종목명 또는 코드를 입력하세요.</p>
          ) : (
            stockResults.map((r) => (
              <button
                key={r.ticker}
                type="button"
                onClick={() => onPick({ id: r.ticker, name: r.name, assetKind: 'stock', region })}
                className="flex w-full items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-left"
              >
                <span className="truncate text-sm font-black">{r.name}</span>
                <span className="ml-2 shrink-0 text-xs font-bold text-muted-foreground">{r.ticker}</span>
              </button>
            ))
          )
        ) : cryptoQuery.isLoading ? (
          <p className="py-3 text-center text-xs font-bold text-muted-foreground">코인 목록을 불러오는 중...</p>
        ) : cryptoQuery.isError || cryptoQuery.data?.error ? (
          <p className="py-3 text-center text-xs font-bold text-muted-foreground">{CRYPTO_UNAVAILABLE}</p>
        ) : cryptoResults.length === 0 ? (
          <p className="py-3 text-center text-xs font-bold text-muted-foreground">일치하는 코인이 없습니다.</p>
        ) : (
          cryptoResults.map((r) => (
            <button
              key={r.market}
              type="button"
              onClick={() => onPick({ id: r.symbol, name: r.koreanName, assetKind: 'crypto', region: 'KR' })}
              className="flex w-full items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-left"
            >
              <span className="truncate text-sm font-black">{r.koreanName}</span>
              <span className="ml-2 shrink-0 text-xs font-bold text-muted-foreground">{r.symbol}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── 차트 렌더 ─────────────────────────────────────────
function ChartCanvas({
  timed,
  config,
  fullscreen,
  showMarkers,
  showIndicators,
  showVolume,
  signalOccurrences,
  patternOccurrences,
  caseIndex,
  onMarkerClick,
}: {
  timed: TimedRow[];
  config: StudyChartConfig;
  fullscreen: boolean;
  showMarkers: boolean;
  showIndicators: boolean;
  showVolume: boolean;
  signalOccurrences: StudyOccurrence[];
  patternOccurrences: PatternOccurrence[];
  caseIndex: number;
  onMarkerClick: (d: ActiveDetail) => void;
}) {
  const priceRef = useRef<HTMLDivElement | null>(null);
  const volRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);
  const macdRef = useRef<HTMLDivElement | null>(null);

  const priceHeight = fullscreen ? Math.max(360, Math.floor(window.innerHeight * 0.5)) : 320;
  const closes = useMemo(() => timed.map((r) => r.close), [timed]);

  const showRsi = showIndicators && !!config.showRsi;
  const showMacd = showIndicators && !!config.showMacd;

  // ── 가격 차트 ──
  useEffect(() => {
    const container = priceRef.current;
    if (!container || timed.length < 2) return;
    const chart = createChart(container, {
      ...baseOptions(priceHeight),
      width: Math.max(container.clientWidth, 1),
    } as any);

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#3b82f6',
      wickUpColor: '#ef4444',
      wickDownColor: '#3b82f6',
      borderUpColor: '#ef4444',
      borderDownColor: '#3b82f6',
    });
    candleSeries.setData(timed.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })));

    // 보조지표(MA)
    const addLine = (data: { time: Time; value: number }[], color: string, width: 1 | 2 = 2, style: LineStyle = LineStyle.Solid) => {
      if (!data.length) return;
      const s = chart.addLineSeries({ color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(data);
    };
    if (showIndicators) {
      const ma5 = smaSeries(closes, 5);
      const ma20 = smaSeries(closes, 20);
      addLine(timed.map((r, i) => (ma5[i] != null ? { time: r.time, value: ma5[i] as number } : null)).filter(Boolean) as any, '#f59e0b');
      addLine(timed.map((r, i) => (ma20[i] != null ? { time: r.time, value: ma20[i] as number } : null)).filter(Boolean) as any, '#22c55e');
    }

    // 패턴 선/가격선
    const focus: { markerIndex: number } | null =
      config.mode === 'signal'
        ? signalOccurrences.length
          ? { markerIndex: signalOccurrences[Math.min(caseIndex, signalOccurrences.length - 1)].index }
          : null
        : patternOccurrences.length
          ? { markerIndex: patternOccurrences[Math.min(caseIndex, patternOccurrences.length - 1)].markerIndex }
          : null;

    if (config.mode === 'pattern' && patternOccurrences.length) {
      const p = patternOccurrences[Math.min(caseIndex, patternOccurrences.length - 1)];
      for (const line of p.lines) {
        const fromT = timed[Math.max(0, Math.min(timed.length - 1, line.from.index))]?.time;
        const toT = timed[Math.max(0, Math.min(timed.length - 1, line.to.index))]?.time;
        if (fromT == null || toT == null) continue;
        const ls = chart.addLineSeries({ color: line.color, lineWidth: 2, lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        ls.setData([
          { time: fromT, value: line.from.price },
          { time: toT, value: line.to.price },
        ]);
      }
      for (const pl of p.priceLines) {
        candleSeries.createPriceLine({ price: pl.price, color: pl.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: pl.label });
      }
    }

    // 마커 (번호/화살표만)
    interface MarkerMeta {
      time: UTCTimestamp;
      index: number;
      detail: ActiveDetail;
    }
    const markerMetas: MarkerMeta[] = [];
    const usedTimes = new Set<number>();
    if (showMarkers) {
      if (config.mode === 'signal') {
        signalOccurrences.forEach((o, n) => {
          const t = timed[o.index]?.time;
          if (t == null || usedTimes.has(Number(t))) return;
          usedTimes.add(Number(t));
          markerMetas.push({
            time: t,
            index: o.index,
            detail: { title: config.title, date: o.date, price: o.price, direction: o.direction, condition: o.condition, indicatorText: o.indicatorText, description: o.description },
          });
        });
      } else {
        patternOccurrences.forEach((o, n) => {
          const t = timed[o.markerIndex]?.time;
          if (t == null || usedTimes.has(Number(t))) return;
          usedTimes.add(Number(t));
          markerMetas.push({
            time: t,
            index: o.markerIndex,
            detail: { title: config.title, date: o.date, price: o.price, direction: o.direction, condition: o.condition, indicatorText: o.indicatorText, description: o.description },
          });
        });
      }
      const markers = markerMetas.map((m, idx) => ({
        time: m.time,
        position: m.detail.direction === 'up' ? 'belowBar' : 'aboveBar',
        color: m.detail.direction === 'up' ? '#ef4444' : '#3b82f6',
        shape: m.detail.direction === 'up' ? 'arrowUp' : 'arrowDown',
        text: String(idx + 1),
      }));
      candleSeries.setMarkers(markers as any);
    }

    // 클릭 시 상세 갱신
    const clickHandler = (param: any) => {
      if (param.time == null) return;
      const match = markerMetas.find((m) => Number(m.time) === Number(param.time));
      if (match) onMarkerClick(match.detail);
    };
    chart.subscribeClick(clickHandler);

    // 신호 전후 20~30개 자동 확대
    if (focus) {
      const center = focus.markerIndex;
      const half = 13;
      const from = Math.max(0, center - half);
      const to = Math.min(timed.length - 1, center + half);
      chart.timeScale().setVisibleRange({ from: timed[from].time, to: timed[to].time });
    } else {
      chart.timeScale().fitContent();
    }

    const resize = () => chart.applyOptions({ width: Math.max(container.clientWidth, 1), height: priceHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      chart.unsubscribeClick(clickHandler);
      observer.disconnect();
      chart.remove();
    };
  }, [timed, config, priceHeight, showMarkers, showIndicators, signalOccurrences, patternOccurrences, caseIndex, closes, onMarkerClick]);

  // ── 거래량 ──
  useEffect(() => {
    const container = volRef.current;
    if (!container || !showVolume || timed.length < 2) return;
    const chart = createChart(container, { ...baseOptions(90), width: Math.max(container.clientWidth, 1) } as any);
    const series = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    (series as ISeriesApi<'Histogram'>).priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    series.setData(timed.map((r) => ({ time: r.time, value: r.volume, color: r.close >= r.open ? 'rgba(239,68,68,0.5)' : 'rgba(59,130,246,0.5)' })));
    chart.timeScale().fitContent();
    const resize = () => chart.applyOptions({ width: Math.max(container.clientWidth, 1), height: 90 });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [timed, showVolume]);

  // ── RSI ──
  useEffect(() => {
    const container = rsiRef.current;
    if (!container || !showRsi || timed.length < 15) return;
    const chart = createChart(container, { ...baseOptions(90), width: Math.max(container.clientWidth, 1) } as any);
    const rsi = rsiSeries(closes);
    const data = timed.map((r, i) => (rsi[i] != null ? { time: r.time, value: rsi[i] as number } : null)).filter(Boolean) as { time: Time; value: number }[];
    const s = chart.addLineSeries({ color: '#a855f7', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    s.setData(data);
    s.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' });
    s.createPriceLine({ price: 30, color: 'rgba(59,130,246,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' });
    chart.timeScale().fitContent();
    const resize = () => chart.applyOptions({ width: Math.max(container.clientWidth, 1), height: 90 });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [timed, showRsi, closes]);

  // ── MACD ──
  useEffect(() => {
    const container = macdRef.current;
    if (!container || !showMacd || timed.length < 30) return;
    const chart = createChart(container, { ...baseOptions(90), width: Math.max(container.clientWidth, 1) } as any);
    const m = macdSeries(closes);
    const macdData = timed.map((r, i) => (m.macd[i] != null ? { time: r.time, value: m.macd[i] as number } : null)).filter(Boolean) as { time: Time; value: number }[];
    const sigData = timed.map((r, i) => (m.signal[i] != null ? { time: r.time, value: m.signal[i] as number } : null)).filter(Boolean) as { time: Time; value: number }[];
    const histData = timed.map((r, i) => (m.hist[i] != null ? { time: r.time, value: m.hist[i] as number, color: (m.hist[i] as number) >= 0 ? 'rgba(239,68,68,0.5)' : 'rgba(59,130,246,0.5)' } : null)).filter(Boolean) as any[];
    const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    hist.setData(histData);
    const macdLine = chart.addLineSeries({ color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    macdLine.setData(macdData);
    const sigLine = chart.addLineSeries({ color: '#22c55e', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    sigLine.setData(sigData);
    chart.timeScale().fitContent();
    const resize = () => chart.applyOptions({ width: Math.max(container.clientWidth, 1), height: 90 });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [timed, showMacd, closes]);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-2xl border border-card-border bg-secondary/20">
        <div ref={priceRef} className="w-full" style={{ height: priceHeight }} />
        {showIndicators && (
          <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 border-t border-card-border px-3 py-1.5 text-[9px] font-bold text-muted-foreground">
            <span className="text-red-500">■ 상승봉</span>
            <span className="text-blue-500">■ 하락봉</span>
            <span className="text-amber-500">━ MA5</span>
            <span className="text-green-500">━ MA20</span>
          </div>
        )}
      </div>
      {showVolume && (
        <div className="overflow-hidden rounded-2xl border border-card-border bg-secondary/20">
          <p className="border-b border-card-border px-3 py-1 text-center text-[10px] font-black text-muted-foreground">거래량</p>
          <div ref={volRef} className="w-full" style={{ height: 90 }} />
        </div>
      )}
      {showRsi && (
        <div className="overflow-hidden rounded-2xl border border-card-border bg-secondary/20">
          <p className="border-b border-card-border px-3 py-1 text-center text-[10px] font-black text-muted-foreground">RSI (14)</p>
          <div ref={rsiRef} className="w-full" style={{ height: 90 }} />
        </div>
      )}
      {showMacd && (
        <div className="overflow-hidden rounded-2xl border border-card-border bg-secondary/20">
          <p className="border-b border-card-border px-3 py-1 text-center text-[10px] font-black text-muted-foreground">MACD (12·26·9)</p>
          <div ref={macdRef} className="w-full" style={{ height: 90 }} />
        </div>
      )}
    </div>
  );
}
