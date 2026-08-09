import { Loader2, AlertCircle, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LoadingState({ label = '불러오는 중...' }: { label?: string }) {
  return (
    <div data-testid="loading-state" className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

// Lightweight skeleton primitive — a subtle pulsing block used to reserve
// layout while data loads, so the user never sees a blank screen.
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted/40', className)} />;
}

// A generic list of card-shaped skeletons for movers / alerts / undervalued.
export function CardListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-card-border bg-card p-3.5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-10 w-10 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

// Full-page fallback for lazily-loaded routes (Suspense boundary).
export function PageFallback() {
  return (
    <div data-testid="page-fallback" className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}

const ERROR_MESSAGES: Record<string, string> = {
  UNKNOWN_TICKER: '종목을 찾을 수 없습니다',
  NOT_CONFIGURED: '데이터 제공에 필요한 API 키가 설정되지 않았습니다',
  RATE_LIMITED: '요청이 많아 잠시 후 다시 시도해 주세요',
  UNAVAILABLE: '해당 종목의 데이터가 없습니다',
  UPSTREAM_ERROR: '데이터 제공처 응답 오류로 불러오지 못했습니다',
};

export function ErrorState({ code, message, onRetry }: { code?: string; message?: string; onRetry?: () => void }) {
  const notFound = code === 'UNKNOWN_TICKER';
  const resolvedMessage = message
    ?? (code && ERROR_MESSAGES[code])
    ?? '데이터를 불러오지 못했습니다';
  return (
    <div data-testid="error-state" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {notFound ? (
        <SearchX className="h-7 w-7 text-muted-foreground" />
      ) : (
        <AlertCircle className="h-7 w-7 text-warning" />
      )}
      <div className="text-sm font-medium">{resolvedMessage}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          다시 시도
        </button>
      )}
    </div>
  );
}
