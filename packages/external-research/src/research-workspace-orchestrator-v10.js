/** Phase10 automatic research chain core.
 * It composes reviewed provider/canonical/backtester seams but grants no execution,
 * adoption, scheduler, profitability or trading authority.
 */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000000;
const model=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(x);
const secret=/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|access[_ -]?token|password|계좌번호)\s*[:=]\s*\S+)/i;
const metricAuthority=/(?:profit\s*factor|expectancy|sharpe|\bMDD\b|\bEV\b|win\s*rate|수익률|기대수익|승률|확률|레버리지|무조건\s*수익|guaranteed\s*profit)/i;
const safeText=(x,max=800)=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&!secret.test(x)&&!metricAuthority.test(x);
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const BUCKET=Object.freeze({KR_STOCK:'STOCK',US_STOCK:'STOCK',CRYPTO_SPOT:'CRYPTO',CRYPTO_FUTURES:'CRYPTO'});
const VIDEO_KINDS=Object.freeze(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION','CONTEXT']);
const REQUIRED_RULES=Object.freeze(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION']);
export const RESEARCH_ORCHESTRATOR_STAGES_V10=Object.freeze([
  'YOUTUBE_SOURCE','GEMINI_VIDEO','GROQ_ADVERSARIAL_REVIEW','RULE_COMPLETENESS',
  'CANONICAL_COMPILER','BACKTEST','RESULT_PERSIST','ADOPTION_REVIEW',
]);
const AUTHORITY=Object.freeze({executionAuthority:'NONE',automaticActivation:false,automaticAdoption:false,
  profitabilityAuthority:'BACKTESTER_ONLY',lossRetryToProfit:false,liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false});
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(object(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
function freeze(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
function planValid(p){return exact(p,['schemaVersion','pipelineId','createdAt','market','marketBucket','sourceId','sourceDigest','videoPlanDigest','providerSequence','requiredRuleKinds','authority','planDigest'])&&
  p.schemaVersion==='research-orchestrator-plan-v10'&&id(p.pipelineId)&&iso(p.createdAt)&&MARKETS.has(p.market)&&p.marketBucket===BUCKET[p.market]&&id(p.sourceId)&&
  digest(p.sourceDigest)&&digest(p.videoPlanDigest)&&JSON.stringify(p.providerSequence)===JSON.stringify(['youtube','gemini','groq'])&&
  JSON.stringify(p.requiredRuleKinds)===JSON.stringify(REQUIRED_RULES)&&p.authority?.executionAuthority==='NONE'&&p.authority?.automaticAdoption===false&&
  p.planDigest===hash(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='planDigest')));}
function observationValid(o){return object(o)&&typeof o.atSec==='number'&&Number.isFinite(o.atSec)&&VIDEO_KINDS.includes(o.kind)&&safeText(o.description,600)&&
  o.origin==='MODEL_OBSERVATION'&&o.semanticReview==='PENDING'&&o.timestampVerified===false;}
function receiptValid(receipt,plan){
  return object(receipt)&&receipt.schemaVersion==='research-video-receipt-v7'&&receipt.planDigest===plan.videoPlanDigest&&
    ['RESPONSE_RECEIVED_REVIEW_REQUIRED','INSUFFICIENT_EVIDENCE'].includes(receipt.status)&&receipt.sourceTruthVerified===false&&
    receipt.entireVideoVerified===false&&receipt.run===null&&receipt.authority?.executionAuthority==='NONE'&&receipt.authority?.profitabilityProven===false&&
    (receipt.status==='INSUFFICIENT_EVIDENCE'||(Array.isArray(receipt.observations)&&receipt.observations.length>0&&receipt.observations.length<=12&&receipt.observations.every(observationValid)&&
      Array.isArray(receipt.limitations)&&receipt.limitations.length<=8&&receipt.limitations.every(x=>safeText(x,400))));
}
function reviewValid(review,request){
  if(!exact(review,['schemaVersion','provider','model','requestDigest','evidenceDigest','findings','missingRuleKinds','disposition','summary','authority'])||
    review.schemaVersion!=='research-groq-adversarial-review-v10'||review.provider!=='groq'||!model(review.model)||
    review.requestDigest!==request.requestDigest||review.evidenceDigest!==request.evidenceDigest||!Array.isArray(review.findings)||review.findings.length>12||
    !Array.isArray(review.missingRuleKinds)||review.missingRuleKinds.some(x=>!REQUIRED_RULES.includes(x))||new Set(review.missingRuleKinds).size!==review.missingRuleKinds.length||
    !['CONTINUE','REVIEW_REQUIRED','BLOCKED'].includes(review.disposition)||!safeText(review.summary,800)||
    !exact(review.authority,['researchOnly','numericPerformanceAuthority','executionAuthority','automaticAdoption'])||
    review.authority.researchOnly!==true||review.authority.numericPerformanceAuthority!==false||
    review.authority.executionAuthority!=='NONE'||review.authority.automaticAdoption!==false)return false;
  const indexes=new Set();
  for(const finding of review.findings){
    if(!exact(finding,['observationIndex','verdict','reason'])||!Number.isSafeInteger(finding.observationIndex)||finding.observationIndex<0||
      finding.observationIndex>=request.claims.length||!['ACCEPT_AS_CLAIM','CHALLENGE','AMBIGUOUS'].includes(finding.verdict)||
      !safeText(finding.reason,500)||indexes.has(finding.observationIndex))return false;
    indexes.add(finding.observationIndex);
  }
  return true;
}
function outcome(plan,status,currentStage,reason,extra={}){
  return freeze({schemaVersion:'research-orchestrator-run-v10',pipelineId:plan.pipelineId,planDigest:plan.planDigest,market:plan.market,
    marketBucket:plan.marketBucket,status,currentStage,reason,...extra,authority:AUTHORITY});
}
function compilerValid(x){return object(x)&&['READY','REVIEW_REQUIRED'].includes(x.status)&&
  (x.status!=='READY'||(x.compiler==='video-research-canonical-handoff-v1'&&digest(x.handoffDigest)&&id(x.hypothesisId)))&&
  (x.reason==null||safeText(x.reason,240));}
function backtestValid(x,plan){return object(x)&&['BACKTEST_RECORDED','REVIEW_REQUIRED'].includes(x.status)&&
  (x.status!=='BACKTEST_RECORDED'||(x.backtester==='evidence-backed-formula-tournament-adapter-v1'&&x.market===plan.market&&digest(x.resultDigest)&&
    exact(x.metrics,['netReturn','maxDrawdown','tradeCount','fullCostIncluded'])&&finite(x.metrics.netReturn)&&finite(x.metrics.maxDrawdown)&&
    x.metrics.maxDrawdown>=0&&integer(x.metrics.tradeCount)&&x.metrics.fullCostIncluded===true))&&(x.reason==null||safeText(x.reason,240));}

export function createResearchOrchestratorPlanV10(raw){
  if(!exact(raw,['schemaVersion','pipelineId','createdAt','market','sourceId','sourceDigest','videoPlanDigest'])||
    raw.schemaVersion!=='research-orchestrator-request-v10'||!id(raw.pipelineId)||!iso(raw.createdAt)||!MARKETS.has(raw.market)||
    !id(raw.sourceId)||!digest(raw.sourceDigest)||!digest(raw.videoPlanDigest))fail('ORCHESTRATOR_PLAN_INVALID');
  const core={schemaVersion:'research-orchestrator-plan-v10',pipelineId:raw.pipelineId,createdAt:raw.createdAt,market:raw.market,
    marketBucket:BUCKET[raw.market],sourceId:raw.sourceId,sourceDigest:raw.sourceDigest,videoPlanDigest:raw.videoPlanDigest,
    providerSequence:['youtube','gemini','groq'],requiredRuleKinds:[...REQUIRED_RULES],authority:AUTHORITY};
  return freeze({...core,planDigest:hash(core)});
}

export function createGroqAdversarialReviewRequestV10(plan,geminiReceipt){
  if(!planValid(plan)||!receiptValid(geminiReceipt,plan)||geminiReceipt.status!=='RESPONSE_RECEIVED_REVIEW_REQUIRED')fail('ORCHESTRATOR_GEMINI_EVIDENCE_INVALID');
  const claims=geminiReceipt.observations.map((o,index)=>freeze({observationIndex:index,atSec:o.atSec,kind:o.kind,description:o.description}));
  const evidenceDigest=hash({pipelineId:plan.pipelineId,videoPlanDigest:plan.videoPlanDigest,claims,limitations:geminiReceipt.limitations});
  const core={schemaVersion:'research-groq-adversarial-request-v10',pipelineId:plan.pipelineId,planDigest:plan.planDigest,evidenceDigest,
    role:'ADVERSARIAL_CRITIC',claims,limitations:[...geminiReceipt.limitations],requiredRuleKinds:[...REQUIRED_RULES],
    constraints:{mayAddRules:false,numericPerformanceAuthority:false,tradingAuthority:false,challengeUnclearClaims:true}};
  return freeze({...core,requestDigest:hash(core)});
}

export function assessRuleCompletenessV10(plan,geminiReceipt,request,groqReview){
  if(!planValid(plan)||!receiptValid(geminiReceipt,plan)||!reviewValid(groqReview,request))fail('ORCHESTRATOR_REVIEW_INVALID');
  const missing=new Set(groqReview.missingRuleKinds);
  const present=new Set(geminiReceipt.observations.map(x=>x.kind));
  for(const kind of REQUIRED_RULES)if(!present.has(kind))missing.add(kind);
  for(const finding of groqReview.findings){
    if(finding.verdict==='CHALLENGE'||finding.verdict==='AMBIGUOUS'){
      const kind=request.claims[finding.observationIndex]?.kind;if(REQUIRED_RULES.includes(kind))missing.add(kind);
    }
  }
  const missingRuleKinds=[...missing].sort();
  return freeze({schemaVersion:'research-rule-completeness-v10',status:groqReview.disposition==='CONTINUE'&&missingRuleKinds.length===0?'COMPLETE':'REVIEW_REQUIRED',
    presentRuleKinds:[...present].filter(x=>REQUIRED_RULES.includes(x)).sort(),missingRuleKinds,
    groqCanAddMissingRules:false,aiAgreementIsProfitabilityEvidence:false});
}

export async function runResearchOrchestratorV10({plan,runGeminiVideo,runGroqReview,compileCanonical,runBacktest,persistResult}={}){
  if(!planValid(plan)||![runGeminiVideo,runGroqReview,compileCanonical,runBacktest,persistResult].every(x=>typeof x==='function'))fail('ORCHESTRATOR_DEPENDENCIES_INVALID');
  const geminiReceipt=await runGeminiVideo(freeze({pipelineId:plan.pipelineId,videoPlanDigest:plan.videoPlanDigest}));
  if(!receiptValid(geminiReceipt,plan))fail('ORCHESTRATOR_GEMINI_EVIDENCE_INVALID');
  if(geminiReceipt.status==='INSUFFICIENT_EVIDENCE')return outcome(plan,'REVIEW_REQUIRED','GEMINI_VIDEO','GEMINI_INSUFFICIENT_EVIDENCE');
  const reviewRequest=createGroqAdversarialReviewRequestV10(plan,geminiReceipt);
  const groqReview=await runGroqReview(reviewRequest);
  if(!reviewValid(groqReview,reviewRequest))fail('ORCHESTRATOR_GROQ_REVIEW_INVALID');
  const ruleAssessment=assessRuleCompletenessV10(plan,geminiReceipt,reviewRequest,groqReview);
  if(ruleAssessment.status!=='COMPLETE')return outcome(plan,'REVIEW_REQUIRED','RULE_COMPLETENESS','RULES_OR_CRITIQUE_REQUIRE_REVIEW',
    {ruleAssessment,groqReviewDigest:hash(groqReview)});
  const compiled=await compileCanonical(freeze({plan,geminiReceipt,groqReview,ruleAssessment}));
  if(!compilerValid(compiled))fail('ORCHESTRATOR_COMPILER_RESULT_INVALID');
  if(compiled.status!=='READY')return outcome(plan,'REVIEW_REQUIRED','CANONICAL_COMPILER',compiled.reason||'CANONICAL_COMPILER_REVIEW_REQUIRED',
    {ruleAssessment,groqReviewDigest:hash(groqReview)});
  const backtest=await runBacktest(freeze({plan,compiled}));
  if(!backtestValid(backtest,plan))fail('ORCHESTRATOR_BACKTEST_RESULT_INVALID');
  if(backtest.status!=='BACKTEST_RECORDED')return outcome(plan,'REVIEW_REQUIRED','BACKTEST',backtest.reason||'BACKTEST_REVIEW_REQUIRED',
    {compilerDigest:compiled.handoffDigest});
  const core={schemaVersion:'research-orchestrator-result-v10',pipelineId:plan.pipelineId,planDigest:plan.planDigest,market:plan.market,
    marketBucket:plan.marketBucket,compilerDigest:compiled.handoffDigest,backtestResultDigest:backtest.resultDigest,metrics:{...backtest.metrics},
    researchOutcome:backtest.metrics.netReturn<0?'LOSS_RECORDED':'NON_NEGATIVE_RECORDED',lossRetryToProfit:false,
    adoptionStatus:'REVIEW_REQUIRED',profitabilityProven:false,authority:AUTHORITY};
  const record=freeze({...core,resultDigest:hash(core)});
  const stored=await persistResult(record);
  if(!exact(stored,['status','resultDigest','marketBucket'])||stored.status!=='STORED'||stored.resultDigest!==record.resultDigest||
    stored.marketBucket!==plan.marketBucket)fail('ORCHESTRATOR_RESULT_STORE_INVALID');
  return outcome(plan,'COMPLETED','ADOPTION_REVIEW',null,{result:record,storage:freeze({...stored})});
}

export function summarizeResearchOrchestratorStatusV10(states,{checkedAt=new Date().toISOString()}={}){
  if(!Array.isArray(states)||!iso(checkedAt))fail('ORCHESTRATOR_STATUS_INPUT_INVALID');
  const stageCounts=Object.fromEntries(RESEARCH_ORCHESTRATOR_STAGES_V10.map(x=>[x,0]));
  const totals={pending:0,processing:0,reviewRequired:0,completed:0};
  const markets={stockCompleted:0,cryptoCompleted:0};
  for(const row of states){
    if(!object(row)||!MARKETS.has(row.market)||!RESEARCH_ORCHESTRATOR_STAGES_V10.includes(row.currentStage)||
      !['PENDING','PROCESSING','REVIEW_REQUIRED','COMPLETED'].includes(row.status))fail('ORCHESTRATOR_STATUS_INPUT_INVALID');
    stageCounts[row.currentStage]++;
    totals[row.status==='PENDING'?'pending':row.status==='PROCESSING'?'processing':row.status==='REVIEW_REQUIRED'?'reviewRequired':'completed']++;
    if(row.status==='COMPLETED')markets[BUCKET[row.market]==='STOCK'?'stockCompleted':'cryptoCompleted']++;
  }
  return freeze({schemaVersion:'research-orchestrator-status-v10',available:true,checkedAt,totals,stageCounts,markets,
    authority:{executionAuthority:'NONE',automaticActivation:false,automaticAdoption:false,providerCallsFromStatus:0,profitabilityAuthority:'BACKTESTER_ONLY'}});
}
function statusValid(x){
  const stages=object(x?.stageCounts)&&RESEARCH_ORCHESTRATOR_STAGES_V10.every(k=>integer(x.stageCounts[k]))&&Object.keys(x.stageCounts).length===RESEARCH_ORCHESTRATOR_STAGES_V10.length;
  return exact(x,['schemaVersion','available','checkedAt','totals','stageCounts','markets','authority'])&&x.schemaVersion==='research-orchestrator-status-v10'&&x.available===true&&iso(x.checkedAt)&&
    exact(x.totals,['pending','processing','reviewRequired','completed'])&&Object.values(x.totals).every(integer)&&stages&&
    exact(x.markets,['stockCompleted','cryptoCompleted'])&&Object.values(x.markets).every(integer)&&
    exact(x.authority,['executionAuthority','automaticActivation','automaticAdoption','providerCallsFromStatus','profitabilityAuthority'])&&
    x.authority.executionAuthority==='NONE'&&x.authority.automaticActivation===false&&x.authority.automaticAdoption===false&&
    x.authority.providerCallsFromStatus===0&&x.authority.profitabilityAuthority==='BACKTESTER_ONLY';
}
export async function readResearchOrchestratorStatusV10(root){
  if(typeof root!=='string'||!isAbsolute(root))fail('ORCHESTRATOR_STATUS_ROOT_INVALID');
  let st;try{st=await lstat(root);}catch(e){if(e?.code==='ENOENT')return {schemaVersion:'research-orchestrator-status-v10',available:false,reason:'ORCHESTRATOR_NOT_ACTIVATED'};throw e;}
  if(!st.isDirectory()||st.isSymbolicLink()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077))
    return {schemaVersion:'research-orchestrator-status-v10',available:false,reason:'ORCHESTRATOR_STATUS_UNAVAILABLE'};
  const path=join(await realpath(root),'orchestrator-status-v10.json');
  let h;try{h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){
    if(e?.code==='ENOENT')return {schemaVersion:'research-orchestrator-status-v10',available:false,reason:'ORCHESTRATOR_STATUS_NOT_WRITTEN'};throw e;
  }
  try{
    const before=await h.stat();
    if(!before.isFile()||before.nlink!==1||before.size>256*1024||(typeof process.getuid==='function'&&before.uid!==process.getuid())||(before.mode&0o077))
      fail('ORCHESTRATOR_STATUS_FILE_UNSAFE');
    const bytes=Buffer.alloc(before.size);let n=0;while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const after=await h.stat();if(n!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('ORCHESTRATOR_STATUS_FILE_CHANGED');
    let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('ORCHESTRATOR_STATUS_INVALID');}
    if(!statusValid(value))fail('ORCHESTRATOR_STATUS_INVALID');return freeze(value);
  }finally{await h.close();}
}
export function researchOrchestratorDigestV10(value){return hash(value);}
