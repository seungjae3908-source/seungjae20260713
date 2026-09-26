import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod,mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHumanRuleDigestDecisionV16,validateHumanRuleDigestDecisionV16,writeHumanRuleDigestDecisionV16,
  HUMAN_RULE_DIGEST_DECISION_FILE_V16,
} from '../src/research-workspace-one-shot-bind-v16.js';

const at='2026-09-26T08:00:00.000Z';
const digest=c=>'a'.repeat(63)+c;
function review(overrides={}){
  const kinds=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];
  return {
    schemaVersion:'research-one-shot-review-v15',available:true,checkedAt:at,status:'HUMAN_RULE_DIGEST_REVIEW',
    reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest:digest('1'),packageDigest:digest('2'),reviewedRuleDigestCandidate:digest('3'),
    providerCalls:{gemini:1,groq:1},sourceTruthVerified:false,entireVideoVerified:false,
    observations:kinds.map((kind,index)=>({observationIndex:index,atSec:10+index,kind,description:'Synthetic '+kind,verdict:'ACCEPT_AS_CLAIM',reason:'Synthetic structural review.'})),
    limitations:['Synthetic only'],groq:{summary:'Synthetic review.',disposition:'CONTINUE'},missingRuleKinds:[],
    authority:{readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,automaticBacktest:false,
      automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'},...overrides,
  };
}
function request(r=review()){
  return {schemaVersion:'research-human-rule-digest-binding-request-v16',bindingId:'binding-v16-test',reviewerId:'repo-owner',
    decidedAt:at,expiresAt:'2026-09-26T08:30:00.000Z',manifestDigest:r.manifestDigest,packageDigest:r.packageDigest,
    reviewedRuleDigest:r.reviewedRuleDigestCandidate,acknowledgements:{sourceTruthNotVerified:true,entireVideoNotVerified:true,
      aiAgreementIsNotProfitabilityEvidence:true,researchOnly:true,noAutomaticAdoption:true}};
}
test('exact human binding grants one research evaluation and zero provider/compiler/backtest work',()=>{
  const r=review(),decision=createHumanRuleDigestDecisionV16(r,request(r));
  assert.equal(decision.decision,'BIND_FOR_RESEARCH_EVALUATION');
  assert.equal(decision.allowedNextAction,'CANONICAL_RESEARCH_EVALUATION_ONE_SHOT');
  assert.equal(decision.maxCanonicalEvaluationRuns,1);
  assert.equal(decision.authority.providerCalls,0);
  assert.equal(decision.authority.compilerRuns,0);
  assert.equal(decision.authority.backtestRuns,0);
  assert.equal(decision.authority.automaticAdoption,false);
  assert.equal(decision.authority.profitabilityProven,false);
  assert.equal(decision.authority.executionAuthority,'NONE');
  assert.equal(validateHumanRuleDigestDecisionV16(decision,r,{now:'2026-09-26T08:10:00.000Z'}),true);
});
test('binding fails closed when a required rule is missing or challenged',()=>{
  const missing=review({missingRuleKinds:['STOP_LOSS']});
  assert.throws(()=>createHumanRuleDigestDecisionV16(missing,request(missing)),/HUMAN_RULE_DIGEST_REVIEW_NOT_BINDABLE/);
  const challenged=review();challenged.observations[0]={...challenged.observations[0],verdict:'CHALLENGE'};
  assert.throws(()=>createHumanRuleDigestDecisionV16(challenged,request(challenged)),/HUMAN_RULE_DIGEST_REVIEW_NOT_BINDABLE/);
});
test('binding request must acknowledge truth and profitability limitations',()=>{
  const r=review(),q=request(r);q.acknowledgements.aiAgreementIsNotProfitabilityEvidence=false;
  assert.throws(()=>createHumanRuleDigestDecisionV16(r,q),/HUMAN_RULE_DIGEST_BINDING_REQUEST_INVALID/);
});
test('binding expires and exact digest mutations invalidate it',()=>{
  const r=review(),decision=createHumanRuleDigestDecisionV16(r,request(r));
  assert.equal(validateHumanRuleDigestDecisionV16(decision,r,{now:'2026-09-26T08:30:00.000Z'}),false);
  assert.equal(validateHumanRuleDigestDecisionV16({...decision,reviewedRuleDigest:digest('4')},r,{now:'2026-09-26T08:10:00.000Z'}),false);
});
test('private decision writer creates one file and refuses overwrite',async t=>{
  const root=await mkdtemp(join(tmpdir(),'human-rule-v16-'));await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const r=review(),decision=createHumanRuleDigestDecisionV16(r,request(r));
  const receipt=await writeHumanRuleDigestDecisionV16(root,decision);
  assert.equal(receipt.status,'BOUND_FOR_RESEARCH_EVALUATION');
  assert.equal(receipt.serverFilesWritten,1);
  assert.equal(receipt.providerCalls,0);assert.equal(receipt.compilerRuns,0);assert.equal(receipt.backtestRuns,0);
  const saved=JSON.parse(await readFile(join(root,HUMAN_RULE_DIGEST_DECISION_FILE_V16),'utf8'));
  assert.equal(saved.decisionDigest,decision.decisionDigest);
  await assert.rejects(()=>writeHumanRuleDigestDecisionV16(root,decision),/HUMAN_RULE_DIGEST_DECISION_ALREADY_EXISTS/);
});
