import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BrainCircuit, RefreshCw, ShieldAlert, WalletCards } from 'lucide-react';
import PortfolioPage from '@/pages/portfolio';
import { BottomNav } from '@/components/bottom-nav';
import { apiGet } from '@/lib/api';
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
  missingSources: string[];
};

type ResponseShape = { ok: boolean; portfolio: Intelligence };

const money = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? 'UNAVAILABLE'
  : `${Math.round(value).toLocaleString('ko-KR')}원`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'UNAVAILABLE' : `${value.toFixed(1)}%`;

function StateBadge({ value }: { value: string }) {
  return <span className="rounded-full border border-border bg-muted/50 px-2 py-1 text-[10px] font-black text-muted-foreground">{value}</span>;
}

function Metric({ label, value, state }: { label: string; value: string; state?: string }) {
  return <div className="min-w-0 rounded-2xl border border-border bg-card p-3"><div className="flex items-center gap-2"><p className="text-[11px] font-bold text-muted-foreground">{label}</p>{state ? <StateBadge value={state} /> : null}</div><p className="mt-2 break-all text-base font-black sm:text-lg">{value}</p></div>;
}

function MonthlySimulator({ intelligence }: { intelligence: Intelligence }) {
  const [amount, setAmount] = useState(300_000);
  const [months, setMonths] = useState(12);
  const total = Math.max(0, amount) * Math.max(1, Math.floor(months));
  const allocationRows = Object.entries(intelligence.allocation.buckets)
    .filter((entry): entry is [string, number] => entry[1] != null && Number.isFinite(entry[1]))
    .map(([key, weight]) => ({ key, weight, amount: total * weight / 100 }));

  return <section className="rounded-3xl border border-border bg-card p-4"><h3 className="font-black">월 적립 시뮬레이터</h3><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs font-bold text-muted-foreground">월 적립액<input aria-label="월 적립액" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="0" value={amount} onChange={(event) => setAmount(Number(event.target.value) || 0)} /></label><label className="text-xs font-bold text-muted-foreground">기간(개월)<input aria-label="적립 기간" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="1" max="120" value={months} onChange={(event) => setMonths(Number(event.target.value) || 1)} /></label></div><p className="mt-3 text-sm font-black">누적 납입금 {money(total)}</p><div className="mt-2 grid gap-1 text-xs font-bold text-muted-foreground">{allocationRows.length ? allocationRows.map((row) => <div key={row.key} className="flex justify-between gap-3"><span>{row.key} · {row.weight.toFixed(1)}%</span><span>{money(row.amount)}</span></div>) : <span>Allocation PARTIAL/UNAVAILABLE</span>}</div><p className="mt-3 rounded-xl bg-muted/40 p-2 text-[11px] font-bold text-muted-foreground">NO_VALIDATED_RETURN_ASSUMPTION — 미래 수익금·미래 자산가치·CAGR은 생성하지 않습니다.</p></section>;
}

function AdditionalBuySimulator({ intelligence }: { intelligence: Intelligence }) {
  const [ticker, setTicker] = useState(intelligence.holdings[0]?.ticker ?? '');
  const [amount, setAmount] = useState(0);
  const holding = intelligence.holdings.find((row) => row.ticker === ticker) ?? intelligence.holdings[0];
  const result = useMemo(() => {
    if (!holding || !(amount > 0) || !(holding.currentPrice > 0)) return null;
    const additionalQuantity = amount / holding.currentPrice;
    const newQuantity = holding.quantity + additionalQuantity;
    const newAveragePrice = newQuantity > 0 ? ((holding.quantity * holding.averagePrice) + amount) / newQuantity : null;
    const knownTotal = intelligence.totalAssets.knownNormalizedKRW;
    const currentWeight = holding.normalizedKRW != null && knownTotal > 0 ? holding.normalizedKRW / knownTotal * 100 : null;
    const projectedWeight = holding.normalizedKRW != null && knownTotal > 0 ? (holding.normalizedKRW + amount) / (knownTotal + amount) * 100 : null;
    return { additionalQuantity, newAveragePrice, currentWeight, projectedWeight };
  }, [amount, holding, intelligence.totalAssets.knownNormalizedKRW]);

  return <section className="rounded-3xl border border-border bg-card p-4"><h3 className="font-black">추가매수 시뮬레이터</h3>{intelligence.holdings.length ? <><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs font-bold text-muted-foreground">보유자산<select aria-label="추가매수 보유자산" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-2 text-foreground" value={holding?.ticker ?? ''} onChange={(event) => setTicker(event.target.value)}>{intelligence.holdings.map((row) => <option value={row.ticker} key={row.id}>{row.name} ({row.ticker})</option>)}</select></label><label className="text-xs font-bold text-muted-foreground">추가 투자 금액<input aria-label="추가 투자 금액" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-foreground" type="number" min="0" value={amount} onChange={(event) => setAmount(Number(event.target.value) || 0)} /></label></div>{holding ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Metric label="현재 평균단가" value={`${holding.averagePrice.toLocaleString()} ${holding.currency}`} /><Metric label="추가 후 평균단가" value={result?.newAveragePrice == null ? '입력 필요' : `${result.newAveragePrice.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${holding.currency}`} /><Metric label="현재 비중(known basis)" value={percent(result?.currentWeight)} /><Metric label="추가 후 비중(known basis)" value={percent(result?.projectedWeight)} /></div> : null}<div className="mt-3 rounded-xl border border-dashed border-border p-3 text-xs font-bold text-muted-foreground">Stop 기준 최대손실 · TP1/TP2/TP3 · Risk/Reward: <strong>UNAVAILABLE</strong><br />검증된 Scanner/Risk Engine PricePlan이 현재 Portfolio API에 연결되지 않아 임의 가격을 만들지 않습니다.</div></> : <p className="mt-3 text-sm font-bold text-muted-foreground">계산할 보유자산이 없습니다.</p>}</section>;
}

function IntelligenceDashboard() {
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

  return <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24"><div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5"><header className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10"><WalletCards className="h-5 w-5 text-primary" /></div><div className="min-w-0 flex-1"><h1 className="text-lg font-black">Portfolio Intelligence</h1><p className="text-xs font-bold text-muted-foreground">실데이터만 집계하며 누락 공급자는 PARTIAL로 표시합니다.</p></div><button type="button" aria-label="포트폴리오 인텔리전스 새로고침" onClick={() => void query.refetch()} disabled={query.isFetching} className="flex h-10 w-10 items-center justify-center rounded-xl border border-border"><RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} /></button></header>{query.isLoading ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-2xl bg-muted/40" />)}</div> : null}{query.isError ? <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm font-bold text-destructive">Portfolio Intelligence API를 불러오지 못했습니다. 실제 서버 오류를 숨기지 않습니다.</div> : null}{intelligence ? <><div className="flex flex-wrap items-center gap-2"><StateBadge value={intelligence.status} /><span className="text-[11px] font-bold text-muted-foreground">기준 {new Date(intelligence.asOf).toLocaleString('ko-KR')}</span></div><section className="grid grid-cols-2 gap-2 lg:grid-cols-4"><Metric label="총 자산" value={money(intelligence.totalAssets.normalizedKRW)} state={intelligence.totalAssets.status} /><Metric label="투자 원금" value={money(intelligence.investmentPrincipal.normalizedKRW)} state={intelligence.investmentPrincipal.status} /><Metric label="평가손익" value={money(intelligence.valuationPnl.normalizedKRW)} state={intelligence.valuationPnl.status} /><Metric label="전체 수익률" value={percent(intelligence.valuationPnl.returnPercent)} state={intelligence.valuationPnl.status} /><Metric label="현금" value={money(intelligence.cash.totalKRW)} state={intelligence.cash.status} /><Metric label="최소 현금 Buffer" value={money(intelligence.minimumCashBuffer.normalizedKRW)} state={intelligence.minimumCashBuffer.status} /><Metric label="추가 투자 가능" value={money(intelligence.investableCash.normalizedKRW)} state={intelligence.investableCash.status} /><Metric label="Portfolio Risk" value={intelligence.riskClassification.level ?? 'UNAVAILABLE'} state={intelligence.riskClassification.status} /></section><section className="grid gap-3 lg:grid-cols-2"><div className="rounded-3xl border border-border bg-card p-4"><h2 className="font-black">자산배분</h2><div className="mt-3 space-y-2">{Object.entries(intelligence.allocation.buckets).map(([key, value]) => <div key={key} className="flex items-center justify-between gap-3 text-sm font-bold"><span>{key}</span><span>{percent(value)}</span></div>)}</div></div><div className="rounded-3xl border border-border bg-card p-4"><h2 className="font-black">집중도 · 분산</h2><p className="mt-3 text-sm font-bold">Top-5 concentration: {percent(intelligence.top5Concentration.percent)}</p><p className="mt-2 text-sm font-bold">Correlation {intelligence.correlation.pair.join(' / ') || '—'}: {intelligence.correlation.correlation == null ? intelligence.correlation.status : intelligence.correlation.correlation.toFixed(3)}</p><p className="mt-1 text-xs font-bold text-muted-foreground">aligned sample {intelligence.correlation.sampleSize}</p></div></section><section className="rounded-3xl border border-border bg-card p-4"><h2 className="font-black">상위 보유자산</h2><div className="mt-3 divide-y divide-border">{intelligence.topHoldings.length ? intelligence.topHoldings.map((holding) => <div key={holding.id} className="flex items-center justify-between gap-3 py-2 text-sm"><div className="min-w-0"><p className="truncate font-black">{holding.name}</p><p className="text-xs font-bold text-muted-foreground">{holding.ticker} · {holding.market}</p></div><span className="shrink-0 font-black">{money(holding.normalizedKRW)}</span></div>) : <p className="text-sm font-bold text-muted-foreground">보유자산 없음</p>}</div></section><section className="rounded-3xl border border-border bg-card p-4"><div className="flex flex-wrap items-center gap-2"><BrainCircuit className="h-4 w-4" /><h2 className="font-black">결정론적 Allocation Policy</h2><select aria-label="투자 성향" className="ml-auto rounded-xl border border-border bg-background px-2 py-2 text-xs font-bold" value={profile} onChange={(event) => setProfile(event.target.value)}><option value="STABLE">안정형</option><option value="BALANCED">균형형</option><option value="GROWTH">성장형</option></select></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{intelligence.allocationPolicy.comparison.map((row) => <div key={row.assetClass} className="rounded-xl bg-muted/40 p-3"><p className="text-xs font-black">{row.assetClass}</p><p className="mt-1 text-xs font-bold text-muted-foreground">허용 {row.minPercent}–{row.maxPercent}%</p><p className="mt-2 text-sm font-black">{row.state}</p></div>)}</div></section><div className="grid gap-4 lg:grid-cols-2"><AdditionalBuySimulator intelligence={intelligence} /><MonthlySimulator intelligence={intelligence} /></div>{intelligence.missingSources.length ? <section className="rounded-3xl border border-warning/30 bg-warning/10 p-4"><div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /><h2 className="font-black">Partial / Unavailable</h2></div><ul className="mt-2 space-y-1 text-xs font-bold text-muted-foreground">{intelligence.missingSources.map((source) => <li key={source}>• {source}</li>)}</ul></section> : null}<section className="rounded-2xl border border-border p-3 text-[11px] font-bold text-muted-foreground">FX: {intelligence.fx.quotes.map((quote) => `${quote.pair} ${quote.rate.toLocaleString()} · ${quote.source} · ${quote.quality}`).join(' / ') || 'FX_UNAVAILABLE'}</section></> : null}</div><BottomNav /></div>;
}

export default function PortfolioV2Page() {
  const [tab, setTab] = useState<'intelligence' | 'holdings'>('intelligence');
  return <div className="flex h-full min-h-0 flex-col bg-background"><div className="grid shrink-0 grid-cols-2 border-b border-border bg-background p-2"><button type="button" onClick={() => setTab('intelligence')} className={cn('rounded-xl px-3 py-2 text-sm font-black', tab === 'intelligence' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>인텔리전스</button><button type="button" onClick={() => setTab('holdings')} className={cn('rounded-xl px-3 py-2 text-sm font-black', tab === 'holdings' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>기존 보유자산</button></div><div className="min-h-0 flex-1">{tab === 'intelligence' ? <IntelligenceDashboard /> : <PortfolioPage />}</div></div>;
}
