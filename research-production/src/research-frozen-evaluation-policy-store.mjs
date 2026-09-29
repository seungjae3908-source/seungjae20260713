import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  buildFrozenResearchEvaluationPoliciesV1,
} from './research-frozen-evaluation-policy.mjs';
import { sha256Canonical as hash } from '../../market-prediction-lab/src/research-cache-provenance.js';

export const RESEARCH_FROZEN_EVALUATION_POLICY_STORE_CONTRACT_V1 =
  'research-frozen-evaluation-policy-store/v1';

function absolute(value,name){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError(`${name} must be absolute`);
  return resolve(raw);
}
async function safeComponentRoot(value){
  const root=absolute(value,'componentRoot');
  let probe=root;
  while(true){
    try{
      const info=await lstat(probe);
      if(info.isSymbolicLink()) throw new Error('componentRoot must not contain symbolic links');
      if(resolve(await realpath(probe))!==probe) throw new Error('componentRoot must not contain symbolic links');
      break;
    }catch(error){
      if(error?.code!=='ENOENT') throw error;
      const parent=dirname(probe);
      if(parent===probe) throw error;
      probe=parent;
    }
  }
  return root;
}
async function ensureSafeDirectory(path,name,{recursive=false}={}){
  try{
    await mkdir(path,{recursive,mode:0o700});
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
  }
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink directory`);
  if(resolve(await realpath(path))!==path) throw new Error(`${name} must not traverse symbolic links`);
  return path;
}
async function writeOnce(directory,fileName,value){
  const finalPath=join(directory,basename(fileName));
  const temp=join(directory,`.pending-${randomUUID()}`);
  const bytes=`${JSON.stringify(value,null,2)}\n`;
  const handle=await open(temp,'wx',0o600);
  try{
    await handle.writeFile(bytes,'utf8');
    await handle.sync();
  }finally{
    await handle.close();
  }
  try{
    await link(temp,finalPath);
    return Object.freeze({status:'created',path:finalPath,digest:hash(value)});
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
    const info=await lstat(finalPath);
    if(!info.isFile()||info.isSymbolicLink()||resolve(await realpath(finalPath))!==finalPath){
      throw new Error('EVALUATION_POLICY_EXISTING_PATH_UNSAFE');
    }
    const existing=JSON.parse(await readFile(finalPath,'utf8'));
    if(hash(existing)!==hash(value)) throw new Error('EVALUATION_POLICY_CONTENT_CONFLICT');
    return Object.freeze({status:'already_present',path:finalPath,digest:hash(existing)});
  }finally{
    try{await unlink(temp);}catch{}
  }
}

export async function persistFrozenResearchEvaluationPoliciesV1({
  componentRoot,
  input,
}={}){
  const root=await safeComponentRoot(componentRoot);
  const policies=buildFrozenResearchEvaluationPoliciesV1(input);
  await ensureSafeDirectory(root,'componentRoot',{recursive:true});
  const policiesRoot=await ensureSafeDirectory(join(root,'evaluation-policies'),'evaluation-policies');
  const directory=await ensureSafeDirectory(join(policiesRoot,policies.policySetDigest),'evaluation policy set directory');
  const entries=[
    ['splitPolicy','splitPolicy.json',policies.splitPolicy],
    ['splitReceipt','splitReceipt.json',policies.splitReceipt],
    ['oosPolicy','oosPolicy.json',policies.oosPolicy],
    ['wfPolicy','wfPolicy.json',policies.wfPolicy],
    ['holdoutPolicy','holdoutPolicy.json',policies.holdoutPolicy],
  ];
  const writes={};
  for(const [key,fileName,value] of entries){
    writes[key]=await writeOnce(directory,fileName,value);
  }
  const recordCore=Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_FROZEN_EVALUATION_POLICY_STORE_CONTRACT_V1,
    policySetDigest:policies.policySetDigest,
    scope:policies.scope,
    componentDigests:Object.freeze(Object.fromEntries(
      entries.map(([key])=>[key,writes[key].digest]),
    )),
    safety:policies.safety,
  });
  const record=Object.freeze({...recordCore,recordDigest:hash(recordCore)});
  const recordWrite=await writeOnce(directory,'record.json',record);
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_FROZEN_EVALUATION_POLICY_STORE_CONTRACT_V1,
    status:[...Object.values(writes),recordWrite].some(row=>row.status==='created')
      ?'persisted':'already_present',
    policySetDigest:policies.policySetDigest,
    directory,
    paths:Object.freeze({
      splitPolicy:writes.splitPolicy.path,
      splitReceipt:writes.splitReceipt.path,
      oosPolicy:writes.oosPolicy.path,
      wfPolicy:writes.wfPolicy.path,
      holdoutPolicy:writes.holdoutPolicy.path,
      record:recordWrite.path,
    }),
    executionAuthority:'NONE',
  });
}
