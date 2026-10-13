import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResearchVideoSourceV1 } from '../src/video-intelligence.js';
import { prepareVideoResearch } from '../src/research-workspace-video-v7.js';
import { createResearchOneShotManifestV12 } from '../src/research-workspace-one-shot-v12.js';
import { runResearchWorkspaceOneShotV12Runtime } from '../scripts/run-research-one-shot-v12.mjs';

const at='2026-09-26T06:30:00.000Z';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'research-one-shot-runtime-v12-'));await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=createResearchVideoSourceV1({
    provider:'YOUTUBE',sourceType:'YOUTUBE_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=abcdefghijk',videoId:'abcdefghijk',
    title:'Synthetic reviewed video',channelOrPublisher:'Test',publishedAt:null,discoveredAt:at,language:'en',durationSec:120,
    transcriptStatus:'AVAILABLE',transcriptSource:'TEST',transcriptAuthorized:true,contentAccessStatus:'AVAILABLE',timestampProvenance:[],
  });
  const spec={schemaVersion:'research-video-spec-v7',videoUrl:source.canonicalUrl,sourceReviewId:'TEST_ONLY',publicAccessReviewed:true,
    durationSec:120,clipStartSec:0,clipEndSec:60,model:'gemini-test',acceptedReportedModels:['gemini-test'],maxOutputTokens:512,timeoutMs:5000};
  const manifest=createResearchOneShotManifestV12({pipelineId:'PIPE_V12_RUNTIME',createdAt:at,market:'US_STOCK',source,videoSpec:spec});
  const sourcePath=join(root,'source.json'),specPath=join(root,'spec.json'),manifestPath=join(root,'manifest.json');
  await writeFile(sourcePath,JSON.stringify(source),{mode:0o600});
  await writeFile(specPath,JSON.stringify(spec),{mode:0o600});
  await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const plan=prepareVideoResearch(spec);
  const videoApproval={schemaVersion:'research-video-call-approval-v7',approvalId:'VIDEO_RUNTIME_V12',planDigest:plan.planDigest,
    notBefore:'2026-09-26T06:29:00.000Z',expiresAt:'2026-09-26T06:40:00.000Z',maxCalls:1,sourceUseApproved:true,
    freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'};
  const groqApproval={schemaVersion:'research-groq-call-approval-v12',approvalId:'GROQ_RUNTIME_V12',orchestratorPlanDigest:manifest.orchestratorPlanDigest,
    notBefore:'2026-09-26T06:29:00.000Z',expiresAt:'2026-09-26T06:40:00.000Z',maxCalls:1,sourceUseApproved:true,
    freeTierReviewed:true,paidFallback:false,executionAuthority:'NONE'};
  const videoApprovalPath=join(root,'video-approval.json'),groqApprovalPath=join(root,'groq-approval.json');
  await writeFile(videoApprovalPath,JSON.stringify(videoApproval),{mode:0o600});
  await writeFile(groqApprovalPath,JSON.stringify(groqApproval),{mode:0o600});
  return {root,sourcePath,specPath,manifestPath,videoApprovalPath,groqApprovalPath};
}
function geminiResponse(observations=true){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return new Response(JSON.stringify({modelVersion:'gemini-test',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({
    videoId:'abcdefghijk',observations:observations?kinds.map((kind,i)=>({atSec:10+i,kind,description:'Synthetic '+kind.toLowerCase()+' claim'})):[],
    limitations:[observations?'Synthetic provider transport only.':'Synthetic insufficient evidence.'],
  })}]}}]}),{status:200,headers:{'content-type':'application/json'}});
}
function groqResponse(){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    findings:kinds.map((_,i)=>({observationIndex:i,verdict:'ACCEPT_AS_CLAIM',reason:'Synthetic structural review only.'})),
    missingRuleKinds:[],disposition:'CONTINUE',summary:'Synthetic adversarial review only.',
  })}}]}),{status:200,headers:{'content-type':'application/json'}});
}

test('daemon V12 makes exactly one Gemini and one Groq call then stops at human review',async t=>{
  const f=await fixture(t),env={GEMINI_API_KEY:'synthetic_gemini_key',GROQ_API_KEY:'synthetic_groq_key',GROQ_MODEL:'groq-test'};
  let geminiCalls=0,groqCalls=0;
  const fetchImpl=async input=>{
    const url=String(input);
    if(url.includes('generativelanguage.googleapis.com')){geminiCalls++;return geminiResponse(true);}
    if(url.includes('api.groq.com')){groqCalls++;return groqResponse();}
    throw new Error('unexpected network target');
  };
  const out=await runResearchWorkspaceOneShotV12Runtime({
    sourcePath:f.sourcePath,specPath:f.specPath,manifestPath:f.manifestPath,videoApprovalPath:f.videoApprovalPath,
    groqApprovalPath:f.groqApprovalPath,outputRoot:f.root,
  },{clock:()=>at,env,fetchImpl});
  assert.equal(out.status,'REVIEW_REQUIRED');assert.equal(out.reason,'HUMAN_RULE_DIGEST_REVIEW_REQUIRED');
  assert.deepEqual(out.providerCalls,{gemini:1,groq:1});assert.equal(geminiCalls,1);assert.equal(groqCalls,1);
  assert.match(out.reviewedRuleDigestCandidate,/^[a-f0-9]{64}$/);assert.equal(out.executionAuthority,'NONE');
  const replay=await runResearchWorkspaceOneShotV12Runtime({
    sourcePath:f.sourcePath,specPath:f.specPath,manifestPath:f.manifestPath,videoApprovalPath:f.videoApprovalPath,
    groqApprovalPath:f.groqApprovalPath,outputRoot:f.root,
  },{clock:()=>at,env,fetchImpl}).catch(e=>e);
  assert.equal(replay.code,'ONE_SHOT_RUN_ALREADY_EXISTS');assert.equal(geminiCalls,1);assert.equal(groqCalls,1);
});
test('daemon V12 stops after insufficient Gemini evidence and never calls Groq',async t=>{
  const f=await fixture(t),env={GEMINI_API_KEY:'synthetic_gemini_key',GROQ_API_KEY:'synthetic_groq_key',GROQ_MODEL:'groq-test'};
  let geminiCalls=0,groqCalls=0;
  const fetchImpl=async input=>{
    const url=String(input);
    if(url.includes('generativelanguage.googleapis.com')){geminiCalls++;return geminiResponse(false);}
    if(url.includes('api.groq.com')){groqCalls++;return groqResponse();}
    throw new Error('unexpected network target');
  };
  const out=await runResearchWorkspaceOneShotV12Runtime({
    sourcePath:f.sourcePath,specPath:f.specPath,manifestPath:f.manifestPath,videoApprovalPath:f.videoApprovalPath,
    groqApprovalPath:f.groqApprovalPath,outputRoot:f.root,
  },{clock:()=>at,env,fetchImpl});
  assert.equal(out.status,'REVIEW_REQUIRED');assert.equal(out.reason,'GEMINI_INSUFFICIENT_EVIDENCE');
  assert.deepEqual(out.providerCalls,{gemini:1,groq:0});assert.equal(geminiCalls,1);assert.equal(groqCalls,0);
});
