import { useEffect, useMemo, useRef, useState } from 'react';

export type ScannerApprovalWaitingItem = {
  id: string;
  direction: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  market: string;
  symbol: string;
  timeframe: string;
  signalAt: string;
  expiresAt: string;
  dataState: 'complete' | 'partial' | 'stale' | 'unavailable';
  confidence: number;
  riskScore: number;
  chaseRisk: 'LOW' | 'ELEVATED' | 'UNAVAILABLE';
  state: 'DETECTED' | 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';
  blockReasons: string[];
  orderSubmitted: false;
  exchangeRequestSent: false;
};

type QueueState = 'ready' | 'loading' | 'empty' | 'error' | 'auth-expired';

function formatTime(value: string) {
  if (!Number.isFinite(Date.parse(value))) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function stateLabel(state: ScannerApprovalWaitingItem['state']) {
  return {
    DETECTED: '감지됨', WATCHING: '감시 중', READY_FOR_APPROVAL: '승인 대기',
    WEAKENED: '신호 약화', INVALIDATED: '신호 무효', EXPIRED: '신호 만료',
  }[state];
}

export function TradeApprovalQueue({
  items,
  viewState = 'ready',
}: {
  items: ScannerApprovalWaitingItem[];
  viewState?: QueueState;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const close = () => {
      setSelectedId(null);
      window.setTimeout(() => lastTriggerRef.current?.focus(), 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.history.back();
    };
    window.addEventListener('popstate', close, { once: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('popstate', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [selectedId]);

  function open(item: ScannerApprovalWaitingItem, trigger: HTMLButtonElement) {
    lastTriggerRef.current = trigger;
    window.history.pushState({ scannerApprovalDetail: item.id }, '');
    setSelectedId(item.id);
  }

  if (viewState === 'loading') return <section aria-busy="true" className="rounded-2xl border border-card-border bg-card p-4">승인 대기 정보를 불러오는 중입니다.</section>;
  if (viewState === 'empty') return <section className="rounded-2xl border border-card-border bg-card p-4">승인 대기 신호가 없습니다.</section>;
  if (viewState === 'error') return <section role="alert" className="rounded-2xl border border-destructive/30 bg-card p-4">승인 대기 정보를 불러오지 못했습니다.</section>;
  if (viewState === 'auth-expired') return <section role="alert" className="rounded-2xl border border-warning/30 bg-card p-4">인증이 만료됐습니다. 다시 로그인한 뒤 조회해 주세요.</section>;

  return (
    <section aria-labelledby="approval-waiting-heading" className="space-y-3" data-testid="scanner-approval-waiting">
      <header className="rounded-2xl border border-card-border bg-card p-4">
        <h2 id="approval-waiting-heading" className="text-base font-black">모바일 승인 대기 정보</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">표시 정보는 최종 주문값이 아니며 승인 직전 가격·보유 수량·신호 상태를 서버에서 다시 확인해야 합니다.</p>
      </header>
      {items.map((item) => {
        const blocked = item.state !== 'READY_FOR_APPROVAL'
          || item.dataState !== 'complete'
          || item.chaseRisk !== 'LOW'
          || item.blockReasons.length > 0;
        return (
          <article key={item.id} className="rounded-2xl border border-card-border bg-card p-4" data-testid={`approval-item-${item.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-bold text-muted-foreground">{item.market} · {item.timeframe}</p>
                <h3 className="mt-1 truncate text-lg font-black">{item.symbol} · {item.direction}</h3>
              </div>
              <span className={blocked ? 'rounded-full bg-destructive/10 px-2 py-1 text-xs font-bold text-destructive' : 'rounded-full bg-positive/10 px-2 py-1 text-xs font-bold text-positive'}>
                {stateLabel(item.state)}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl bg-muted p-3"><dt className="text-muted-foreground">신호 시각</dt><dd className="mt-1 font-bold">{formatTime(item.signalAt)}</dd></div>
              <div className="rounded-xl bg-muted p-3"><dt className="text-muted-foreground">만료 시각</dt><dd className="mt-1 font-bold">{formatTime(item.expiresAt)}</dd></div>
              <div className="rounded-xl bg-muted p-3"><dt className="text-muted-foreground">데이터 상태</dt><dd className="mt-1 font-bold">{item.dataState}</dd></div>
              <div className="rounded-xl bg-muted p-3"><dt className="text-muted-foreground">신뢰도</dt><dd className="mt-1 font-bold">{item.confidence}%</dd></div>
              <div className="rounded-xl bg-muted p-3"><dt className="text-muted-foreground">위험점수</dt><dd className="mt-1 font-bold">{item.riskScore}</dd></div>
              <div className="rounded-xl bg-muted p-3"><dt className="text-muted-foreground">추격 위험</dt><dd className="mt-1 font-bold">{item.chaseRisk}</dd></div>
            </dl>
            {blocked ? <p className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{item.blockReasons.join(' · ') || '현재 상태에서는 승인할 수 없습니다.'}</p> : null}
            <button
              type="button"
              onClick={(event) => open(item, event.currentTarget)}
              className="mt-3 min-h-11 w-full rounded-xl border border-card-border px-3 text-sm font-extrabold"
            >
              대기 정보 보기
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">주문 생성 {String(item.orderSubmitted)} · 거래소 요청 {String(item.exchangeRequestSent)}</p>
          </article>
        );
      })}
      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-detail-title"
            className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl"
          >
            <h2 id="approval-detail-title" className="text-lg font-black">{selected.symbol} 승인 대기 상세</h2>
            <p className="mt-2 text-sm">{selected.direction} · {selected.market} · {selected.timeframe}</p>
            <p className="mt-3 rounded-xl bg-muted p-3 text-xs leading-5">가격·보유 수량·신호 상태는 아직 최종 확정이 아닙니다. 이 화면에서는 실제 주문을 실행하지 않습니다.</p>
            <button
              type="button"
              autoFocus
              onClick={() => window.history.back()}
              className="mt-4 min-h-11 w-full rounded-xl bg-primary px-4 text-sm font-extrabold text-primary-foreground"
            >
              닫기
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}
