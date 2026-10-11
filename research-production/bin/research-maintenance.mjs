#!/usr/bin/env node
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(code){throw Object.assign(new Error(code),{code});}
function inside(parent,child){const p=resolve(parent)+sep,c=resolve(child)+sep;return c.startsWith(p);}
function hours(value,fallback,min,max,code){
  const n=Number(value??fallback);
  if(!Number.isSafeInteger(n)||n<min||n>max)fail(code);
  return n;
}
async function safeRoot(value){
  const root=resolve(String(value??'/var/lib/investment-research-production'));
  if(!isAbsolute(root))fail('RESEARCH_MAINTENANCE_ROOT_INVALID');
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||inside(forbidden,root))fail('RESEARCH_MAINTENANCE_ROOT_FORBIDDEN');
  }
  const st=await lstat(root);
  if(!st.isDirectory()||st.isSymbolicLink()||await realpath(root)!==root)fail('RESEARCH_MAINTENANCE_ROOT_UNSAFE');
  if(typeof process.getuid==='function'&&st.uid!==process.getuid())fail('RESEARCH_MAINTENANCE_ROOT_OWNER_MISMATCH');
  return root;
}
async function names(path){try{return await readdir(path);}catch(e){if(e?.code==='ENOENT')return[];throw e;}}
async function safeDir(path){
  try{const st=await lstat(path);return st.isDirectory()&&!st.isSymbolicLink()&&await realpath(path)===path?st:null;}
  catch(e){if(e?.code==='ENOENT')return null;throw e;}
}
async function endedAt(taskDir){
  try{
    const row=JSON.parse(await readFile(join(taskDir,'result.json'),'utf8'));
    return Number.isSafeInteger(row?.endedAt)&&row.endedAt>0?row.endedAt:null;
  }catch(e){if(e?.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}
}
export async function runResearchMaintenance({
  stateRoot=process.env.RESEARCH_STATE_ROOT,
  retentionHours=process.env.RESEARCH_WORKSPACE_RETENTION_HOURS,
  stagingRetentionHours=process.env.RESEARCH_STAGING_RETENTION_HOURS,
  now=()=>Date.now(),
}={}){
  const root=await safeRoot(stateRoot);
  const at=Number(now());if(!Number.isSafeInteger(at)||at<=0)fail('RESEARCH_MAINTENANCE_CLOCK_INVALID');
  const workspaceHours=hours(retentionHours,336,24,2160,'RESEARCH_WORKSPACE_RETENTION_INVALID');
  const stagingHours=hours(stagingRetentionHours,24,1,168,'RESEARCH_STAGING_RETENTION_INVALID');
  const workspaceCutoff=at-workspaceHours*3600000,stagingCutoff=at-stagingHours*3600000;
  let workspacesRemoved=0,stagingRemoved=0,skipped=0;
  const runs=join(root,'runs');
  for(const cycleName of await names(runs)){
    const cycleDir=join(runs,cycleName);if(!await safeDir(cycleDir)){skipped++;continue;}
    for(const taskName of await names(cycleDir)){
      const taskDir=join(cycleDir,taskName);if(!await safeDir(taskDir))continue;
      const finished=await endedAt(taskDir);if(finished==null||finished>=workspaceCutoff)continue;
      const workspace=join(taskDir,'workspace');if(!await safeDir(workspace))continue;
      await rm(workspace,{recursive:true,force:false});workspacesRemoved++;
    }
  }
  const staging=join(root,'video-research','provider-staging');
  for(const name of await names(staging)){
    const path=join(staging,name),st=await safeDir(path);if(!st)continue;
    if(st.mtimeMs<stagingCutoff){await rm(path,{recursive:true,force:false});stagingRemoved++;}
  }
  return Object.freeze({
    schemaVersion:'research-production-maintenance-v1',status:'COMPLETE',observedAt:at,
    workspaceRetentionHours:workspaceHours,stagingRetentionHours:stagingHours,
    workspacesRemoved,stagingRemoved,skipped,evidenceFilesDeleted:0,
    executionAuthority:'NONE',liveTrading:false,privateTradingApiAllowed:false,realOrderEnabled:false,
  });
}
try{
  if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    const out=await runResearchMaintenance();
    process.stdout.write(JSON.stringify(out)+'\n');
  }
}catch(error){
  process.stderr.write(JSON.stringify({status:'failed_closed',reason:String(error?.code??error?.message??'RESEARCH_MAINTENANCE_FAILED').slice(0,160),executionAuthority:'NONE'})+'\n');
  process.exitCode=1;
}
