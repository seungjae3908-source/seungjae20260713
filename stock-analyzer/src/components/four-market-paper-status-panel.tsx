import { useEffect, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { PAPER_FOUR_MARKET_KEYS, parseFourPaperReadOnlyStatus,
  type FourPaperReadOnlyStatus } from '@/lib/four-market-paper-status';

const formatWon=(v:number)=>Math.round(v).toLocaleString('ko-KR')+'원';

/** GET-only automatic Paper readiness, on the Paper page only.
 * No LIVE component, POST/bootstrap, policy edit, or exchange API.
 */
export function FourMarketPaperStatusPanel(){
  const auth=useAuth();
  const userId=auth.user?.id ?? auth.profile?.id ?? '';
  const authorized=Boolean(userId && auth.can('canAccessJournalSync'));
  const [status,setStatus]=useState<FourPaperReadOnlyStatus|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!authorized){setStatus(null);setError(false);setLoading(false);return;}
    const controller=new AbortController();
    setLoading(true);
    let active=true;
    void (async()=>{
      try{
        const response=await authorizedFetch('/api/paper-journal/four-market/status',{signal:controller.signal});
        const data:unknown=await response.json().catch(()=>null);
        if(!response.ok)throw new Error('PAPER_FOUR_MARKET_STATUS_UNAVAILABLE');
        const verified=parseFourPaperReadOnlyStatus(data);
        if(active){setStatus(verified);setError(false);}
      }catch{
        if(active){setStatus(null);setError(true);}
      }finally{if(active)setLoading(false);}
    })();
    return()=>{active=false;controller.abort();};
  },[userId,authorized,revision]);
  const stateLabel=!authorized?'일지 조회 권한 필요':loading?'조회 중'
    :error?'읽기 전용 검증 실패':!status?'확인 필요'
      :!status.rlsGuardReady?'회원 DB 보호 미적용'
        :status.ready?'4시장 독립계좌 검증됨':'모의계좌·이력 준비 필요';
  return <section className="shrink-0 border-b border-card-border bg-card px-3 py-2 text-xs"
    data-testid="paper-four-market-readonly-summary">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <strong>자동모의매매 4시장 계좌</strong>
        <span className="text-muted-foreground">{stateLabel}</span>
      </div>
      <button type="button" className="rounded-lg border border-card-border px-3 py-1.5"
        data-testid="paper-four-market-refresh" disabled={!authorized||loading}
        onClick={()=>setRevision(v=>v+1)}>상태 재확인</button>
    </div>
    <details className="mt-1" data-testid="paper-four-market-details">
      <summary className="cursor-pointer py-1 text-muted-foreground">시장별 가상자본·정산·DB 보호 증거 보기 (조회 전용)</summary>
      {status ? <div className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-4">
        {PAPER_FOUR_MARKET_KEYS.map(({key,label})=>{
          const balance=status.marketCapital[key];
          return <div key={key} className="rounded-lg border border-card-border p-2">
            <strong>{label}</strong>
            <p>기준 가상자본 {formatWon(1_000_000)}</p>
            <p>{balance.settlementReady
              ? '검증 운용금 '+formatWon(balance.operatingCapitalKrw!)
              : '정산 증거 미확인'}</p>
            <p>{balance.settlementReady
              ? '내부 예비금 '+formatWon(balance.reserveKrw!)
              : '예비금 미확정'}</p>
            <p>{balance.newEntriesAllowed?'모의 신규진입 증거 통과':'모의 신규진입 차단'}</p>
          </div>;
        })}
      </div> : <p className="pt-2 text-muted-foreground">
        사용자별 가상계좌 원장 증거를 확인하지 못했습니다. 원금을 현재 수익으로 표시하지 않습니다.
      </p>}
      {status?.creationBlockers.length ?
        <p className="mt-2 text-amber-700">계좌 준비 차단: {status.creationBlockers.join(' · ')}</p> : null}
      <p className="mt-2 text-muted-foreground">
        조회 전용입니다. LIVE/AUTO·실계좌·실주문·모의계좌 생성 상태를 변경하지 않습니다.
      </p>
    </details>
  </section>;
}
