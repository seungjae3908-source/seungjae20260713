#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createResearchWorkerQueue, runResearchWorkerLoop, runResearchWorkerOnce } from '../src/research-workspace-worker-v9.js';
import { runExistingProvidersCli } from './run-existing-research-providers-v8.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function parse(argv){
  const out={},flags=new Set(['--init','--status','--once','--loop']),values=new Set(['--root','--worker-id','--poll-ms','--existing-env','--enqueue']);
  for(let i=0;i<argv.length;i++){const k=argv[i];if(flags.has(k)){if(out[k])fail('WORKER_CLI_ARGUMENTS_INVALID');out[k]=true;continue;}
    if(!values.has(k)||Object.hasOwn(out,k)||!argv[i+1]||argv[i+1].startsWith('--'))fail('WORKER_CLI_ARGUMENTS_INVALID');out[k]=argv[++i];}
  const actions=['--init','--status','--once','--loop','--enqueue'].filter(k=>out[k]);if(actions.length!==1||!out['--root']||!isAbsolute(out['--root']))fail('WORKER_CLI_ARGUMENTS_INVALID');
  if((out['--once']||out['--loop'])&&!out['--worker-id'])fail('WORKER_CLI_ARGUMENTS_INVALID');
  if(out['--existing-env']&&!isAbsolute(out['--existing-env']))fail('WORKER_CLI_ARGUMENTS_INVALID');
  return out;
}
export async function runResearchWorkerCli(argv,{env=process.env,clock=()=>new Date().toISOString()}={}){
  const o=parse(argv),queue=createResearchWorkerQueue(o['--root'],{clock});
  if(o['--init'])return queue.initialize();
  if(o['--status'])return queue.status();
  if(o['--enqueue']){const job=JSON.parse(await readFile(o['--enqueue'],'utf8'));return queue.enqueue(job);}
  const handler=async job=>{
    if(job.task.runner!=='EXISTING_PROVIDER_VIDEO_V8')fail('WORKER_TASK_UNSUPPORTED');
    const args=[...job.task.argv];if(o['--existing-env'])args.push('--existing-env',o['--existing-env']);
    const result=await runExistingProvidersCli(args,{env,clock});
    return {status:result.status,resultDigest:sha(result)};
  };
  if(o['--once'])return runResearchWorkerOnce(queue,{workerId:o['--worker-id'],handler,retryableCodes:['PROVIDER_RUNTIME_UNAVAILABLE','WORKER_HANDLER_UNAVAILABLE']});
  const poll=Number(o['--poll-ms']??5000);if(!Number.isSafeInteger(poll)||poll<250||poll>60000)fail('WORKER_CLI_ARGUMENTS_INVALID');
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{await runResearchWorkerLoop(queue,{workerId:o['--worker-id'],handler,retryableCodes:['PROVIDER_RUNTIME_UNAVAILABLE','WORKER_HANDLER_UNAVAILABLE'],pollMs:poll,signal:controller.signal});return {status:'STOPPED'};}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--help'))process.stdout.write('No daemon is installed. Actions: --init | --status | --enqueue /absolute/job.json | --once --worker-id ID | --loop --worker-id ID [--poll-ms N]. Always require --root /absolute/private/root. Optional --existing-env is operator-selected and reused through V8. Starting --loop is runtime activation and is not performed by repository installation.\n');
  else runResearchWorkerCli(process.argv.slice(2)).then(x=>process.stdout.write(JSON.stringify(x)+'\n')).catch(e=>{process.stderr.write(JSON.stringify({status:'BLOCKED',reason:/^(?:WORKER|PROVIDER|VIDEO)_[A-Z0-9_]+$/.test(e?.code)?e.code:'WORKER_RUNTIME_UNAVAILABLE'})+'\n');process.exitCode=1;});
}
