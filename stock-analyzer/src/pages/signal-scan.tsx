// 신호검색 전체 화면 — 시장별 매수/매도 후보를 탭으로 최대 10개씩 표시한다.
// 가짜 데이터 금지: 서버가 내려준 실제 후보만 사용하고, 없으면 빈 상태를 표시한다.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { BottomNav } from '@/components/bottom-nav';
import { SearchField } from '@/components/search-field';
import { memberGradeLabel, useMemberPermissions } from '@/lib/permissions';
import { useAuth } from '@/lib/auth';
import { formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
type ScanMarket = 'kr' | 'us' | 'spot' | 'futures';
type DirectionTab = 'buy' | 'sell';
type SignalFilter = 'strongBuy' | 'strongSell' | 'pattern' | 'volume';
type ScanStyle = 'scalp' | 'swing' | 'long' | 'custom';
type MatchMode = 'and' | 'or';
type SortMode = 'score' | 'change' | 'riskReward';
type ConditionKey = 'score' | 'volume' | 'macd' | 'trend' | 'riskData';

type Candidate = {
  ticker: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  currency: string;
  market: string;
  direction: string;
  score: number | null;
  verdict: string;
  basis: string[];
  support: number | null;
  resistance: number | null;
  target: number | null;
  stop: number | null;
  volumeState: string;
  trendState: string;
  risks: string[];
  invalidation: string[];
  dataAsOf: string;
  timeframe: '15m' | '1D' | '';
};

type ScanGroup = {
  key: string;
  label: string;
  candidates: Candidate[];
};

type ScanResponse = {
  ok: boolean;
  asset: string;
  market: string;
  generatedAt?: string;
  scanned?: number;
  providerErrors?: string[];
  groups: ScanGroup[];
};

const MARKET_OPTIONS: Array<{
  key: ScanMarket;
  label: string;
  description: string;
}> = [
  { key: 'kr', label: '국내주식', description: 'KRX' },
  { key: 'us', label: '해외주식', description: 'US' },
  { key: 'spot', label: '코인 현물', description: 'SPOT' },
  { key: 'futures', label: '코인 선물', description: 'FUTURES' },
];
const SPOT_SIGNAL_FILTERS: Array<{ key: SignalFilter; label: string }> = [
  { key: 'strongBuy', label: '매수 우세' },
  { key: 'strongSell', label: '매도 우세' },
  { key: 'pattern', label: 'MACD 전환' },
  { key: 'volume', label: '거래량 확대' },
];

const FUTURES_SIGNAL_FILTERS: Array<{ key: SignalFilter; label: string }> = [
  { key: 'strongBuy', label: '강한 롱' },
  { key: 'strongSell', label: '강한 숏' },
  { key: 'pattern', label: '매수 관찰' },
  { key: 'volume', label: '매도 관찰' },
];

const SCALP_SIGNAL_FILTERS: Array<{ key: SignalFilter; label: string }> = [
  { key: 'strongBuy', label: '강한 단타 롱' },
  { key: 'strongSell', label: '강한 단타 숏' },
  { key: 'pattern', label: '단타 롱 관찰' },
  { key: 'volume', label: '단타 숏 관찰' },
];

const CONDITION_OPTIONS: Array<{ key: ConditionKey; label: string }> = [
  { key: 'score', label: '점수 70 이상' },
  { key: 'volume', label: '거래량 확대' },
  { key: 'macd', label: 'MACD 전환' },
  { key: 'trend', label: '추세 확인' },
  { key: 'riskData', label: '위험정보 확인' },
];

function candidateRiskReward(candidate: Candidate): number | null {
  const price = candidate.price;
  const target = candidate.target;
  const stop = candidate.stop;
  if (price == null || target == null || stop == null) return null;
  const reward = Math.abs(target - price);
  const risk = Math.abs(price - stop);
  return risk > 0 && Number.isFinite(reward / risk) ? reward / risk : null;
}

function marketToQuery(market: ScanMarket): {
  asset: 'stock' | 'coin';
  market: string;
} {
  if (market === 'kr') return { asset: 'stock', market: 'KR' };
  if (market === 'us') return { asset: 'stock', market: 'US' };
  if (market === 'spot') return { asset: 'coin', market: 'spot' };
  return { asset: 'coin', market: 'futures' };
}

function marketToChartAsset(market: ScanMarket) {
  if (market === 'kr') return 'stockKR';
  if (market === 'us') return 'stockUS';
  if (market === 'spot') return 'coinSpot';
  return 'coinFutures';
}

function normalizeCandidate(raw: AnyObj): Candidate {
  const toNum = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const toStrArr = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];

  return {
    ticker: String(raw.ticker ?? raw.symbol ?? ''),
    name: String(raw.name ?? raw.koreanName ?? raw.ticker ?? raw.symbol ?? ''),
    price: toNum(raw.price ?? raw.currentPrice),
    changePercent: toNum(raw.changePercent ?? raw.changeRate),
    currency: String(raw.currency ?? 'KRW'),
    market: String(raw.market ?? ''),
    direction: String(raw.direction ?? raw.view ?? ''),
    score: toNum(raw.score ?? raw.signalScore),
    verdict: String(raw.verdict ?? raw.summary ?? ''),
    basis: toStrArr(raw.basis ?? raw.reasons),
    support: toNum(raw.support),
    resistance: toNum(raw.resistance),
    target: toNum(raw.target ?? raw.targetPrice ?? raw.aiTarget ?? raw.resistance),
    stop: toNum(raw.stop ?? raw.stopPrice ?? raw.aiStop ?? raw.support),
    volumeState: String(raw.volumeState ?? ''),
    trendState: String(raw.trendState ?? ''),
    risks: toStrArr(raw.risks),
    invalidation: toStrArr(raw.invalidation),
    dataAsOf: String(raw.dataAsOf ?? raw.updatedAt ?? ''),
    timeframe:
      raw.timeframe === '15m' || raw.timeframe === '1D'
        ? raw.timeframe
        : '',
  };
}

const SIGNAL_SCAN_CACHE_MAX_AGE = 30 * 60_000;

function signalScanStorageKey(asset: string, market: string): string {
  return `signal-scan:last-good:${asset}:${market}`;
}

function readStoredSignalScan(
  asset: string,
  market: string,
): { value: ScanResponse; storedAt: number } | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(signalScanStorageKey(asset, market));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { value?: ScanResponse; storedAt?: number };
    if (!parsed.value?.ok || !Number.isFinite(parsed.storedAt)) return undefined;
    if (Date.now() - Number(parsed.storedAt) > SIGNAL_SCAN_CACHE_MAX_AGE) return undefined;
    return { value: parsed.value, storedAt: Number(parsed.storedAt) };
  } catch {
    return undefined;
  }
}

function storeSignalScan(asset: string, market: string, value: ScanResponse): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      signalScanStorageKey(asset, market),
      JSON.stringify({ value, storedAt: Date.now() }),
    );
  } catch {
    // 저장 공간이 없으면 메모리 캐시만 사용한다.
  }
}

function directionKind(value: string): DirectionTab | null {
  const text = value.trim().toLowerCase();

  if (
    text.includes('매수') ||
    text.includes('buy') ||
    text.includes('long') ||
    text.includes('롱')
  ) {
    return 'buy';
  }

  if (
    text.includes('매도') ||
    text.includes('sell') ||
    text.includes('short') ||
    text.includes('숏')
  ) {
    return 'sell';
  }

  return null;
}

export default function SignalScanPage() {
  const [, navigate] = useLocation();
  const [matched, params] = useRoute('/tech/signal-scan/:market') as [
    boolean,
    { market?: string } | null,
  ];

  const permissions = useMemberPermissions();
  const auth = useAuth() as AnyObj;

  const routeMarket = matched
    ? (['kr', 'us', 'spot', 'futures'].includes(String(params?.market))
        ? (params?.market as ScanMarket)
        : undefined)
    : undefined;

  const [stateMarket, setStateMarket] =
    useState<ScanMarket>(routeMarket ?? 'kr');
  const [directionTab, setDirectionTab] =
    useState<DirectionTab>('buy');
  const [scanStyle, setScanStyle] = useState<ScanStyle>('scalp');
  const [matchMode, setMatchMode] = useState<MatchMode>('and');
  const [sortMode, setSortMode] = useState<SortMode>('score');
  const [selectedConditions, setSelectedConditions] = useState<ConditionKey[]>([
    'score',
    'volume',
  ]);
  const [excludeOverheated, setExcludeOverheated] = useState(true);
  const [excludeRisky, setExcludeRisky] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);
  const [signalFilter, setSignalFilter] =
    useState<SignalFilter>('strongBuy');
  const [selected, setSelected] =
    useState<Candidate | null>(null);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('signal-scan-ui-preset-v1');
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        scanStyle?: ScanStyle;
        matchMode?: MatchMode;
        sortMode?: SortMode;
        selectedConditions?: ConditionKey[];
        excludeOverheated?: boolean;
        excludeRisky?: boolean;
      };
      if (saved.scanStyle) setScanStyle(saved.scanStyle);
      if (saved.matchMode) setMatchMode(saved.matchMode);
      if (saved.sortMode) setSortMode(saved.sortMode);
      if (Array.isArray(saved.selectedConditions)) setSelectedConditions(saved.selectedConditions);
      if (typeof saved.excludeOverheated === 'boolean') setExcludeOverheated(saved.excludeOverheated);
      if (typeof saved.excludeRisky === 'boolean') setExcludeRisky(saved.excludeRisky);
    } catch {
      // 손상된 로컬 설정은 무시한다.
    }
  }, []);

  const market = routeMarket ?? stateMarket;
  const marketTitle =
    MARKET_OPTIONS.find((item) => item.key === market)?.label ?? '시장';
  const isFutures = market === 'futures';
  const canUseFutures = permissions.has('futures');
  const futuresLocked = isFutures && !canUseFutures;

  const { asset, market: marketParam } = marketToQuery(market);
  const storedScan = useMemo(
    () => readStoredSignalScan(asset, marketParam),
    [asset, marketParam],
  );

  const query = useQuery({
    queryKey: ['signal-scan', asset, marketParam],
    queryFn: async () => {
      const value = await apiGet<ScanResponse>(
        `/market/signal-scan?asset=${asset}&market=${marketParam}`,
      );
      storeSignalScan(asset, marketParam, value);
      return value;
    },
    enabled: !futuresLocked,
    staleTime: 5 * 60_000,
    gcTime: 20 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 0,
    initialData: storedScan?.value,
    initialDataUpdatedAt: storedScan?.storedAt,
    placeholderData: (previous) => previous,
  });

  const groups = useMemo<ScanGroup[]>(() => {
    const rawGroups = (query.data?.groups ?? []) as AnyObj[];

    return rawGroups.map((group) => {
      const seen = new Set<string>();
      const candidates: Candidate[] = [];

      for (const item of (group.candidates ?? []) as AnyObj[]) {
        const candidate = normalizeCandidate(item);
        if (!candidate.ticker) continue;

        const key = `${candidate.market}:${candidate.ticker}:${candidate.timeframe}`;
        if (seen.has(key)) continue;

        seen.add(key);
        candidates.push(candidate);
      }

      return {
        key: String(group.key ?? ''),
        label: String(group.label ?? ''),
        candidates,
      };
    });
  }, [query.data]);

  const visibleCandidates = useMemo(() => {
    const rows: Candidate[] = [];
    const needle = searchText.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const seen = new Set<string>();

    for (const group of groups) {
      const groupDirection = directionKind(`${group.key} ${group.label}`);

      for (const candidate of group.candidates) {
        const key = `${candidate.market}:${candidate.ticker}:${candidate.timeframe}`;
        if (seen.has(key)) continue;

        const candidateDirection =
          directionKind(candidate.direction) ?? groupDirection;

        const basisText = candidate.basis.join(' ').toLowerCase();
        const hasMacdTurn = /macd.*교차/.test(basisText);
        const hasVolumeExpansion =
          /거래량.*(증가|급증|폭증|확대)|volume.*(increase|surge)/.test(
            basisText,
          );

        const score = candidate.score ?? 0;
        const isScalpTimeframe = candidate.timeframe === '15m';
        const hasScalpMomentum =
          hasVolumeExpansion ||
          /거래대금|돌파|단기|상승|하락|추세|지지|저항/.test(
            `${basisText} ${candidate.volumeState} ${candidate.trendState}`,
          );
        const combinedText = `${basisText} ${candidate.verdict} ${candidate.trendState} ${candidate.volumeState}`.toLowerCase();
        const isOverheated = /과열|과매수|급등|overbought/.test(combinedText);
        const isRisky = /거래.?금지|상장.?폐지|데이터.?오류|청산.?위험|투자.?주의/.test(combinedText);
        const conditionResults: Record<ConditionKey, boolean> = {
          score: score >= 70,
          volume: hasVolumeExpansion,
          macd: hasMacdTurn,
          trend: /상승|하락|강세|약세|추세|돌파/.test(combinedText),
          riskData: candidate.risks.length > 0 || candidate.invalidation.length > 0,
        };
        if (excludeOverheated && isOverheated) continue;
        if (excludeRisky && isRisky) continue;
        let matches = false;

        if (scanStyle === 'scalp') {
          if (!isScalpTimeframe) continue;
          if (signalFilter === 'strongBuy') {
            matches =
              candidateDirection === 'buy' &&
              score >= 76 &&
              hasScalpMomentum;
          } else if (signalFilter === 'strongSell') {
            matches =
              candidateDirection === 'sell' &&
              score >= 76 &&
              hasScalpMomentum;
          } else if (signalFilter === 'pattern') {
            matches = candidateDirection === 'buy' && score >= 68;
          } else {
            matches = candidateDirection === 'sell' && score >= 68;
          }
        } else if (scanStyle === 'custom') {
          const checks = selectedConditions.map((key) => conditionResults[key]);
          matches = checks.length > 0 && (matchMode === 'and' ? checks.every(Boolean) : checks.some(Boolean));
          if (signalFilter === 'strongBuy') matches = matches && candidateDirection === 'buy';
          if (signalFilter === 'strongSell') matches = matches && candidateDirection === 'sell';
        } else if (scanStyle === 'long') {
          matches =
            candidate.timeframe === '1D' &&
            score >= 70 &&
            /추세|상승|회복|돌파|강세/.test(combinedText);
          if (signalFilter === 'strongSell') matches = candidate.timeframe === '1D' && candidateDirection === 'sell' && score >= 70;
        } else if (isFutures) {
          if (signalFilter === 'strongBuy') {
            matches = group.key === 'long';
          } else if (signalFilter === 'strongSell') {
            matches = group.key === 'short';
          } else if (signalFilter === 'pattern') {
            matches = group.key === 'buyView';
          } else {
            matches = group.key === 'sellView';
          }
        } else if (signalFilter === 'strongBuy') {
          matches = candidateDirection === 'buy' && score >= 72;
        } else if (signalFilter === 'strongSell') {
          matches = candidateDirection === 'sell' && score >= 72;
        } else if (signalFilter === 'pattern') {
          matches = hasMacdTurn;
        } else {
          matches = hasVolumeExpansion;
        }

        if (!matches) continue;
        if (
          needle &&
          ![candidate.name, candidate.ticker, candidate.market].some((value) =>
            String(value ?? '')
              .normalize('NFKC')
              .toLowerCase()
              .replace(/\s+/g, '')
              .includes(needle),
          )
        ) continue;

        seen.add(key);
        rows.push(candidate);
      }
    }

    return rows
      .sort((a, b) => {
        if (sortMode === 'change') {
          return (b.changePercent ?? -Infinity) - (a.changePercent ?? -Infinity);
        }
        if (sortMode === 'riskReward') {
          return (candidateRiskReward(b) ?? -1) - (candidateRiskReward(a) ?? -1);
        }
        return (
          (b.score ?? -1) - (a.score ?? -1) ||
          a.name.localeCompare(b.name, 'ko')
        );
      })
      .slice(0, needle ? 30 : 10);
  }, [
    excludeOverheated,
    excludeRisky,
    groups,
    isFutures,
    matchMode,
    scanStyle,
    searchText,
    selectedConditions,
    signalFilter,
    sortMode,
  ]);

  const selectMarket = (next: ScanMarket) => {
    setSelected(null);
    setDirectionTab('buy');
    setSignalFilter('strongBuy');
    setSearchText('');

    if (routeMarket) {
      navigate(`/tech/signal-scan/${next}`);
      return;
    }

    setStateMarket(next);
  };

  const goToChartRelay = (candidate: Candidate) => {
    const chartAsset = marketToChartAsset(market);
    const symbol = candidate.ticker.trim().toUpperCase();

    const params = new URLSearchParams({
      asset: chartAsset,
      symbol,
      interval: candidate.timeframe || (scanStyle === 'scalp' ? '15m' : '1D'),
      tab: 'live',
    });

    setSelected(null);

    const target = `/tech/chart-relay?${params.toString()}`;

    if (typeof window !== 'undefined') {
      window.location.assign(target);
      return;
    }

    navigate(target);
  };

  const signalFilters =
    scanStyle === 'scalp'
      ? SCALP_SIGNAL_FILTERS
      : isFutures
        ? FUTURES_SIGNAL_FILTERS
        : SPOT_SIGNAL_FILTERS;

  const candidateSectionLabel =
    signalFilters.find((item) => item.key === signalFilter)?.label ??
    '기술 신호';

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="w-full min-w-0 px-4 pb-28 pt-4">
        <header className="relative flex min-h-[68px] w-full items-center justify-center px-14 text-center">
          <button
            type="button"
            onClick={() => navigate('/tech')}
            aria-label="뒤로"
            className="absolute left-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="w-full min-w-0 text-center">
            <h1 className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">
              {marketTitle} 신호검색
            </h1>
            <p className="mt-1 break-keep text-center text-[11px] font-bold leading-4 text-muted-foreground">
              {scanStyle === 'scalp'
                ? '15분봉 단타 후보'
                : scanStyle === 'swing'
                  ? '15분봉·일봉 스윙 후보'
                  : scanStyle === 'long'
                    ? '일봉 중장기 후보'
                    : '직접 설정 조건검색'}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void query.refetch()}
            aria-label="새로고침"
            disabled={futuresLocked}
            className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <RefreshCw
              className={cn(
                'h-4 w-4',
                query.isFetching && 'animate-spin',
              )}
            />
          </button>
        </header>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {([
            { key: 'scalp' as const, label: '단타용 · 15분봉' },
            { key: 'swing' as const, label: '스윙' },
            { key: 'long' as const, label: '중장기' },
            { key: 'custom' as const, label: '직접 설정' },
          ]).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setScanStyle(item.key);
                setSelected(null);
                setSignalFilter('strongBuy');
                setDirectionTab('buy');
              }}
              className={cn(
                'min-w-0 rounded-xl border px-1.5 py-2.5 text-[11px] font-black',
                scanStyle === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {scanStyle === 'scalp' && (
          <p className="mt-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-center text-[10px] font-bold text-warning">
            실제 15분봉만 사용 · 거래량/거래대금·단기 추세·지지/저항을 함께 확인
          </p>
        )}

        <section className="mt-3 rounded-2xl border border-card-border bg-card p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] font-black text-muted-foreground">
              조건 조합
              <select
                value={matchMode}
                onChange={(event) => setMatchMode(event.target.value as MatchMode)}
                className="mt-1 h-9 w-full rounded-xl border border-card-border bg-background px-3 text-xs font-black text-foreground"
              >
                <option value="and">AND · 모두 충족</option>
                <option value="or">OR · 하나 이상</option>
              </select>
            </label>
            <label className="text-[10px] font-black text-muted-foreground">
              결과 정렬
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                className="mt-1 h-9 w-full rounded-xl border border-card-border bg-background px-3 text-xs font-black text-foreground"
              >
                <option value="score">신호 점수순</option>
                <option value="change">등락률순</option>
                <option value="riskReward">손익비순</option>
              </select>
            </label>
          </div>

          <p className="mt-3 text-[10px] font-black text-muted-foreground">조건 선택</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CONDITION_OPTIONS.map((condition) => {
              const active = selectedConditions.includes(condition.key);
              return (
                <button
                  key={condition.key}
                  type="button"
                  onClick={() =>
                    setSelectedConditions((current) =>
                      active
                        ? current.filter((key) => key !== condition.key)
                        : [...current, condition.key],
                    )
                  }
                  className={cn(
                    'rounded-full border px-2.5 py-1.5 text-[10px] font-black',
                    active
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-card-border bg-background text-muted-foreground',
                  )}
                >
                  {condition.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setExcludeOverheated((value) => !value)}
              className={cn(
                'rounded-xl border px-2 py-2 text-[10px] font-black',
                excludeOverheated ? 'border-warning/50 bg-warning/10 text-warning' : 'border-card-border text-muted-foreground',
              )}
            >
              과열 제외 {excludeOverheated ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              onClick={() => setExcludeRisky((value) => !value)}
              className={cn(
                'rounded-xl border px-2 py-2 text-[10px] font-black',
                excludeRisky ? 'border-warning/50 bg-warning/10 text-warning' : 'border-card-border text-muted-foreground',
              )}
            >
              위험 제외 {excludeRisky ? 'ON' : 'OFF'}
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              window.localStorage.setItem(
                'signal-scan-ui-preset-v1',
                JSON.stringify({ scanStyle, matchMode, sortMode, selectedConditions, excludeOverheated, excludeRisky }),
              );
              setSavedNotice(true);
              window.setTimeout(() => setSavedNotice(false), 1800);
            }}
            className="mt-2 w-full rounded-xl border border-card-border bg-background py-2 text-[10px] font-black"
          >
            {savedNotice ? '조건 저장 완료' : '현재 조건 저장'}
          </button>
        </section>

        <div
          data-signal-market-grid="direct"
          className="mt-3 grid grid-cols-2 gap-2"
          aria-label="검색 시장 선택"
        >
          {MARKET_OPTIONS.map((item) => {
            const active = market === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => selectMarket(item.key)}
                aria-pressed={active}
                className={cn(
                  'min-h-[54px] rounded-2xl border px-3 py-2.5 text-center transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                    : 'border-card-border bg-card text-muted-foreground',
                )}
              >
                <span className="block text-xs font-black">{item.label}</span>
                <span
                  className={cn(
                    'mt-0.5 block text-[9px] font-bold tracking-wide',
                    active ? 'text-primary-foreground/75' : 'text-muted-foreground/70',
                  )}
                >
                  {item.description}
                </span>
              </button>
            );
          })}
        </div>

        <SearchField
          value={searchText}
          onChange={setSearchText}
          className="mt-3"
          ariaLabel="신호 종목 검색"
          placeholder="종목명·티커·상품코드 한 글자 검색"
        />

        <div className="mt-3 grid grid-cols-4 gap-1">
          {signalFilters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => {
                setSelected(null);
                setSignalFilter(filter.key);
                setDirectionTab(
                  filter.key === 'strongSell' ? 'sell' : 'buy',
                );
              }}
              className={cn(
                'min-w-0 whitespace-nowrap rounded-xl border px-1 py-2 text-center text-[10px] font-black',
                signalFilter === filter.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {futuresLocked ? (
            <StateBox>
              코인 선물은 정회원 전용입니다. 현재 등급:{' '}
              {memberGradeLabel(auth?.profile ?? null)} · 등급 변경은
              관리자에게 문의해 주세요.
            </StateBox>
          ) : query.isLoading ? (
            <StateBox>데이터를 불러오는 중입니다.</StateBox>
          ) : query.isError ? (
            <StateBox error>
              데이터를 불러오지 못했습니다.
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="mt-2 block w-full rounded-xl border border-card-border bg-card py-2 text-xs font-black text-foreground"
              >
                다시 시도
              </button>
            </StateBox>
          ) : groups.length === 0 ? (
            <StateBox>분석 가능한 데이터가 없습니다.</StateBox>
          ) : visibleCandidates.length === 0 ? (
            <StateBox>
              현재 {candidateSectionLabel} 조건에 해당하는 종목이 없습니다.
            </StateBox>
          ) : (
            <section>
              <div className="mb-2 flex items-end justify-between gap-3">
                <h2 className="text-sm font-black">
                  {candidateSectionLabel}
                </h2>
                <p className="text-[10px] font-bold text-muted-foreground">
                  {scanStyle === 'scalp' ? '15분봉 · 최대 10종목' : '최대 10종목'}
                </p>
              </div>

              <div className="space-y-2">
                {visibleCandidates.map((candidate, index) => (
                  <button
                    key={`${signalFilter}:${candidate.market}:${candidate.ticker}:${candidate.timeframe}`}
                    type="button"
                    onClick={() => setSelected(candidate)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900 p-3 text-left text-white shadow-md"
                  >
                    <span className="w-6 shrink-0 text-center text-sm font-black text-primary">
                      {index + 1}
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black">
                        {candidate.name}
                      </p>

                      <p className="mt-0.5 truncate text-[10px] font-bold text-muted-foreground">
                        {candidate.ticker}
                        {candidate.market
                          ? ` · ${candidate.market}`
                          : ''}
                        {candidate.direction
                          ? ` · ${candidate.direction}`
                          : ''}
                        {candidate.timeframe
                          ? ` · ${candidate.timeframe === '15m' ? '15분' : '일봉'}`
                          : ''}
                      </p>

                      {candidate.verdict && (
                        <p className="mt-0.5 line-clamp-1 text-[10px] font-bold text-muted-foreground">
                          {candidate.verdict}
                        </p>
                      )}

                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] font-black">
                        <span className="text-orange-500">
                          목표 {candidate.target != null
                            ? formatAppPrice(candidate.target, candidate.currency)
                            : '데이터 없음'}
                        </span>
                        <span className="text-cyan-500">
                          손절 {candidate.stop != null
                            ? formatAppPrice(candidate.stop, candidate.currency)
                            : '데이터 없음'}
                        </span>
                        <span className="text-emerald-400">
                          손익비 {candidateRiskReward(candidate) != null
                            ? `1:${candidateRiskReward(candidate)!.toFixed(2)}`
                            : '계산 불가'}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-xs font-black">
                        {candidate.price != null
                          ? formatAppPrice(
                              candidate.price,
                              candidate.currency,
                            )
                          : '데이터 없음'}
                      </p>

                      <p className="mt-0.5 text-[10px] font-black text-primary">
                        {candidate.changePercent != null
                          ? `${formatAppPercent(
                              candidate.changePercent,
                            )} · `
                          : ''}
                        {candidate.score != null
                          ? `점수 ${Math.round(candidate.score)}`
                          : '점수 없음'}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <p className="mt-4 text-center text-[10px] font-bold text-muted-foreground">
          규칙 기반 참고용 신호입니다. 투자 판단과 책임은 본인에게 있습니다.
        </p>
      </div>

      {selected && (
        <CandidateModal
          candidate={selected}
          onClose={() => setSelected(null)}
          onGoToChart={() => goToChartRelay(selected)}
        />
      )}

      <BottomNav />
    </div>
  );
}

function CandidateModal({
  candidate,
  onClose,
  onGoToChart,
}: {
  candidate: Candidate;
  onClose: () => void;
  onGoToChart: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-card p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-black">
              {candidate.name}
            </h2>

            <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
              {candidate.ticker}
              {candidate.market ? ` · ${candidate.market}` : ''}
              {candidate.timeframe
                ? ` · ${candidate.timeframe === '15m' ? '15분' : '일봉'}`
                : ''}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <DetailField
            label="현재가"
            value={
              candidate.price != null
                ? formatAppPrice(
                    candidate.price,
                    candidate.currency,
                  )
                : '데이터 없음'
            }
          />

          <DetailField
            label="신호 점수"
            value={
              candidate.score != null
                ? `${Math.round(candidate.score)}점`
                : '데이터 없음'
            }
          />

          <DetailField
            label="신호 방향"
            value={candidate.direction || '데이터 없음'}
          />

          <DetailField
            label="추세 상태"
            value={candidate.trendState || '데이터 없음'}
          />

          <DetailField
            label="거래량 상태"
            value={candidate.volumeState || '데이터 없음'}
          />

          <DetailField
            label="등락률"
            value={
              candidate.changePercent != null
                ? formatAppPercent(candidate.changePercent)
                : '데이터 없음'
            }
          />

          <DetailField
            label="지지선"
            value={
              candidate.support != null
                ? formatAppPrice(
                    candidate.support,
                    candidate.currency,
                  )
                : '데이터 없음'
            }
          />

          <DetailField
            label="저항선"
            value={
              candidate.resistance != null
                ? formatAppPrice(
                    candidate.resistance,
                    candidate.currency,
                  )
                : '데이터 없음'
            }
          />

          <DetailField
            label="차트 목표가"
            value={
              candidate.target != null
                ? formatAppPrice(candidate.target, candidate.currency)
                : '데이터 없음'
            }
          />

          <DetailField
            label="차트 손절가"
            value={
              candidate.stop != null
                ? formatAppPrice(candidate.stop, candidate.currency)
                : '데이터 없음'
            }
          />
        </div>

        <DetailBlock label="종합 판단">
          <p className="text-xs font-bold leading-5">
            {candidate.verdict || '데이터를 불러오지 못했습니다.'}
          </p>
        </DetailBlock>

        <DetailList label="기술적 근거" items={candidate.basis} />
        <DetailList label="위험 요인" items={candidate.risks} />
        <DetailList
          label="신호 무효 조건"
          items={candidate.invalidation}
        />

        <p className="mt-3 text-[10px] font-bold text-muted-foreground">
          데이터 기준 시간: {candidate.dataAsOf || '데이터 없음'}
        </p>

        <button
          type="button"
          onClick={onGoToChart}
          className="mt-4 w-full rounded-2xl bg-primary py-3 text-sm font-black text-primary-foreground"
        >
          차트생중계로 이동
        </button>
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-card-border bg-background p-2.5">
      <p className="text-[10px] font-bold text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate text-xs font-black">{value}</p>
    </div>
  );
}

function DetailBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 rounded-xl border border-card-border bg-background p-3">
      <p className="mb-1 text-[10px] font-bold text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function DetailList({
  label,
  items,
}: {
  label: string;
  items: string[];
}) {
  return (
    <DetailBlock label={label}>
      {items.length === 0 ? (
        <p className="text-xs font-bold text-muted-foreground">
          데이터 없음
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li
              key={`${label}-${index}`}
              className="text-xs font-bold leading-5"
            >
              · {item}
            </li>
          ))}
        </ul>
      )}
    </DetailBlock>
  );
}

function StateBox({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-4 text-center text-xs font-bold',
        error
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}