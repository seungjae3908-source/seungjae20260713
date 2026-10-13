#!/usr/bin/env node
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeCanonicalEvaluationOneShotV18 } from '../src/research-workspace-canonical-evaluation-executor-v18.js';
import { createCanonicalEvaluationRuntimeV18 } from '../src/research-workspace-canonical-evaluation-runtime-v18.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha40=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const inside=(parent,child)=>{const p=resolve(parent)+sep,c=resolve(child)+sep;return c.startsWith(p);};
const safeCode=x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{2,95}$/.test(x)?x:'CANONICAL_EVALUATION_RUNTIME_FAILED';

async function secureDir(path,{create=false}={}){
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('CANONICAL_EVALUATION_ROOT_INVALID');
  if(create)await mkdir(path,{recursive:true,mode:0o700});
  const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    const st=await h.stat();
    if(!st.isDirectory()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077)||await realpath(path)!==path)
      fail('CANONICAL_EVALUATION_ROOT_UNSAFE');
  }finally{await h.close();}
  return path;
}
async function readJson(path,root,limit=4*1024*1024){
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||!inside(root,path))fail('CANONICAL_EVALUATION_PACKAGE_PATH_INVALID');
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const a=await h.stat();
    if(!a.isFile()||a.nlink!==1||a.size<=0||a.size>limit||(typeof process.getuid==='function'&&a.uid!==process.getuid())||(a.mode&0o077))
      fail('CANONICAL_EVALUATION_PACKAGE_UNSAFE');
    const b=Buffer.alloc(a.size);let n=0;
    while(n<b.length){const r=await h.read(b,n,b.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const z=await h.stat();
    if(n!==a.size||z.size!==a.size||z.mtimeMs!==a.mtimeMs||z.ctimeMs!==a.ctimeMs)fail('CANONICAL_EVALUATION_PACKAGE_CHANGED');
    try{return JSON.parse(b.toString('utf8'));}catch{fail('CANONICAL_EVALUATION_PACKAGE_INVALID');}
  }finally{await h.close();}
}
async function readOptional(path){
  try{
    const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const st=await h.stat();const b=Buffer.alloc(st.size);let n=0;while(n<b.length){const r=await h.read(b,n,b.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}return JSON.parse(b.toString('utf8'));}
    finally{await h.close();}
  }catch(e){if(e?.code==='ENOENT')return null;throw e;}
}
async function writeExclusive(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const h=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}
}
function parse(argv){
  const out={},allowed=new Set(['--package','--state-root','--repo-root','--current-sha']);
  for(let i=0;i<argv.length;i++){const k=argv[i];if(!allowed.has(k)||Object.hasOwn(out,k)||!argv[i+1]||argv[i+1].startsWith('--'))fail('CANONICAL_EVALUATION_ARGUMENTS_INVALID');out[k]=argv[++i];}
  for(const k of allowed)if(!out[k])fail('CANONICAL_EVALUATION_ARGUMENTS_INVALID');
  return out;
}
function checkoutSha(repoRoot){
  try{return execFileSync('git',['-c','safe.directory='+repoRoot,'-C',repoRoot,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim().toLowerCase();}
  catch{fail('CANONICAL_EVALUATION_CHECKOUT_UNVERIFIED');}
}
export async function runCanonicalEvaluationExecutionV18({packagePath,stateRoot,repoRoot,currentSha}={}){
  if(!sha40(currentSha)||!isAbsolute(repoRoot)||resolve(repoRoot)!==repoRoot)fail('CANONICAL_EVALUATION_IDENTITY_INVALID');
  await secureDir(stateRoot);
  if(checkoutSha(repoRoot)!==currentSha)fail('CANONICAL_EVALUATION_CHECKOUT_SHA_MISMATCH');
  const approvedRoot=await secureDir(join(stateRoot,'phase18','approved'),{create:true});
  const runtimeRoot=await secureDir(join(stateRoot,'phase18','runtime'),{create:true});
  const pkg=await readJson(packagePath,approvedRoot);
  if(!object(pkg)||pkg.schemaVersion!=='research-canonical-evaluation-execution-package-v18'||pkg.currentSha!==currentSha
    ||!object(pkg.request)||!object(pkg.review)||!object(pkg.decision)||!object(pkg.config)||!object(pkg.preflight)
    ||!object(pkg.runtimeProof)||!object(pkg.executionContext))fail('CANONICAL_EVALUATION_PACKAGE_INVALID');
  const runtime=createCanonicalEvaluationRuntimeV18(pkg.executionContext,{currentSha,config:pkg.config});
  const reservations=await secureDir(join(runtimeRoot,'reservations'),{create:true});
  const results=await secureDir(join(runtimeRoot,'results'),{create:true});
  const reserve=async record=>{
    const path=join(reservations,record.reservationId+'.json'),prior=await readOptional(path);
    if(prior){
      if(prior.requestDigest!==record.requestDigest||prior.sourceSha!==record.sourceSha)fail('CANONICAL_EVALUATION_RESERVATION_CONFLICT');
      return {acquired:false};
    }
    await writeExclusive(path,{...record,reservedAt:new Date().toISOString()});return {acquired:true};
  };
  const persistResult=async result=>{
    const path=join(results,result.requestDigest+'.json'),prior=await readOptional(path);
    if(prior)return {stored:JSON.stringify(prior)===JSON.stringify(result),requestDigest:result.requestDigest};
    await writeExclusive(path,result);return {stored:true,requestDigest:result.requestDigest};
  };
  return executeCanonicalEvaluationOneShotV18({
    request:pkg.request,currentSha,review:pkg.review,decision:pkg.decision,config:pkg.config,preflight:pkg.preflight,
    runtimeProof:pkg.runtimeProof,checkedAt:new Date().toISOString(),executionContext:pkg.executionContext,
  },{reserve,compileCanonical:runtime.compileCanonical,runBacktest:runtime.runBacktest,persistResult});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const o=parse(process.argv.slice(2));
    const result=await runCanonicalEvaluationExecutionV18({
      packagePath:resolve(o['--package']),stateRoot:resolve(o['--state-root']),repoRoot:resolve(o['--repo-root']),
      currentSha:String(o['--current-sha']).trim().toLowerCase(),
    });
    process.stdout.write(JSON.stringify({
      schemaVersion:result.schemaVersion,status:result.status,reason:result.reason??null,evaluationId:result.evaluationId,
      sourceSha:result.sourceSha,requestDigest:result.requestDigest,reservationId:result.reservationId,
      compilerRuns:result.compilerRuns,backtestRuns:result.backtestRuns,resultDisposition:result.resultDisposition,
      automaticAdoption:false,paperActivation:false,liveActivation:false,profitabilityProven:false,executionAuthority:'NONE',
    })+'\n');
    if(!['RESEARCH_EVIDENCE_RECORDED','REVIEW_REQUIRED'].includes(result.status))process.exitCode=2;
  }catch(e){
    process.stderr.write(JSON.stringify({status:'BLOCKED',reason:safeCode(e?.code??e?.message),executionAuthority:'NONE'})+'\n');
    process.exitCode=1;
  }
}
