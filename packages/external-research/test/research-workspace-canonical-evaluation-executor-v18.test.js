import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHumanRuleDigestDecisionV16 } from '../src/research-workspace-one-shot-bind-v16.js';
import { assessCanonicalEvaluationReadinessV17 } from '../src/research-workspace-canonical-evaluation-readiness-v17.js';
import { createCanonicalEvaluationExecutionRequestV18 } from '../src/research-workspace-canonical-evaluation-one-shot-v18.js';
import { executeCanonicalEvaluationOneShotV18 } from '../src/research-workspace-canonical-evaluation-executor-v18.js';

const now='2026-09-26T08:40:00.000Z',sourceSha='a'.repeat(40),manifestDigest='b'.repeat(64),packageDigest='c'.repeat(64),reviewedRuleDigest='d'.repeat(64);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
function review(){const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];return {schemaVersion:'research-one-shot-review-v15',available:true,checkedAt:now,status:'HUMAN_RULE_DIGEST_REVIEW',reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest,packageDigest,reviewedRuleDigestCandidate:reviewedRuleDigest,providerCalls:{gemini:1,groq:1},sourceTruthVerified:false,entireVideoVerified:false,observations:kinds.map((kind,i)=>({observationIndex:i,atSec:10+i,kind,description:'Synthetic '+kind,verdict:'ACCEPT_AS_CLAIM',reason:'Reviewed.'})),limitations:['Synthetic only'],groq:{summary:'Reviewed.',disposition:'CONTINUE'},missingRuleKinds:[],authority:{readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,automaticBacktest:false,automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'}};}
function decision(r){return createHumanRuleDigestDecisionV16(r,{schemaVersion:'research-human-rule-digest-binding-request-v16',bindingId:'binding-executor-v18',reviewerId:'owner',decidedAt:'2026-09-26T08:35:00.000Z',expiresAt:'2026-09-26T09:00:00.000Z',manifestDigest,packageDigest,reviewedRuleDigest,acknowledgements:{sourceTruthNotVerified:true,entireVideoNotVerified:true,aiAgreementIsNotProfitabilityEvidence:true,researchOnly:true,noAutomaticAdoption:true}});}
function binding(ownerRefs,capability){return {status:'AVAILABLE',ownerRefs,capability,sourceSha,evidenceId:'evidence-'+capability.toLowerCase(),properties:{runtimeActivationAllowed:false,scheduleMutationAllowed:false,deploymentAllowed:false,finalHoldoutPreAccessAllowed:false,arbitraryExecutableCodeAllowed:false,profitabilityClaimAllowed:false,executionAuthority:'NONE'}};}
function dataset(role){return {role,datasetIdentity:'dataset:'+role.toLowerCase(),datasetDigest:sha({role}),frozen:true,selectionFeedbackAllowed:false};}
function config(){const core={schemaVersion:'research-canonical-evaluation-config-v17',configId:'eval-executor-v18',createdAt:'2026-09-26T08:30:00.000Z',sourceSha,manifestDigest,packageDigest,reviewedRuleDigest,market:'US_STOCK',side:'LONG',timeframe:'1h',strategyFamily:'TREND_ADX',symbolScope:['SPY'],categories:['TREND_FOLLOWING'],crossValidation:{supportingPaperBundleDigest:'1'.repeat(64),contradictoryPaperBundleDigest:null,officialSourceBundleDigest:null,supportingPaperCount:1,contradictoryPaperCount:0,allSourcesReviewed:true},canonicalCoreDigest:'2'.repeat(64),seedProfileId:'US_STOCK:SWING',templateSetDigest:'3'.repeat(64),compilerPolicyDigest:'4'.repeat(64),tournamentPolicyDigest:'5'.repeat(64),datasets:{train:dataset('TRAIN'),oos:dataset('OOS'),purgedOos:dataset('PURGED_OOS'),walkForward:dataset('WALK_FORWARD'),costStress:dataset('COST_STRESS'),regimeStress:dataset('REGIME_STRESS'),finalHoldout:dataset('FINAL_HOLDOUT')},runtimeBindings:{stageCheckpointExecutor:binding(['#551'],'TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1'),canonicalBundleSource:binding(['#821','#833'],'AUTHENTIC_CANONICAL_BUNDLE_SOURCE_V1'),formulaCompiler:binding(['#550'],'BOUNDED_FORMULA_COMPILER_V1'),canonicalBacktester:binding(['#690'],'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1'),statisticalFirewall:binding(['#547'],'CANONICAL_STATISTICAL_FIREWALL_V1')},authority:{providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,profitabilityProven:false,liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE'}};return {...core,configDigest:sha(core)};}
function proof(){const dependencies={formulaCompiler:{status:'PRESENT',ownerRef:'#550',capability:'BOUNDED_FORMULA_COMPILER_V1',implementationPath:'market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js',implementationBlobSha:'1'.repeat(40)},canonicalBacktester:{status:'PRESENT',ownerRef:'#690',capability:'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1',implementationPath:'market-prediction-lab/src/independent-strategy-backtest.js',implementationBlobSha:'2'.repeat(40)},statisticalFirewall:{status:'PRESENT',ownerRef:'#547',capability:'CANONICAL_STATISTICAL_FIREWALL_V1',implementationPath:'market-prediction-lab/src/global-strategy-statistical-firewall-v1.js',implementationBlobSha:'3'.repeat(40)},statisticalFirewallAdapter:{status:'PRESENT',ownerRef:'#547',capability:'TOURNAMENT_STATISTICAL_FIREWALL_ADAPTER_V1',implementationPath:'market-prediction-lab/src/research-tournament-statistical-firewall-adapter-v1.js',implementationBlobSha:'4'.repeat(40)}};const core={schemaVersion:'research-canonical-evaluation-runtime-proof-v18',sourceSha,verifiedAt:'2026-09-26T08:39:30.000Z',dependencies};return {...core,proofDigest:sha(core)};}
function fixture(){const r=review(),d=decision(r),c=config(),p=assessCanonicalEvaluationReadinessV17({config:c,currentSha:sourceSha,review:r,decision:d,checkedAt:now}),runtimeProof=proof();const request=createCanonicalEvaluationExecutionRequestV18({evaluationId:'executor-v18',requestedAt:'2026-09-26T08:39:00.000Z',expiresAt:'2026-09-26T08:55:00.000Z',currentSha:sourceSha,decision:d,config:c,preflight:p,runtimeProof});return {request,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof,checkedAt:now};}

test('reservation is acquired before exactly one compiler and one backtest call',async()=>{
  const input=fixture(),events=[];
  const out=await executeCanonicalEvaluationOneShotV18(input,{
    reserve:async()=>{events.push('reserve');return {acquired:true};},
    compileCanonical:async()=>{events.push('compile');return {status:'READY',handoffDigest:'e'.repeat(64)};},
    runBacktest:async()=>{events.push('backtest');return {status:'BACKTEST_RECORDED',backtesterCalls:1,resultDigest:'f'.repeat(64),metrics:{netReturn:0,maxDrawdown:0,tradeCount:1,fullCostIncluded:true}};},
    persistResult:async value=>{events.push('persist');return {stored:true,requestDigest:value.requestDigest};},
  });
  assert.deepEqual(events,['reserve','compile','backtest','persist']);
  assert.equal(out.status,'RESEARCH_EVIDENCE_RECORDED');assert.equal(out.compilerRuns,1);assert.equal(out.backtestRuns,1);
  assert.equal(out.automaticAdoption,false);assert.equal(out.paperActivation,false);assert.equal(out.liveActivation,false);assert.equal(out.executionAuthority,'NONE');
});
test('existing reservation blocks replay before compiler or backtest',async()=>{
  const input=fixture();let calls=0;
  const out=await executeCanonicalEvaluationOneShotV18(input,{reserve:async()=>({acquired:false}),compileCanonical:async()=>{calls++;},runBacktest:async()=>{calls++;},persistResult:async()=>{calls++;}});
  assert.equal(out.status,'BLOCKED');assert.equal(out.reason,'ONE_SHOT_REPLAY_FORBIDDEN');assert.equal(calls,0);assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);
});
test('compiler review requirement stops before backtest and persists the result',async()=>{
  const input=fixture();let backtests=0;
  const out=await executeCanonicalEvaluationOneShotV18(input,{reserve:async()=>({acquired:true}),compileCanonical:async()=>({status:'REVIEW_REQUIRED',reason:'RULE_REVIEW_REQUIRED'}),runBacktest:async()=>{backtests++;},persistResult:async value=>({stored:true,requestDigest:value.requestDigest})});
  assert.equal(out.status,'REVIEW_REQUIRED');assert.equal(out.compilerRuns,1);assert.equal(out.backtestRuns,0);assert.equal(backtests,0);
});

test('backtester call count above one fails closed even if callback claims success',async()=>{
  const input=fixture();
  const out=await executeCanonicalEvaluationOneShotV18(input,{
    reserve:async()=>({acquired:true}),
    compileCanonical:async()=>({status:'READY',handoffDigest:'e'.repeat(64)}),
    runBacktest:async()=>({status:'BACKTEST_RECORDED',backtesterCalls:2,resultDigest:'f'.repeat(64)}),
    persistResult:async value=>({stored:true,requestDigest:value.requestDigest}),
  });
  assert.equal(out.status,'BLOCKED');assert.equal(out.reason,'BACKTEST_RUN_BOUND_VIOLATION');assert.equal(out.backtestRuns,0);
});
