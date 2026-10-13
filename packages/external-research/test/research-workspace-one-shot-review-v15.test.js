import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProviderReviewPackageV12 } from '../src/research-workspace-one-shot-v12.js';
import { readResearchOneShotReviewV15 } from '../src/research-workspace-one-shot-review-v15.js';

const at='2026-09-26T08:00:00.000Z';
const manifest={schemaVersion:'research-one-shot-manifest-v12',pipelineId:'PIPE_V15',createdAt:at,market:'US_STOCK',sourceId:'source-v15',
  sourceDigest:'1'.repeat(64),videoPlanDigest:'2'.repeat(64),orchestratorPlanDigest:'3'.repeat(64),
  providerSequence:['gemini','groq'],requiredStopAfterProviders:'HUMAN_RULE_DIGEST_REVIEW',
  authority:{executionAuthority:'NONE',automaticActivation:false,automaticAdoption:false,paidFallback:false,maxGeminiCalls:1,maxGroqCalls:1},
  manifestDigest:'4'.repeat(64)};
const observations=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'].map((kind,i)=>({
  atSec:20+i,kind,description:'Synthetic '+kind.toLowerCase()+' claim',origin:'MODEL_OBSERVATION',semanticReview:'PENDING',timestampVerified:false,
}));
const gemini={schemaVersion:'research-video-receipt-v7',status:'RESPONSE_RECEIVED_REVIEW_REQUIRED',observations,limitations:['Synthetic only'],
  missingRuleKinds:[],reportedModel:'gemini-test',usage:null,planDigest:manifest.videoPlanDigest,requestSha256:'5'.repeat(64),responseSha256:'6'.repeat(64),
  callsAttempted:1,statusCode:200,startedAt:at,completedAt:at,videoBytesSha256:null,sourceTruthVerified:false,entireVideoVerified:false,
  run:null,dailyTargetStatus:'NOT_EVALUATED',authority:{executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0,autoCompile:false,
    autoPublish:false,automaticAdoption:false,profitabilityProven:false,paidFallback:false}};
const groq={schemaVersion:'research-groq-adversarial-review-v10',provider:'groq',model:'groq-test',requestDigest:'7'.repeat(64),evidenceDigest:'8'.repeat(64),
  findings:observations.map((_,i)=>({observationIndex:i,verdict:i===0?'CHALLENGE':'ACCEPT_AS_CLAIM',reason:'Synthetic review reason.'})),
  missingRuleKinds:['ENTRY'],disposition:'REVIEW_REQUIRED',summary:'Synthetic adversarial review.',
  authority:{researchOnly:true,numericPerformanceAuthority:false,executionAuthority:'NONE',automaticAdoption:false}};
const pkg=buildProviderReviewPackageV12({manifest,geminiReceipt:gemini,groqReview:groq});

async function rootFixture(t){
  const root=await mkdtemp(join(tmpdir(),'one-shot-review-v15-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  const runDir=join(root,'one-shot-'+manifest.manifestDigest);await mkdir(runDir,{mode:0o700});
  return {root,runDir};
}
async function writeJson(path,value,mode=0o600){await writeFile(path,JSON.stringify(value),{mode});}

test('reader exposes only sanitized Gemini claims and Groq verdicts for human digest review',async t=>{
  const f=await rootFixture(t);
  await writeJson(join(f.runDir,'gemini-receipt.json'),gemini);
  await writeJson(join(f.runDir,'groq-review.json'),groq);
  await writeJson(join(f.runDir,'review-package.json'),pkg);
  await writeJson(join(f.runDir,'state-review-required.json'),{schemaVersion:'research-one-shot-state-v12',status:'REVIEW_REQUIRED',
    reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest:manifest.manifestDigest,packageDigest:pkg.packageDigest,
    reviewedRuleDigestCandidate:pkg.reviewedRuleDigestCandidate,providerCalls:{gemini:1,groq:1},executionAuthority:'NONE',
    automaticAdoption:false,profitabilityProven:false});
  const result=await readResearchOneShotReviewV15(f.root,{checkedAt:at});
  assert.equal(result.available,true);if(!result.available)return;
  assert.equal(result.status,'HUMAN_RULE_DIGEST_REVIEW');
  assert.equal(result.observations.length,5);
  assert.equal(result.observations[0].verdict,'CHALLENGE');
  assert.equal(result.packageDigest,pkg.packageDigest);
  assert.equal(result.reviewedRuleDigestCandidate,pkg.reviewedRuleDigestCandidate);
  assert.deepEqual(result.providerCalls,{gemini:1,groq:1});
  assert.equal(result.authority.providerCallsFromRead,0);
  assert.equal(result.authority.automaticBinding,false);
  assert.equal(result.authority.automaticCompiler,false);
  assert.equal(result.authority.automaticBacktest,false);
  assert.equal(result.authority.executionAuthority,'NONE');
  assert.doesNotMatch(JSON.stringify(result),/api[_ -]?key|Bearer|private[_ -]?key/i);
});

test('Gemini insufficient evidence is a distinct no-retry source-review state',async t=>{
  const f=await rootFixture(t);
  const insufficient={...gemini,status:'INSUFFICIENT_EVIDENCE',observations:[],limitations:['Video content was insufficient for reviewed rules.']};
  await writeJson(join(f.runDir,'gemini-receipt.json'),insufficient);
  await writeJson(join(f.runDir,'state-review-required.json'),{schemaVersion:'research-one-shot-state-v12',status:'REVIEW_REQUIRED',
    reason:'GEMINI_INSUFFICIENT_EVIDENCE',manifestDigest:manifest.manifestDigest,providerCalls:{gemini:1,groq:0},executionAuthority:'NONE'});
  const result=await readResearchOneShotReviewV15(f.root,{checkedAt:at});
  assert.equal(result.available,true);if(!result.available)return;
  assert.equal(result.status,'SOURCE_EVIDENCE_REVIEW_NO_RETRY');
  assert.equal(result.packageDigest,null);
  assert.equal(result.reviewedRuleDigestCandidate,null);
  assert.deepEqual(result.providerCalls,{gemini:1,groq:0});
  assert.equal(result.groq,null);
  assert.deepEqual(result.observations,[]);
});

test('forged package or adoption authority fails closed',async t=>{
  const f=await rootFixture(t);
  await writeJson(join(f.runDir,'gemini-receipt.json'),gemini);
  await writeJson(join(f.runDir,'groq-review.json'),groq);
  await writeJson(join(f.runDir,'review-package.json'),{...pkg,automaticAdoption:true});
  await writeJson(join(f.runDir,'state-review-required.json'),{schemaVersion:'research-one-shot-state-v12',status:'REVIEW_REQUIRED',
    reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest:manifest.manifestDigest,packageDigest:pkg.packageDigest,
    reviewedRuleDigestCandidate:pkg.reviewedRuleDigestCandidate,executionAuthority:'NONE'});
  await assert.rejects(()=>readResearchOneShotReviewV15(f.root,{checkedAt:at}),/ONE_SHOT_REVIEW_PACKAGE_INVALID/);
});

test('unsafe manifest permissions are rejected rather than treated as unavailable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'one-shot-review-v15-unsafe-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
  await writeJson(join(root,'manifest.json'),manifest,0o644);
  await assert.rejects(()=>readResearchOneShotReviewV15(root,{checkedAt:at}),/ONE_SHOT_REVIEW_FILE_UNSAFE/);
});
