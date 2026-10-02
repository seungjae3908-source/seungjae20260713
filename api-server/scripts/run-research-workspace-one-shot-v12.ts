#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runResearchWorkspaceOneShotV12 } from '../src/tools/research-workspace-one-shot-v12';

function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function parse(argv:string[]){
  const out:Record<string,string|boolean>={};
  const flags=new Set(['--prepare','--execute']);
  const values=new Set(['--source','--spec','--output-root','--pipeline-id','--market','--manifest','--video-approval','--groq-approval']);
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(flags.has(key)){if(out[key])fail('ONE_SHOT_CLI_ARGUMENTS_INVALID');out[key]=true;continue;}
    if(!values.has(key)||Object.hasOwn(out,key)||!argv[i+1]||argv[i+1].startsWith('--'))fail('ONE_SHOT_CLI_ARGUMENTS_INVALID');
    out[key]=argv[++i];
  }
  if(Boolean(out['--prepare'])===Boolean(out['--execute']))fail('ONE_SHOT_CLI_ARGUMENTS_INVALID');
  for(const key of ['--source','--spec','--output-root'])if(typeof out[key]!=='string')fail('ONE_SHOT_CLI_ARGUMENTS_INVALID');
  if(out['--prepare']&&(typeof out['--pipeline-id']!=='string'||typeof out['--market']!=='string'))fail('ONE_SHOT_CLI_ARGUMENTS_INVALID');
  if(out['--execute']&&['--manifest','--video-approval','--groq-approval'].some(k=>typeof out[k]!=='string'))fail('ONE_SHOT_CLI_ARGUMENTS_INVALID');
  return out;
}
export async function runResearchWorkspaceOneShotCliV12(argv:string[]){
  const o=parse(argv);
  if(o['--prepare'])return runResearchWorkspaceOneShotV12({
    mode:'prepare',sourcePath:String(o['--source']),specPath:String(o['--spec']),outputRoot:String(o['--output-root']),
    pipelineId:String(o['--pipeline-id']),market:String(o['--market']) as any,
  });
  return runResearchWorkspaceOneShotV12({
    mode:'execute',sourcePath:String(o['--source']),specPath:String(o['--spec']),outputRoot:String(o['--output-root']),
    manifestPath:String(o['--manifest']),videoApprovalPath:String(o['--video-approval']),groqApprovalPath:String(o['--groq-approval']),
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--help')){
    process.stdout.write('Prepare (network/key free): --prepare --source /abs/source.json --spec /abs/spec.json --output-root /abs/private-root --pipeline-id ID --market MARKET\n'+
      'Execute reviewed provider capture: --execute --source /abs/source.json --spec /abs/spec.json --manifest /abs/manifest.json --video-approval /abs/video-approval.json --groq-approval /abs/groq-approval.json --output-root /abs/private-root\n'+
      'Execution performs at most one Gemini call and one Groq call, then stops at human rule-digest review. No compiler/backtest, schedule, deployment, trading or paid fallback.\n');
  }else{
    runResearchWorkspaceOneShotCliV12(process.argv.slice(2)).then((result:any)=>{
      process.stdout.write(JSON.stringify({status:result.status,reason:result.reason??null,
        manifestDigest:result.manifest?.manifestDigest??result.manifestDigest??null,
        packageDigest:result.reviewPackage?.packageDigest??null,
        reviewedRuleDigestCandidate:result.reviewPackage?.reviewedRuleDigestCandidate??result.reviewedRuleDigestCandidate??null,
        providerCalls:result.providerCalls??{gemini:0,groq:0},executionAuthority:'NONE'})+'\n');
      if(!['PREPARED_NOT_EXECUTED','REVIEW_REQUIRED'].includes(result.status))process.exitCode=1;
    }).catch((cause:any)=>{
      const reason=typeof cause?.code==='string'&&/^(?:ONE_SHOT|VIDEO|PROVIDER|GROQ|RESEARCH_GROQ)_[A-Z0-9_]+$/.test(cause.code)?cause.code:'ONE_SHOT_CLI_FAILED';
      process.stderr.write(JSON.stringify({status:'BLOCKED',reason,executionAuthority:'NONE'})+'\n');process.exitCode=1;
    });
  }
}
