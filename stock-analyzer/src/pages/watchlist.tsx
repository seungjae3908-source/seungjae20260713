import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Star, TrendingDown, TrendingUp } from 'lucide-react';
import { useQuotes } from '@/hooks/use-stock-data';
import { BottomNav } from '@/components/bottom-nav';
import { LoadingState } from '@/components/data-state';
import {
  classifyStock,
  stockClassBadgeClass,
  type StockGrade,
} from '@/lib/stock-classifier';
import {
  displayStockName,
  formatAppPercent,
  formatAppPrice,
  readWatchlistItems,
  setWatchlistTargetPrice,
  toggleWatchlistItem,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

export default function WatchlistPage() {
  const [, navigate] = useLocation();
  const [items, setItems] = useState<WatchlistItem[]>(() =>
    readWatchlistItems(),
  );

  const tickers = useMemo(() => items.map((item) => item.ticker), [items]);
  const { data, isLoading } = useQuotes(tickers);

  useEffect(() => {
    const refresh = () => setItems(readWatchlistItems());

    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);

    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const rows = useMemo(() => {
    const quoteMap = new Map(
      (data?.quotes ?? []).map((quote) => [quote.ticker, quote]),
    );

    return items.map((item) => ({
      ...item,
      ...(quoteMap.get(item.ticker) as AnyObj | undefined),
    }));
  }, [data?.quotes, items]);

  const remove = (
    event: MouseEvent<HTMLButtonElement>,
    row: WatchlistItem,
  ) => {
    event.stopPropagation();
    toggleWatchlistItem(row);
    setItems(readWatchlistItems());
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
        <h1 className="text-xl font-extrabold">관심종목</h1>

        <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
          ☆/★로 추가한 종목이 여기에 자동으로 연동됩니다.
        </p>
      </header>

      <main className="flex-1 overflow-y-auto p-3 pb-24">
        {items.length === 0 ? (
          <EmptyState />
        ) : isLoading ? (
          <LoadingState label="관심종목 불러오는 중..." />
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <WatchCard
                key={row.ticker}
                row={row}
                onOpen={() =>
                  navigate(
                    `/stock/${row.ticker}?back=${encodeURIComponent(
                      '/watchlist',
                    )}`,
                  )
                }
                onRemove={remove}
              />
            ))}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Star className="h-8 w-8 text-muted-foreground" />

      <p className="break-keep text-sm leading-relaxed text-muted-foreground">
        관심종목이 없습니다.
      </p>

      <Link
        href="/search"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        종목 찾기
      </Link>
    </div>
  );
}

function WatchCard({
  row,
  onOpen,
  onRemove,
}: {
  row: WatchlistItem & AnyObj;
  onOpen: () => void;
  onRemove: (
    event: MouseEvent<HTMLButtonElement>,
    row: WatchlistItem,
  ) => void;
}) {
  const market = row.market === 'US' ? 'US' : 'KR';
  const currency = row.currency === 'USD' ? 'USD' : 'KRW';
  const name = displayStockName(row.ticker, row.name, market);
  const positive = (row.changePercent ?? 0) >= 0;

  const classification = classifyStock({
    ...row,
    aiScore: row.aiScore ?? row.rating?.score,
    changePercent: row.changePercent,
  });

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
      }}
      className="cursor-pointer rounded-3xl border border-card-border bg-card p-4 shadow-sm transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-keep text-base font-extrabold leading-relaxed">
            {name}
          </h2>

          <p className="mt-0.5 text-xs font-bold text-muted-foreground">
            {market === 'US' ? `티커 ${row.ticker}` : row.ticker}
          </p>
        </div>

        <button
          type="button"
          onClick={(event) => onRemove(event, row)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-warning bg-warning/10 text-warning"
          aria-label="관심종목 삭제"
        >
          <Star className="h-5 w-5" fill="currentColor" />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl bg-secondary/70 p-2">
          <p className="text-[11px] text-muted-foreground">현재가</p>

          <p className="mt-1 text-sm font-extrabold">
            {formatAppPrice(row.price, currency)}
          </p>
        </div>

        <div className="rounded-2xl bg-secondary/70 p-2">
          <p className="text-[11px] text-muted-foreground">등락률</p>

          <p
            className={cn(
              'mt-1 flex items-center justify-center gap-1 text-sm font-extrabold',
              positive ? 'text-positive' : 'text-destructive',
            )}
          >
            {positive ? (
              <TrendingUp className="h-3.5 w-3.5" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5" />
            )}

            {formatAppPercent(row.changePercent)}
          </p>
        </div>

        <div
          className={cn(
            'rounded-2xl border p-2',
            stockClassBadgeClass(
              (row as AnyObj).grade?.label ?? classification.label,
            ),
          )}
        >
          <p className="text-[11px]">분류</p>

          <p className="mt-1 text-sm font-extrabold">
            {(row as AnyObj).grade?.label ?? classification.label}
          </p>
        </div>
      </div>

      <TargetPriceRow row={row} />

      <p className="mt-3 break-keep rounded-2xl bg-secondary/70 p-3 text-xs leading-relaxed text-muted-foreground">
        {classification.reason}
      </p>
    </article>
  );
}

function TargetPriceRow({ row }: { row: WatchlistItem & AnyObj }) {
  const currency = row.currency === 'USD' ? 'USD' : 'KRW';
  const target = typeof row.targetPrice === 'number' ? row.targetPrice : null;
  const [value, setValue] = useState<string>(target != null ? String(target) : '');

  useEffect(() => {
    setValue(target != null ? String(target) : '');
  }, [target]);

  const price = typeof row.price === 'number' ? row.price : null;
  const gap =
    target != null && price != null && price > 0
      ? ((target - price) / price) * 100
      : null;

  const save = () => {
    const parsed = Number(value.replace(/,/g, '').trim());
    setWatchlistTargetPrice(
      row.ticker,
      Number.isFinite(parsed) && parsed > 0 ? parsed : null,
    );
  };

  return (
    <div
      className="mt-3 flex items-center gap-2 rounded-2xl bg-secondary/70 px-3 py-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="presentation"
    >
      <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
        목표가
      </span>

      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
        }}
        placeholder="미설정"
        aria-label={`${row.ticker} 목표가`}
        className="min-w-0 flex-1 bg-transparent text-sm font-extrabold outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />

      {gap != null && (
        <span
          className={cn(
            'shrink-0 text-[11px] font-bold',
            gap <= 0 ? 'text-positive' : 'text-muted-foreground',
          )}
        >
          {gap <= 0 ? '목표 달성!' : `목표까지 +${gap.toFixed(1)}%`}
        </span>
      )}

      <button
        type="button"
        onClick={save}
        className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-xs font-bold text-primary-foreground"
      >
        저장
      </button>

      {target != null && (
        <button
          type="button"
          onClick={() => {
            setValue('');
            setWatchlistTargetPrice(row.ticker, null);
          }}
          className="shrink-0 rounded-lg border border-card-border px-2 py-1 text-xs text-muted-foreground"
          aria-label="목표가 삭제"
        >
          지우기
        </button>
      )}
    </div>
  );
}