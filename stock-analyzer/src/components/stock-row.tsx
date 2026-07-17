import { Link } from 'wouter';
import { Star, ChevronRight } from 'lucide-react';
import { RatingBadge } from '@/components/rating-badge';
import { useWatchlist } from '@/hooks/use-watchlist';
import { formatPrice, formatPercent } from '@/lib/format';
import { changeTone, toneText } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { AssetType, QuoteRow, SearchResult } from '@/lib/api';

const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  STOCK: '',
  ETF: 'ETF',
  ETN: 'ETN',
  LEVERAGED_ETF: '레버리지 ETF',
  INVERSE_ETF: '인버스 ETF',
  LEVERAGED_ETN: '레버리지 ETN',
  INVERSE_ETN: '인버스 ETN',
  REIT: '리츠',
  ADR: 'ADR',
};

export function StockRow({ stock, rank }: { stock: QuoteRow; rank?: number }) {
  const { isWatchlisted, toggle } = useWatchlist();
  const watched = isWatchlisted(stock.ticker);
  const tone = changeTone(stock.changePercent);
  return (
    <Link
      href={`/stock/${stock.ticker}`}
      className="flex items-center gap-3 rounded-xl border border-card-border bg-card px-3 py-3 transition-colors hover:border-border active:scale-[0.99]"
    >
      {rank != null ? (
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-bold tabular-nums',
            rank <= 3
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
          aria-label={`${rank}위`}
        >
          {rank}
        </span>
      ) : null}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle(stock.ticker);
        }}
        className="shrink-0"
        aria-label="관심 종목 토글"
      >
        <Star className={cn('h-5 w-5', watched ? 'fill-warning text-warning' : 'text-muted-foreground')} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{stock.name}</div>
        <div className="text-xs text-muted-foreground">{stock.ticker}</div>
        {stock.reason ? (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{stock.reason}</div>
        ) : null}
      </div>
      <div className="flex flex-col items-end">
        <div className="font-mono text-sm tabular-nums">{formatPrice(stock.price, stock.currency)}</div>
        <div className={cn('font-mono text-xs tabular-nums', toneText(tone))}>
          {formatPercent(stock.changePercent)}
        </div>
      </div>
      <RatingBadge rating={stock.rating.rating} />
    </Link>
  );
}

export function SearchRow({ stock }: { stock: SearchResult }) {
  return (
    <Link
      href={`/stock/${stock.ticker}`}
      className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-0 hover:bg-card"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{stock.name}</span>
          {stock.assetType && ASSET_TYPE_LABEL[stock.assetType] ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {ASSET_TYPE_LABEL[stock.assetType]}
            </span>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {stock.ticker} · {stock.market === 'KR' ? '한국' : '미국'}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}
