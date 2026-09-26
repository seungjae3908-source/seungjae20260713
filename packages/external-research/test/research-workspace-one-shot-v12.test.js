import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchVideoSourceV1 } from '../src/video-intelligence.js';
import { createGroqAdversarialReviewRequestV10, createResearchOrchestratorPlanV10 } from '../src/research-workspace-orchestrator-v10.js';
import {
  createResearchOneShotManifestV12, verifyGroqCallApprovalV12, buildGroqReviewPromptV12,
  parseGroqReviewResponseV12, buildProviderReviewPackageV12,
} from '../src/research-workspace-one-shot-v12.js';

const at='2026-09-26T06:30:00.000Z';
const source=createResearchVideoSourceV1({
  provider:'YOUTUBE',sourceType:'YOUTUBE_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=abcdefghijk',
  videoId:'abcdefghijk',title:'Synthetic',channelOrPublisher:'Test',publishedAt:null,discoveredAt:at,language:'en',
  durationSec:120,transcriptStatus:'AVAILABLE',transcriptSource:'TEST',transcriptAuthorized:true,
  contentAccessStatus:'AVAILABLE',timestampProvenance:[],
});
const spec={
  schemaVersion:'research-video-spec-v7',videoUrl:source.canonicalUrl,sourceReviewId:'TEST_ONLY',publicAccessReviewed:true,
  durationSec:120,clipStartSec:0,clipEndSec:60,model:'gemini-test',acceptedReportedModels:['gemini-test'],maxOutputTokens:256,timeoutMs:1000,
};
const manifest=createResearchOneShotManifestV12({pipelineId:'PIPE_V12',createdAt:at,market:'US_STOCK',source,videoSpec:spec});
const plan=createResearchOrchestratorPlanV10({
  schemaVersion:'research-orchestrator-request-v10',pipelineId:manifest.pipelineId,createdAt:manifest.createdAt,market:manifest.market,
  sourceId:manifest.sourceId,sourceDigest:manifest.sourceDigest,videoPlanDigest:manifest.videoPlanDigest,
});
const observations=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'].map((kind,i)=>({
  atSec:10+i,kind,description:'Synthetic '+kind.toLowerCase()+' claim',origin:'MODEL_OBSERVATION',
  semanticReview:'PENDING',timestampVerified:false,
}));
const geminiReceipt={
  schemaVersion:'research-video-receipt-v7',status:'RESPONSE_RECEIVED_REVIEW_REQUIRED',observations,limitations:['Synthetic'],
  missingRuleKinds:[],reportedModel:'gemini-test',usage:null,planDigest:manifest.videoPlanDigest,requestSha256:'a'.repeat(64),
  responseSha256:'b'.repeat(64),callsAttempted:1,statusCode:200,startedAt:at,completedAt:at,videoBytesSha256:null,
  sourceTruthVerified:false,entireVideoVerified:false,run:null,dailyTargetStatus:'NOT_EVALUATED',
  authority:{executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0,autoCompile:false,autoPublish:false,automaticAdoption:false,profitabilityProven:false,paidFallback:false},
};
const request=createGroqAdversarialReviewRequestV10(plan,geminiReceipt);

function validRaw(){
  return JSON.stringify({
    findings:request.claims.map(c=>({observationIndex:c.observationIndex,verdict:'ACCEPT_AS_CLAIM',reason:'Synthetic structural review.'})),
    missingRuleKinds:[],disposition:'CONTINUE',summary:'Synthetic review only.',
  });
}

test('one-shot manifest pins video and orchestrator identities and two-call maximum',()=>{
  assert.match(manifest.manifestDigest,/^[a-f0-9]{64}$/);
  assert.equal(manifest.orchestratorPlanDigest,plan.planDigest);
  assert.deepEqual(manifest.providerSequence,['gemini','groq']);
  assert.equal(manifest.authority.maxGeminiCalls,1);
  assert.equal(manifest.authority.maxGroqCalls,1);
  assert.equal(manifest.requiredStopAfterProviders,'HUMAN_RULE_DIGEST_REVIEW');
});

test('Groq approval is exact-plan, one-call and time bounded',()=>{
  const approval={
    schemaVersion:'research-groq-call-approval-v12',approvalId:'GROQ_TEST',
    orchestratorPlanDigest:manifest.orchestratorPlanDigest,notBefore:'2026-09-26T06:29:00.000Z',
    expiresAt:'2026-09-26T06:40:00.000Z',maxCalls:1,sourceUseApproved:true,freeTierReviewed:true,
    paidFallback:false,executionAuthority:'NONE',
  };
  assert.equal(verifyGroqCallApprovalV12(approval,manifest,at),true);
  assert.throws(()=>verifyGroqCallApprovalV12({...approval,maxCalls:2},manifest,at),/GROQ_APPROVAL_INVALID/);
});

test('Groq prompt requests complete critique and forbids invented rules',()=>{
  const prompt=buildGroqReviewPromptV12(request);
  assert.match(prompt,/exactly one row for every observationIndex/);
  assert.match(prompt,/Never invent a missing rule/);
  assert.match(prompt,/EVIDENCE_JSON=/);
});

test('strict Groq parser requires coverage of every observation',()=>{
  const review=parseGroqReviewResponseV12(validRaw(),{request,model:'groq-test'});
  assert.equal(review.findings.length,request.claims.length);
  const partial=JSON.parse(validRaw());
  partial.findings=partial.findings.slice(1);
  assert.throws(()=>parseGroqReviewResponseV12(JSON.stringify(partial),{request,model:'groq-test'}),/GROQ_REVIEW_OUTPUT_INVALID/);
});

test('provider package always stops for human digest review before compiler',()=>{
  const review=parseGroqReviewResponseV12(validRaw(),{request,model:'groq-test'});
  const pkg=buildProviderReviewPackageV12({manifest,geminiReceipt,groqReview:review});
  assert.equal(pkg.status,'REVIEW_REQUIRED');
  assert.equal(pkg.requiredNextStep,'HUMAN_REVIEW_AND_BIND_RULE_DIGEST_BEFORE_COMPILER');
  assert.deepEqual(pkg.providerCalls,{gemini:1,groq:1});
  assert.equal(pkg.profitabilityProven,false);
  assert.equal(pkg.automaticAdoption,false);
  assert.equal(pkg.executionAuthority,'NONE');
});
