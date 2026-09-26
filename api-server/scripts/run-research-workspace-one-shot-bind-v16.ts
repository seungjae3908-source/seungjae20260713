#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readResearchOneShotReviewV15 } from '../../../packages/external-research/src/research-workspace-one-shot-review-v15.js';
import {
  createHumanRuleDigestDecisionV16, writeHumanRuleDigestDecisionV16,
} from '../../../packages/external-research/src/research-workspace-one-shot-bind-v16.js';

const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const digest=(x:string)=>/^[a-f0-9]{64}$/.test(x);
const ident=(x:string)=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
function parse(argv:string[]){
  const out:Record<string,string>={};
  const allowed=new Set(['--root','--binding-id','--reviewer-id','--manifest-digest','--package-digest','--reviewed-rule-digest']);
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(!allowed.has(key)||Object.hasOwn(out,key)||!argv[i+1]||argv[i+1].startsWith('--'))fail('HUMAN_RULE_DIGEST_CLI_ARGUMENTS_INVALID');
    out[key]=argv[++i];
  }
  for(const key of allowed)if(!out[key])fail('HUMAN_RULE_DIGEST_CLI_ARGUMENTS_INVALID');
  if(!ident(out['--binding-id'])||!ident(out['--reviewer-id'])||![out['--manifest-digest'],out['--package-digest'],out['--reviewed-rule-digest']].every(digest))
    fail('HUMAN_RULE_DIGEST_CLI_ARGUMENTS_INVALID');
  return out;
}
export async function runHumanRuleDigestBindCliV16(argv:string[],{clock=()=>new Date().toISOString()}={}){
  const o=parse(argv),decidedAt=clock();
  if(!Number.isFinite(Date.parse(decidedAt))||new Date(decidedAt).toISOString()!==decidedAt)fail('HUMAN_RULE_DIGEST_CLOCK_INVALID');
  const review=await readResearchOneShotReviewV15(o['--root'],{checkedAt:decidedAt});
  if(!review.available||review.status!=='HUMAN_RULE_DIGEST_REVIEW')fail('HUMAN_RULE_DIGEST_REVIEW_NOT_READY');
  if(review.manifestDigest!==o['--manifest-digest']||review.packageDigest!==o['--package-digest']
    ||review.reviewedRuleDigestCandidate!==o['--reviewed-rule-digest'])fail('HUMAN_RULE_DIGEST_COMMAND_DIGEST_MISMATCH');
  const expiresAt=new Date(Date.parse(decidedAt)+30*60_000).toISOString();
  const decision=createHumanRuleDigestDecisionV16(review,{
    schemaVersion:'research-human-rule-digest-binding-request-v16',
    bindingId:o['--binding-id'],reviewerId:o['--reviewer-id'],decidedAt,expiresAt,
    manifestDigest:o['--manifest-digest'],packageDigest:o['--package-digest'],reviewedRuleDigest:o['--reviewed-rule-digest'],
    acknowledgements:{sourceTruthNotVerified:true,entireVideoNotVerified:true,aiAgreementIsNotProfitabilityEvidence:true,
      researchOnly:true,noAutomaticAdoption:true},
  });
  const receipt=await writeHumanRuleDigestDecisionV16(o['--root'],decision);
  return {...receipt,bindingId:decision.bindingId,reviewerId:decision.reviewerId,expiresAt:decision.expiresAt};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--help')){
    process.stdout.write('Bind reviewed rule digest for one canonical research evaluation only: --root /private/root --binding-id ID --reviewer-id OWNER --manifest-digest SHA256 --package-digest SHA256 --reviewed-rule-digest SHA256\n'+
      'This writes exactly one private human-rule-digest-decision-v16.json with O_EXCL. Provider calls, compiler runs and backtests remain zero; no profitability or trading authority is granted.\n');
  }else{
    runHumanRuleDigestBindCliV16(process.argv.slice(2)).then(result=>{
      process.stdout.write(JSON.stringify(result)+'\n');
    }).catch((cause:any)=>{
      const reason=typeof cause?.code==='string'&&/^HUMAN_RULE_DIGEST_[A-Z0-9_]+$/.test(cause.code)?cause.code:'HUMAN_RULE_DIGEST_BIND_FAILED';
      process.stderr.write(JSON.stringify({status:'BLOCKED',reason,providerCalls:0,compilerRuns:0,backtestRuns:0,
        automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'})+'\n');
      process.exitCode=1;
    });
  }
}
