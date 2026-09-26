import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat,open,realpath } from 'node:fs/promises';
import { isAbsolute,join,resolve } from 'node:path';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const REQUIRED=new Set(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION']);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const ACK_KEYS=['sourceTruthNotVerified','entireVideoNotVerified','aiAgreementIsNotProfitabilityEvidence','researchOnly','noAutomaticAdoption'];
const AUTH=Object.freeze({researchEvaluationOnly:true,providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,
  profitabilityProven:false,liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE'});
export const HUMAN_RULE_DIGEST_DECISION_FILE_V16='human-rule-digest-decision-v16.json';

function reviewEligible(review){
  if(!object(review)||review.schemaVersion!=='research-one-shot-review-v15'||review.available!==true
    ||review.status!=='HUMAN_RULE_DIGEST_REVIEW'||review.reason!=='HUMAN_RULE_DIGEST_REVIEW_REQUIRED'
    ||!digest(review.manifestDigest)||!digest(review.packageDigest)||!digest(review.reviewedRuleDigestCandidate)
    ||review.providerCalls?.gemini!==1||review.providerCalls?.groq!==1||review.sourceTruthVerified!==false||review.entireVideoVerified!==false
    ||!Array.isArray(review.observations)||!Array.isArray(review.missingRuleKinds)||review.missingRuleKinds.length!==0
    ||review.groq?.disposition!=='CONTINUE'||review.authority?.readOnly!==true||review.authority?.automaticBinding!==false
    ||review.authority?.automaticCompiler!==false||review.authority?.automaticBacktest!==false||review.authority?.automaticAdoption!==false
    ||review.authority?.profitabilityProven!==false||review.authority?.executionAuthority!=='NONE')return false;
  const byKind=new Map([...REQUIRED].map(k=>[k,[]]));
  for(const row of review.observations){
    if(REQUIRED.has(row?.kind))byKind.get(row.kind).push(row);
  }
  for(const kind of REQUIRED){
    const rows=byKind.get(kind);
    if(!rows?.length||rows.some(row=>row.verdict!=='ACCEPT_AS_CLAIM'))return false;
  }
  return true;
}
function requestValid(request,review){
  if(!exact(request,['schemaVersion','bindingId','reviewerId','decidedAt','expiresAt','manifestDigest','packageDigest',
    'reviewedRuleDigest','acknowledgements'])||request.schemaVersion!=='research-human-rule-digest-binding-request-v16'
    ||!id(request.bindingId)||!id(request.reviewerId)||!iso(request.decidedAt)||!iso(request.expiresAt)
    ||request.expiresAt<=request.decidedAt||Date.parse(request.expiresAt)-Date.parse(request.decidedAt)>3600000
    ||request.manifestDigest!==review.manifestDigest||request.packageDigest!==review.packageDigest
    ||request.reviewedRuleDigest!==review.reviewedRuleDigestCandidate||!exact(request.acknowledgements,ACK_KEYS)
    ||ACK_KEYS.some(k=>request.acknowledgements[k]!==true))return false;
  return true;
}
export function createHumanRuleDigestDecisionV16(review,request){
  if(!reviewEligible(review))fail('HUMAN_RULE_DIGEST_REVIEW_NOT_BINDABLE');
  if(!requestValid(request,review))fail('HUMAN_RULE_DIGEST_BINDING_REQUEST_INVALID');
  const core={schemaVersion:'research-human-rule-digest-decision-v16',bindingId:request.bindingId,reviewerId:request.reviewerId,
    decidedAt:request.decidedAt,expiresAt:request.expiresAt,decision:'BIND_FOR_RESEARCH_EVALUATION',
    manifestDigest:review.manifestDigest,packageDigest:review.packageDigest,reviewedRuleDigest:review.reviewedRuleDigestCandidate,
    reviewFingerprint:sha(review),allowedNextAction:'CANONICAL_RESEARCH_EVALUATION_ONE_SHOT',maxCanonicalEvaluationRuns:1,
    acknowledgements:{...request.acknowledgements},authority:AUTH};
  return freeze({...core,decisionDigest:sha(core)});
}
export function validateHumanRuleDigestDecisionV16(value,review,{now=new Date().toISOString()}={}){
  if(!reviewEligible(review)||!iso(now)||!object(value)||value.schemaVersion!=='research-human-rule-digest-decision-v16'
    ||!id(value.bindingId)||!id(value.reviewerId)||!iso(value.decidedAt)||!iso(value.expiresAt)||value.decidedAt>now||now>=value.expiresAt
    ||value.decision!=='BIND_FOR_RESEARCH_EVALUATION'||value.manifestDigest!==review.manifestDigest
    ||value.packageDigest!==review.packageDigest||value.reviewedRuleDigest!==review.reviewedRuleDigestCandidate
    ||value.reviewFingerprint!==sha(review)||value.allowedNextAction!=='CANONICAL_RESEARCH_EVALUATION_ONE_SHOT'
    ||value.maxCanonicalEvaluationRuns!==1||!exact(value.acknowledgements,ACK_KEYS)
    ||ACK_KEYS.some(k=>value.acknowledgements[k]!==true)
    ||value.authority?.researchEvaluationOnly!==true||value.authority?.providerCalls!==0||value.authority?.compilerRuns!==0
    ||value.authority?.backtestRuns!==0||value.authority?.automaticAdoption!==false||value.authority?.profitabilityProven!==false
    ||value.authority?.liveTrading!==false||value.authority?.autoTrading!==false||value.authority?.realOrderEnabled!==false
    ||value.authority?.privateTradingApiAllowed!==false||value.authority?.executionAuthority!=='NONE'
    ||!digest(value.decisionDigest))return false;
  const core=Object.fromEntries(Object.entries(value).filter(([k])=>k!=='decisionDigest'));
  return value.decisionDigest===sha(core);
}
async function privateRoot(root){
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root||process.platform!=='linux'||typeof process.geteuid!=='function')
    fail('HUMAN_RULE_DIGEST_ROOT_INVALID');
  const st=await lstat(root);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.geteuid()||(st.mode&0o077)||await realpath(root)!==root)
    fail('HUMAN_RULE_DIGEST_ROOT_UNSAFE');
  return st;
}
export async function writeHumanRuleDigestDecisionV16(root,decision){
  await privateRoot(root);
  if(!object(decision)||decision.schemaVersion!=='research-human-rule-digest-decision-v16'||!digest(decision.decisionDigest))
    fail('HUMAN_RULE_DIGEST_DECISION_INVALID');
  const path=join(root,HUMAN_RULE_DIGEST_DECISION_FILE_V16);
  let h;try{h=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(e){if(e?.code==='EEXIST')fail('HUMAN_RULE_DIGEST_DECISION_ALREADY_EXISTS');throw e;}
  try{await h.writeFile(JSON.stringify(decision,null,2)+'\n');await h.sync();}finally{await h.close();}
  const d=await open(root,constants.O_RDONLY|constants.O_DIRECTORY);try{await d.sync();}finally{await d.close();}
  return freeze({status:'BOUND_FOR_RESEARCH_EVALUATION',decisionDigest:decision.decisionDigest,
    reviewedRuleDigest:decision.reviewedRuleDigest,allowedNextAction:decision.allowedNextAction,maxCanonicalEvaluationRuns:1,
    providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE',
    serverFilesWritten:1});
}
