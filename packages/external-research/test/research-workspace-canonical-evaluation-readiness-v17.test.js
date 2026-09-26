import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHumanRuleDigestDecisionV16 } from '../src/research-workspace-one-shot-bind-v16.js';
import { assessCanonicalEvaluationReadinessV17 } from '../src/research-workspace-canonical-evaluation-readiness-v17.js';

const now='2026-09-26T08:00:00.000Z';
const sourceSha='a'.repeat(40);
const manifestDigest='b'.repeat(64);
const packageDigest='c'.repeat(64);
const reviewedRuleDigest='d'.repeat(64);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');

function review(){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return {
    schemaVersion:'research-one-shot-review-v15',available:true,checkedAt:now,status:'HUMAN_RULE_DIGEST_REVIEW',
    reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest,packageDigest,reviewedRuleDigestCandidate:reviewedRuleDigest,
    providerCalls:{gemini:1,groq:1},sourceTruthVerified:false,entireVideoVerified:false,
    observations:kinds.map((kind,i)=>({observationIndex:i,atSec:10+i,kind,description:'Synthetic '+kind,verdict:'ACCEPT_AS_CLAIM',reason:'Synthetic structural review.'})),
    limitations:['Synthetic only'],groq:{summary:'Synthetic review.',disposition:'CONTINUE'},missingRuleKinds:[],
    authority:{readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,automaticBacktest:false,
      automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'},
  };
}
function decision(r=review(),expiresAt='2026-09-26T08:20:00.000Z'){
  return createHumanRuleDigestDecisionV16(r,{
    schemaVersion:'research-human-rule-digest-binding-request-v16',bindingId:'binding-v17',reviewerId:'owner',
    decidedAt:'2026-09-26T07:55:00.000Z',expiresAt,manifestDigest,packageDigest,reviewedRuleDigest,
    acknowledgements:{sourceTruthNotVerified:true,entireVideoNotVerified:true,aiAgreementIsNotProfitabilityEvidence:true,researchOnly:true,noAutomaticAdoption:true},
  });
}
function binding(ownerRefs,capability){
  return {status:'AVAILABLE',ownerRefs,capability,sourceSha,evidenceId:'evidence-'+capability.toLowerCase(),
    properties:{runtimeActivationAllowed:false,scheduleMutationAllowed:false,deploymentAllowed:false,finalHoldoutPreAccessAllowed:false,
      arbitraryExecutableCodeAllowed:false,profitabilityClaimAllowed:false,executionAuthority:'NONE'}};
}
function dataset(role){
  return {role,datasetIdentity:'dataset:'+role.toLowerCase(),datasetDigest:sha({role}),frozen:true,selectionFeedbackAllowed:false};
}
function config(){
  const core={
    schemaVersion:'research-canonical-evaluation-config-v17',configId:'eval-v17',createdAt:'2026-09-26T07:50:00.000Z',
    sourceSha,manifestDigest,packageDigest,reviewedRuleDigest,market:'US_STOCK',side:'LONG',timeframe:'1h',
    strategyFamily:'TREND_ADX',symbolScope:['SPY'],categories:['TREND_FOLLOWING'],
    crossValidation:{supportingPaperBundleDigest:'1'.repeat(64),contradictoryPaperBundleDigest:null,officialSourceBundleDigest:null,
      supportingPaperCount:1,contradictoryPaperCount:0,allSourcesReviewed:true},
    canonicalCoreDigest:'2'.repeat(64),seedProfileId:'US_STOCK:SWING',templateSetDigest:'3'.repeat(64),
    compilerPolicyDigest:'4'.repeat(64),tournamentPolicyDigest:'5'.repeat(64),
    datasets:{train:dataset('TRAIN'),oos:dataset('OOS'),purgedOos:dataset('PURGED_OOS'),walkForward:dataset('WALK_FORWARD'),
      costStress:dataset('COST_STRESS'),regimeStress:dataset('REGIME_STRESS'),finalHoldout:dataset('FINAL_HOLDOUT')},
    runtimeBindings:{
      stageCheckpointExecutor:binding(['#551'],'TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1'),
      canonicalBundleSource:binding(['#821','#833'],'AUTHENTIC_CANONICAL_BUNDLE_SOURCE_V1'),
      formulaCompiler:binding(['#550'],'BOUNDED_FORMULA_COMPILER_V1'),
      canonicalBacktester:binding(['#690'],'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1'),
      statisticalFirewall:binding(['#547'],'CANONICAL_STATISTICAL_FIREWALL_V1'),
    },
    authority:{providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,profitabilityProven:false,
      liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE'},
  };
  return {...core,configDigest:sha(core)};
}
test('v17 is ready only with valid binding, datasets, owner ports and zero authority',()=>{
  const r=review(),d=decision(r),c=config();
  const out=assessCanonicalEvaluationReadinessV17({config:c,currentSha:sourceSha,review:r,decision:d,checkedAt:now});
  assert.equal(out.status,'READY_FOR_CANONICAL_EVALUATION_ONE_SHOT');
  assert.deepEqual(out.reasonCodes,[]);
  assert.equal(out.providerCalls,0);assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);
  assert.equal(out.finalHoldoutPreAccess,false);assert.equal(out.executionAuthority,'NONE');
});
test('expired human binding blocks canonical evaluation',()=>{
  const r=review(),d=decision(r,'2026-09-26T07:59:00.000Z');
  const out=assessCanonicalEvaluationReadinessV17({config:config(),currentSha:sourceSha,review:r,decision:d,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('HUMAN_RULE_DIGEST_DECISION_INVALID_OR_EXPIRED'));
});
test('missing #690 backtester binding blocks before compiler or backtest',()=>{
  const r=review(),d=decision(r),c=config();delete c.runtimeBindings.canonicalBacktester;
  const out=assessCanonicalEvaluationReadinessV17({config:c,currentSha:sourceSha,review:r,decision:d,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('CANONICAL_RUNTIME_BINDINGS_INCOMPLETE'));
  assert.equal(out.compilerRuns,0);assert.equal(out.backtestRuns,0);
});
test('missing OOS/final holdout dataset identity blocks evaluation',()=>{
  const r=review(),d=decision(r),c=config();delete c.datasets.finalHoldout;
  const out=assessCanonicalEvaluationReadinessV17({config:c,currentSha:sourceSha,review:r,decision:d,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('DATASET_BINDINGS_INCOMPLETE'));
});
test('any authority mutation blocks evaluation',()=>{
  const r=review(),d=decision(r),c=config();c.authority.liveTrading=true;
  const out=assessCanonicalEvaluationReadinessV17({config:c,currentSha:sourceSha,review:r,decision:d,checkedAt:now});
  assert.equal(out.status,'BLOCKED');assert.ok(out.reasonCodes.includes('EVALUATION_CONFIG_AUTHORITY_INVALID'));
});
