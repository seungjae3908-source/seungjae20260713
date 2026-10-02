import { useEffect,useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { parseResearchOneShotReview,type ResearchOneShotReviewUi } from '@/lib/research-one-shot-review';

type Load={state:'loading'}|{state:'unavailable'}|{state:'ready';data:Extract<ResearchOneShotReviewUi,{available:true}>};
const verdictLabel:Record<string,string>={
 ACCEPT_AS_CLAIM:'구조상 검토 가능 · 사실 인증 아님',
 CHALLENGE:'반론·충돌 있음',
 AMBIGUOUS:'모호함',
};
const kindLabel:Record<string,string>={
 ENTRY:'진입',EXIT:'청산',STOP_LOSS:'손절',POSITION_SIZING:'포지션 크기',EXECUTION_ASSUMPTION:'실행 가정',CONTEXT:'문맥',
};
export function ResearchWorkspaceOneShotReview({revision}:{revision:number}){
 const [load,setLoad]=useState<Load>({state:'loading'});
 useEffect(()=>{const c=new AbortController();let active=true;setLoad({state:'loading'});
  const timer=window.setTimeout(()=>{if(active){c.abort();setLoad({state:'unavailable'});}},8000);
  void authorizedFetch('/api/research/video/evidence/workspace/one-shot-review',{method:'GET',signal:c.signal,headers:{Accept:'application/json'}})
   .then(async r=>{if(!r.ok)throw new Error('UNAVAILABLE');const x=parseResearchOneShotReview(await r.json());if(!x.available)throw new Error('UNAVAILABLE');return x;})
   .then(data=>{if(active&&!c.signal.aborted)setLoad({state:'ready',data});})
   .catch(()=>{if(active&&!c.signal.aborted)setLoad({state:'unavailable'});})
   .finally(()=>window.clearTimeout(timer));
  return()=>{active=false;c.abort();window.clearTimeout(timer);};},[revision]);
 return <section className="rounded-xl border border-card-border bg-card p-3" data-testid="research-one-shot-review" aria-label="첫 AI 연구 사람 검토">
  <h3 className="text-sm font-bold">첫 AI 연구 · 사람 검토</h3>
  <p className="mt-1 text-xs text-muted-foreground">Gemini 규칙 → Groq 반대검토 → 사람 확인 · 읽기 전용</p>
  {load.state==='loading'?<p className="mt-2 text-xs text-muted-foreground">one-shot 검토 결과를 확인하고 있습니다.</p>:null}
  {load.state==='unavailable'?<p className="mt-2 text-xs text-muted-foreground">실행 결과가 아직 없거나 안전하게 읽을 수 없습니다. 성공·0건으로 간주하지 않습니다.</p>:null}
  {load.state==='ready'&&load.data.status==='SOURCE_EVIDENCE_REVIEW_NO_RETRY'?<>
    <div className="mt-3 rounded-lg border border-dashed border-card-border p-3">
      <strong className="text-sm">Gemini 증거 부족 · 자동 재실행 금지</strong>
      <p className="mt-1 text-xs text-muted-foreground">검토 가능한 규칙이 충분하지 않았습니다. Groq는 호출하지 않았고, 원자료·source/spec·승인을 새로 검토해야 합니다.</p>
      <p className="mt-2 text-xs">호출: Gemini {load.data.providerCalls.gemini}회 · Groq {load.data.providerCalls.groq}회</p>
      {load.data.limitations.map((x,i)=><p key={i} className="mt-1 break-words text-xs text-muted-foreground">한계: {x}</p>)}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">이 상태에서는 규칙 digest 승인·컴파일·백테스트로 진행하지 않습니다.</p>
  </>:null}
  {load.state==='ready'&&load.data.status==='HUMAN_RULE_DIGEST_REVIEW'?<>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[
        ['상태','사람 검토 대기'],['Gemini',String(load.data.providerCalls.gemini)+'회'],['Groq',String(load.data.providerCalls.groq)+'회'],['자동 적용','비활성'],
      ].map(([k,v])=><div key={k} className="rounded-lg bg-muted/30 p-2"><span className="text-xs text-muted-foreground">{k}</span><strong className="block break-words text-sm">{v}</strong></div>)}
    </div>
    <div className="mt-3 space-y-2" data-testid="one-shot-observations">{load.data.observations.map(row=>
      <article key={row.observationIndex} className="rounded-lg border border-card-border p-3" data-verdict={row.verdict}>
        <div className="flex flex-wrap items-center gap-2 text-xs"><strong>{kindLabel[row.kind]??row.kind}</strong><span>{row.atSec}초</span><span className="text-muted-foreground">{verdictLabel[row.verdict]??row.verdict}</span></div>
        <p className="mt-2 break-words text-sm">{row.description}</p>
        <p className="mt-1 break-words text-xs text-muted-foreground">Groq 검토: {row.reason}</p>
      </article>)}</div>
    {load.data.groq?<div className="mt-3 rounded-lg bg-muted/30 p-3 text-xs"><strong>Groq 종합 반대검토</strong><p className="mt-1 break-words">{load.data.groq.summary}</p><p className="mt-1 text-muted-foreground">판정: {load.data.groq.disposition}</p></div>:null}
    {load.data.missingRuleKinds.length?<p className="mt-2 text-xs">누락·재검토 규칙: {load.data.missingRuleKinds.map(x=>kindLabel[x]??x).join(', ')}</p>:null}
    {load.data.limitations.map((x,i)=><p key={i} className="mt-1 break-words text-xs text-muted-foreground">한계: {x}</p>)}
    <details className="mt-3 border-t border-card-border pt-2"><summary className="min-h-11 cursor-pointer py-2 text-xs font-bold">검토 식별값</summary>
      <p className="break-all text-xs text-muted-foreground">manifest: {load.data.manifestDigest}</p>
      <p className="mt-1 break-all text-xs text-muted-foreground">package: {load.data.packageDigest}</p>
      <p className="mt-1 break-all text-xs text-muted-foreground">reviewed rule digest 후보: {load.data.reviewedRuleDigestCandidate}</p>
    </details>
    <p className="mt-2 text-xs text-muted-foreground">ACCEPT_AS_CLAIM은 사실 인증이 아닙니다. AI 동의는 수익성 증거가 아니며, 이 화면은 승인·컴파일·백테스트를 실행하지 않습니다.</p>
  </>:null}
 </section>;
}
