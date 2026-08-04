import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

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

export function ScannerReadinessStatus() {
  const queryClient = useQueryClient();
  const [, setRevision] = useState(0);

  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event?.query && isScannerQuery(event.query.queryKey)) {
      setRevision((value) => value + 1);
    }
  }), [queryClient]);

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

  const retry = () => queryClient.refetchQueries({
    queryKey: ['scan'],
    type: 'active',
  });

  return (
    <div
      data-testid="scanner-readiness-status"
      className="pointer-events-none absolute right-3 top-3 z-50 max-w-[min(92vw,360px)]"
    >
      {loading && (
        <div data-testid="scanner-loading" className="rounded-2xl border border-card-border bg-card/95 px-3 py-2 text-xs font-extrabold shadow-lg backdrop-blur">
          조건검색 데이터 확인 중
        </div>
      )}
      {providerError && (
        <div data-testid="scanner-provider-error" className="pointer-events-auto rounded-2xl border border-destructive/40 bg-card/95 p-3 shadow-lg backdrop-blur">
          <p className="text-xs font-extrabold text-destructive">데이터 공급자 오류</p>
          <p className="mt-1 break-keep text-[11px] leading-4 text-muted-foreground">빈 결과로 처리하지 않았습니다. 공급자 상태를 확인한 뒤 다시 시도하세요.</p>
          <button type="button" onClick={() => void retry()} className="mt-2 rounded-full bg-primary px-3 py-1.5 text-[11px] font-extrabold text-primary-foreground">다시 시도</button>
        </div>
      )}
      {partial && (
        <div data-testid="scanner-partial" className="rounded-2xl border border-amber-500/50 bg-card/95 p-3 shadow-lg backdrop-blur">
          <p className="text-xs font-extrabold text-amber-700">일부 데이터 지연 · 부분 결과</p>
          <p className="mt-1 break-keep text-[11px] leading-4 text-muted-foreground">{data?.message || '제한시간 안에 완료된 신뢰 가능한 결과만 표시합니다.'}</p>
          <p className="mt-1 text-[10px] font-bold text-muted-foreground">
            완료 {Number(data?.completedCount ?? 0)}/{Number(data?.requestedCount ?? 0)} · timeout {Number(data?.timeoutCount ?? 0)} · 공급자 오류 {Number(data?.providerErrorCount ?? 0)} · {Number(data?.elapsedMs ?? 0)}ms
          </p>
        </div>
      )}
      {empty && (
        <div data-testid="scanner-empty" className="rounded-2xl border border-card-border bg-card/95 px-3 py-2 text-xs font-extrabold shadow-lg backdrop-blur">
          정상 완료 · 조건 일치 종목 0개
        </div>
      )}
      {success && (
        <div data-testid="scanner-success" className="rounded-2xl border border-card-border bg-card/95 px-3 py-2 text-xs font-extrabold shadow-lg backdrop-blur">
          검색 완료 · {cards.length}개 종목
        </div>
      )}
    </div>
  );
}
