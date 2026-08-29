import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { BrainCircuit, RefreshCw, ShieldAlert, WalletCards } from 'lucide-react';
import PortfolioPage from '@/pages/portfolio';
import { BottomNav } from '@/components/bottom-nav';
import { PortfolioAiDiagnosis } from '@/components/portfolio-ai-diagnosis';
import { apiGet } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type IntelligenceHolding = {
  id: string;
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  nativeValue: number;
  normalizedKRW: number | null;
};

type Intelligence = {
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  asOf: string;
  totalAssets: { status: string; normalizedKRW: number | null; knownNormalizedKRW: number };
  investmentPrincipal: { status: string; normalizedKRW: number | null; knownNormalizedKRW: number };
  valuationPnl: { status: string; normalizedKRW: number | null; returnPercent: number | null };
  cash: { status: string; totalKRW: number | null };
  minimumCashBuffer: { status: string; normalizedKRW: number | null };
  investableCash: { status: string; normalizedKRW: number | null };
  assets: { krStocks: number | null; usStocks: number | null; cryptoSpot: number | null; cryptoFuturesEquity: number | null; cash: number | null };
  allocation: { status: string; knownTotalKRW: number; buckets: Record<string, number | null> };
  holdings: IntelligenceHolding[];
  topHoldings: IntelligenceHolding[];
  top5Concentration: { status: string; percent: number | null };
  correlation: { status: string; sampleSize: number; correlation: number | null; pair: string[] };
  riskClassification: { status: string; level: string | null; reason: string };
  allocationPolicy: { profile: string; status: string; comparison: Array<{ assetClass: string; currentPercent: number | null; minPercent: number; maxPercent: number; state: string }> };
  fx: { status: string; quotes: Array<{ rate: number; pair: string; source: string; asOf: string; quality: string }> };
  dataQuality: { status: string; providerCount: number; includedProviderCount: number; invalidHoldingRows: number };
  missingSources: string[];
};

type ResponseShape = { ok: boolean; portfolio: Intelligence };

type AdditionalBuyResponse = {
  ok: boolean;
  status: string;
  priceBasis: 'NORMALIZED_KRW';
  holding: {
    ticker: string;
    name: string;
    market: string;
    nativeCurrency: string;
    currentAveragePriceNative: number;
    currentPriceNative: number;
    currentPositionValueKRW: number | null;
  };
  result: {
    status: 'READY' | 'UNAVAILABLE';
    additionalQuantity: number | null;
    additionalInvestmentKRW: number | null;
    newAveragePrice: number | null;
    currentWeightPercent: number | null;
    projectedWeightPercent: number | null;
    stopLoss: number | null;
    targets: number[];
    estimatedMaxLossKRW: number | null;
    targetProfitsKRW: Array<number | null>;
    missing: string[];
  };
  evidence: { stopLoss: string; targets: string; source: string | null };
};

type MonthlyResponse = {
  ok: boolean;
  status: string;
  assumption: 'NO_VALIDATED_RETURN_ASSUMPTION';
  allocationBasis: 'CURRENT_KNOWN_ALLOCATION';
  allocationKnownTotalKRW: number;
  profileForPolicyComparison: string;
  profileUsedForAllocation: false;
  unavailableOutputs: string[];
  plan: null | {
    monthlyAmountKRW: number;
    months: number;
    cumulativeInvestmentKRW: number;
    allocations: Array<{ key: string; weight: number; cumulativeContributionKRW: number }>;
  };
};

type PortfolioV2Tab = 'intelligence' | 'holdings' | 'journal';

const money = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? 'UNAVAILABLE'
  : `${Math.round(value).toLocaleString('ko-KR')}원`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'UNAVAILABLE' : `${value.toFixed(1)}%`;

function basisTime(value: string | null | undefined): string {
  if (!value) return '미제공';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미제공';
  return date.toLocaleString('ko-KR');
}

function missingSourceLabel(source: string): string {
  const quote = source.match(/^QUOTE:([^:]+):(UNAVAILABLE|INVALID_PRICE)$/);
  if (quote) return `${quote[1]} 공개 시세 ${quote[2] === 'UNAVAILABLE' ? '수집 실패' : '가격 검증 실패'}`;
  const invalidRows = source.match(/^PORTFOLIO_HOLDINGS:INVALID_ROWS:(\d+)$/);
  if (invalidRows) return `보유자산 원본 ${invalidRows[1]}건 형식 검증 실패`;
  if (source.includes('READONLY_CASH_SOURCE_UNAVAILABLE')) return '현금 계좌 read-only 원본 미연결';
  if (source.includes('PRIVATE_PROVIDER_NOT_CALLED')) return 'Private provider 안전 경계로 계좌 데이터 미수집';
  if (source.includes('CORRELATION:HISTORY_UNAVAILABLE')) return '상관관계 계산용 공개 일봉 이력 수집 실패';
  if (source.toUpperCase().includes('FX')) return `환율 근거 부족: ${source}`;
  return source;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await authorizedFetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (T & { message?: string; error?: string }) | null;
  if (!response.ok || !payload) throw new Error(payload?.message || payload?.error || `HTTP_${response.status}`);
  return payload;
}

function StateBadge({ value }: { value: string }) {
  return <span className="rounded-full border border-border bg-muted/50 px-2 py-1 text-[10px] font-black text-muted-foreground">{value}</span>;
}

function Metric({ label, value, state, testId }: { label: string; value: string; state?: string; testId?: string }) {
  return <div data-testid={testId} className="min-w-0 rounded-2xl border border-border bg-card p-3">
    <div className="flex items-center gap-2"><p className="text-[11px] font-bold text-muted-foreground">{label}</p>{state ? <StateBadge value={state} /> : null}</div>
    <p className="mt-2 break-all text-base font-black sm:text-lg">{value}</p>
  </div>;
}

function MonthlySimulator({ intelligence, profile }: { intelligence: Intelligence; profile: string }) {
  const [amount, setAmount] = useState(300_000);
  const [months, setMonths] = useState(12);
  const [result, setResult] = useState<MonthlyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setResult(null);
  }, [profile]);

  async function calculate() {
    setBusy(true);
    setError('');
    try {
      setResult(await postJson<MonthlyResponse>('/portfolio/intelligence/monthly-contribution', {
        monthlyAmountKRW: amount,
        months,
        profile,
      }));
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : '월 적립 시뮬레이션에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="rounded-3xl border border-border bg-card p-4">
    <h3 className="font-black">월 적립 시뮬레이터</h3>
    <p className="mt-1 text-[11px] font-bold leading-5 text-muted-foreground">미래 수익을 예측하는 계산이 아니라, 현재 확인된 자산비중으로 납입금을 나누는 read-only 계획입니다.</p>
    <div className="mt-3 grid grid-cols-2 gap-2">
      <label className="text-xs font-bold text-muted-foreground">월 적립액<input aria-label="월 적립액" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="1" value={amount} onChange={(event) => setAmount(Number(event.target.value) || 0)} /></label>
      <label className="text-xs font-bold text-muted-foreground">기간(개월)<input aria-label="적립 기간" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="1" max="120" value={months} onChange={(event) => setMonths(Number(event.target.value) || 1)} /></label>
    </div>
    <div className="mt-2 grid grid-cols-3 gap-2">{[12, 24, 36].map((value) => <button key={value} type="button" onClick={() => setMonths(value)} className={cn('rounded-xl border border-border px-2 py-2 text-xs font-black', months === value && 'bg-primary/10 text-primary')}>{value}개월</button>)}</div>
    <button type="button" disabled={busy || amount <= 0 || months <= 0} onClick={() => void calculate()} className="mt-3 w-full rounded-xl bg-primary px-3 py-2.5 text-sm font-black text-primary-foreground disabled:opacity-50">{busy ? '계산 중...' : '적립 시뮬레이션 계산'}</button>
    {error ? <p role="alert" className="mt-2 text-xs font-bold text-destructive">{error}</p> : null}
    {result?.plan ? <>
      <p className="mt-3 text-sm font-black">누적 납입금 {money(result.plan.cumulativeInvestmentKRW)}</p>
      <div className="mt-2 grid gap-1 text-xs font-bold text-muted-foreground">{result.plan.allocations.map((row) => <div key={row.key} className="flex justify-between gap-3"><span>{row.key} · {(row.weight * 100).toFixed(1)}%</span><span>{money(row.cumulativeContributionKRW)}</span></div>)}</div>
    </> : result ? <p className="mt-3 text-xs font-bold text-muted-foreground">Allocation {result.status} — 배분 가능한 검증 데이터가 부족합니다.</p> : <p className="mt-3 text-xs font-bold text-muted-foreground">현재 확인된 allocation {money(intelligence.allocation.knownTotalKRW)} 기준으로 계산합니다.</p>}
    <div data-testid="portfolio-monthly-basis" className="mt-3 rounded-xl border border-border bg-muted/40 p-3 text-[11px] font-bold leading-5 text-muted-foreground">
      <p>적립 배분 기준: <strong className="text-foreground">{result?.allocationBasis ?? 'CURRENT_KNOWN_ALLOCATION'}</strong></p>
      <p>투자성향 {result?.profileForPolicyComparison ?? profile}은 위 Allocation Policy의 허용범위 비교에만 사용됩니다.</p>
      <p>검증된 단일 목표비중이 없으므로 성향에 맞춘 목표비중을 임의 생성하지 않습니다.</p>
      {result ? <p>계산 당시 확인된 배분 기준 자산: {money(result.allocationKnownTotalKRW)}</p> : null}
    </div>
    <p className="mt-3 rounded-xl bg-muted/40 p-2 text-[11px] font-bold text-muted-foreground">NO_VALIDATED_RETURN_ASSUMPTION — 미래 수익금·미래 자산가치·CAGR은 생성하지 않습니다.</p>
  </section>;
}

function AdditionalBuySimulator({ intelligence }: { intelligence: Intelligence }) {
  const [ticker, setTicker] = useState(intelligence.holdings[0]?.ticker ?? '');
  const [mode, setMode] = useState<'amount' | 'quantity'>('amount');
  const [amount, setAmount] = useState(0);
  const [quantity, setQuantity] = useState(0);
  const [result, setResult] = useState<AdditionalBuyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const holding = intelligence.holdings.find((row) => row.ticker === ticker) ?? intelligence.holdings[0];

  async function calculate() {
    if (!holding) return;
    setBusy(true);
    setError('');
    try {
      setResult(await postJson<AdditionalBuyResponse>('/portfolio/intelligence/additional-buy', {
        ticker: holding.ticker,
        additionalAmountKRW: mode === 'amount' ? amount : undefined,
        additionalQuantity: mode === 'quantity' ? quantity : undefined,
      }));
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : '추가매수 시뮬레이션에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  const simulation = result?.result;
  const projectedValue = result?.holding.currentPositionValueKRW != null && simulation?.additionalInvestmentKRW != null
    ? result.holding.currentPositionValueKRW + simulation.additionalInvestmentKRW
    : null;
  const firstTargetProfit = simulation?.targetProfitsKRW[0] ?? null;
  const riskReward = firstTargetProfit != null && simulation?.estimatedMaxLossKRW != null && simulation.estimatedMaxLossKRW > 0
    ? firstTargetProfit / simulation.estimatedMaxLossKRW
    : null;

  return <section className="rounded-3xl border border-border bg-card p-4">
    <h3 className="font-black">추가매수 시뮬레이터</h3>
    <p className="mt-1 text-[11px] font-bold leading-5 text-muted-foreground">현재 보유수량·평단·공개 시세·환율로만 계산합니다. Stop/Target 근거가 없으면 손실·목표수익을 만들지 않습니다.</p>
    {intelligence.holdings.length ? <>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs font-bold text-muted-foreground">보유자산<select aria-label="추가매수 보유자산" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-2 text-foreground" value={holding?.ticker ?? ''} onChange={(event) => { setTicker(event.target.value); setResult(null); }}>{intelligence.holdings.map((row) => <option value={row.ticker} key={row.id}>{row.name} ({row.ticker})</option>)}</select></label>
        <label className="text-xs font-bold text-muted-foreground">입력 기준<select aria-label="추가매수 입력 기준" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-2 text-foreground" value={mode} onChange={(event) => { setMode(event.target.value === 'quantity' ? 'quantity' : 'amount'); setResult(null); }}><option value="amount">추가 금액(KRW)</option><option value="quantity">추가 수량</option></select></label>
      </div>
      {mode === 'amount' ? <label className="mt-2 block text-xs font-bold text-muted-foreground">추가 투자 금액<input aria-label="추가 투자 금액" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="0" value={amount} onChange={(event) => setAmount(Number(event.target.value) || 0)} /></label> : <label className="mt-2 block text-xs font-bold text-muted-foreground">추가 수량<input aria-label="추가 수량" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(Number(event.target.value) || 0)} /></label>}
      <button type="button" disabled={busy || (mode === 'amount' ? amount <= 0 : quantity <= 0)} onClick={() => void calculate()} className="mt-3 w-full rounded-xl bg-primary px-3 py-2.5 text-sm font-black text-primary-foreground disabled:opacity-50">{busy ? '계산 중...' : '추가매수 계산'}</button>
      {error ? <p role="alert" className="mt-2 text-xs font-bold text-destructive">{error}</p> : null}
      {holding ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Metric label="현재 평균단가(원통화)" value={`${holding.averagePrice.toLocaleString()} ${holding.currency}`} />
        <Metric label="현재가(원통화)" value={`${holding.currentPrice.toLocaleString()} ${holding.currency}`} />
        <Metric label="추가 후 평단(KRW 환산)" value={money(simulation?.newAveragePrice)} state={simulation?.status} />
        <Metric label="현재 비중(확인된 자산 기준)" value={percent(simulation?.currentWeightPercent)} />
        <Metric label="추가 후 비중(확인된 자산 기준)" value={percent(simulation?.projectedWeightPercent)} />
        <Metric label="현재 평가금액(KRW)" value={money(holding.normalizedKRW)} />
        <Metric label="추가 후 평가금액(KRW)" value={money(projectedValue)} />
        <Metric label="추가 금액(KRW)" value={money(simulation?.additionalInvestmentKRW)} />
        <Metric label="Stop 기준 최대손실" value={money(simulation?.estimatedMaxLossKRW)} />
      </div> : null}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Metric label="TP1 예상수익" value={money(simulation?.targetProfitsKRW[0])} /><Metric label="TP2 예상수익" value={money(simulation?.targetProfitsKRW[1])} /><Metric label="TP3 예상수익" value={money(simulation?.targetProfitsKRW[2])} /><Metric label="Risk / Reward" value={riskReward == null ? 'UNAVAILABLE' : riskReward.toFixed(2)} /></div>
      <div data-testid="portfolio-additional-buy-basis" className="mt-3 rounded-xl border border-dashed border-border p-3 text-xs font-bold leading-5 text-muted-foreground">
        <p>가격 계산 기준: <strong className="text-foreground">{result?.priceBasis ?? 'NORMALIZED_KRW'}</strong></p>
        <p>Stop/Target evidence: <strong>{result?.evidence.stopLoss ?? 'UNAVAILABLE'} / {result?.evidence.targets ?? 'UNAVAILABLE'}</strong></p>
        {simulation?.missing?.length ? <ul className="mt-1">{simulation.missing.map((item) => <li key={item}>• {item}</li>)}</ul> : null}
        <p>검증된 Scanner/Risk Engine PricePlan이 연결되지 않은 경우 서버 Core도 임의 가격을 만들지 않습니다.</p>
      </div>
    </> : <p className="mt-3 text-sm font-bold text-muted-foreground">계산할 보유자산이 없습니다.</p>}
  </section>;
}

function IntelligenceDashboard() {
  const [location] = useLocation();
  const [profile, setProfile] = useState('BALANCED');
  const query = useQuery({
    queryKey: ['portfolio-intelligence-v2', profile],
    queryFn: () => apiGet<ResponseShape>(`/portfolio/intelligence?profile=${encodeURIComponent(profile)}`),
    staleTime: 30_000,
    refetchInterval: () => typeof document !== 'undefined' && document.hidden ? false : 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const intelligence = query.data?.portfolio;

  useEffect(() => {
    const locationQuery = location.includes('?') ? location.slice(location.indexOf('?') + 1) : '';
    const browserQuery = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
    const focus = new URLSearchParams(locationQuery || browserQuery).get('focus');
    if (focus !== 'ai') return;
    const timer = window.setTimeout(() => {
      document.getElementById('portfolio-ai-diagnosis')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [location]);

  return <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24">
    <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10"><WalletCards className="h-5 w-5 text-primary" /></div>
        <div className="min-w-0 flex-1"><h2 className="text-lg font-black">Portfolio Intelligence</h2><p className="text-xs font-bold text-muted-foreground">실데이터만 집계하며 누락 공급자는 PARTIAL로 표시합니다. AI Mentor는 계산된 사실만 설명합니다.</p></div>
        <button type="button" aria-label="포트폴리오 인텔리전스 새로고침" onClick={() => void query.refetch()} disabled={query.isFetching} className="flex h-10 w-10 items-center justify-center rounded-xl border border-border"><RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} /></button>
      </header>

      <PortfolioAiDiagnosis />
      {query.isLoading ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-2xl bg-muted/40" />)}</div> : null}
      {query.isError ? <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm font-bold text-destructive">Portfolio Intelligence API를 불러오지 못했습니다. 실제 서버 오류를 숨기지 않습니다.</div> : null}

      {intelligence ? <>
        <div data-testid="portfolio-data-quality" className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
          <StateBadge value={intelligence.status} />
          <span className="text-[11px] font-bold text-muted-foreground">기준(서버 수집) {basisTime(intelligence.asOf)}</span>
          <span className="text-[11px] font-bold text-muted-foreground">공급자 포함 {intelligence.dataQuality.includedProviderCount}/{intelligence.dataQuality.providerCount}</span>
          {intelligence.dataQuality.invalidHoldingRows > 0 ? <span className="text-[11px] font-bold text-destructive">보유원본 검증실패 {intelligence.dataQuality.invalidHoldingRows}건</span> : null}
        </div>

        <section className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Metric label="총 자산(완전 집계)" value={money(intelligence.totalAssets.normalizedKRW)} state={intelligence.totalAssets.status} />
          <Metric testId="portfolio-known-total" label="확인된 자산 합계" value={money(intelligence.totalAssets.knownNormalizedKRW)} state="KNOWN_BASIS" />
          <Metric label="투자 원금" value={money(intelligence.investmentPrincipal.normalizedKRW)} state={intelligence.investmentPrincipal.status} />
          <Metric label="평가손익" value={money(intelligence.valuationPnl.normalizedKRW)} state={intelligence.valuationPnl.status} />
          <Metric label="전체 수익률" value={percent(intelligence.valuationPnl.returnPercent)} state={intelligence.valuationPnl.status} />
          <Metric label="현금" value={money(intelligence.cash.totalKRW)} state={intelligence.cash.status} />
          <Metric label="최소 현금 Buffer" value={money(intelligence.minimumCashBuffer.normalizedKRW)} state={intelligence.minimumCashBuffer.status} />
          <Metric label="추가 투자 가능" value={money(intelligence.investableCash.normalizedKRW)} state={intelligence.investableCash.status} />
          <Metric label="Portfolio Risk" value={intelligence.riskClassification.level ?? 'UNAVAILABLE'} state={intelligence.riskClassification.status} />
        </section>

        {intelligence.totalAssets.normalizedKRW == null ? <p className="rounded-xl bg-muted/40 p-3 text-xs font-bold leading-5 text-muted-foreground">총 자산은 현금/계좌 등 누락 소스 때문에 확정하지 않습니다. <strong className="text-foreground">확인된 자산 합계</strong>는 현재 실제로 수집된 항목만 더한 값이며 완전한 총자산으로 간주하지 않습니다.</p> : null}

        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-3xl border border-border bg-card p-4"><h2 className="font-black">자산배분 · 확인된 자산 기준</h2><div className="mt-3 space-y-2">{Object.entries(intelligence.allocation.buckets).map(([key, value]) => <div key={key} className="flex items-center justify-between gap-3 text-sm font-bold"><span>{key}</span><span>{percent(value)}</span></div>)}</div><p className="mt-3 text-[11px] font-bold text-muted-foreground">분모 {money(intelligence.allocation.knownTotalKRW)} · 미수집 자산은 0%로 바꾸지 않습니다.</p></div>
          <div className="rounded-3xl border border-border bg-card p-4"><h2 className="font-black">집중도 · 분산</h2><p className="mt-3 text-sm font-bold">Top-5 concentration: {percent(intelligence.top5Concentration.percent)}</p><p className="mt-2 text-sm font-bold">Correlation {intelligence.correlation.pair.join(' / ') || '—'}: {intelligence.correlation.correlation == null ? intelligence.correlation.status : intelligence.correlation.correlation.toFixed(3)}</p><p className="mt-1 text-xs font-bold text-muted-foreground">aligned sample {intelligence.correlation.sampleSize}</p><p className="mt-2 text-xs font-bold text-muted-foreground">Risk reason: {intelligence.riskClassification.reason}</p></div>
        </section>

        <section className="rounded-3xl border border-border bg-card p-4"><h2 className="font-black">상위 보유자산</h2><div className="mt-3 divide-y divide-border">{intelligence.topHoldings.length ? intelligence.topHoldings.map((holding) => <div key={holding.id} className="flex items-center justify-between gap-3 py-2 text-sm"><div className="min-w-0"><p className="truncate font-black">{holding.name}</p><p className="text-xs font-bold text-muted-foreground">{holding.ticker} · {holding.market} · {holding.currentPrice.toLocaleString()} {holding.currency}</p></div><span className="shrink-0 font-black">{money(holding.normalizedKRW)}</span></div>) : <p className="text-sm font-bold text-muted-foreground">보유자산 없음</p>}</div></section>

        <section className="rounded-3xl border border-border bg-card p-4"><div className="flex flex-wrap items-center gap-2"><BrainCircuit className="h-4 w-4" /><h2 className="font-black">결정론적 Allocation Policy</h2><select aria-label="투자 성향" className="ml-auto rounded-xl border border-border bg-background px-2 py-2 text-xs font-bold" value={profile} onChange={(event) => setProfile(event.target.value)}><option value="STABLE">안정형</option><option value="BALANCED">균형형</option><option value="GROWTH">성장형</option></select></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{intelligence.allocationPolicy.comparison.map((row) => <div key={row.assetClass} className="rounded-xl bg-muted/40 p-3"><p className="text-xs font-black">{row.assetClass}</p><p className="mt-1 text-xs font-bold text-muted-foreground">현재 {percent(row.currentPercent)} · 허용 {row.minPercent}–{row.maxPercent}%</p><p className="mt-2 text-sm font-black">{row.state}</p></div>)}</div><p className="mt-3 text-[11px] font-bold text-muted-foreground">이 정책은 현재 비중을 허용범위와 비교합니다. 단일 목표비중을 의미하지 않습니다.</p></section>

        <div className="grid gap-4 lg:grid-cols-2"><AdditionalBuySimulator intelligence={intelligence} /><MonthlySimulator intelligence={intelligence} profile={profile} /></div>

        {intelligence.missingSources.length ? <section data-testid="portfolio-partial-sources" className="rounded-3xl border border-warning/30 bg-warning/10 p-4"><div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /><h2 className="font-black">수집하지 못한 데이터</h2></div><p className="mt-1 text-xs font-bold text-muted-foreground">아래 항목은 0으로 간주하지 않으며 총자산·리스크·배분을 PARTIAL로 유지합니다.</p><ul className="mt-2 space-y-1 text-xs font-bold text-muted-foreground">{intelligence.missingSources.map((source) => <li key={source}>• {missingSourceLabel(source)}</li>)}</ul></section> : null}

        <section data-testid="portfolio-fx-provenance" className="rounded-3xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2"><h2 className="font-black">환율 근거</h2><StateBadge value={intelligence.fx.status} /></div>
          {intelligence.fx.quotes.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{intelligence.fx.quotes.map((quote) => <div key={`${quote.pair}-${quote.source}`} className="rounded-xl bg-muted/40 p-3"><div className="flex items-center justify-between gap-2"><p className="text-sm font-black">{quote.pair}</p><StateBadge value={quote.quality} /></div><p className="mt-1 text-lg font-black">{quote.rate.toLocaleString()}</p><p className="mt-1 text-[11px] font-bold text-muted-foreground">{quote.source}</p><p className="mt-1 text-[11px] font-bold text-muted-foreground">근거 시각 {basisTime(quote.asOf)}</p></div>)}</div> : <p className="mt-3 text-xs font-bold text-muted-foreground">FX_UNAVAILABLE — 환율이 필요한 자산은 KRW 합계에 임의 반영하지 않습니다.</p>}
        </section>
      </> : null}
    </div>
    <BottomNav />
  </div>;
}

function portfolioV2Tab(location: string): PortfolioV2Tab {
  const locationQuery = location.includes('?') ? location.slice(location.indexOf('?') + 1) : '';
  const browserQuery = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
  const tab = new URLSearchParams(locationQuery || browserQuery).get('tab');
  if (tab === 'journal') return 'journal';
  if (tab === 'holdings') return 'holdings';
  return 'intelligence';
}

export default function PortfolioV2Page() {
  const [location, navigate] = useLocation();
  const [tab, setTab] = useState<PortfolioV2Tab>(() => portfolioV2Tab(location));

  useEffect(() => {
    setTab(portfolioV2Tab(location));
  }, [location]);

  useEffect(() => {
    const syncFromHistory = () => setTab(portfolioV2Tab(window.location.href));
    window.addEventListener('popstate', syncFromHistory);
    return () => window.removeEventListener('popstate', syncFromHistory);
  }, []);

  function selectTab(next: PortfolioV2Tab) {
    setTab(next);
    navigate(next === 'intelligence' ? '/portfolio' : `/portfolio?tab=${next}`);
  }

  return <div className="flex h-full min-h-0 flex-col bg-background"><div className="shrink-0 border-b border-border bg-background px-3 pb-2 pt-3"><div className="mx-auto w-full max-w-6xl">{tab === 'intelligence' ? <div className="mb-3"><h1 className="text-xl font-black">내 포트폴리오</h1><p className="mt-1 text-xs font-bold text-muted-foreground">인텔리전스, AI Mentor, 기존 보유자산, 통합 매매일지를 한 곳에서 확인합니다.</p></div> : null}<div className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1" aria-label="포트폴리오 V2 보기"><button type="button" aria-pressed={tab === 'intelligence'} onClick={() => selectTab('intelligence')} className={cn('min-h-11 rounded-xl px-2 py-2.5 text-xs font-black sm:text-sm', tab === 'intelligence' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>인텔리전스</button><button type="button" aria-pressed={tab === 'holdings'} onClick={() => selectTab('holdings')} className={cn('min-h-11 rounded-xl px-2 py-2.5 text-xs font-black sm:text-sm', tab === 'holdings' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>보유자산</button><button type="button" aria-pressed={tab === 'journal'} onClick={() => selectTab('journal')} className={cn('min-h-11 rounded-xl px-2 py-2.5 text-xs font-black sm:text-sm', tab === 'journal' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>매매일지</button></div></div></div><div className="min-h-0 flex-1">{tab === 'intelligence' ? <IntelligenceDashboard /> : <div className="h-full [&_[aria-label='포트폴리오_보기']]:hidden"><PortfolioPage /></div>}</div></div>;
}
