import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type ShadowMarket = 'KR' | 'US' | 'UPBIT_SPOT' | 'BITGET_FUTURES';
type ShadowDirection = 'LONG' | 'SHORT';

type ShadowPolicy = {
  version: string;
  startingCapitalKRW: number;
  minimumNotionalKRW: number;
  maximumNotionalPerPositionKRW: number;
  maximumConcurrentPositions: number;
  maximumDailyLossKRW: number;
  maximumTotalLossKRW: number;
  allowedLeverage: number;
};

type ShadowPosition = {
  id: string;
  market: ShadowMarket;
  symbol: string;
  direction: ShadowDirection;
  quantity: number;
  entryPrice: number;
  allocatedCapitalKRW: number;
  stopPrice: number | null;
  targetPrice: number | null;
  openedAt: string;
  currentPrice: number | null;
  unrealizedPnlKRW: number | null;
  unrealizedReturnPercent: number | null;
  quoteFetchedAt: string | null;
  quoteError: string | null;
};

type ShadowTrade = {
  id: string;
  market: ShadowMarket;
  symbol: string;
  direction: ShadowDirection;
  allocatedCapitalKRW: number;
  netPnlKRW: number;
  exitReason: string;
  closedAt: string;
};

type ShadowStatus = {
  ok: true;
  mode: 'SHADOW';
  realOrdersEnabled: false;
  policy: ShadowPolicy;
  account: {
    startedAt: string;
    updatedAt: string;
    disabled: boolean;
    disabledReason: string | null;
    startingCapitalKRW: number;
    equityKRW: number;
    availableCapitalKRW: number;
    allocatedCapitalKRW: number;
    realizedPnlKRW: number;
    unrealizedPnlKRW: number;
    dailyNetPnlKRW: number;
    totalFeesKRW: number;
    estimatedSlippageKRW: number;
    tradeCount: number;
    wins: number;
    losses: number;
    winRate: number;
  };
  positions: ShadowPosition[];
  trades: ShadowTrade[];
};

const MARKET_TABS: Array<{ key: ShadowMarket; label: string; placeholder: string }> = [
  { key: 'KR', label: '국내주식', placeholder: '예: 005930' },
  { key: 'US', label: '해외주식', placeholder: '예: AAPL' },
  { key: 'UPBIT_SPOT', label: '코인 현물', placeholder: '예: BTC' },
  { key: 'BITGET_FUTURES', label: '코인 선물', placeholder: '예: BTCUSDT' },
];

function formatKrw(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
}

async function readApi<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? `HTTP_${response.status}`);
  }
  return payload;
}

export default function AutoTradePage() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<ShadowStatus | null>(null);
  const [market, setMarket] = useState<ShadowMarket>('KR');
  const [symbol, setSymbol] = useState('');
  const [direction, setDirection] = useState<ShadowDirection>('LONG');
  const [notionalKRW, setNotionalKRW] = useState('20000');
  const [stopPrice, setStopPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeMarket = useMemo(
    () => MARKET_TABS.find((item) => item.key === market) ?? MARKET_TABS[0],
    [market],
  );

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await authorizedFetch('/api/auto-trading/shadow/status', {
        cache: 'no-store',
      });
      setStatus(await readApi<ShadowStatus>(response));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '가상계좌를 불러오지 못했습니다.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(true), 15_000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (market !== 'BITGET_FUTURES' && direction === 'SHORT') {
      setDirection('LONG');
    }
  }, [direction, market]);

  async function openPosition() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await authorizedFetch('/api/auto-trading/shadow/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market,
          symbol,
          direction,
          notionalKRW: Number(notionalKRW),
          stopPrice: stopPrice ? Number(stopPrice) : null,
          targetPrice: targetPrice ? Number(targetPrice) : null,
        }),
      });
      setStatus(await readApi<ShadowStatus>(response));
      setSymbol('');
      setStopPrice('');
      setTargetPrice('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '가상 진입에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  async function closePosition(positionId: string) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await authorizedFetch(
        `/api/auto-trading/shadow/close/${encodeURIComponent(positionId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'USER_SHADOW_CLOSE' }),
        },
      );
      setStatus(await readApi<ShadowStatus>(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '가상 청산에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  const positionBlocked =
    !status ||
    status.account.disabled ||
    status.positions.length >= status.policy.maximumConcurrentPositions;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto max-w-md px-4 pb-28 pt-4">
        <header className="grid grid-cols-[40px_1fr_40px] items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/tech')}
            aria-label="뒤로"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-center">
            <h1 className="text-lg font-extrabold">자동매매 1단계</h1>
            <p className="text-[11px] font-bold text-muted-foreground">
              20만 원 실시간 섀도 계좌
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            aria-label="새로고침"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </header>

        <div className="mt-3 rounded-2xl border border-positive/40 bg-positive/10 p-3 text-center text-xs font-black text-positive">
          <ShieldCheck className="mr-1 inline h-4 w-4" />
          실제 주문 0건 · 실제 자금은 사용하지 않습니다.
        </div>

        {error && (
          <div className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-xs font-bold text-destructive">
            {error}
          </div>
        )}

        <section className="mt-4 rounded-2xl border border-card-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold text-muted-foreground">가상계좌 평가금액</p>
              <p className="mt-1 text-2xl font-black">
                {formatKrw(status?.account.equityKRW)}
              </p>
            </div>
            <span
              className={cn(
                'rounded-full px-3 py-1 text-xs font-black',
                (status?.account.equityKRW ?? 200_000) >= 200_000
                  ? 'bg-positive/10 text-positive'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {formatKrw((status?.account.equityKRW ?? 200_000) - 200_000)}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <Metric label="사용 가능" value={formatKrw(status?.account.availableCapitalKRW)} />
            <Metric label="운용 중" value={formatKrw(status?.account.allocatedCapitalKRW)} />
            <Metric label="확정 손익" value={formatKrw(status?.account.realizedPnlKRW)} />
            <Metric label="평가 손익" value={formatKrw(status?.account.unrealizedPnlKRW)} />
            <Metric label="승률" value={`${(status?.account.winRate ?? 0).toFixed(1)}%`} />
            <Metric label="거래 수" value={`${status?.account.tradeCount ?? 0}회`} />
            <Metric label="비용 추정" value={formatKrw(status?.account.totalFeesKRW)} />
            <Metric label="슬리피지 추정" value={formatKrw(status?.account.estimatedSlippageKRW)} />
          </div>

          {status?.account.disabled && (
            <div className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs font-black text-destructive">
              안전정지: {status.account.disabledReason}
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-card-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-black">가상 진입</h2>
            <span className="text-[10px] font-bold text-muted-foreground">
              1회 최대 {formatKrw(status?.policy.maximumNotionalPerPositionKRW ?? 20_000)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {MARKET_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setMarket(tab.key)}
                className={cn(
                  'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
                  market === tab.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-background text-muted-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <label className="mt-3 block text-[11px] font-bold text-muted-foreground">
            종목 또는 코인
          </label>
          <input
            type="text"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value.toUpperCase())}
            placeholder={activeMarket.placeholder}
            className="mt-1.5 w-full rounded-xl border border-card-border bg-background px-3 py-2.5 text-sm font-bold outline-none"
          />

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDirection('LONG')}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-xs font-black',
                direction === 'LONG'
                  ? 'border-positive bg-positive/10 text-positive'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              매수 · 롱
            </button>
            <button
              type="button"
              disabled={market !== 'BITGET_FUTURES'}
              onClick={() => setDirection('SHORT')}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-xs font-black disabled:cursor-not-allowed disabled:opacity-40',
                direction === 'SHORT'
                  ? 'border-destructive bg-destructive/10 text-destructive'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              숏 · 선물 전용
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Field label="가상 주문금액" value={notionalKRW} onChange={setNotionalKRW} />
            <Field label="손절가(선택)" value={stopPrice} onChange={setStopPrice} />
            <Field label="목표가(선택)" value={targetPrice} onChange={setTargetPrice} />
          </div>

          <button
            type="button"
            disabled={submitting || positionBlocked || !symbol.trim()}
            onClick={() => void openPosition()}
            className="mt-4 w-full rounded-2xl bg-primary py-3 text-sm font-black text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? '처리 중...' : '실제 시세로 가상 진입'}
          </button>

          <p className="mt-2 text-center text-[10px] font-bold leading-4 text-muted-foreground">
            비용과 슬리피지를 보수적으로 반영하며 실제 거래소 주문은 전송하지 않습니다.
          </p>
        </section>

        <section className="mt-4 rounded-2xl border border-card-border bg-card p-4">
          <h2 className="text-sm font-black">운용 중 포지션</h2>
          {!status?.positions.length ? (
            <div className="mt-3 rounded-xl border border-card-border bg-background p-4 text-center text-xs font-bold text-muted-foreground">
              현재 가상 포지션이 없습니다.
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {status.positions.map((position) => (
                <div key={position.id} className="rounded-xl border border-card-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black">{position.symbol}</p>
                      <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                        {position.market} · {position.direction} · {formatDate(position.openedAt)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'rounded-full px-2 py-1 text-[10px] font-black',
                        (position.unrealizedPnlKRW ?? 0) >= 0
                          ? 'bg-positive/10 text-positive'
                          : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {formatKrw(position.unrealizedPnlKRW)}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                    <Metric label="진입가" value={formatPrice(position.entryPrice)} compact />
                    <Metric label="현재가" value={formatPrice(position.currentPrice)} compact />
                    <Metric label="운용금" value={formatKrw(position.allocatedCapitalKRW)} compact />
                    <Metric
                      label="수익률"
                      value={
                        position.unrealizedReturnPercent == null
                          ? '-'
                          : `${position.unrealizedReturnPercent.toFixed(2)}%`
                      }
                      compact
                    />
                    <Metric label="손절가" value={formatPrice(position.stopPrice)} compact />
                    <Metric label="목표가" value={formatPrice(position.targetPrice)} compact />
                  </div>
                  {position.quoteError && (
                    <p className="mt-2 text-[10px] font-bold text-destructive">
                      시세 오류: {position.quoteError}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void closePosition(position.id)}
                    className="mt-3 w-full rounded-xl border border-destructive/40 py-2.5 text-xs font-black text-destructive disabled:opacity-45"
                  >
                    실제 시세로 가상 청산
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-card-border bg-card p-4">
          <h2 className="text-sm font-black">최근 가상 거래</h2>
          {!status?.trades.length ? (
            <p className="mt-3 text-center text-xs font-bold text-muted-foreground">
              완료된 가상 거래가 없습니다.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {status.trades.slice(0, 10).map((trade) => (
                <div
                  key={trade.id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-background p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black">
                      {trade.symbol} · {trade.direction}
                    </p>
                    <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                      {formatDate(trade.closedAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 text-xs font-black',
                      trade.netPnlKRW >= 0 ? 'text-positive' : 'text-destructive',
                    )}
                  >
                    {formatKrw(trade.netPnlKRW)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="mt-4 text-center text-[10px] font-bold leading-4 text-muted-foreground">
          정책 {status?.policy.version ?? 'shadow-200k-v1'} · 15초마다 시세 갱신
          <br />
          자동 신호 진입과 실제 주문은 다음 단계에서 별도 검증 후 연결합니다.
        </p>
      </div>
      <BottomNav />
    </div>
  );
}

function Metric({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('rounded-xl bg-background', compact ? 'p-2.5' : 'p-3')}>
      <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-black', compact ? 'text-[11px]' : 'text-xs')}>{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-xl border border-card-border bg-background px-2.5 py-2.5 text-xs font-bold outline-none"
      />
    </label>
  );
}
