import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  executionLedgerAttentionEntries,
  getTradeExecutionLedger,
  type TradeExecutionLedgerSnapshot,
} from '@/lib/trade-execution-ledger';

function time(value:string|null) {
  if (!value) return '미확인';
  const at=Date.parse(value);
  if (!Number.isFinite(at)) return '미확인';
  return new Intl.DateTimeFormat('ko-KR',{
    timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
  }).format(new Date(at));
}

function stateLabel(value:string) {
  const labels:Record<string,string>={
    SUBMITTED:'제출 준비',ACCEPTED:'접수',PARTIALLY_FILLED:'부분 체결',FILLED:'체결 완료',
    CANCEL_REQUESTED:'취소 확인 중',CANCELED:'취소',REJECTED:'거절',EXPIRED:'만료',RECOVERY_REQUIRED:'복구 확인 필요',
  };
  return labels[value] ?? value;
}

function truthLabel(value:string) {
  return value === 'RECONCILING' ? '대조 중'
    : value === 'MANUAL_REVIEW' ? '수동 확인'
      : value === 'TERMINAL' ? '종료'
        : '안정';
}

export function JournalExecutionLedgerTimeline() {
  const [data,setData]=useState<TradeExecutionLedgerSnapshot|null>(null);
  const [error,setError]=useState('');
  const [version,setVersion]=useState(0);
  const [busy,setBusy]=useState(true);

  useEffect(()=>{
    const controller=new AbortController();
    setBusy(true); setError('');
    void getTradeExecutionLedger(controller.signal)
      .then((value)=>setData(value))
      .catch((reason)=>{
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '주문 실행 원장을 불러오지 못했습니다.');
      })
      .finally(()=>{ if(!controller.signal.aborted) setBusy(false); });
    return ()=>controller.abort();
  },[version]);

  const attention=useMemo(()=>data ? executionLedgerAttentionEntries(data) : [],[data]);
  return <section className="rounded-2xl border border-border bg-card p-4" data-testid="journal-execution-ledger-timeline">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[10px] font-black tracking-[0.16em] text-primary">주문 실행 원장 · 읽기 전용</p>
        <h3 className="mt-1 text-base font-extrabold">체결 전·거절·복구 상태</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
          체결이 없어 일반 거래 통계에 들어가지 않는 주문도 숨기지 않고 표시합니다. 이 영역은 실행 원장을 읽기만 하며 승률·손익·수익성 증거에는 포함하지 않습니다.
        </p>
      </div>
      <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-xs font-bold disabled:opacity-50"
        disabled={busy} onClick={()=>setVersion((value)=>value+1)} data-testid="journal-execution-ledger-refresh">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}새로고침
      </button>
    </div>

    {data ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] text-muted-foreground">전체 주문</p><p className="mt-1 font-black">{data.summary.total}건</p></div>
      <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] text-muted-foreground">대조/복구</p><p className="mt-1 font-black">{data.summary.reconciling}건</p></div>
      <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] text-muted-foreground">수동 확인</p><p className="mt-1 font-black">{data.summary.manualReview}건</p></div>
      <div className="rounded-xl bg-muted/40 p-3"><p className="text-[10px] text-muted-foreground">제출 결과 미확정</p><p className="mt-1 font-black">{data.summary.unknownSubmission}건</p></div>
    </div> : null}

    {error ? <p role="alert" className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</p> : null}
    {busy && !data ? <div className="mt-3 flex min-h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" aria-label="주문 실행 원장 불러오는 중" /></div> : null}

    {data && attention.length === 0 ? <div className="mt-3 rounded-xl border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
      체결 전·거절·복구 상태로 남아 있는 주문이 없습니다.
    </div> : null}

    {attention.length ? <div className="mt-3 space-y-2" aria-label="체결 전 및 복구 주문 목록">
      {attention.slice(0,20).map((entry)=>{
        const warning=entry.truthPhase === 'RECONCILING' || entry.truthPhase === 'MANUAL_REVIEW' || entry.integrityBlockers.length > 0;
        return <article key={entry.orderId} className="rounded-xl border border-border bg-background p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="break-words text-sm font-black">{entry.symbol ?? '종목 미확인'} · {stateLabel(entry.orderState)}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{entry.exchange.toUpperCase()} · {entry.market ?? '시장 미확인'} · 최근 갱신 {time(entry.updatedAt)}</p>
            </div>
            <span className={`rounded-full border px-2 py-1 text-[10px] font-black ${warning ? 'border-amber-500/30 bg-amber-500/10 text-amber-700' : 'border-border bg-muted/30 text-muted-foreground'}`}>
              {truthLabel(entry.truthPhase)}
            </span>
          </div>
          <div className="mt-2 grid gap-1 text-[10px] text-muted-foreground sm:grid-cols-2">
            <p className="break-all">orderId · {entry.orderId}</p>
            <p className="break-all">planId · {entry.planId}</p>
            <p>체결 {entry.filledQuantity} / 요청 {entry.requestedQuantity ?? '미확인'}</p>
            <p>event {entry.eventCount}건 · 최근 {time(entry.latestEventAt)}</p>
          </div>
          <p className="mt-2 break-all text-xs font-semibold">
            {entry.latestEventReason ?? entry.lastErrorCode ?? '추가 오류 사유 없음'}
          </p>
          {entry.integrityBlockers.length ? <p className="mt-1 break-all text-[10px] text-amber-700">
            정합성 확인 · {entry.integrityBlockers.join(' · ')}
          </p> : null}
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {entry.providerMutationAllowed ? <AlertTriangle className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            providerMutationAllowed=false · safeToResubmit={String(entry.safeToResubmit)}
          </p>
        </article>;
      })}
      {attention.length > 20 ? <p className="text-[10px] text-muted-foreground">최근 상태 20건만 표시 · 전체 {attention.length}건</p> : null}
    </div> : null}
  </section>;
}
