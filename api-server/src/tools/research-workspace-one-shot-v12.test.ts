import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchVideoSourceV1 } from '../../../packages/external-research/src/video-intelligence.js';
import { prepareVideoResearch } from '../../../packages/external-research/src/research-workspace-video-v7.js';
import { runResearchWorkspaceOneShotV12 } from './research-workspace-one-shot-v12';

const at='2026-09-26T06:30:00.000Z';
async function fixture(t:any){
  const root=await mkdtemp(join(tmpdir(),'research-one-shot-v12-'));await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=createResearchVideoSourceV1({
    provider:'YOUTUBE',sourceType:'YOUTUBE_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=abcdefghijk',videoId:'abcdefghijk',
    title:'Synthetic reviewed video',channelOrPublisher:'Test',publishedAt:null,discoveredAt:at,language:'en',durationSec:120,
    transcriptStatus:'AVAILABLE',transcriptSource:'TEST',transcriptAuthorized:true,contentAccessStatus:'AVAILABLE',timestampProvenance:[],
  });
  const spec={schemaVersion:'research-video-spec-v7',videoUrl:source.canonicalUrl,sourceReviewId:'TEST_ONLY',publicAccessReviewed:true,
    durationSec:120,clipStartSec:0,clipEndSec:60,model:'gemini-test',acceptedReportedModels:['gemini-test'],maxOutputTokens:512,timeoutMs:5000};
  const sourcePath=join(root,'source.json'),specPath=join(root,'spec.json');
  await writeFile(sourcePath,JSON.stringify(source),{mode:0o600});await writeFile(specPath,JSON.stringify(spec),{mode:0o600});
  return {root,source,spec,sourcePath,specPath};
}
function geminiResponse(){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return new Response(JSON.stringify({modelVersion:'gemini-test',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({
    videoId:'abcdefghijk',observations:kinds.map((kind,i)=>({atSec:10+i,kind,description:'Synthetic '+kind.toLowerCase()+' claim'})),
    limitations:['Synthetic provider transport only.'],
  })}]}}]}),{status:200,headers:{'content-type':'application/json'}});
}
function groqResponse(){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    findings:kinds.map((_,i)=>({observationIndex:i,verdict:'ACCEPT_AS_CLAIM',reason:'Synthetic structural review only.'})),
    missingRuleKinds:[],disposition:'CONTINUE',summary:'Synthetic adversarial review only.',
  })}}]}),{status:200,headers:{'content-type':'application/json'}});
}

test('prepare mode is network and credential free',async t=>{
  const f=await fixture(t);let envReads=0,calls=0;
  const env=new Proxy({}, {getOwnPropertyDescriptor(){envReads++;throw new Error('must not read env');}}) as any;
  const result=await runResearchWorkspaceOneShotV12({
    mode:'prepare',sourcePath:f.sourcePath,specPath:f.specPath,outputRoot:f.root,pipelineId:'PIPE_V12_TEST',market:'US_STOCK',
  },{env,clock:()=>at,fetchImpl:async()=>{calls++;throw new Error('must not call network');}});
  assert.equal(result.status,'PREPARED_NOT_EXECUTED');assert.deepEqual(result.providerCalls,{gemini:0,groq:0});
  assert.equal(result.credentialRead,false);assert.equal(envReads,0);assert.equal(calls,0);
});

test('execute performs exactly one Gemini and one Groq call then stops for human digest review',async t=>{
  const f=await fixture(t);
  const prepared=await runResearchWorkspaceOneShotV12({
    mode:'prepare',sourcePath:f.sourcePath,specPath:f.specPath,outputRoot:f.root,pipelineId:'PIPE_V12_EXEC',market:'US_STOCK',
  },{clock:()=>at,env:{}});
  const manifest=prepared.manifest;
  const manifestPath=join(f.root,'manifest-'+manifest.manifestDigest+'.json');
  const plan=prepareVideoResearch(f.spec);
  const videoApproval={schemaVersion:'research-video-call-approval-v7',approvalId:'VIDEO_V12',planDigest:plan.planDigest,
    notBefore:'2026-09-26T06:29:00.000Z',expiresAt:'2026-09-26T06:40:00.000Z',maxCalls:1,sourceUseApproved:true,
    freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'};
  const groqApproval={schemaVersion:'research-groq-call-approval-v12',approvalId:'GROQ_V12',orchestratorPlanDigest:manifest.orchestratorPlanDigest,
    notBefore:'2026-09-26T06:29:00.000Z',expiresAt:'2026-09-26T06:40:00.000Z',maxCalls:1,sourceUseApproved:true,
    freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'};
  const videoApprovalPath=join(f.root,'video-approval.json'),groqApprovalPath=join(f.root,'groq-approval.json');
  await writeFile(videoApprovalPath,JSON.stringify(videoApproval),{mode:0o600});
  await writeFile(groqApprovalPath,JSON.stringify(groqApproval),{mode:0o600});
  const env={GEMINI_API_KEY:'synthetic_gemini_key',GROQ_API_KEY:'synthetic_groq_key',GROQ_MODEL:'groq-test'};
  let geminiCalls=0,groqCalls=0;
  const fetchImpl=async(input:any)=>{
    const url=String(input);
    if(url.includes('generativelanguage.googleapis.com')){geminiCalls++;return geminiResponse();}
    if(url.includes('api.groq.com')){groqCalls++;return groqResponse();}
    throw new Error('unexpected network target: '+url);
  };
  const result=await runResearchWorkspaceOneShotV12({
    mode:'execute',sourcePath:f.sourcePath,specPath:f.specPath,manifestPath,videoApprovalPath,groqApprovalPath,outputRoot:f.root,
  },{clock:()=>at,env,fetchImpl:fetchImpl as any});
  assert.equal(result.status,'REVIEW_REQUIRED');
  assert.equal(result.reviewPackage.requiredNextStep,'HUMAN_REVIEW_AND_BIND_RULE_DIGEST_BEFORE_COMPILER');
  assert.match(result.reviewPackage.reviewedRuleDigestCandidate,/^[a-f0-9]{64}$/);
  assert.deepEqual(result.providerCalls,{gemini:1,groq:1});
  assert.equal(geminiCalls,1);assert.equal(groqCalls,1);
  await assert.rejects(()=>runResearchWorkspaceOneShotV12({
    mode:'execute',sourcePath:f.sourcePath,specPath:f.specPath,manifestPath,videoApprovalPath,groqApprovalPath,outputRoot:f.root,
  },{clock:()=>at,env,fetchImpl:fetchImpl as any}),/ONE_SHOT_RUN_ALREADY_EXISTS/);
  assert.equal(geminiCalls,1);assert.equal(groqCalls,1);
});
