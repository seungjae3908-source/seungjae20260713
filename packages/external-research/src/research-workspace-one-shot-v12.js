import { createHash } from 'node:crypto';
import { assertResearchVideoSourceV1 } from './video-intelligence.js';
import { prepareVideoResearch } from './research-workspace-video-v7.js';
import { createResearchOrchestratorPlanV10 } from './research-workspace-orchestrator-v10.js';
import { researchRuntimeRuleDigestV11 } from './research-workspace-runtime-binding-v11.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const safe=(x,max=800)=>typeof x==='string'&&x.trim().length>0&&x.length<=max
  &&!/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|api[_ -]?key\s*[:=])/i.test(x)
  &&!/(?:profit\s*factor|expectancy|sharpe|\bMDD\b|\bEV\b|win\s*rate|수익률|기대수익|승률|확률|레버리지|guaranteed\s*profit)/i.test(x);
const RULES=Object.freeze(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION']);
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const AUTH=Object.freeze({
  executionAuthority:'NONE',automaticActivation:false,automaticAdoption:false,paidFallback:false,maxGeminiCalls:1,maxGroqCalls:1,
});

export function researchOneShotDigestV12(value){return sha(value);}

export function createResearchOneShotManifestV12({pipelineId,createdAt,market,source,videoSpec}={}){
  if(!id(pipelineId)||!iso(createdAt)||!MARKETS.has(market))fail('ONE_SHOT_MANIFEST_INPUT_INVALID');
  assertResearchVideoSourceV1(source);
  const plan=prepareVideoResearch(videoSpec);
  if(source.canonicalUrl!==videoSpec.videoUrl||source.videoId!==plan.videoId)fail('ONE_SHOT_SOURCE_VIDEO_MISMATCH');
  const sourceDigest=sha(source);
  const orchestrator=createResearchOrchestratorPlanV10({
    schemaVersion:'research-orchestrator-request-v10',pipelineId,createdAt,market,
    sourceId:source.sourceId,sourceDigest,videoPlanDigest:plan.planDigest,
  });
  const core={
    schemaVersion:'research-one-shot-manifest-v12',pipelineId,createdAt,market,sourceId:source.sourceId,sourceDigest,
    videoPlanDigest:plan.planDigest,orchestratorPlanDigest:orchestrator.planDigest,providerSequence:['gemini','groq'],
    requiredStopAfterProviders:'HUMAN_RULE_DIGEST_REVIEW',authority:AUTH,
  };
  return freeze({...core,manifestDigest:sha(core)});
}

export function verifyGroqCallApprovalV12(approval,manifest,now){
  if(!exact(approval,['schemaVersion','approvalId','orchestratorPlanDigest','notBefore','expiresAt','maxCalls','sourceUseApproved','freeTierReviewed','paidFallback','executionAuthority'])
    ||approval.schemaVersion!=='research-groq-call-approval-v12'||!id(approval.approvalId)
    ||approval.orchestratorPlanDigest!==manifest?.orchestratorPlanDigest||approval.maxCalls!==1
    ||approval.sourceUseApproved!==true||approval.freeTierReviewed!==true||approval.paidFallback!==false||approval.executionAuthority!=='NONE'
    ||!iso(approval.notBefore)||!iso(approval.expiresAt)||!iso(now)||approval.notBefore>now||now>=approval.expiresAt
    ||Date.parse(approval.expiresAt)-Date.parse(approval.notBefore)<=0
    ||Date.parse(approval.expiresAt)-Date.parse(approval.notBefore)>3600000)fail('GROQ_APPROVAL_INVALID');
  return true;
}

export function buildGroqReviewPromptV12(request){
  if(!object(request)||request.schemaVersion!=='research-groq-adversarial-request-v10'||!digest(request.requestDigest)
    ||!Array.isArray(request.claims)||request.claims.length<1||request.claims.length>12)fail('GROQ_REVIEW_REQUEST_INVALID');
  const evidence=JSON.stringify({
    claims:request.claims,limitations:request.limitations,requiredRuleKinds:request.requiredRuleKinds,
  });
  const prompt=[
    'Review every claim as adversarial research evidence.',
    'Return exactly one JSON object with keys findings, missingRuleKinds, disposition, summary.',
    'findings must contain exactly one row for every observationIndex with keys observationIndex, verdict, reason.',
    'verdict is ACCEPT_AS_CLAIM, CHALLENGE, or AMBIGUOUS. ACCEPT_AS_CLAIM means only structurally usable for later human review, not true.',
    'missingRuleKinds may contain only ENTRY, EXIT, STOP_LOSS, POSITION_SIZING, EXECUTION_ASSUMPTION.',
    'disposition is CONTINUE, REVIEW_REQUIRED, or BLOCKED. Never invent a missing rule or numeric performance.',
    'No markdown. No trading instruction.',
    'EVIDENCE_JSON='+evidence,
  ].join('\n');
  if(prompt.length>16000)fail('GROQ_REVIEW_PROMPT_TOO_LARGE');
  return prompt;
}

export function parseGroqReviewResponseV12(raw,{request,model}={}){
  if(typeof raw!=='string'||raw.length>16000||raw.includes(String.fromCharCode(96))
    ||!raw.trim().startsWith('{')||!raw.trim().endsWith('}')||!safe(model,120))fail('GROQ_REVIEW_OUTPUT_INVALID');
  let x;try{x=JSON.parse(raw);}catch{fail('GROQ_REVIEW_OUTPUT_INVALID');}
  if(!exact(x,['findings','missingRuleKinds','disposition','summary'])||!Array.isArray(x.findings)
    ||x.findings.length!==request.claims.length||!Array.isArray(x.missingRuleKinds)
    ||x.missingRuleKinds.some(k=>!RULES.includes(k))||new Set(x.missingRuleKinds).size!==x.missingRuleKinds.length
    ||!['CONTINUE','REVIEW_REQUIRED','BLOCKED'].includes(x.disposition)||!safe(x.summary))fail('GROQ_REVIEW_OUTPUT_INVALID');
  const seen=new Set();
  const findings=x.findings.map(f=>{
    if(!exact(f,['observationIndex','verdict','reason'])||!Number.isSafeInteger(f.observationIndex)
      ||f.observationIndex<0||f.observationIndex>=request.claims.length||seen.has(f.observationIndex)
      ||!['ACCEPT_AS_CLAIM','CHALLENGE','AMBIGUOUS'].includes(f.verdict)||!safe(f.reason,500))fail('GROQ_REVIEW_OUTPUT_INVALID');
    seen.add(f.observationIndex);
    return {observationIndex:f.observationIndex,verdict:f.verdict,reason:f.reason};
  }).sort((a,b)=>a.observationIndex-b.observationIndex);
  if(seen.size!==request.claims.length)fail('GROQ_REVIEW_OUTPUT_INVALID');
  return freeze({
    schemaVersion:'research-groq-adversarial-review-v10',provider:'groq',model,
    requestDigest:request.requestDigest,evidenceDigest:request.evidenceDigest,findings,
    missingRuleKinds:[...x.missingRuleKinds].sort(),disposition:x.disposition,summary:x.summary,
    authority:{researchOnly:true,numericPerformanceAuthority:false,executionAuthority:'NONE',automaticAdoption:false},
  });
}

export function buildProviderReviewPackageV12({manifest,geminiReceipt,groqReview}={}){
  if(!object(manifest)||manifest.schemaVersion!=='research-one-shot-manifest-v12'||!digest(manifest.manifestDigest)
    ||geminiReceipt?.schemaVersion!=='research-video-receipt-v7'
    ||groqReview?.schemaVersion!=='research-groq-adversarial-review-v10')fail('ONE_SHOT_REVIEW_PACKAGE_INVALID');
  const reviewedRuleDigestCandidate=researchRuntimeRuleDigestV11(geminiReceipt,groqReview);
  const core={
    schemaVersion:'research-provider-review-package-v12',pipelineId:manifest.pipelineId,manifestDigest:manifest.manifestDigest,
    videoPlanDigest:manifest.videoPlanDigest,geminiReceiptDigest:sha(geminiReceipt),groqReviewDigest:sha(groqReview),
    reviewedRuleDigestCandidate,status:'REVIEW_REQUIRED',
    requiredNextStep:'HUMAN_REVIEW_AND_BIND_RULE_DIGEST_BEFORE_COMPILER',
    providerCalls:{gemini:1,groq:1},profitabilityProven:false,automaticAdoption:false,executionAuthority:'NONE',
  };
  return freeze({...core,packageDigest:sha(core)});
}
