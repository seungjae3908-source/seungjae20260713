import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHumanRuleDigestDecisionV16 } from '../src/research-workspace-one-shot-bind-v16.js';
import { assessCanonicalEvaluationReadinessV17 } from '../src/research-workspace-canonical-evaluation-readiness-v17.js';
import { assessCanonicalEvaluationExecutionContractV18 } from '../src/research-workspace-canonical-evaluation-one-shot-v18.js';

const now='2026-09-26T08:40:00.000Z';
const sourceSha='a'.repeat(40),manifestDigest='b'.repeat(64),packageDigest='c'.repeat(64),reviewedRuleDigest='d'.repeat(64);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');

function review(){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return {schemaVersion:'research-one-shot-review-v15',available:true,checkedAt:now,status:'HUMAN_RULE_DIGEST_REVIEW',
    reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest,packageDigest,reviewedRuleDigestCandidate:reviewedRuleDigest,
    providerCalls:{gemini:1,groq:1},sourceTruthVerified:false,entireVideoVerified:false,
    observations:kinds.map((kind,i)=>({observationIndex:i,atSec:10+i,kind,description:'Synthetic '+kind,verdict:'ACCEPT_AS_CLAIM',reason:'Synthetic structural review.'})),
    limitations:['Synthetic only'],groq:{summary:'Synthetic review.',disposition:'CONTINUE'},missingRuleKinds:[],
    authority:{readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,automaticBacktest:false,automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'}};
}
function decision(r=review()){
  return createHumanRuleDigestDecisionV16(r,{schemaVersion:'research-human-rule-digest-binding-request-v16',bindingId:'binding-v18',reviewerId:'owner',
    decidedAt:'2026-09-26T08:35:00.000Z',expiresAt:'2026-09-26T09:00:00.000Z',manifestDigest,packageDigest,reviewedRuleDigest,
    acknowledgements:{sourceTruthNotVerified:true,entireVideoNotVerified:true,aiAgreementIsNotProfitabilityEvidence:true,researchOnly:true,noAutomaticAdoption:true}});
}
function binding(ownerRefs,capability){
  return {status:'AVAILABLE',ownerRefs,capability,sourceSha,evidenceId:'evidence-'+capability.toLowerCase(),
    properties:{runtimeActivationAllowed:false,scheduleMutationAllowed:false,deploymentAllowed:false,finalHoldoutPreAccessAllowed:false,arbitraryExecutableCodeAllowed:false,profitabilityClaimAllowed:false,executionAuthority:'NONE'}};
}
function dataset(role){return {role,datasetIdentity:'dataset:'+role.toLowerCase(),datasetDigest:sha({role}),frozen:true,selectionFeedbackAllowed:false};}
function config(){
  const core={schemaVersion:'research-canonical-evaluation-config-v17',configId:'eval-v18',createdAt:'2026-09-26T08:30:00.000Z',
    sourceSha,manifestDigest,packageDigest,reviewedRuleDigest,market:'US_STOCK',side:'LONG',timeframe:'1h',strategyFamily:'TREND_ADX',symbolScope:['SPY'],categories:['TREND_FOLLOWING'],
    crossValidation:{supportingPaperBundleDigest:'1'.repeat(64),contradictoryPaperBundleDigest:null,officialSourceBundleDigest:null,supportingPaperCount:1,contradictoryPaperCount:0,allSourcesReviewed:true},
    canonicalCoreDigest:'2'.repeat(64),seedProfileId:'US_STOCK:SWING',templateSetDigest:'3'.repeat(64),compilerPolicyDigest:'4'.repeat(64),tournamentPolicyDigest:'5'.repeat(64),
    datasets:{train:dataset('TRAIN'),oos:dataset('OOS'),purgedOos:dataset('PURGED_OOS'),walkForward:dataset('WALK_FORWARD'),costStress:dataset('COST_STRESS'),regimeStress:dataset('REGIME_STRESS'),finalHoldout:dataset('FINAL_HOLDOUT')},
    runtimeBindings:{stageCheckpointExecutor:binding(['#551'],'TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1'),canonicalBundleSource:binding(['#821','#833'],'AUTHENTIC_CANONICAL_BUNDLE_SOURCE_V1'),
      formulaCompiler:binding(['#550'],'BOUNDED_FORMULA_COMPILER_V1'),canonicalBacktester:binding(['#690'],'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1'),statisticalFirewall:binding(['#547'],'CANONICAL_STATISTICAL_FIREWALL_V1')},
    authority:{providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,profitabilityProven:false,liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE'}};
  return {...core,configDigest:sha(core)};
}
function preflight(r,d,c,checkedAt=now){return assessCanonicalEvaluationReadinessV17({config:c,currentSha:sourceSha,review:r,decision:d,checkedAt});}
function runtimeProof(overrides={}){
  const dependencies={
    formulaCompiler:{status:'PRESENT',ownerRef:'#550',capability:'BOUNDED_FORMULA_COMPILER_V1',implementationPath:'market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js',implementationBlobSha:'1'.repeat(40)},
    canonicalBacktester:{status:'PRESENT',ownerRef:'#690',capability:'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1',implementationPath:'market-prediction-lab/src/independent-strategy-backtest.js',implementationBlobSha:'2'.repeat(40)},
    statisticalFirewall:{status:'PRESENT',ownerRef:'#547',capability:'CANONICAL_STATISTICAL_FIREWALL_V1',implementationPath:'market-prediction-lab/src/global-strategy-statistical-firewall-v1.js',implementationBlobSha:'3'.repeat(40)},
    ...(overrides.dependencies??{}),
  };
  const core={schemaVersion:'research-canonical-evaluation-runtime-proof-v18',sourceSha,verifiedAt:'2026-09-26T08:39:30.000Z',dependencies};
  return {...core,proofDigest:sha(core)};
}
function request(d,c,p,proof,overrides={}){
  const evaluationId='eval-once-v18',phase17ReceiptDigest=sha(p),runtimeProofDigest=proof.proofDigest;
  const oneShotReservationId=sha({schemaVersion:'research-canonical-evaluation-one-shot-reservation-v18',evaluationId,sourceSha,
    decisionDigest:d.decisionDigest,configDigest:c.configDigest,phase17ReceiptDigest,runtimeProofDigest});
  const base={schemaVersion:'research-canonical-evaluation-one-shot-request-v18',evaluationId,requestedAt:'2026-09-26T08:39:00.000Z',expiresAt:'2026-09-26T08:55:00.000Z',
    sourceSha,decisionDigest:d.decisionDigest,configDigest:c.configDigest,phase17ReceiptDigest,runtimeProofDigest,oneShotReservationId,
    compiler:{ownerRef:'#550',capability:'BOUNDED_FORMULA_COMPILER_V1',maxRuns:1,finalHoldoutAccessAllowed:false,arbitraryExecutableCodeAllowed:false},
    backtester:{ownerRef:'#690',capability:'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1',maxRuns:1,executionEquivalentRequired:true,finalHoldoutAccessPolicy:'FINAL_ONLY_AFTER_SELECTION_FREEZE',selectionFeedbackAllowed:false},
    statisticalFirewall:{ownerRef:'#547',capability:'CANONICAL_STATISTICAL_FIREWALL_V1',required:true,bypassAllowed:false},
    resultPolicy:{disposition:'RESEARCH_EVIDENCE_ONLY',automaticAdoption:false,paperActivation:false,liveActivation:false,profitabilityClaimAllowed:false},
    authority:{providerCalls:0,compilerRuns:0,backtestRuns:0,maxCompilerRuns:1,maxBacktestRuns:1,finalHoldoutPreAccess:false,selectionFeedbackToGenerator:false,replayAllowed:false,
      automaticAdoption:false,paperActivation:false,liveActivation:false,profitabilityProven:false,liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE'}};
  const core={...base,...overrides};return {...core,requestDigest:sha(core)};
}

test('v18 admits only one bounded compiler/backtest run after fresh Phase17 and current-main runtime proof',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c),proof=runtimeProof(),q=request(d,c,p,proof);
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'READY_FOR_BOUNDED_COMPILER_BACKTEST_ONE_SHOT');
  assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);assert.equal(out.maxCompilerRuns,1);assert.equal(out.maxBacktestRuns,1);
  assert.equal(out.finalHoldoutPreAccess,false);assert.equal(out.selectionFeedbackToGenerator,false);assert.equal(out.resultDisposition,'RESEARCH_EVIDENCE_ONLY');
  assert.equal(out.executionAuthority,'NONE');
});
test('missing or blocked Phase17 readiness never admits compiler/backtester',()=>{
  const r=review(),d=decision(r),c=config(),proof=runtimeProof();const p={...preflight(r,d,c),status:'BLOCKED',reasonCodes:['SYNTHETIC_BLOCK']};const q=request(d,c,p,proof);
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('FRESH_PHASE17_READY_RECEIPT_REQUIRED'));assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);
});
test('stale Phase17 READY receipt is rejected even while the human decision is still valid',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c,'2026-09-26T08:20:00.000Z'),proof=runtimeProof(),q=request(d,c,p,proof);
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('FRESH_PHASE17_READY_RECEIPT_REQUIRED'));
});
test('missing canonical #547 firewall on current SHA blocks actual evaluation admission',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c);
  const proof=runtimeProof({dependencies:{statisticalFirewall:{status:'MISSING',ownerRef:'#547',capability:'CANONICAL_STATISTICAL_FIREWALL_V1',implementationPath:'market-prediction-lab/src/global-strategy-statistical-firewall-v1.js',implementationBlobSha:null}}});
  const q=request(d,c,p,proof);
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('CANONICAL_STATISTICAL_FIREWALL_NOT_PRESENT_ON_CURRENT_SHA'));
  assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);
});
test('request cannot widen compiler or backtester to more than one run',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c),proof=runtimeProof();
  const q=request(d,c,p,proof,{compiler:{ownerRef:'#550',capability:'BOUNDED_FORMULA_COMPILER_V1',maxRuns:2,finalHoldoutAccessAllowed:false,arbitraryExecutableCodeAllowed:false}});
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('CANONICAL_EVALUATION_V18_REQUEST_SHAPE_INVALID'));
});
test('final holdout cannot feed selection or the generator',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c),proof=runtimeProof();
  const q=request(d,c,p,proof,{backtester:{ownerRef:'#690',capability:'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1',maxRuns:1,executionEquivalentRequired:true,finalHoldoutAccessPolicy:'FINAL_ONLY_AFTER_SELECTION_FREEZE',selectionFeedbackAllowed:true}});
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.equal(out.selectionFeedbackToGenerator,false);
});
test('research result cannot auto-adopt or activate Paper/live trading',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c),proof=runtimeProof();
  const q=request(d,c,p,proof,{resultPolicy:{disposition:'RESEARCH_EVIDENCE_ONLY',automaticAdoption:true,paperActivation:false,liveActivation:false,profitabilityClaimAllowed:false}});
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.equal(out.automaticAdoption,false);assert.equal(out.paperActivation,false);assert.equal(out.liveActivation,false);
});
test('expired one-shot request blocks without consuming the reservation',()=>{
  const r=review(),d=decision(r),c=config(),p=preflight(r,d,c),proof=runtimeProof();
  const q=request(d,c,p,proof,{expiresAt:'2026-09-26T08:39:30.000Z'});
  const out=assessCanonicalEvaluationExecutionContractV18({request:q,currentSha:sourceSha,review:r,decision:d,config:c,preflight:p,runtimeProof:proof,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.equal(out.replayAllowed,false);assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);
});
