import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

type ScannerResult = {
  cards?: unknown[];
  partial?: boolean;
  timedOut?: boolean;
  completedCount?: number;
  requestedCount?: number;
  providerErrorCount?: number;
  timeoutCount?: number;
  elapsedMs?: number;
  message?: string;
  dataState?: string;
};

function isScannerQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'scan';
}

function countText(visibleCount: number, requestedCount: number) {
  return requestedCount > 0 ? `${visibleCount}/${requestedCount}` : `${visibleCount}개`;
}

export function ScannerReadinessStatus() {
  const queryClient = useQueryClient();
  const [, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let scheduled = false;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!event?.query || !isScannerQuery(event.query.queryKey) || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) setRevision((value) => value + 1);
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

  const candidates = queryClient.getQueryCache().findAll({ queryKey: ['scan'] });
  const query = [...candidates].sort((left, right) => {
    const leftTime = Math.max(left.state.dataUpdatedAt, left.state.errorUpdatedAt);
    const rightTime = Math.max(right.state.dataUpdatedAt, right.state.errorUpdatedAt);
    return rightTime - leftTime;
  })[0];

  const data = query?.state.data as ScannerResult | undefined;
  const loading = !query || (query.state.status === 'pending' && query.state.fetchStatus === 'fetching');
  const providerError = query?.state.status === 'error';
  const partial = query?.state.status === 'success' && data?.partial === true;
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  const empty = query?.state.status === 'success' && !partial && cards.length === 0;
  const success = query?.state.status === 'success' && !partial && cards.length > 0;
  const requestedCount = Number(data?.requestedCount ?? 0);
  const completedCount = Number(data?.completedCount ?? cards.length);
  const providerErrorCount = Number(data?.providerErrorCount ?? 0);
  const updatedAt = query?.state.dataUpdatedAt
    ? new Date(query.state.dataUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : null;

  const retry = () => queryClient.refetchQueries({
    queryKey: ['scan'],
    type: 'active',
  });

  return (
    <div data-testid="scanner-readiness-status" className="shrink-0 border-b border-card-border bg-background px-3 py-2 sm:px-4">
      {loading ? (
        <div data-testid="scanner-loading" className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border bg-card px-3 text-xs font-extrabold">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          최신 검색 결과를 준비하고 있습니다.
        </div>
      ) : null}

      {providerError ? (
        <div data-testid="scanner-provider-error" className="flex min-h-11 items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 truncate text-xs font-extrabold text-destructive">데이터 공급자 연결을 확인해 주세요.</p>
          <button type="button" onClick={() => void retry()} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-destructive/30 px-2.5 text-[11px] font-black">
            <RefreshCw className="h-3.5 w-3.5" />다시 시도
          </button>
        </div>
      ) : null}

      {partial ? (
        <details data-testid="scanner-partial" className="group rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 truncate text-xs font-black text-amber-500">부분 결과 {countText(cards.length, requestedCount)}</span>
            <button
              type="button"
              onClick={(event) => { event.preventDefault(); void retry(); }}
              className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-amber-500/30 px-2.5 text-[11px] font-black text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />재시도
            </button>
          </summary>
          <div className="mt-2 border-t border-amber-500/20 pt-2 text-[11px] font-medium leading-5 text-muted-foreground">
            <p>{data?.message || '확인된 신뢰 가능한 후보를 먼저 표시하고 있습니다.'}</p>
            <p className="mt-1">확인 {completedCount || cards.length} · 표시 {cards.length}{providerErrorCount > 0 ? ` · 공급자 오류 ${providerErrorCount}` : ''}{updatedAt ? ` · 갱신 ${updatedAt}` : ''}</p>
          </div>
        </details>
      ) : null}

      {empty ? (
        <div data-testid="scanner-empty" className="flex min-h-11 items-center gap-2 rounded-xl border border-card-border bg-card px-3 text-xs font-extrabold">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />정상 완료 · 현재 조건과 일치하는 종목이 없습니다.
        </div>
      ) : null}

      {success ? (
        <div data-testid="scanner-success" className="flex min-h-11 items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-extrabold">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />검색 완료 · {cards.length}개 후보
        </div>
      ) : null}
    </div>
  );
}
