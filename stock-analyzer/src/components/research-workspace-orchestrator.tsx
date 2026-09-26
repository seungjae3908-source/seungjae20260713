import { useEffect,useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { parseResearchOrchestratorStatus,RESEARCH_ORCHESTRATOR_STAGE_LABELS,type ResearchOrchestratorUiStatus } from '@/lib/research-orchestrator-status';
type Load={state:'loading'}|{state:'unavailable'}|{state:'ready';data:Extract<ResearchOrchestratorUiStatus,{available:true}>};
export function ResearchWorkspaceOrchestrator({revision}:{revision:number}){
 const [load,setLoad]=useState<Load>({state:'loading'});
 useEffect(()=>{const c=new AbortController();let active=true;setLoad({state:'loading'});const timer=window.setTimeout(()=>{if(active){c.abort();setLoad({state:'unavailable'});}},8000);
  void authorizedFetch('/api/research/video/evidence/workspace/orchestrator',{method:'GET',signal:c.signal,headers:{Accept:'application/json'}})
   .then(async r=>{if(!r.ok)throw new Error('UNAVAILABLE');const x=parseResearchOrchestratorStatus(await r.json());if(!x.available)throw new Error('UNAVAILABLE');return x;})
   .then(data=>{if(active&&!c.signal.aborted)setLoad({state:'ready',data});}).catch(()=>{if(active&&!c.signal.aborted)setLoad({state:'unavailable'});}).finally(()=>window.clearTimeout(timer));
  return()=>{active=false;c.abort();window.clearTimeout(timer);};},[revision]);
 const stages=Object.entries(RESEARCH_ORCHESTRATOR_STAGE_LABELS);
 return <section className="rounded-xl border border-card-border bg-card p-3" data-testid="research-orchestrator-status" aria-label="자동 연구 체인 상태">
  <h3 className="text-sm font-bold">자동 연구 체인</h3>
  <p className="mt-1 text-xs text-muted-foreground">YouTube → Gemini → Groq 반대검토 → 규칙 검사 → 백테스트 → 결과 저장 → 채택 검토</p>
  {load.state==='loading'?<p className="mt-2 text-xs text-muted-foreground">자동 연구 연결 상태를 확인하고 있습니다.</p>:null}
  {load.state==='unavailable'?<p className="mt-2 text-xs text-muted-foreground">오케스트레이터가 아직 활성화되지 않았거나 상태를 읽을 수 없습니다. 완료 0건으로 간주하지 않습니다.</p>:null}
  {load.state==='ready'?<><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{[
   ['실행 중',load.data.totals.processing],['검토 필요',load.data.totals.reviewRequired],['주식 완료',load.data.markets.stockCompleted],['코인 완료',load.data.markets.cryptoCompleted],
  ].map(([k,v])=><div key={String(k)} className="rounded-lg bg-muted/30 p-2"><span className="text-xs text-muted-foreground">{k}</span><strong className="block">{v}</strong></div>)}</div>
  <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{stages.map(([key,label])=><div key={key} className="min-w-0 rounded-lg border border-card-border p-2"><span className="block break-keep text-[11px] text-muted-foreground">{label}</span><strong className="block text-sm">{load.data.stageCounts[key]}</strong></div>)}</div>
  <p className="mt-2 text-xs text-muted-foreground">AI끼리 동의해도 수익성 판정이 아닙니다. 수익·낙폭·비용 숫자는 기존 백테스터 결과만 사용하고 자동 채택은 하지 않습니다.</p></>:null}
 </section>;
}
