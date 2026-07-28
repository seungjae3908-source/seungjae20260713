import { useEffect, useMemo, useState } from 'react';
import { Activity, Search } from 'lucide-react';
import { ChartRelayAutoOrderApproval } from '@/components/chart-relay-auto-order-approval';
import {
  useRealtimeChart,
  type RealtimeChartAsset,
} from '@/hooks/use-realtime-chart';
import { cn } from '@/lib/utils';

type AssetOption = {
  key: RealtimeChartAsset;
  label: string;
};

const ASSETS: AssetOption[] = [
  { key: 'stockKR', label: '국내주식' },
  { key: 'stockUS', label: '해외주식' },
  { key: 'coinSpot', label: '코인 현물' },
  { key: 'coinFutures', label: '코인 선물' },
];

const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D'] as const;
const STORAGE_KEY = 'admin-auto-trade-monitor-selection.v1';

type SavedSelection = {
  asset?: RealtimeChartAsset;
  symbol?: string;
  interval?: string;
};

function loadSelection(): SavedSelection {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as SavedSelection;
  } catch {
    return {};
  }
}

export function AdminAutoTradeMonitor() {
  const saved = useMemo(loadSelection, []);
  const [asset, setAsset] = useState<RealtimeChartAsset>(() =>
    ASSETS.some((item) => item.key === saved.asset) ? saved.asset! : 'stockKR',
  );
  const [symbolInput, setSymbolInput] = useState(() => String(saved.symbol ?? ''));
  const [interval, setInterval] = useState(() =>
    INTERVALS.includes(saved.interval as (typeof INTERVALS)[number])
      ? saved.interval!
      : '5m',
  );

  const symbol = symbolInput.trim().toUpperCase();
  const realtime = useRealtimeChart({
    asset,
    symbol,
    interval,
    enabled: Boolean(symbol),
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ asset, symbol, interval }),
    );
  }, [asset, interval, symbol]);

  const statusLabel = !symbol
    ? '감시할 종목을 입력하세요.'
    : realtime.status === 'live'
      ? `실시간 연결 · ${realtime.provider ?? '공급자 확인 중'}`
      : realtime.status === 'connecting' || realtime.status === 'reconnecting'
        ? '실시간 데이터를 연결하는 중입니다.'
        : realtime.status === 'error'
          ? realtime.error ?? '실시간 연결을 확인해 주세요.'
          : '실시간 데이터 대기 중입니다.';

  return (
    <div className="space-y-3">
      <section className="rounded-3xl border border-card-border bg-card p-4 text-center shadow-sm">
        <div className="flex items-center justify-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-black">자동매매 실제 감시 대상</h2>
        </div>
        <p className="mt-1 break-keep text-[10px] font-bold leading-4 text-muted-foreground">
          실제 가격·기술신호를 감시하지만 주문은 확인 팝업의 실행 버튼을 직접 눌러야만 전송됩니다.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {ASSETS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setAsset(item.key)}
              className={cn(
                'h-10 rounded-xl border px-2 text-center text-xs font-black',
                asset === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="relative mt-3 flex h-11 items-center rounded-xl border border-card-border bg-background px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value.toUpperCase())}
            inputMode="search"
            aria-label="자동매매 감시 종목"
            className="min-w-0 flex-1 bg-transparent px-2 text-center text-sm font-black uppercase outline-none"
          />
          {symbolInput && (
            <button
              type="button"
              onClick={() => setSymbolInput('')}
              aria-label="종목 입력값 삭제"
              className="h-8 w-8 rounded-full text-sm font-black text-muted-foreground"
            >
              ×
            </button>
          )}
        </label>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {INTERVALS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setInterval(item)}
              className={cn(
                'h-9 rounded-lg border text-[10px] font-black',
                interval === item
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              {item}
            </button>
          ))}
        </div>

        <p
          className={cn(
            'mt-3 rounded-xl bg-secondary/70 px-3 py-2 text-center text-[10px] font-bold leading-4 text-muted-foreground',
            realtime.status === 'error' && 'bg-destructive/10 text-destructive',
          )}
        >
          {statusLabel}
        </p>
      </section>

      {symbol && (
        <ChartRelayAutoOrderApproval
          plan={(realtime.snapshot?.plan ?? null) as Record<string, unknown> | null}
          candles={(realtime.snapshot?.candles ?? []) as Record<string, unknown>[]}
          asset={asset}
          symbol={symbol}
          interval={interval}
        />
      )}
    </div>
  );
}
