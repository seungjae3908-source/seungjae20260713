import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,writeFile,rm,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
 createResearchOrchestratorPlanV10,createGroqAdversarialReviewRequestV10,assessRuleCompletenessV10,
 runResearchOrchestratorV10,summarizeResearchOrchestratorStatusV10,readResearchOrchestratorStatusV10
} from '../src/research-workspace-orchestrator-v10.js';

const hex=c=>c.repeat(64);
const plan=()=>createResearchOrchestratorPlanV10({schemaVersion:'research-orchestrator-request-v10',pipelineId:'PIPE_TEST',createdAt:'2026-09-26T05:30:00.000Z',
 market:'US_STOCK',sourceId:'YT_TEST',sourceDigest:hex('a'),videoPlanDigest:hex('b')});
const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
const receipt=(p,override={})=>({schemaVersion:'research-video-receipt-v7',status:'RESPONSE_RECEIVED_REVIEW_REQUIRED',planDigest:p.videoPlanDigest,
 sourceTruthVerified:false,entireVideoVerified:false,run:null,authority:{executionAuthority:'NONE',profitabilityProven:false},
 observations:kinds.map((kind,i)=>({atSec:10+i,kind,description:`Synthetic ${kind.toLowerCase()} claim for offline contract QA.`,origin:'MODEL_OBSERVATION',semanticReview:'PENDING',timestampVerified:false})),
 limitations:['Synthetic transport only.'],...override});
const review=(request,override={})=>({schemaVersion:'research-groq-adversarial-review-v10',provider:'groq',model:'groq-test',
 requestDigest:request.requestDigest,evidenceDigest:request.evidenceDigest,
 findings:request.claims.map(c=>({observationIndex:c.observationIndex,verdict:'ACCEPT_AS_CLAIM',reason:'Claim is structurally testable but remains unverified evidence.'})),
 missingRuleKinds:[],disposition:'CONTINUE',summary:'No structural omission found; independent deterministic testing is still required.',
 authority:{researchOnly:true,numericPerformanceAuthority:false,executionAuthority:'NONE',automaticAdoption:false},...override});

test('plan fixes provider order, market bucket and no execution authority',()=>{const p=plan();assert.deepEqual(p.providerSequence,['youtube','gemini','groq']);assert.equal(p.marketBucket,'STOCK');assert.equal(p.authority.executionAuthority,'NONE');assert.equal(p.authority.lossRetryToProfit,false);});
test('Groq request contains Gemini claims but cannot add rules or numeric authority',()=>{const p=plan(),r=createGroqAdversarialReviewRequestV10(p,receipt(p));assert.equal(r.role,'ADVERSARIAL_CRITIC');assert.equal(r.constraints.mayAddRules,false);assert.equal(r.constraints.numericPerformanceAuthority,false);assert.equal(r.claims.length,5);});
test('challenged claim makes rule completeness require review rather than inventing a replacement',()=>{const p=plan(),g=receipt(p),q=createGroqAdversarialReviewRequestV10(p,g),x=review(q);x.findings[0]={...x.findings[0],verdict:'CHALLENGE'};const a=assessRuleCompletenessV10(p,g,q,x);assert.equal(a.status,'REVIEW_REQUIRED');assert.ok(a.missingRuleKinds.includes('ENTRY'));assert.equal(a.groqCanAddMissingRules,false);});
test('missing Gemini rule cannot be supplied by Groq',()=>{const p=plan(),g=receipt(p,{observations:receipt(p).observations.filter(x=>x.kind!=='STOP_LOSS')}),q=createGroqAdversarialReviewRequestV10(p,g),x=review(q);const a=assessRuleCompletenessV10(p,g,q,x);assert.equal(a.status,'REVIEW_REQUIRED');assert.ok(a.missingRuleKinds.includes('STOP_LOSS'));});
test('complete chain records negative backtest once and never retries to profit',async()=>{const p=plan(),g=receipt(p);let backtests=0,stores=0;
 const out=await runResearchOrchestratorV10({plan:p,runGeminiVideo:async()=>g,runGroqReview:async q=>review(q),
  compileCanonical:async()=>({status:'READY',compiler:'video-research-canonical-handoff-v1',handoffDigest:hex('c'),hypothesisId:'H_TEST',reason:null}),
  runBacktest:async()=>{backtests++;return {status:'BACKTEST_RECORDED',backtester:'evidence-backed-formula-tournament-adapter-v1',market:'US_STOCK',resultDigest:hex('d'),metrics:{netReturn:-0.12,maxDrawdown:0.08,tradeCount:31,fullCostIncluded:true},reason:null};},
  persistResult:async r=>{stores++;return {status:'STORED',resultDigest:r.resultDigest,marketBucket:r.marketBucket};}});
 assert.equal(out.status,'COMPLETED');assert.equal(out.result.researchOutcome,'LOSS_RECORDED');assert.equal(out.result.lossRetryToProfit,false);assert.equal(out.result.adoptionStatus,'REVIEW_REQUIRED');assert.equal(backtests,1);assert.equal(stores,1);
});
test('AI agreement never bypasses canonical compiler review',async()=>{const p=plan(),g=receipt(p);let backtests=0;
 const out=await runResearchOrchestratorV10({plan:p,runGeminiVideo:async()=>g,runGroqReview:async q=>review(q),
  compileCanonical:async()=>({status:'REVIEW_REQUIRED',reason:'ACADEMIC_SUPPORT_REQUIRED'}),runBacktest:async()=>{backtests++;},persistResult:async()=>{throw new Error('not reached');}});
 assert.equal(out.status,'REVIEW_REQUIRED');assert.equal(out.currentStage,'CANONICAL_COMPILER');assert.equal(backtests,0);
});
test('backtest numeric authority must be the existing adapter identity',async()=>{const p=plan(),g=receipt(p);
 await assert.rejects(()=>runResearchOrchestratorV10({plan:p,runGeminiVideo:async()=>g,runGroqReview:async q=>review(q),
  compileCanonical:async()=>({status:'READY',compiler:'video-research-canonical-handoff-v1',handoffDigest:hex('c'),hypothesisId:'H_TEST',reason:null}),
  runBacktest:async()=>({status:'BACKTEST_RECORDED',backtester:'ai-guessed-return',market:'US_STOCK',resultDigest:hex('d'),metrics:{netReturn:1,maxDrawdown:0,tradeCount:1,fullCostIncluded:true},reason:null}),
  persistResult:async()=>({})}),/BACKTEST_RESULT_INVALID/);
});
test('stock and crypto completion counts remain separate',()=>{const s=summarizeResearchOrchestratorStatusV10([
 {market:'US_STOCK',status:'COMPLETED',currentStage:'ADOPTION_REVIEW'},{market:'CRYPTO_SPOT',status:'COMPLETED',currentStage:'ADOPTION_REVIEW'},
 {market:'CRYPTO_FUTURES',status:'REVIEW_REQUIRED',currentStage:'BACKTEST'}],{checkedAt:'2026-09-26T05:30:00.000Z'});
 assert.equal(s.markets.stockCompleted,1);assert.equal(s.markets.cryptoCompleted,1);assert.equal(s.totals.reviewRequired,1);assert.equal(s.authority.profitabilityAuthority,'BACKTESTER_ONLY');
});
test('missing orchestrator store is unavailable, not zero completion',async()=>{const root=join(tmpdir(),`missing-orch-${process.pid}-phase10`);const s=await readResearchOrchestratorStatusV10(root);assert.equal(s.available,false);assert.equal(s.reason,'ORCHESTRATOR_NOT_ACTIVATED');});
test('status reader accepts only private exact status file',async t=>{const root=await mkdtemp(join(tmpdir(),'orch-v10-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
 const status=summarizeResearchOrchestratorStatusV10([{market:'KR_STOCK',status:'PROCESSING',currentStage:'GROQ_ADVERSARIAL_REVIEW'}],{checkedAt:'2026-09-26T05:30:00.000Z'});
 await writeFile(join(root,'orchestrator-status-v10.json'),JSON.stringify(status),{mode:0o600});assert.deepEqual(await readResearchOrchestratorStatusV10(root),status);
});
test('world-readable status file is rejected',async t=>{const root=await mkdtemp(join(tmpdir(),'orch-v10-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
 const status=summarizeResearchOrchestratorStatusV10([],{checkedAt:'2026-09-26T05:30:00.000Z'});const path=join(root,'orchestrator-status-v10.json');await writeFile(path,JSON.stringify(status),{mode:0o644});await assert.rejects(()=>readResearchOrchestratorStatusV10(root),/FILE_UNSAFE/);
});
