import { useEffect, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { parseResearchWorkerStatus, type ResearchWorkerUiStatus } from '@/lib/research-worker-status';
const labels={ACTIVE:'작업자 신호 확인',STALE:'작업자 신호 만료',NOT_RUNNING:'아직 실행되지 않음',UNKNOWN:'상태 확인 필요'};
type Load={state:'loading'}|{state:'unavailable'}|{state:'ready';data:Extract<ResearchWorkerUiStatus,{available:true}>};
export function ResearchWorkspaceWorker({revision}:{revision:number}){
 const [load,setLoad]=useState<Load>({state:'loading'});
 useEffect(()=>{const c=new AbortController();let active=true;setLoad({state:'loading'});const timer=window.setTimeout(()=>{if(active){c.abort();setLoad({state:'unavailable'});}},8000);
  void authorizedFetch('/api/research/video/evidence/workspace/worker',{method:'GET',signal:c.signal,headers:{Accept:'application/json'}})
   .then(async r=>{if(!r.ok)throw new Error('UNAVAILABLE');const x=parseResearchWorkerStatus(await r.json());if(!x.available)throw new Error('UNAVAILABLE');return x;})
   .then(data=>{if(active&&!c.signal.aborted)setLoad({state:'ready',data});}).catch(()=>{if(active&&!c.signal.aborted)setLoad({state:'unavailable'});}).finally(()=>window.clearTimeout(timer));
  return()=>{active=false;c.abort();window.clearTimeout(timer);};},[revision]);
 return <section className="rounded-xl border border-card-border bg-card p-3" data-testid="research-worker-status" aria-label="24시간 연구 작업자 상태">
  <h3 className="text-sm font-bold">24시간 연구 작업자</h3>
  {load.state==='loading'?<p className="mt-2 text-xs text-muted-foreground">작업 상태를 확인하고 있습니다.</p>:null}
  {load.state==='unavailable'?<p className="mt-2 text-xs text-muted-foreground">작업 저장소가 아직 활성화되지 않았거나 조회할 수 없습니다. 0건으로 간주하지 않습니다.</p>:null}
  {load.state==='ready'?<><p className="mt-2 text-sm font-semibold">{labels[load.data.workerState]}</p>
   <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">{[
    ['대기',load.data.counts.queued],['실행',load.data.counts.running],['완료',load.data.counts.succeeded],['실패',load.data.counts.failed],['확인 필요',load.data.counts.blocked],
   ].map(([k,v])=><div key={String(k)} className="rounded-lg bg-muted/30 p-2"><span className="text-xs text-muted-foreground">{k}</span><strong className="block">{v}</strong></div>)}</div>
   <p className="mt-2 text-xs text-muted-foreground">코드는 준비되어도 자동 활성화는 별도 단계입니다. 외부 호출 예약 뒤 중단된 작업은 자동 재시도하지 않습니다.</p></>:null}
 </section>;
}
