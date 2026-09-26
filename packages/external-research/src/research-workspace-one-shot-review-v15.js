import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat,open,realpath } from 'node:fs/promises';
import { isAbsolute,join,resolve } from 'node:path';
import { researchRuntimeRuleDigestV11 } from './research-workspace-runtime-binding-v11.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const safe=(x,max=800)=>typeof x==='string'&&x.trim().length>0&&x.length<=max
  &&!/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|api[_ -]?key\s*[:=]|private[_ -]?key\s*[:=]|계좌번호|비밀번호)/i.test(x)
  &&!/(?:profit\s*factor|expectancy|sharpe|\bMDD\b|\bEV\b|win\s*rate|수익률|기대수익|승률|확률|레버리지|guaranteed\s*profit)/i.test(x);
const KINDS=new Set(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION','CONTEXT']);
const REQUIRED=new Set(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION']);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const unavailable=reason=>freeze({schemaVersion:'research-one-shot-review-v15',available:false,reason});
const AUTH=Object.freeze({readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,
  automaticBacktest:false,automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'});

async function privateDir(path,uid,code){
  const st=await lstat(path);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==uid||(st.mode&0o077)||await realpath(path)!==path)fail(code);
  return st;
}
async function readJson(dir,name,limit,uid){
  if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(name)||name.includes('..'))fail('ONE_SHOT_REVIEW_BASENAME_INVALID');
  const path=join(dir,name);let h;
  try{h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(e){if(e?.code==='ENOENT')return null;throw e;}
  try{
    const a=await h.stat();
    if(!a.isFile()||a.nlink!==1||a.uid!==uid||(a.mode&0o077)||a.size<=0||a.size>limit)fail('ONE_SHOT_REVIEW_FILE_UNSAFE');
    const bytes=Buffer.alloc(a.size);let n=0;
    while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const b=await h.stat();
    if(n!==a.size||b.size!==a.size||b.mtimeMs!==a.mtimeMs||b.ctimeMs!==a.ctimeMs||b.mode!==a.mode||b.uid!==a.uid)
      fail('ONE_SHOT_REVIEW_FILE_CHANGED');
    let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('ONE_SHOT_REVIEW_JSON_INVALID');}
    return value;
  }finally{await h.close();}
}
function manifestValid(x){
  return object(x)&&x.schemaVersion==='research-one-shot-manifest-v12'&&digest(x.manifestDigest)&&digest(x.videoPlanDigest)
    &&typeof x.pipelineId==='string'&&typeof x.sourceId==='string';
}
function observationValid(o){
  return object(o)&&Number.isFinite(o.atSec)&&o.atSec>=0&&KINDS.has(o.kind)&&safe(o.description,600)
    &&o.origin==='MODEL_OBSERVATION'&&o.semanticReview==='PENDING'&&o.timestampVerified===false;
}
function geminiValid(x,manifest){
  return object(x)&&x.schemaVersion==='research-video-receipt-v7'
    &&['RESPONSE_RECEIVED_REVIEW_REQUIRED','INSUFFICIENT_EVIDENCE'].includes(x.status)
    &&x.planDigest===manifest.videoPlanDigest&&Number.isSafeInteger(x.callsAttempted)&&x.callsAttempted===1
    &&x.sourceTruthVerified===false&&x.entireVideoVerified===false&&x.run===null
    &&x.authority?.executionAuthority==='NONE'&&x.authority?.profitabilityProven===false
    &&Array.isArray(x.observations)&&x.observations.length<=12&&x.observations.every(observationValid)
    &&Array.isArray(x.limitations)&&x.limitations.length<=8&&x.limitations.every(v=>safe(v,400));
}
function groqValid(x,gemini){
  if(!object(x)||x.schemaVersion!=='research-groq-adversarial-review-v10'||x.provider!=='groq'||!digest(x.requestDigest)||!digest(x.evidenceDigest)
    ||!Array.isArray(x.findings)||x.findings.length>12||!Array.isArray(x.missingRuleKinds)
    ||x.missingRuleKinds.some(k=>!REQUIRED.has(k))||new Set(x.missingRuleKinds).size!==x.missingRuleKinds.length
    ||!['CONTINUE','REVIEW_REQUIRED','BLOCKED'].includes(x.disposition)||!safe(x.summary,800)
    ||x.authority?.researchOnly!==true||x.authority?.numericPerformanceAuthority!==false
    ||x.authority?.executionAuthority!=='NONE'||x.authority?.automaticAdoption!==false)return false;
  const seen=new Set();
  for(const f of x.findings){
    if(!exact(f,['observationIndex','verdict','reason'])||!Number.isSafeInteger(f.observationIndex)||f.observationIndex<0
      ||f.observationIndex>=gemini.observations.length||seen.has(f.observationIndex)
      ||!['ACCEPT_AS_CLAIM','CHALLENGE','AMBIGUOUS'].includes(f.verdict)||!safe(f.reason,500))return false;
    seen.add(f.observationIndex);
  }
  return seen.size===gemini.observations.length;
}
function packageValid(x,manifest,gemini,groq){
  if(!exact(x,['schemaVersion','pipelineId','manifestDigest','videoPlanDigest','geminiReceiptDigest','groqReviewDigest',
    'reviewedRuleDigestCandidate','status','requiredNextStep','providerCalls','profitabilityProven','automaticAdoption',
    'executionAuthority','packageDigest']))return false;
  const core=Object.fromEntries(Object.entries(x).filter(([k])=>k!=='packageDigest'));
  return x.schemaVersion==='research-provider-review-package-v12'&&x.pipelineId===manifest.pipelineId
    &&x.manifestDigest===manifest.manifestDigest&&x.videoPlanDigest===manifest.videoPlanDigest
    &&x.geminiReceiptDigest===sha(gemini)&&x.groqReviewDigest===sha(groq)
    &&x.reviewedRuleDigestCandidate===researchRuntimeRuleDigestV11(gemini,groq)
    &&x.status==='REVIEW_REQUIRED'&&x.requiredNextStep==='HUMAN_REVIEW_AND_BIND_RULE_DIGEST_BEFORE_COMPILER'
    &&exact(x.providerCalls,['gemini','groq'])&&x.providerCalls.gemini===1&&x.providerCalls.groq===1
    &&x.profitabilityProven===false&&x.automaticAdoption===false&&x.executionAuthority==='NONE'
    &&digest(x.packageDigest)&&x.packageDigest===sha(core);
}
function stateValid(x,manifest){
  return object(x)&&x.schemaVersion==='research-one-shot-state-v12'&&x.status==='REVIEW_REQUIRED'
    &&x.manifestDigest===manifest.manifestDigest&&typeof x.reason==='string'&&/^[A-Z0-9_]{3,96}$/.test(x.reason)
    &&x.executionAuthority==='NONE';
}

export async function readResearchOneShotReviewV15(root,{checkedAt=new Date().toISOString()}={}){
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root||!iso(checkedAt))fail('ONE_SHOT_REVIEW_INPUT_INVALID');
  if(process.platform!=='linux'||typeof process.geteuid!=='function')fail('ONE_SHOT_REVIEW_LINUX_REQUIRED');
  let rootStat;try{rootStat=await privateDir(root,process.geteuid(),'ONE_SHOT_REVIEW_ROOT_UNSAFE');}
  catch(e){if(e?.code==='ENOENT')return unavailable('ONE_SHOT_ROOT_NOT_CONFIGURED');throw e;}
  const manifest=await readJson(root,'manifest.json',128*1024,rootStat.uid);
  if(manifest===null)return unavailable('ONE_SHOT_MANIFEST_NOT_AVAILABLE');
  if(!manifestValid(manifest))fail('ONE_SHOT_REVIEW_MANIFEST_INVALID');
  const runDir=join(root,'one-shot-'+manifest.manifestDigest);
  try{await privateDir(runDir,rootStat.uid,'ONE_SHOT_REVIEW_RUN_DIR_UNSAFE');}
  catch(e){if(e?.code==='ENOENT')return unavailable('ONE_SHOT_NOT_EXECUTED');throw e;}

  const state=await readJson(runDir,'state-review-required.json',128*1024,rootStat.uid);
  const gemini=await readJson(runDir,'gemini-receipt.json',256*1024,rootStat.uid);
  if(state===null||gemini===null)return unavailable('ONE_SHOT_REVIEW_NOT_READY');
  if(!stateValid(state,manifest)||!geminiValid(gemini,manifest))fail('ONE_SHOT_REVIEW_STATE_INVALID');

  if(state.reason==='GEMINI_INSUFFICIENT_EVIDENCE'){
    if(gemini.status!=='INSUFFICIENT_EVIDENCE'||gemini.observations.length!==0)fail('ONE_SHOT_REVIEW_INSUFFICIENT_STATE_INVALID');
    return freeze({schemaVersion:'research-one-shot-review-v15',available:true,checkedAt,status:'SOURCE_EVIDENCE_REVIEW_NO_RETRY',
      reason:'GEMINI_INSUFFICIENT_EVIDENCE',manifestDigest:manifest.manifestDigest,packageDigest:null,reviewedRuleDigestCandidate:null,
      providerCalls:{gemini:1,groq:0},sourceTruthVerified:false,entireVideoVerified:false,observations:[],
      limitations:[...gemini.limitations],groq:null,missingRuleKinds:[],authority:AUTH});
  }
  if(state.reason!=='HUMAN_RULE_DIGEST_REVIEW_REQUIRED'||gemini.status!=='RESPONSE_RECEIVED_REVIEW_REQUIRED')
    fail('ONE_SHOT_REVIEW_STATE_INVALID');

  const groq=await readJson(runDir,'groq-review.json',256*1024,rootStat.uid);
  const pkg=await readJson(runDir,'review-package.json',256*1024,rootStat.uid);
  if(groq===null||pkg===null)return unavailable('ONE_SHOT_REVIEW_PACKAGE_NOT_AVAILABLE');
  if(!groqValid(groq,gemini)||!packageValid(pkg,manifest,gemini,groq)
    ||state.packageDigest!==pkg.packageDigest||state.reviewedRuleDigestCandidate!==pkg.reviewedRuleDigestCandidate)
    fail('ONE_SHOT_REVIEW_PACKAGE_INVALID');

  const findings=new Map(groq.findings.map(x=>[x.observationIndex,x]));
  const observations=gemini.observations.map((o,index)=>{
    const f=findings.get(index);if(!f)fail('ONE_SHOT_REVIEW_FINDING_MISSING');
    return freeze({observationIndex:index,atSec:o.atSec,kind:o.kind,description:o.description,verdict:f.verdict,reason:f.reason});
  });
  return freeze({schemaVersion:'research-one-shot-review-v15',available:true,checkedAt,status:'HUMAN_RULE_DIGEST_REVIEW',
    reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest:manifest.manifestDigest,packageDigest:pkg.packageDigest,
    reviewedRuleDigestCandidate:pkg.reviewedRuleDigestCandidate,providerCalls:{gemini:1,groq:1},
    sourceTruthVerified:false,entireVideoVerified:false,observations,limitations:[...gemini.limitations],
    groq:{summary:groq.summary,disposition:groq.disposition},missingRuleKinds:[...groq.missingRuleKinds],authority:AUTH});
}
