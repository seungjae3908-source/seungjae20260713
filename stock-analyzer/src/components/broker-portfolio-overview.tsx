import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Link2, RefreshCw, WalletCards } from 'lucide-react';
import { useLocation } from 'wouter';
import { apiGet } from '@/lib/api';

type Provider = 'toss' | 'kiwoom' | 'upbit' | 'bitget';

type CurrencyTotal = {
  currency: string;
  totalAssets: number;
  cashAvailable: number;
  holdingsMarketValue: number;
  profitLoss: number;
  derivativesNotional: number;
  holdingAllocationPercent: number | null;
  providers: Provider[];
  pricingComplete: boolean;
};

type Holding = {
  provider: Provider;
  sourceProvider: Provider;
  accountId: string;
  symbol: string;
  name: string | null;
  currency: string;
  quantity: number;
  marketValue: number | null;
  profitLoss: number | null;
  valuationState: 'VALUED' | 'UNPRICED';
};

type Position = {
  sourceProvider: 'bitget';
  symbol: string;
  side: string;
  quantity: number;
  leverage: number | null;
  notionalValue: number | null;
  unrealizedPnl: number | null;
  currency: string;
};

type BrokerPortfolio = {
  asOf: string;
  baseCurrency: null;
  conversionApplied: false;
  totalsByCurrency: CurrencyTotal[];
  holdings: Holding[];
  positions: Position[];
  incompleteProviders: Provider[];
};

type Snapshot = { portfolio?: BrokerPortfolio };

const PROVIDER_LABEL: Record<Provider, string> = {
  toss: 'Toss Securities',
  kiwoom: 'Kiwoom',
  upbit: 'Upbit',
  bitget: 'Bitget',
};

function amount(value: number | null | undefined, currency: string) {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 4,
  }).format(value);
}

export function BrokerPortfolioOverview() {
  const [, navigate] = useLocation();
  const query = useQuery({
    queryKey: ['member-broker-portfolio'],
    queryFn: () => apiGet<Snapshot>('/trade-automation/account-connections/snapshot'),
    staleTime: 20_000,
    retry: false,
  });
  const portfolio = query.data?.portfolio;

  return <section data-testid="broker-portfolio-overview" className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><WalletCards className="h-5 w-5 shrink-0 text-primary" /><h2 className="font-extrabold">연결 계좌 통합 자산</h2></div>
        <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">Toss 우선·Kiwoom 보완, Upbit 현물, Bitget 선물을 공급자 출처와 함께 표시합니다.</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={() => navigate('/account')} className="flex min-h-10 items-center gap-2 rounded-xl border border-card-border px-3 text-xs font-extrabold"><Link2 className="h-4 w-4" />연결 관리</button>
        <button type="button" aria-label="통합 자산 새로고침" disabled={query.isFetching} onClick={() => void query.refetch()} className="flex h-10 w-10 items-center justify-center rounded-xl border border-card-border disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></button>
      </div>
    </div>

    {query.isLoading ? <p className="mt-4 rounded-2xl bg-secondary p-4 text-sm font-bold">연결 계좌를 안전하게 조회하고 있습니다.</p> : null}
    {query.isError ? <p className="mt-4 rounded-2xl bg-destructive/10 p-4 text-sm font-bold text-destructive">연결 계좌 자산을 불러오지 못했습니다. 계정 연결 상태를 확인해 주세요.</p> : null}

    {portfolio ? <>
      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {portfolio.totalsByCurrency.map((total) => <article key={total.currency} className="min-w-0 rounded-2xl bg-secondary/60 p-4" data-testid={`broker-total-${total.currency.toLowerCase()}`}>
          <div className="flex items-center justify-between gap-2"><p className="text-xs font-extrabold text-muted-foreground">{total.currency} 총자산</p><span className="rounded-full bg-background px-2 py-1 text-[10px] font-extrabold">{total.providers.map((provider) => PROVIDER_LABEL[provider]).join(' · ')}</span></div>
          <p className="mt-2 truncate text-xl font-black tabular-nums">{amount(total.totalAssets, total.currency)}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="현금·주문가능" value={amount(total.cashAvailable, total.currency)} />
            <Metric label="보유 평가" value={amount(total.holdingsMarketValue, total.currency)} />
            <Metric label="평가손익" value={amount(total.profitLoss, total.currency)} />
            <Metric label="자산 비중" value={total.holdingAllocationPercent == null ? '-' : `${total.holdingAllocationPercent.toFixed(1)}%`} />
          </div>
          {!total.pricingComplete ? <p className="mt-2 text-[11px] font-bold text-warning">현재가가 없는 자산은 합계에서 제외됨</p> : null}
          {total.derivativesNotional > 0 ? <p className="mt-2 text-[11px] text-muted-foreground">선물 명목 노출 {amount(total.derivativesNotional, total.currency)} · 총자산과 중복 합산하지 않음</p> : null}
        </article>)}
      </div>

      {!portfolio.totalsByCurrency.length ? <div className="mt-4 rounded-2xl bg-secondary p-4 text-sm font-bold">연결되어 평가 가능한 계좌 자산이 없습니다.</div> : null}

      {portfolio.incompleteProviders.length ? <div className="mt-4 flex items-start gap-2 rounded-2xl bg-warning/10 p-3 text-xs font-bold text-warning"><AlertTriangle className="h-4 w-4 shrink-0" /><span>미연결·확인 필요: {portfolio.incompleteProviders.map((provider) => PROVIDER_LABEL[provider]).join(', ')}. 값을 0원으로 간주하지 않습니다.</span></div> : null}

      {portfolio.holdings.length ? <div className="mt-4">
        <h3 className="text-sm font-extrabold">연결 계좌 보유자산</h3>
        <div className="mt-2 max-h-64 space-y-2 overflow-y-auto overscroll-contain">
          {portfolio.holdings.slice(0, 30).map((holding, index) => <div key={`${holding.sourceProvider}-${holding.accountId}-${holding.symbol}-${index}`} className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-card-border px-3 py-2.5 text-xs">
            <div className="min-w-0"><p className="truncate font-extrabold">{holding.name || holding.symbol}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{PROVIDER_LABEL[holding.sourceProvider]} · {holding.symbol} · {amount(holding.quantity, '')}주/단위</p></div>
            <div className="shrink-0 text-right"><p className="font-extrabold tabular-nums">{amount(holding.marketValue, holding.currency)} {holding.currency}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{holding.valuationState === 'UNPRICED' ? '현재가 미확인' : `손익 ${amount(holding.profitLoss, holding.currency)}`}</p></div>
          </div>)}
        </div>
      </div> : null}

      {portfolio.positions.length ? <div className="mt-4">
        <h3 className="text-sm font-extrabold">선물 포지션</h3>
        <div className="mt-2 space-y-2">{portfolio.positions.slice(0, 20).map((position, index) => <div key={`${position.symbol}-${position.side}-${index}`} className="rounded-2xl border border-card-border px-3 py-2.5 text-xs"><div className="flex min-w-0 justify-between gap-3"><span className="min-w-0 truncate font-extrabold">{position.symbol} · {position.side}</span><span className="shrink-0">{PROVIDER_LABEL[position.sourceProvider]}</span></div><p className="mt-1 text-[10px] text-muted-foreground">명목 {amount(position.notionalValue, position.currency)} {position.currency} · {position.leverage ?? '-'}x · 미실현 {amount(position.unrealizedPnl, position.currency)}</p></div>)}</div>
      </div> : null}

      <p className="mt-3 text-[10px] text-muted-foreground">통화 환산 미적용 · 기준시각 {new Date(portfolio.asOf).toLocaleString('ko-KR')}</p>
    </> : null}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-background p-2.5"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-extrabold tabular-nums">{value}</p></div>;
}
