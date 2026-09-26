#!/usr/bin/env node
/** Reuse a selected existing environment. Never source a shell file or export its secrets. */
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { runVideoCli } from './run-research-video-v7.mjs';
import { inspectExistingResearchProviders, runExistingEnvironmentVideo } from '../src/research-workspace-providers-v8.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
async function readExistingEnvFile(path) {
  if (!isAbsolute(path) || await realpath(path)!==path) fail('PROVIDER_ENV_FILE_PATH_INVALID');
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=await h.stat();
    if (!st.isFile() || st.size>65536 || st.nlink!==1 || st.uid!==process.getuid() || (st.mode&0o077)) fail('PROVIDER_ENV_FILE_UNSAFE');
    const bytes=Buffer.alloc(65537); let n=0;
    while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const after=await h.stat();
    if(n!==st.size||n>65536||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)fail('PROVIDER_ENV_FILE_CHANGED');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n));
    // parseEnv is a data parser: no interpolation, import, eval or shell sourcing.
    return parseEnv(text);
  } finally {await h.close();}
}
export async function runExistingProvidersCli(argv,{env=process.env,fetchImpl=globalThis.fetch,clock=()=>new Date().toISOString()}={}) {
  const options={},allowed=new Set(['--preflight','--existing-env','--spec','--output-root','--execute','--approval']);
  for(let i=0;i<argv.length;i++){
    const k=argv[i];if(!allowed.has(k)||Object.hasOwn(options,k))fail('PROVIDER_CLI_ARGUMENTS_INVALID');
    if(k==='--preflight'||k==='--execute'){options[k]=true;continue;}
    if(!argv[i+1]||argv[i+1].startsWith('--'))fail('PROVIDER_CLI_ARGUMENTS_INVALID');options[k]=argv[++i];
  }
  if(options['--preflight'] && ['--spec','--output-root','--execute','--approval'].some(k=>options[k]))fail('PROVIDER_CLI_ARGUMENTS_INVALID');
  const selected=options['--existing-env']?await readExistingEnvFile(options['--existing-env']):env;
  if(options['--preflight'])return inspectExistingResearchProviders(selected,{now:clock(),source:options['--existing-env']?'EXPLICIT_ENV_FILE':'INHERITED_PROCESS'});
  const pass=[];for(const k of ['--spec','--output-root','--approval'])if(options[k])pass.push(k,options[k]);
  if(options['--execute'])pass.push('--execute');
  return runExistingEnvironmentVideo(pass,{env:selected,invokeVideo:(args,options)=>runVideoCli(args,{...options,fetchImpl,clock})});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--help'))process.stdout.write('Read only: node run-existing-research-providers-v8.mjs --preflight [--existing-env /absolute/existing/private.env]\nVideo plan: --spec /absolute/spec.json --output-root /absolute/private-directory\nOne reviewed call: add --execute --approval /absolute/existing/approval.json\nAn env-file is an explicit alternative source, not merged with inherited secrets. No key values are printed. No PM2 restart, deployment, registration, paid fallback or scheduler.\n');
  else runExistingProvidersCli(process.argv.slice(2)).then(result=>{
    const safe=result.schemaVersion==='research-provider-readiness-v8'?result:{status:result.status,reason:result.reason??null,planDigest:result.planDigest,callsAttempted:result.callsAttempted??0};
    process.stdout.write(JSON.stringify(safe)+'\n');
    if(result.status&&!['PREPARED_NOT_EXECUTED','RESPONSE_RECEIVED_REVIEW_REQUIRED','INSUFFICIENT_EVIDENCE'].includes(result.status))process.exitCode=1;
  }).catch(e=>{process.stderr.write(JSON.stringify({status:'BLOCKED',reason:/^(?:PROVIDER|VIDEO)_[A-Z_]+$/.test(e?.code)?e.code:'PROVIDER_RUNTIME_UNAVAILABLE'})+'\n');process.exitCode=1;});
}
