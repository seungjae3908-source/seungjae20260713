import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, SearchX, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSafeErrorDiagnostics, readPublicDeploySha } from '@/lib/safe-error-diagnostics';
import { describeError } from '@/lib/error-reason';

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
    <div
      data-testid="page-fallback"
      role="status"
      aria-busy="true"
      aria-label="화면을 불러오는 중"
      className="flex-1 p-4 sm:p-6"
    >
      <span className="sr-only">화면을 불러오는 중입니다.</span>
      <div aria-hidden="true" className="mx-auto w-full max-w-7xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-2/3" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-2xl sm:h-96" />
      </div>
    </div>
  );
}

type ErrorStateProps = {
  code?: string;
  message?: string;
  provider?: string;
  occurredAt?: string;
  onRetry?: () => void;
};

export function ErrorState({ code, message, provider, occurredAt: providedOccurredAt, onRetry }: ErrorStateProps) {
  const notFound = code === 'UNKNOWN_TICKER';
  // Always explain what failed, why, and what to do — never a bare code.
  const described = describeError(code ?? null, { message });
  const resolvedMessage = described.title;
  const [occurredAt, setOccurredAt] = useState(() => providedOccurredAt ?? new Date().toISOString());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setOccurredAt(providedOccurredAt ?? new Date().toISOString());
    setCopyState('idle');
  }, [code, message, provider, providedOccurredAt]);

  const copyDiagnostics = async () => {
    const appSha = await readPublicDeploySha();
    const diagnostics = formatSafeErrorDiagnostics({
      pathname: window.location.pathname,
      appSha,
      provider,
      errorCode: code,
      occurredAt,
    });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(diagnostics);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div data-testid="error-state" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {notFound ? (
        <SearchX className="h-7 w-7 text-muted-foreground" />
      ) : (
        <AlertCircle className="h-7 w-7 text-warning" />
      )}
      <div className="text-sm font-medium" data-error-code={described.code ?? undefined}>{resolvedMessage}</div>
      <p className="max-w-md break-keep px-4 text-xs leading-5 text-muted-foreground">{described.reason} {described.action}</p>
      {(onRetry || !notFound) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-11 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground"
            >
              다시 시도
            </button>
          )}
          {!notFound && (
            <button
              aria-label="안전한 오류 진단 정보 복사"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground"
              data-testid="copy-error-diagnostics"
              onClick={() => void copyDiagnostics()}
              type="button"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {copyState === 'copied' ? '복사됨' : copyState === 'failed' ? '복사 실패' : '오류 정보 복사'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
