#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivateReviewedReader } from '../../packages/external-research/src/research-workspace-archive-v5.js';
import { readResearchOneShotReviewV15 } from '../../packages/external-research/src/research-workspace-one-shot-review-v15.js';
import { HUMAN_RULE_DIGEST_DECISION_FILE_V16 } from '../../packages/external-research/src/research-workspace-one-shot-bind-v16.js';
import { CANONICAL_EVALUATION_CONFIG_FILE_V17, assessCanonicalEvaluationReadinessV17 } from '../../packages/external-research/src/research-workspace-canonical-evaluation-readiness-v17.js';

const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const sha=x=>/^[a-f0-9]{40}$/.test(x);
function parse(argv:string[]){
  const out:Record<string,string>={};const allowed=new Set(['--root','--current-sha']);
  for(let i=0;i<argv.length;i++){const k=argv[i];if(!allowed.has(k)||Object.hasOwn(out,k)||!argv[i+1]||argv[i+1].startsWith('--'))fail('CANONICAL_EVALUATION_PREFLIGHT_CLI_ARGUMENTS_INVALID');out[k]=argv[++i];}
  if(!out['--root']||!sha(out['--current-sha']??''))fail('CANONICAL_EVALUATION_PREFLIGHT_CLI_ARGUMENTS_INVALID');return out;
}
export async function runCanonicalEvaluationPreflightV17(argv:string[],{clock=()=>new Date().toISOString()}={}){
  const o=parse(argv),checkedAt=clock(),read=createPrivateReviewedReader(o['--root']);
  const review=await readResearchOneShotReviewV15(o['--root'],{checkedAt});
  if(!review.available)return {schemaVersion:'research-canonical-evaluation-readiness-v17',status:'BLOCKED',checkedAt,currentSha:o['--current-sha'],reasonCodes:[review.reason],providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'};
  const load=async(name:string,limit:number)=>{const raw=await read(name,limit);try{return JSON.parse(raw.toString('utf8'));}catch{fail('CANONICAL_EVALUATION_PREFLIGHT_JSON_INVALID');}};
  const decision=await load(HUMAN_RULE_DIGEST_DECISION_FILE_V16,64*1024);
  const config=await load(CANONICAL_EVALUATION_CONFIG_FILE_V17,512*1024);
  return assessCanonicalEvaluationReadinessV17({config,currentSha:o['--current-sha'],review,decision,checkedAt});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--help'))process.stdout.write('Read-only canonical evaluation preflight: --root /private/root --current-sha SHA40\nNo provider, compiler or backtest is executed; Phase16 binding is not consumed.\n');
  else runCanonicalEvaluationPreflightV17(process.argv.slice(2)).then(x=>process.stdout.write(JSON.stringify(x)+'\n')).catch((e:any)=>{process.stderr.write(JSON.stringify({status:'BLOCKED',reason:e?.code??'CANONICAL_EVALUATION_PREFLIGHT_FAILED',providerCalls:0,compilerRuns:0,backtestRuns:0,executionAuthority:'NONE'})+'\n');process.exitCode=1;});
}
