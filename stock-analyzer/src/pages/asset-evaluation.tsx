import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { useUsdKrwRate } from '@/lib/portfolio-fx';
import { cn } from '@/lib/utils';

type AssetMode = 'all' | 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
type AnyObj = Record<string, any>;

type AssetRow = {
  key: string;
  asset: Exclude<AssetMode, 'all'>;
  name: string;
  ticker: string;
  valueKrw: number | null;
  returnPercent: number | null;
  href: string;
};

function numberOf(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function modeFromLocation(): AssetMode {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('asset');
  return value === 'stockKR' || value === 'stockUS' || value === 'coinSpot' || value === 'coinFutures'
    ? value
    : 'all';
}

function assetLabel(mode: AssetMode): string {
  if (mode === 'stockKR') return '국내주식';
  if (mode === 'stockUS') return '해외주식';
  if (mode === 'coinSpot') return '코인 현물';
  if (mode === 'coinFutures') return '코인 선물';
  return '전체 보유자산';
}

function manwon(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '데이터 없음';
  const scaled = value / 10_000;
  const abs = Math.abs(scaled);
  const maximumFractionDigits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${scaled.toLocaleString('ko-KR', { maximumFractionDigits })}만원`;
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '데이터 없음';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

async function fetchJson(path: string): Promise<AnyObj> {
  const response = await authorizedFetch(`/api${path.startsWith('/') ? path : `/${path}`}`, {
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as AnyObj;
  if (!response.ok) throw new Error(String(body.message ?? body.error ?? response.status));
  return body;
}

export default function AssetEvaluationPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const fx = useUsdKrwRate();
  const mode = modeFromLocation();

  const holdingsQuery = useQuery({
    queryKey: ['asset-evaluation-holdings', auth.user?.id ?? 'anon'],
    enabled: Boolean(auth.configured && auth.user),
    retry: false,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('portfolio_holdings')
        .select('*')
        .eq('user_id', auth.user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const tickers = rows.map((row: AnyObj) => String(row.ticker ?? '').toUpperCase()).filter(Boolean);
      let quoteMap = new Map<string, AnyObj>();
      if (tickers.length) {
        const quoteBody = await fetchJson(`/quotes?tickers=${encodeURIComponent(tickers.join(','))}`).catch(() => ({}));
        const quotes = Array.isArray(quoteBody.quotes) ? quoteBody.quotes : [];
        quoteMap = new Map<string, AnyObj>(quotes.map((quote: AnyObj): [string, AnyObj] => [String(quote.ticker ?? quote.symbol ?? '').toUpperCase(), quote]));
      }
      return rows.map((row: AnyObj) => ({ ...row, quote: quoteMap.get(String(row.ticker ?? '').toUpperCase()) }));
    },
  });

  const spotAccounts = useQuery({
    queryKey: ['asset-evaluation-upbit-accounts'],
    queryFn: () => fetchJson('/crypto/spot/accounts'),
    retry: false,
  });

  const spotSymbols = useMemo(
    () => ((spotAccounts.data?.accounts ?? []) as AnyObj[])
      .map((row) => String(row.currency ?? '').toUpperCase())
      .filter((symbol) => symbol && symbol !== 'KRW'),
    [spotAccounts.data],
  );

  const spotTickers = useQuery({
    queryKey: ['asset-evaluation-upbit-tickers', spotSymbols.join(',')],
    enabled: spotSymbols.length > 0,
    queryFn: () => fetchJson(`/crypto/spot/tickers?markets=${encodeURIComponent(spotSymbols.join(','))}`),
    retry: false,
  });

  const futuresPositions = useQuery({
    queryKey: ['asset-evaluation-bitget-positions'],
    queryFn: () => fetchJson('/crypto/futures/positions'),
    retry: false,
  });

  const rows = useMemo<AssetRow[]>(() => {
    const result: AssetRow[] = [];
    const fxRate = fx.rate;

    for (const row of (holdingsQuery.data ?? []) as AnyObj[]) {
      const market = row.market === 'US' ? 'US' : 'KR';
      const asset: AssetRow['asset'] = market === 'US' ? 'stockUS' : 'stockKR';
      const quantity = numberOf(row.quantity);
      const average = numberOf(row.average_price);
      const current = numberOf(row.quote?.price ?? row.quote?.currentPrice ?? row.quote?.cur_prc);
      const valueNative = quantity != null && current != null ? quantity * Math.abs(current) : null;
      const valueKrw = valueNative == null
        ? null
        : market === 'US'
          ? fxRate == null ? null : valueNative * fxRate
          : valueNative;
      const returnPercent = average != null && average > 0 && current != null
        ? ((Math.abs(current) - average) / average) * 100
        : null;
      const ticker = String(row.ticker ?? '').toUpperCase();
      result.push({
        key: `${asset}:${row.id ?? ticker}`,
        asset,
        name: String(row.name ?? ticker),
        ticker,
        valueKrw,
        returnPercent,
        href: `/stock/${encodeURIComponent(ticker)}?back=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      });
    }

    const spotPriceMap = new Map<string, AnyObj>(
      ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((row): [string, AnyObj] => [
        String(row.symbol ?? row.market ?? '').replace(/^KRW-/, '').toUpperCase(),
        row,
      ]),
    );
    for (const account of (spotAccounts.data?.accounts ?? []) as AnyObj[]) {
      const ticker = String(account.currency ?? '').toUpperCase();
      if (!ticker || ticker === 'KRW') continue;
      const quantity = numberOf(account.balance);
      const average = numberOf(account.averageBuyPrice);
      const current = numberOf(spotPriceMap.get(ticker)?.price);
      const valueKrw = quantity != null && current != null ? quantity * current : null;
      const returnPercent = average != null && average > 0 && current != null
        ? ((current - average) / average) * 100
        : null;
      result.push({
        key: `coinSpot:${ticker}`,
        asset: 'coinSpot',
        name: ticker,
        ticker,
        valueKrw,
        returnPercent,
        href: `/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(ticker)}`,
      });
    }

    for (const position of (futuresPositions.data?.positions ?? []) as AnyObj[]) {
      const ticker = String(position.symbol ?? '').toUpperCase();
      const quantity = numberOf(position.total);
      const entry = numberOf(position.openPriceAvg);
      const mark = numberOf(position.markPrice);
      const direction = String(position.holdSide ?? '').toLowerCase();
      const valueUsdt = quantity != null && mark != null ? Math.abs(quantity) * mark : null;
      const valueKrw = valueUsdt == null || fxRate == null ? null : valueUsdt * fxRate;
      let returnPercent: number | null = null;
      if (entry != null && entry > 0 && mark != null) {
        const raw = ((mark - entry) / entry) * 100;
        returnPercent = direction === 'short' ? -raw : raw;
      }
      result.push({
        key: `coinFutures:${ticker}:${direction}`,
        asset: 'coinFutures',
        name: ticker,
        ticker,
        valueKrw,
        returnPercent,
        href: `/stock-info?asset=coin&coinMarket=futures&symbol=${encodeURIComponent(ticker)}`,
      });
    }

    return result;
  }, [fx.rate, futuresPositions.data, holdingsQuery.data, spotAccounts.data, spotTickers.data]);

  const totals = useMemo(() => {
    const map: Record<Exclude<AssetMode, 'all'>, number | null> = {
      stockKR: 0,
      stockUS: 0,
      coinSpot: 0,
      coinFutures: 0,
    };
    const hasValue: Record<Exclude<AssetMode, 'all'>, boolean> = {
      stockKR: false,
      stockUS: false,
      coinSpot: false,
      coinFutures: false,
    };
    for (const row of rows) {
      if (row.valueKrw != null) {
        map[row.asset] = (map[row.asset] ?? 0) + row.valueKrw;
        hasValue[row.asset] = true;
      }
    }
    for (const key of Object.keys(map) as Array<Exclude<AssetMode, 'all'>>) {
      if (!hasValue[key]) map[key] = null;
    }
    return map;
  }, [rows]);

  const visibleRows = mode === 'all' ? [] : rows.filter((row) => row.asset === mode);
  const loading = holdingsQuery.isLoading || spotAccounts.isLoading || futuresPositions.isLoading;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24 text-center">
      <header className="border-b border-card-border px-4 pb-4 pt-5">
        <h1 className="text-2xl font-extrabold">{assetLabel(mode)}</h1>
        <p className="mt-1 text-xs font-bold text-muted-foreground">평가금액은 모두 만원 단위입니다.</p>
      </header>

      <main className="space-y-4 px-4 py-4">
        {mode === 'all' ? (
          <div className="grid grid-cols-2 gap-3">
            {(['stockKR', 'stockUS', 'coinSpot', 'coinFutures'] as const).map((asset) => (
              <button
                key={asset}
                type="button"
                onClick={() => navigate(`/portfolio/summary?asset=${asset}`)}
                className="rounded-3xl border border-card-border bg-card p-5 text-center shadow-sm"
              >
                <p className="text-sm font-extrabold">{assetLabel(asset)}</p>
                <p className="mt-3 text-xl font-black text-primary">{manwon(totals[asset])}</p>
              </button>
            ))}
          </div>
        ) : (
          <>
            <section className="rounded-3xl border border-card-border bg-card p-5 text-center shadow-sm">
              <p className="text-sm font-bold text-muted-foreground">총평가금액</p>
              <p className="mt-2 text-2xl font-black text-primary">{manwon(totals[mode])}</p>
            </section>

            <section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
              <div className="grid grid-cols-[minmax(0,1fr)_110px_90px] border-b border-card-border px-3 py-3 text-xs font-black text-muted-foreground">
                <span>종목</span>
                <span>평가금액</span>
                <span>현재 수익률</span>
              </div>
              {loading && <p className="p-6 text-sm font-bold text-muted-foreground">실제 보유자산을 불러오는 중입니다.</p>}
              {!loading && visibleRows.length === 0 && <p className="p-6 text-sm font-bold text-muted-foreground">표시할 실제 보유자산이 없습니다.</p>}
              {visibleRows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => navigate(row.href)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_110px_90px] items-center border-b border-card-border px-3 py-4 text-center last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-extrabold">{row.name}</span>
                    <span className="mt-1 block truncate text-[10px] font-bold text-muted-foreground">{row.ticker}</span>
                  </span>
                  <span className="text-sm font-black">{manwon(row.valueKrw)}</span>
                  <span className={cn('text-sm font-black', row.returnPercent == null ? 'text-muted-foreground' : row.returnPercent >= 0 ? 'text-positive' : 'text-destructive')}>
                    {percent(row.returnPercent)}
                  </span>
                </button>
              ))}
            </section>
          </>
        )}

        {(holdingsQuery.isError || spotAccounts.isError || futuresPositions.isError) && (
          <p className="rounded-2xl bg-destructive/10 p-4 text-sm font-bold text-destructive">
            일부 자산 연결에 실패했습니다. 임시 금액은 표시하지 않습니다.
          </p>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
