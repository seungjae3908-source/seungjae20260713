import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { runExistingProvidersCli } from '../../../packages/external-research/scripts/run-existing-research-providers-v8.mjs';
import { runExistingEnvironmentGroqReview } from '../../../packages/external-research/src/research-workspace-providers-v8.js';
import { createGroqAdversarialReviewRequestV10, createResearchOrchestratorPlanV10 } from '../../../packages/external-research/src/research-workspace-orchestrator-v10.js';
import {
  buildGroqReviewPromptV12, buildProviderReviewPackageV12, createResearchOneShotManifestV12,
  parseGroqReviewResponseV12, researchOneShotDigestV12, verifyGroqCallApprovalV12,
  type ResearchOneShotManifestV12,
} from '../../../packages/external-research/src/research-workspace-one-shot-v12.js';
import { answerGroqResearchJsonWithConfig } from '../services/research-groq-json-transport.service';

type Market = ResearchOneShotManifestV12['market'];
type OneShotInput =
  | { mode:'prepare'; sourcePath:string; specPath:string; outputRoot:string; pipelineId:string; market:Market }
  | { mode:'execute'; sourcePath:string; specPath:string; manifestPath:string; videoApprovalPath:string; groqApprovalPath:string; outputRoot:string };
type Dependencies={env?:Record<string,string|undefined>;fetchImpl?:typeof fetch;clock?:()=>string};

const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const iso=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const safeCode=(x:unknown)=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{2,95}$/.test(x)?x:'ONE_SHOT_RUNTIME_UNAVAILABLE';

async function privateRoot(path:string):Promise<string>{
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('ONE_SHOT_ROOT_INVALID');
  const st=await lstat(path);
  if(!st.isDirectory()||st.isSymbolicLink()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077))fail('ONE_SHOT_ROOT_UNSAFE');
  const real=await realpath(path);if(real!==path)fail('ONE_SHOT_ROOT_UNSAFE');return real;
}
async function readJson(path:string,limit=512*1024):Promise<any>{
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('ONE_SHOT_INPUT_PATH_INVALID');
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const a=await h.stat();
    if(!a.isFile()||a.nlink!==1||a.size<=0||a.size>limit||(typeof process.getuid==='function'&&a.uid!==process.getuid())||(a.mode&0o077))fail('ONE_SHOT_INPUT_UNSAFE');
    const bytes=Buffer.alloc(a.size);let n=0;
    while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const b=await h.stat();
    if(n!==a.size||b.size!==a.size||b.mtimeMs!==a.mtimeMs||b.ctimeMs!==a.ctimeMs)fail('ONE_SHOT_INPUT_CHANGED');
    try{return JSON.parse(bytes.toString('utf8'));}catch{fail('ONE_SHOT_INPUT_INVALID');}
  }finally{await h.close();}
}
async function exclusive(path:string,value:unknown|Buffer):Promise<void>{
  const h=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await h.writeFile(Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}
}
async function syncDir(path:string):Promise<void>{
  const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY);try{await h.sync();}finally{await h.close();}
}
function manifestMatches(input:any,recomputed:ResearchOneShotManifestV12):boolean{
  return input?.schemaVersion==='research-one-shot-manifest-v12'
    && input.manifestDigest===recomputed.manifestDigest
    && researchOneShotDigestV12(input)===researchOneShotDigestV12(recomputed);
}
function planFromManifest(manifest:ResearchOneShotManifestV12){
  return createResearchOrchestratorPlanV10({
    schemaVersion:'research-orchestrator-request-v10',pipelineId:manifest.pipelineId,createdAt:manifest.createdAt,market:manifest.market,
    sourceId:manifest.sourceId,sourceDigest:manifest.sourceDigest,videoPlanDigest:manifest.videoPlanDigest,
  });
}

export async function runResearchWorkspaceOneShotV12(input:OneShotInput,deps:Dependencies={}):Promise<any>{
  const clock=deps.clock??(()=>new Date().toISOString());
  const now=clock();if(!iso(now))fail('ONE_SHOT_CLOCK_INVALID');
  const root=await privateRoot(input.outputRoot);
  const source=await readJson(input.sourcePath);
  const spec=await readJson(input.specPath);
  if(input.mode==='prepare'){
    const manifest=createResearchOneShotManifestV12({pipelineId:input.pipelineId,createdAt:now,market:input.market,source,videoSpec:spec});
    const name='manifest-'+manifest.manifestDigest+'.json';
    await exclusive(join(root,name),manifest);await syncDir(root);
    return {status:'PREPARED_NOT_EXECUTED',manifest,providerCalls:{gemini:0,groq:0},credentialRead:false,automaticActivation:false};
  }

  const rawManifest=await readJson(input.manifestPath);
  const recomputed=createResearchOneShotManifestV12({
    pipelineId:rawManifest.pipelineId,createdAt:rawManifest.createdAt,market:rawManifest.market,source,videoSpec:spec,
  });
  if(!manifestMatches(rawManifest,recomputed))fail('ONE_SHOT_MANIFEST_MISMATCH');
  const manifest=recomputed;
  const runDir=join(root,'one-shot-'+manifest.manifestDigest);
  try{await mkdir(runDir,{mode:0o700});}catch(cause:any){if(cause?.code==='EEXIST')fail('ONE_SHOT_RUN_ALREADY_EXISTS');throw cause;}
  await exclusive(join(runDir,'manifest.json'),manifest);
  await exclusive(join(runDir,'state-started.json'),{
    schemaVersion:'research-one-shot-state-v12',status:'STARTED',manifestDigest:manifest.manifestDigest,startedAt:now,
    executionAuthority:'NONE',automaticAdoption:false,
  });
  await syncDir(runDir);

  let groqReserved=false;
  try{
    const gemini=await runExistingProvidersCli(
      ['--spec',input.specPath,'--output-root',root,'--execute','--approval',input.videoApprovalPath],
      {env:deps.env??process.env,fetchImpl:deps.fetchImpl??fetch,clock},
    );
    await exclusive(join(runDir,'gemini-receipt.json'),gemini);
    if(gemini?.planDigest!==manifest.videoPlanDigest)fail('ONE_SHOT_GEMINI_PLAN_MISMATCH');
    if(gemini?.status==='INSUFFICIENT_EVIDENCE'){
      const state={schemaVersion:'research-one-shot-state-v12',status:'REVIEW_REQUIRED',reason:'GEMINI_INSUFFICIENT_EVIDENCE',
        manifestDigest:manifest.manifestDigest,providerCalls:{gemini:gemini.callsAttempted??0,groq:0},executionAuthority:'NONE'};
      await exclusive(join(runDir,'state-review-required.json'),state);await syncDir(runDir);return state;
    }
    if(gemini?.status!=='RESPONSE_RECEIVED_REVIEW_REQUIRED'){
      const uncertain=(gemini?.callsAttempted??0)>0;
      const state={schemaVersion:'research-one-shot-state-v12',status:uncertain?'BLOCKED_UNCERTAIN':'BLOCKED',
        reason:safeCode(gemini?.reason??'ONE_SHOT_GEMINI_FAILED'),manifestDigest:manifest.manifestDigest,
        providerCalls:{gemini:gemini?.callsAttempted??0,groq:0},executionAuthority:'NONE'};
      await exclusive(join(runDir,uncertain?'state-blocked-uncertain.json':'state-blocked.json'),state);await syncDir(runDir);return state;
    }

    const plan=planFromManifest(manifest);
    if(plan.planDigest!==manifest.orchestratorPlanDigest)fail('ONE_SHOT_ORCHESTRATOR_PLAN_MISMATCH');
    const request:any=createGroqAdversarialReviewRequestV10(plan,gemini);
    const approval=await readJson(input.groqApprovalPath,64*1024);
    verifyGroqCallApprovalV12(approval,manifest,clock());
    await exclusive(join(runDir,'groq-request.json'),request);
    const reservationId=researchOneShotDigestV12({approvalId:approval.approvalId,requestDigest:request.requestDigest});
    await exclusive(join(root,'groq-call-'+reservationId+'.json'),{
      schemaVersion:'research-groq-call-reservation-v12',approvalId:approval.approvalId,orchestratorPlanDigest:manifest.orchestratorPlanDigest,
      requestDigest:request.requestDigest,reservedAt:clock(),status:'ATTEMPT_RESERVED',
    });
    await syncDir(root);groqReserved=true;

    const review=await runExistingEnvironmentGroqReview(request,{env:deps.env??process.env,invokeGroq:async(req:any,config:any)=>{
      const prompt=buildGroqReviewPromptV12(req);
      const response=await answerGroqResearchJsonWithConfig(
        {message:prompt,apiKey:config.apiKey,model:config.model},deps.fetchImpl??fetch,undefined,20_000,
      );
      return parseGroqReviewResponseV12(response.answer,{request:req,model:response.model});
    }});
    await exclusive(join(runDir,'groq-review.json'),review);
    const reviewPackage=buildProviderReviewPackageV12({manifest,geminiReceipt:gemini,groqReview:review});
    await exclusive(join(runDir,'review-package.json'),reviewPackage);
    await exclusive(join(runDir,'state-review-required.json'),{
      schemaVersion:'research-one-shot-state-v12',status:'REVIEW_REQUIRED',reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',
      manifestDigest:manifest.manifestDigest,packageDigest:reviewPackage.packageDigest,
      reviewedRuleDigestCandidate:reviewPackage.reviewedRuleDigestCandidate,providerCalls:{gemini:1,groq:1},
      executionAuthority:'NONE',automaticAdoption:false,profitabilityProven:false,
    });
    await syncDir(runDir);
    return {status:'REVIEW_REQUIRED',manifestDigest:manifest.manifestDigest,reviewPackage,providerCalls:{gemini:1,groq:1}};
  }catch(cause:any){
    const reason=safeCode(cause?.code);
    const state={schemaVersion:'research-one-shot-state-v12',status:groqReserved?'BLOCKED_UNCERTAIN':'BLOCKED',reason,
      manifestDigest:manifest.manifestDigest,executionAuthority:'NONE',automaticAdoption:false};
    try{await exclusive(join(runDir,groqReserved?'state-blocked-uncertain.json':'state-blocked.json'),state);await syncDir(runDir);}catch{}
    return state;
  }
}
