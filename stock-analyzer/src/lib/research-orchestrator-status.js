const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000000;
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export const RESEARCH_ORCHESTRATOR_STAGE_LABELS=Object.freeze({
 YOUTUBE_SOURCE:'YouTube 자료',GEMINI_VIDEO:'Gemini 영상 분석',GROQ_ADVERSARIAL_REVIEW:'Groq 반대검토',RULE_COMPLETENESS:'규칙 완성도',
 CANONICAL_COMPILER:'규칙 컴파일',BACKTEST:'백테스트',RESULT_PERSIST:'결과 저장',ADOPTION_REVIEW:'채택 검토',
});
const stageKeys=Object.keys(RESEARCH_ORCHESTRATOR_STAGE_LABELS);
export function parseResearchOrchestratorStatus(raw){
 if(!object(raw)||raw.schemaVersion!=='research-orchestrator-status-v10')throw new Error('INVALID_RESEARCH_ORCHESTRATOR_STATUS');
 if(raw.available===false)return {available:false,reason:'ORCHESTRATOR_STATUS_UNAVAILABLE'};
 if(raw.available!==true||!iso(raw.checkedAt)||!object(raw.totals)||!object(raw.stageCounts)||!object(raw.markets)||!object(raw.authority)||
  !['pending','processing','reviewRequired','completed'].every(k=>integer(raw.totals[k]))||Object.keys(raw.totals).length!==4||
  !stageKeys.every(k=>integer(raw.stageCounts[k]))||Object.keys(raw.stageCounts).length!==stageKeys.length||
  !['stockCompleted','cryptoCompleted'].every(k=>integer(raw.markets[k]))||Object.keys(raw.markets).length!==2||
  raw.authority.executionAuthority!=='NONE'||raw.authority.automaticActivation!==false||raw.authority.automaticAdoption!==false||
  raw.authority.providerCallsFromStatus!==0||raw.authority.profitabilityAuthority!=='BACKTESTER_ONLY')throw new Error('INVALID_RESEARCH_ORCHESTRATOR_STATUS');
 return {available:true,checkedAt:raw.checkedAt,totals:{...raw.totals},stageCounts:{...raw.stageCounts},markets:{...raw.markets}};
}
