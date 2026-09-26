import { useEffect, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { parseResearchProviderStatus, type ProviderStatus } from '@/lib/research-provider-status';
const labels={youtube:'YouTube',gemini:'Gemini',groq:'Groq'};
const stateLabels={PRESENT:'설정 확인',MISSING_IN_SELECTED_RUNTIME:'현재 실행환경에서 미확인',CONFLICT:'설정 충돌',INVALID:'설정 형식 확인 필요'};
const modelLabels={NOT_APPLICABLE:'모델 해당 없음',DEFAULT_NOT_RESOLVED:'기본 모델 미확정',EXPLICIT:'모델 명시됨',INVALID:'모델 설정 오류',CONFLICT:'모델 설정 충돌'};
type Load={state:'loading'}|{state:'unavailable'}|{state:'ready';data:ProviderStatus};
export function ResearchWorkspaceProviders({revision}:{revision:number}) {
  const [load,setLoad]=useState<Load>({state:'loading'});
  useEffect(()=>{
    const c=new AbortController();let active=true;
    setLoad({state:'loading'});
    const timer=window.setTimeout(()=>{if(active){c.abort();setLoad({state:'unavailable'});}},8000);
    void authorizedFetch('/api/research/video/evidence/workspace/providers',{method:'GET',signal:c.signal,headers:{Accept:'application/json'}})
      .then(async r=>{if(!r.ok)throw new Error('UNAVAILABLE');return parseResearchProviderStatus(await r.json());})
      .then(data=>{if(active&&!c.signal.aborted)setLoad({state:'ready',data});})
      .catch(()=>{if(active&&!c.signal.aborted)setLoad({state:'unavailable'});})
      .finally(()=>window.clearTimeout(timer));
    return()=>{active=false;c.abort();window.clearTimeout(timer);};
  },[revision]);
  return <section className="rounded-xl border border-card-border bg-card p-3" data-testid="research-provider-status" aria-label="기존 연구 연결 상태">
    <h3 className="text-sm font-bold">기존 연구 연결</h3>
    {load.state==='loading'?<p className="mt-2 text-xs text-muted-foreground">서버 설정을 확인하고 있습니다.</p>:null}
    {load.state==='unavailable'?<p className="mt-2 text-xs text-muted-foreground">연결 상태를 조회하지 못했습니다. 미연결로 단정하지 않습니다.</p>:null}
    {load.state==='ready'?<>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">{load.data.providers.map(p=><div key={p.provider} data-provider={p.provider} className="min-w-0 rounded-lg bg-muted/30 p-2 text-sm"><strong>{labels[p.provider]}</strong><p className="mt-1 break-words text-xs">{stateLabels[p.credentialState]}</p><p className="mt-1 break-words text-xs text-muted-foreground">{modelLabels[p.modelState]}</p><p className="mt-1 break-words text-xs font-medium text-warning">{p.callVerified?'실제 호출 확인':'실제 호출 미검증'}</p></div>)}</div>
      {load.data.unmappedGenericCredential?<p className="mt-2 text-xs">공통 AI 설정의 제공자 확인이 필요합니다.</p>:null}
      <p className="mt-2 text-xs text-muted-foreground">설정 상태와 실제 호출 검증은 별개입니다. 상태 조회 자체는 provider를 호출하거나 quota를 소비하지 않습니다.</p>
    </>:null}
  </section>;
}
