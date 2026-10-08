#!/usr/bin/env node
import { constants, realpathSync } from 'node:fs';
import { link, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResearchWorkerQueue } from '../../packages/external-research/src/research-workspace-worker-v9.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
async function secureDir(path,{create=false}={}){
  if(create)await mkdir(path,{recursive:true,mode:0o700});
  const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    const st=await h.stat();
    if(!st.isDirectory()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077)||await realpath(path)!==path)
      fail('APPROVED_JOB_INTAKE_DIR_UNSAFE');
  }finally{await h.close();}
  return path;
}
async function readJob(path){
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const st=await h.stat();
    if(!st.isFile()||st.nlink!==1||st.size<=0||st.size>128*1024||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077))
      fail('APPROVED_JOB_FILE_UNSAFE');
    const bytes=Buffer.alloc(st.size);let n=0;
    while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    if(n!==st.size)fail('APPROVED_JOB_FILE_CHANGED');
    try{return JSON.parse(bytes.toString('utf8'));}catch{fail('APPROVED_JOB_JSON_INVALID');}
  }finally{await h.close();}
}
export async function intakeApprovedResearchJobs({stateRoot=process.env.RESEARCH_STATE_ROOT}={}){
  const root=resolve(String(stateRoot??'/var/lib/investment-research-production'));
  if(!isAbsolute(root))fail('APPROVED_JOB_STATE_ROOT_INVALID');
  await secureDir(root);
  const inbox=await secureDir(join(root,'video-research','approved-jobs'),{create:true});
  const accepted=await secureDir(join(root,'video-research','accepted-jobs'),{create:true});
  const queue=createResearchWorkerQueue(join(root,'workspace-worker'));
  await queue.initialize();
  let queued=0,existing=0;
  for(const name of (await readdir(inbox)).filter(x=>x.endsWith('.json')).sort()){
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}[.]json$/.test(name))continue;
    const path=join(inbox,name),job=await readJob(path);
    const result=await queue.enqueue(job);
    if(result.status==='QUEUED')queued++;else if(result.status==='EXISTS')existing++;else fail('APPROVED_JOB_QUEUE_RESULT_INVALID');
    const destination=join(accepted,`${job.jobId}-${result.jobDigest}.json`);
    try{await link(path,destination);}catch(e){if(e?.code!=='EEXIST')throw e;fail('APPROVED_JOB_ACCEPTED_PATH_CONFLICT');}
    await unlink(path);
  }
  return Object.freeze({schemaVersion:'research-approved-job-intake-v1',status:'COMPLETE',queued,existing,
    executionAuthority:'NONE',automaticApproval:false,providerCalls:0});
}
function isDirectRun(){
  try{
    return Boolean(process.argv[1])
      && realpathSync(resolve(process.argv[1]))===realpathSync(fileURLToPath(import.meta.url));
  }catch{return false;}
}
if(isDirectRun()){
  intakeApprovedResearchJobs().then(x=>process.stdout.write(JSON.stringify(x)+'\n')).catch(e=>{
    process.stderr.write(JSON.stringify({status:'failed_closed',reason:String(e?.code??e?.message??'APPROVED_JOB_INTAKE_FAILED').slice(0,160),executionAuthority:'NONE'})+'\n');
    process.exitCode=1;
  });
}
