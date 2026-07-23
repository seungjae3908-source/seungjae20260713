import { Star } from 'lucide-react';
import { useWatchlist } from '@/hooks/use-watchlist';
import { toast } from '@/hooks/use-toast';
import type { WatchlistItem } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

export function FavoriteButton({ item, className }: { item: WatchlistItem; className?: string }) {
  const { isWatchlisted, toggle } = useWatchlist();
  const active = isWatchlisted(item.ticker);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggle(item).catch((error) => toast({
          title: '관심종목 저장 실패',
          description: error instanceof Error ? error.message : '원래 상태로 복구했습니다.',
          variant: 'destructive',
        }));
      }}
      className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full', className)}
      aria-label={`${item.name || item.ticker} 관심종목 ${active ? '해제' : '등록'}`}
      aria-pressed={active}
    >
      <Star className={cn('h-4 w-4', active ? 'fill-warning text-warning' : 'text-muted-foreground')} />
    </button>
  );
}
