'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');

const FIXED_FILES=Object.freeze({
  source:'source.json',
  spec:'spec.json',
  manifest:'manifest.json',
  videoApproval:'video-approval.json',
  groqApproval:'groq-approval.json',
});
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const bool=(env,name)=>{
  const raw=env[name];
  if(raw===undefined||raw===null||String(raw).trim()==='')return null;
  const value=String(raw).trim().toLowerCase();
  if(value==='true')return true;if(value==='false')return false;return 'MALFORMED';
};
const keyState=values=>{
  const rows=values.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
  if(!rows.length)return 'MISSING';
  if(rows.some(v=>!/^[A-Za-z0-9_.-]{8,512}$/.test(v)))return 'INVALID';
  return new Set(rows).size===1?'PRESENT':'CONFLICT';
};
const modelState=values=>{
  const rows=values.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
  if(!rows.length)return 'MISSING';
  if(rows.some(v=>!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(v)))return 'INVALID';
  return new Set(rows).size===1?'EXPLICIT':'CONFLICT';
};
function providerReadiness(env){
  const explicit=String(env.AI_CHAT_PROVIDER??'').trim().toLowerCase();
  const geminiIdentity=new Set(['gemini','google','google-gemini']);
  const geminiKeys=[env.GEMINI_API_KEY,env.GOOGLE_API_KEY];
  if(geminiIdentity.has(explicit))geminiKeys.push(env.AI_CHAT_API_KEY);
  const groqKeys=[env.GROQ_API_KEY];
  if(explicit==='groq')groqKeys.push(env.AI_CHAT_API_KEY);
  const groqModels=[env.GROQ_MODEL];
  if(explicit==='groq')groqModels.push(env.AI_CHAT_MODEL);
  const generic=typeof env.AI_CHAT_API_KEY==='string'&&env.AI_CHAT_API_KEY.trim().length>0;
  return Object.freeze({
    geminiCredential:keyState(geminiKeys),
    groqCredential:keyState(groqKeys),
    groqModel:modelState(groqModels),
    unmappedGenericCredential:Boolean(generic&&!geminiIdentity.has(explicit)&&explicit!=='groq'),
  });
}
function safeFlags(env){
  const names=['LIVE_TRADING','AUTO_TRADING','REAL_ORDER_ENABLED','PRIVATE_TRADING_API_ALLOWED','ORDER_EXECUTION_ENABLED'];
  const states=Object.fromEntries(names.map(name=>[name,bool(env,name)]));
  const malformed=Object.entries(states).filter(([,v])=>v==='MALFORMED').map(([k])=>k);
  const enabled=Object.entries(states).filter(([,v])=>v===true).map(([k])=>k);
  const authority=String(env.executionAuthority??env.EXECUTION_AUTHORITY??'NONE').trim().toUpperCase();
  return {states,malformed,enabled,authority,safe:!malformed.length&&!enabled.length&&authority==='NONE'};
}
function fileFact(root,name,uid,limit){
  const full=path.join(root,name);
  try{
    const lst=fs.lstatSync(full);
    if(lst.isSymbolicLink()||!lst.isFile()||lst.nlink!==1||lst.uid!==uid||(lst.mode&0o077)||lst.size<=0||lst.size>limit)
      return {safe:false,exists:true,value:null};
    const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const a=fs.fstatSync(fd);
      const raw=Buffer.alloc(a.size);let off=0;
      while(off<raw.length){const n=fs.readSync(fd,raw,off,raw.length-off,off);if(!n)break;off+=n;}
      const b=fs.fstatSync(fd);
      if(off!==a.size||b.size!==a.size||b.mtimeMs!==a.mtimeMs||b.ctimeMs!==a.ctimeMs)return {safe:false,exists:true,value:null};
      let value;try{value=JSON.parse(raw.toString('utf8'));}catch{return {safe:false,exists:true,value:null};}
      return {safe:true,exists:true,value};
    }finally{fs.closeSync(fd);}
  }catch(e){return {safe:false,exists:e&&e.code!=='ENOENT',value:null};}
}
function collectFiles(root,uid){
  return {
    source:fileFact(root,FIXED_FILES.source,uid,256*1024),
    spec:fileFact(root,FIXED_FILES.spec,uid,128*1024),
    manifest:fileFact(root,FIXED_FILES.manifest,uid,128*1024),
    videoApproval:fileFact(root,FIXED_FILES.videoApproval,uid,64*1024),
    groqApproval:fileFact(root,FIXED_FILES.groqApproval,uid,64*1024),
  };
}
function rootFact(root,uid){
  if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root)return {configured:false,safe:false};
  try{
    const st=fs.lstatSync(root);
    return {configured:true,safe:st.isDirectory()&&!st.isSymbolicLink()&&st.uid===uid&&!(st.mode&0o077)&&fs.realpathSync(root)===root};
  }catch{return {configured:true,safe:false};}
}
function validateDocuments(files,now){
  const reasons=[];
  for(const [name,fact] of Object.entries(files))if(!fact.exists||!fact.safe)reasons.push('FILE_'+name.toUpperCase()+'_UNAVAILABLE_OR_UNSAFE');
  if(reasons.length)return {ok:false,reasons};
  const source=files.source.value,spec=files.spec.value,manifest=files.manifest.value,video=files.videoApproval.value,groq=files.groqApproval.value;
  if(!obj(source)||typeof source.sourceId!=='string'||typeof source.canonicalUrl!=='string'||typeof source.videoId!=='string')
    reasons.push('SOURCE_SHAPE_INVALID');
  if(!obj(spec)||spec.schemaVersion!=='research-video-spec-v7'||spec.videoUrl!==source?.canonicalUrl)
    reasons.push('SPEC_SOURCE_BINDING_INVALID');
  if(!obj(manifest)||manifest.schemaVersion!=='research-one-shot-manifest-v12'||!hash(manifest.manifestDigest)
    ||manifest.sourceId!==source?.sourceId||!hash(manifest.videoPlanDigest)||!hash(manifest.orchestratorPlanDigest))
    reasons.push('MANIFEST_BINDING_INVALID');
  if(!obj(video)||video.schemaVersion!=='research-video-call-approval-v7'||video.planDigest!==manifest?.videoPlanDigest
    ||video.maxCalls!==1||video.sourceUseApproved!==true||video.freeTierReviewed!==true||video.paidFallback!==false||video.executionAuthority!=='NONE')
    reasons.push('VIDEO_APPROVAL_BINDING_INVALID');
  if(!obj(groq)||groq.schemaVersion!=='research-groq-call-approval-v12'||groq.orchestratorPlanDigest!==manifest?.orchestratorPlanDigest
    ||groq.maxCalls!==1||groq.sourceUseApproved!==true||groq.freeTierReviewed!==true||groq.paidFallback!==false||groq.executionAuthority!=='NONE')
    reasons.push('GROQ_APPROVAL_BINDING_INVALID');
  for(const [label,row] of [['VIDEO',video],['GROQ',groq]]){
    if(!iso(row?.notBefore)||!iso(row?.expiresAt)||row.notBefore>now||now>=row.expiresAt
      ||Date.parse(row.expiresAt)-Date.parse(row.notBefore)<=0||Date.parse(row.expiresAt)-Date.parse(row.notBefore)>3600000)
      reasons.push(label+'_APPROVAL_EXPIRED_OR_INVALID');
  }
  return {ok:reasons.length===0,reasons};
}
function evaluatePreflightV13({processes,targetSha,now,rootFacts,files}){
  const reasons=[];
  if(!sha(targetSha)||!iso(now))throw new Error('PREFLIGHT_INPUT_INVALID');
  const matches=Array.isArray(processes)?processes.filter(x=>x&&x.name==='stock-app'):[];
  if(matches.length!==1||!matches[0].pm2_env)return Object.freeze({
    schemaVersion:'research-one-shot-operational-preflight-v13',status:'BLOCKED',checkedAt:now,targetSha,
    reasonCodes:['PM2_STOCK_APP_AMBIGUOUS'],providerCalls:0,serverFilesWritten:0,secretValuesCollected:0,executionAuthority:'NONE'
  });
  const app=matches[0],env=app.pm2_env;
  const activeSha=String(env.DEPLOY_SHA??'').trim().toLowerCase();
  if(env.status!=='online')reasons.push('PM2_NOT_ONLINE');
  if(activeSha!==targetSha)reasons.push('PRODUCTION_SHA_MISMATCH');
  const flags=safeFlags(env);if(!flags.safe)reasons.push('TRADING_AUTHORITY_NOT_SAFE');
  const providers=providerReadiness(env);
  if(providers.geminiCredential!=='PRESENT')reasons.push('GEMINI_CREDENTIAL_NOT_READY');
  if(providers.groqCredential!=='PRESENT')reasons.push('GROQ_CREDENTIAL_NOT_READY');
  if(providers.groqModel!=='EXPLICIT')reasons.push('GROQ_MODEL_NOT_READY');
  if(providers.unmappedGenericCredential)reasons.push('GENERIC_PROVIDER_CREDENTIAL_UNMAPPED');
  if(!rootFacts?.configured)reasons.push('ONE_SHOT_ROOT_NOT_CONFIGURED');
  else if(!rootFacts.safe)reasons.push('ONE_SHOT_ROOT_UNSAFE');
  const docs=files?validateDocuments(files,now):{ok:false,reasons:['ONE_SHOT_FILES_NOT_CHECKED']};
  reasons.push(...docs.reasons);
  return Object.freeze({
    schemaVersion:'research-one-shot-operational-preflight-v13',
    status:reasons.length?'BLOCKED':'READY_FOR_REVIEWED_ONE_SHOT',
    checkedAt:now,targetSha,activeDeploySha:sha(activeSha)?activeSha:null,pm2Online:env.status==='online',
    rootConfigured:Boolean(rootFacts?.configured),rootSafe:Boolean(rootFacts?.safe),
    files:Object.fromEntries(Object.entries(FIXED_FILES).map(([k])=>[k,Boolean(files?.[k]?.exists&&files?.[k]?.safe)])),
    providers,approvalBinding:docs.ok,
    safety:{liveTrading:flags.states.LIVE_TRADING??false,autoTrading:flags.states.AUTO_TRADING??false,
      realOrderEnabled:flags.states.REAL_ORDER_ENABLED??false,privateTradingApiAllowed:flags.states.PRIVATE_TRADING_API_ALLOWED??false,
      orderExecutionEnabled:flags.states.ORDER_EXECUTION_ENABLED??false,executionAuthority:flags.authority},
    reasonCodes:[...new Set(reasons)].sort(),providerCalls:0,serverFilesWritten:0,serverFilesDeleted:0,
    serverProcessesRestarted:0,databaseChanges:0,secretValuesCollected:0,executionAuthority:'NONE'
  });
}
function live(){
  const targetSha=String(process.env.TARGET_SHA??'').trim().toLowerCase();
  const now=new Date().toISOString();
  const processes=JSON.parse(cp.execFileSync('pm2',['jlist'],{encoding:'utf8',maxBuffer:4*1024*1024}));
  const app=processes.filter(x=>x&&x.name==='stock-app');
  if(app.length!==1||!app[0].pm2_env){
    process.stdout.write(JSON.stringify(evaluatePreflightV13({processes,targetSha,now,rootFacts:null,files:null}))+'\n');return;
  }
  const pid=Number(app[0].pid);
  let uid=typeof process.getuid==='function'?process.getuid():-1;
  try{if(Number.isSafeInteger(pid)&&pid>0)uid=fs.statSync('/proc/'+pid).uid;}catch{}
  const root=typeof app[0].pm2_env.RESEARCH_WORKSPACE_ONE_SHOT_ROOT==='string'?app[0].pm2_env.RESEARCH_WORKSPACE_ONE_SHOT_ROOT.trim():'';
  const rf=rootFact(root,uid);
  const files=rf.safe?collectFiles(root,uid):null;
  process.stdout.write(JSON.stringify(evaluatePreflightV13({processes,targetSha,now,rootFacts:rf,files}))+'\n');
}
module.exports={evaluatePreflightV13,providerReadiness,safeFlags,validateDocuments,FIXED_FILES};
if(require.main===module)live();
