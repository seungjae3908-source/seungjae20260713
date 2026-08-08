import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import { apiGet } from '@/lib/api';

type Holding = {
  symbol?: string;
  name?: string;
  quantity?: number | null;
  averagePrice?: number | null;
  currentPrice?: number | null;
  evaluationAmount?: number | null;
  profitLoss?: number | null;
  profitRate?: number | null;
  currency?: string;
};

type Snapshot = {
  ok: boolean;
  readOnly: boolean;
  mutationsAllowed: boolean;
  checkedAt: string;
  providers: {
    kiwoom: {
      configured: boolean;
      connected: boolean;
      accountMasked?: string | null;
      error?: string | null;
      kr?: {
        ok: boolean;
        estimatedAssets?: number | null;
        totalEvaluationAmount?: number | null;
        totalProfitLoss?: number | null;
        totalProfitRate?: number | null;
        holdingCount: number;
        holdings: Holding[];
        error?: string | null;
      };
      us?: {
        ok: boolean;
        holdingCount: number;
        holdings: Holding[];
        error?: string | null;
      };
    };
    upbit: {
      configured: boolean;
      connected: boolean;
      assetCount?: number;
      assets?: Array<{
        currency: string;
        balance: number | null;
        locked: number | null;
        averageBuyPrice: number | null;
        unitCurrency: string;
      }>;
      error?: string | null;
    };
    bitget: {
      configured: boolean;
      connected: boolean;
      accounts?: Array<{
        marginCoin: string;
        available: number | null;
        locked: number | null;
        accountEquity: number | null;
        unrealizedPL: number | null;
      }>;
      positions?: Array<{
        symbol: string;
        side: string;
        total: number | null;
        leverage: number | null;
        averageOpenPrice: number | null;
        markPrice: number | null;
        unrealizedPL: number | null;
        liquidationPrice: number | null;
      }>;
      error?: string | null;
    };
  };
};

function amount(value: number | null | undefined, currency?: string) {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 6,
  }).format(value);
}

function Status({ configured, connected }: { configured: boolean; connected: boolean }) {
  const label = connected ? '연결됨' : configured ? '연결 확인 필요' : '키 미설정';
  const className = connected
    ? 'bg-positive/10 text-positive'
    : configured
      ? 'bg-warning/10 text-warning'
      : 'bg-secondary text-muted-foreground';
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${className}`}>{label}</span>;
}

function ErrorLine({ value }: { value?: string | null }) {
  if (!value) return null;
  return <p className="mt-2 break-words text-xs font-bold text-warning">{value}</p>;
}

export function BrokerageAccountConnections() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await apiGet<Snapshot>('/account-connections/snapshot'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계좌 연결 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  const kiwoom = snapshot?.providers.kiwoom;
  const upbit = snapshot?.providers.upbit;
  const bitget = snapshot?.providers.bitget;

  return (
    <section data-testid="brokerage-account-connections" className="mt-4 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <WalletCards className="h-5 w-5 shrink-0 text-primary" />
            <h2 className="text-sm font-extrabold">증권 · 거래소 계좌 연결</h2>
          </div>
          <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
            잔고·보유·포지션 조회만 허용합니다. 주문·취소·이체는 이 화면에서 실행되지 않습니다.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          className="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? '확인 중' : '새로고침'}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-positive/10 p-3 text-xs font-bold text-positive">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">READ-ONLY · 주문/취소/이체 mutation 0건</span>
      </div>

      {error ? <p className="mt-3 break-words rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p> : null}

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3">
        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-kiwoom">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Kiwoom · 국내/미국주식</p><p className="mt-0.5 text-[11px] text-muted-foreground">{kiwoom?.accountMasked ? `계좌 ${kiwoom.accountMasked}` : '서버 키 기반 연결'}</p></div>
            <Status configured={Boolean(kiwoom?.configured)} connected={Boolean(kiwoom?.connected)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="국내 추정자산" value={amount(kiwoom?.kr?.estimatedAssets, 'KRW')} />
            <Metric label="국내 평가손익" value={amount(kiwoom?.kr?.totalProfitLoss, 'KRW')} />
            <Metric label="국내 보유" value={`${kiwoom?.kr?.holdingCount ?? 0}종목`} />
            <Metric label="미국 보유" value={`${kiwoom?.us?.holdingCount ?? 0}종목`} />
          </div>
          <HoldingList rows={[...(kiwoom?.kr?.holdings ?? []), ...(kiwoom?.us?.holdings ?? [])].slice(0, 6)} />
          <ErrorLine value={kiwoom?.error ?? kiwoom?.kr?.error ?? kiwoom?.us?.error} />
        </article>

        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-upbit">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Upbit · 코인 현물</p><p className="mt-0.5 text-[11px] text-muted-foreground">자산조회 권한만 사용</p></div>
            <Status configured={Boolean(upbit?.configured)} connected={Boolean(upbit?.connected)} />
          </div>
          <p className="mt-3 text-xs font-bold">보유 자산 {upbit?.assetCount ?? 0}개</p>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain">
            {(upbit?.assets ?? []).slice(0, 10).map((row) => (
              <div key={row.currency} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                <span className="min-w-0 truncate font-extrabold">{row.currency}</span>
                <span className="shrink-0 tabular-nums">{amount(row.balance, row.unitCurrency)}</span>
              </div>
            ))}
          </div>
          <ErrorLine value={upbit?.error} />
        </article>

        <article className="min-w-0 rounded-2xl border border-card-border p-3" data-testid="connection-bitget">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-sm font-extrabold">Bitget · 코인 선물</p><p className="mt-0.5 text-[11px] text-muted-foreground">계정·포지션 조회 전용</p></div>
            <Status configured={Boolean(bitget?.configured)} connected={Boolean(bitget?.connected)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="선물 계정" value={`${bitget?.accounts?.length ?? 0}개`} />
            <Metric label="열린 포지션" value={`${(bitget?.positions ?? []).filter((row) => (row.total ?? 0) !== 0).length}개`} />
          </div>
          <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">
            {(bitget?.positions ?? []).filter((row) => (row.total ?? 0) !== 0).slice(0, 8).map((row, index) => (
              <div key={`${row.symbol}-${row.side}-${index}`} className="rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 truncate font-extrabold">{row.symbol} · {row.side}</span><span className="shrink-0">{amount(row.total)}</span></div>
                <p className="mt-1 break-words text-[11px] text-muted-foreground">레버리지 {amount(row.leverage)}x · 미실현 {amount(row.unrealizedPL)}</p>
              </div>
            ))}
          </div>
          <ErrorLine value={bitget?.error} />
        </article>
      </div>

      {snapshot?.checkedAt ? <p className="mt-3 text-[11px] text-muted-foreground">최근 확인 {new Date(snapshot.checkedAt).toLocaleString('ko-KR')}</p> : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-secondary/60 p-2.5"><p className="break-keep text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-extrabold tabular-nums">{value}</p></div>;
}

function HoldingList({ rows }: { rows: Holding[] }) {
  if (!rows.length) return null;
  return <div className="mt-2 max-h-44 space-y-1 overflow-y-auto overscroll-contain">{rows.map((row, index) => (
    <div key={`${row.symbol ?? row.name ?? 'holding'}-${index}`} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
      <span className="min-w-0 truncate font-extrabold">{row.name || row.symbol || '보유자산'}</span>
      <span className="shrink-0 tabular-nums">{amount(row.quantity)}</span>
    </div>
  ))}</div>;
}
