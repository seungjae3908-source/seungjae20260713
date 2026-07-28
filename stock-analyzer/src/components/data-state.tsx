import { Loader2, AlertCircle, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LoadingState({ label = '불러오는 중...' }: { label?: string }) {
  return (
    <div className="mx-auto my-4 flex w-full max-w-md flex-col items-center justify-center gap-3 rounded-3xl border border-card-border bg-card/90 px-5 py-10 text-muted-foreground shadow-sm">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </span>
      <span className="text-center text-xs font-bold">{label}</span>
      <span className="text-center text-[10px] font-semibold text-muted-foreground/70">
        이전 화면은 유지되며 완료되면 자동으로 갱신됩니다.
      </span>
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
    <div className="flex h-full min-h-[240px] flex-1 items-center justify-center px-5 py-24 text-muted-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl border border-card-border bg-card/90 px-5 py-10 shadow-sm">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </span>
        <p className="text-xs font-black text-foreground">화면을 준비하고 있습니다</p>
        <p className="text-center text-[10px] font-semibold leading-4">
          잠시만 기다리면 자동으로 표시됩니다.
        </p>
      </div>
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

export function ErrorState({ code, onRetry }: { code?: string; onRetry?: () => void }) {
  const notFound = code === 'UNKNOWN_TICKER';
  const message =
    (code && ERROR_MESSAGES[code]) ?? '데이터를 불러오지 못했습니다';
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {notFound ? (
        <SearchX className="h-7 w-7 text-muted-foreground" />
      ) : (
        <AlertCircle className="h-7 w-7 text-warning" />
      )}
      <div className="text-sm font-medium">{message}</div>
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
