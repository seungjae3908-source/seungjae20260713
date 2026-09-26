/** Durable local research queue foundation. No scheduler, provider grant issuer or trading authority. */
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const integer=(x,a,b)=>Number.isSafeInteger(x)&&x>=a&&x<=b;
const sha=value=>createHash('sha256').update(value).digest('hex');
const safeCode=x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(x);
const kinds=new Set(['VIDEO_PREPARE','VIDEO_EXECUTE_APPROVED']);
const runner='EXISTING_PROVIDER_VIDEO_V8';
const networkModes=new Set(['NONE','APPROVED_ONE_SHOT']);
const terminal=new Set(['SUCCEEDED','FAILED','BLOCKED_UNCERTAIN']);
const claims=new WeakMap();
const safeArg=x=>typeof x==='string'&&x.length>0&&x.length<=2048&&!/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*\S+)/i.test(x);

function clone(x){return structuredClone(x);}
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(object(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
function jsonDigest(x){return sha(JSON.stringify(canonical(x)));}
function taskValid(task){
  if(!exact(task,['kind','runner','networkMode','argv'])||!kinds.has(task.kind)||task.runner!==runner||!networkModes.has(task.networkMode)||
    !Array.isArray(task.argv)||task.argv.length<4||task.argv.length>20||!task.argv.every(safeArg))return false;
  if(task.argv.includes('--existing-env')||task.argv.includes('--preflight'))return false;
  const execute=task.argv.includes('--execute'),approval=task.argv.includes('--approval');
  if(task.kind==='VIDEO_PREPARE'&&(task.networkMode!=='NONE'||execute||approval))return false;
  if(task.kind==='VIDEO_EXECUTE_APPROVED'&&(task.networkMode!=='APPROVED_ONE_SHOT'||!execute||!approval))return false;
  for(const required of ['--spec','--output-root'])if(!task.argv.includes(required))return false;
  return true;
}
function jobValid(job){
  return exact(job,['schemaVersion','jobId','createdAt','notBefore','maxAttempts','task'])&&
    job.schemaVersion==='research-worker-job-v9'&&id(job.jobId)&&iso(job.createdAt)&&iso(job.notBefore)&&
    job.notBefore>=job.createdAt&&integer(job.maxAttempts,1,5)&&taskValid(job.task);
}
function stateValid(row){
  return object(row)&&row.schemaVersion==='research-worker-state-v9'&&id(row.jobId)&&digest(row.jobDigest)&&
    ['QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED_UNCERTAIN'].includes(row.status)&&
    integer(row.attempts,0,5)&&integer(row.maxAttempts,1,5)&&taskValid(row.task)&&iso(row.createdAt)&&iso(row.notBefore)&&iso(row.updatedAt);
}
async function exists(path){try{await lstat(path);return true;}catch(e){if(e?.code==='ENOENT')return false;throw e;}}
async function secureDir(path,{create=false}={}){
  if(create)await mkdir(path,{recursive:true,mode:0o700});
  const st=await lstat(path);
  if(!st.isDirectory()||st.isSymbolicLink()||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077))fail('WORKER_STORE_UNSAFE');
  return await realpath(path);
}
async function readJson(path,max=256*1024){
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const st=await h.stat();
    if(!st.isFile()||st.nlink!==1||st.size>max||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077))fail('WORKER_FILE_UNSAFE');
    const b=Buffer.alloc(st.size);let n=0;
    while(n<b.length){const r=await h.read(b,n,b.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const after=await h.stat();
    if(n!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)fail('WORKER_FILE_CHANGED');
    return JSON.parse(b.toString('utf8'));
  }catch(e){if(e instanceof SyntaxError)fail('WORKER_FILE_INVALID');throw e;}finally{await h.close();}
}
async function writeAtomic(path,value){
  const dir=path.slice(0,path.lastIndexOf('/')),name=path.slice(path.lastIndexOf('/')+1);
  const tmp=join(dir,`.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const h=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}
  await rename(tmp,path);
}
async function writeExclusive(path,value){
  const h=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}
}
function dirs(root){return Object.fromEntries(['index','queued','running','done','failed','blocked','heartbeats','reservations'].map(x=>[x,join(root,x)]));}
async function listJson(dir){try{return (await readdir(dir)).filter(x=>x.endsWith('.json')).sort();}catch(e){if(e?.code==='ENOENT')return [];throw e;}}
async function runningFile(d,jobId){
  const rows=(await listJson(d.running)).filter(x=>x.startsWith(jobId+'.'));
  if(rows.length>1)fail('WORKER_DUPLICATE_RUNNING_STATE');
  return rows.length?join(d.running,rows[0]):null;
}
function queuedState(job){
  const jobDigest=jsonDigest(job);
  return {schemaVersion:'research-worker-state-v9',jobId:job.jobId,jobDigest,status:'QUEUED',attempts:0,maxAttempts:job.maxAttempts,
    createdAt:job.createdAt,notBefore:job.notBefore,updatedAt:job.createdAt,task:clone(job.task),lastError:null};
}
function leaseView(row,workerId,leaseId,path){
  const lease=Object.freeze({jobId:row.jobId,jobDigest:row.jobDigest,workerId,leaseId,taskKind:row.task.kind});
  claims.set(lease,{path});
  return lease;
}
function claimData(lease){const x=claims.get(lease);if(!x)fail('WORKER_LEASE_REQUIRED');return x;}

export function createResearchWorkerQueue(root,{clock=()=>new Date().toISOString(),leaseMs=60000,retryDelayMs=60000}={}){
  if(typeof root!=='string'||!isAbsolute(root)||typeof clock!=='function'||!integer(leaseMs,5000,600000)||!integer(retryDelayMs,0,3600000))fail('WORKER_CONFIG_INVALID');
  const d=dirs(root);
  async function initialize(){
    await secureDir(root,{create:true});
    for(const path of Object.values(d))await secureDir(path,{create:true});
    return {schemaVersion:'research-worker-init-v9',rootReady:true,automaticActivation:false};
  }
  async function enqueue(job){
    if(!jobValid(job))fail('WORKER_JOB_INVALID');
    await initialize();
    const state=queuedState(job),indexPath=join(d.index,`${job.jobId}.json`);
    if(await exists(indexPath)){
      const old=await readJson(indexPath);
      if(old.jobDigest!==state.jobDigest)fail('WORKER_JOB_ID_CONFLICT');
      return {status:'EXISTS',jobId:job.jobId,jobDigest:state.jobDigest};
    }
    await writeExclusive(indexPath,{schemaVersion:'research-worker-index-v9',jobId:job.jobId,jobDigest:state.jobDigest,createdAt:job.createdAt});
    await writeExclusive(join(d.queued,`${job.jobId}.json`),state);
    return {status:'QUEUED',jobId:job.jobId,jobDigest:state.jobDigest};
  }
  async function claimNext(workerId){
    if(!id(workerId))fail('WORKER_ID_INVALID');
    await initialize();const now=clock();if(!iso(now))fail('WORKER_CLOCK_INVALID');
    for(const name of await listJson(d.queued)){
      const queuedPath=join(d.queued,name),jobId=name.slice(0,-5),leaseId=randomBytes(12).toString('hex');
      const target=join(d.running,`${jobId}.${leaseId}.json`);
      try{await rename(queuedPath,target);}catch(e){if(e?.code==='ENOENT')continue;throw e;}
      let row;
      try{row=await readJson(target);}catch(e){await rename(target,join(d.failed,`${jobId}.json`)).catch(()=>{});throw e;}
      if(!stateValid(row)||row.status!=='QUEUED'||row.jobId!==jobId)fail('WORKER_QUEUE_STATE_INVALID');
      if(row.notBefore>now){await rename(target,queuedPath);continue;}
      const expiresAt=new Date(Date.parse(now)+leaseMs).toISOString();
      row={...row,status:'RUNNING',attempts:row.attempts+1,updatedAt:now,workerId,leaseId,startedAt:now,leaseExpiresAt:expiresAt,lastError:null};
      await writeAtomic(target,row);
      await writeAtomic(join(d.heartbeats,`${jobId}.${leaseId}.json`),{schemaVersion:'research-worker-lease-heartbeat-v9',jobId,leaseId,workerId,heartbeatAt:now,leaseExpiresAt:expiresAt});
      return {job:clone(row),lease:leaseView(row,workerId,leaseId,target)};
    }
    return null;
  }
  async function heartbeat(lease){
    const {path}=claimData(lease),row=await readJson(path);
    if(row.status!=='RUNNING'||row.leaseId!==lease.leaseId||row.workerId!==lease.workerId)fail('WORKER_LEASE_LOST');
    const now=clock(),expiresAt=new Date(Date.parse(now)+leaseMs).toISOString();if(!iso(now))fail('WORKER_CLOCK_INVALID');
    await writeAtomic(join(d.heartbeats,`${lease.jobId}.${lease.leaseId}.json`),{schemaVersion:'research-worker-lease-heartbeat-v9',jobId:lease.jobId,leaseId:lease.leaseId,workerId:lease.workerId,heartbeatAt:now,leaseExpiresAt:expiresAt});
    return expiresAt;
  }
  async function reserveExternal(lease,reservationDigest){
    const {path}=claimData(lease);if(!digest(reservationDigest))fail('WORKER_RESERVATION_INVALID');
    const row=await readJson(path);if(row.status!=='RUNNING'||row.leaseId!==lease.leaseId)fail('WORKER_LEASE_LOST');
    const target=join(d.reservations,`${lease.jobId}.${lease.leaseId}.json`);
    if(await exists(target)){const old=await readJson(target);if(old.reservationDigest!==reservationDigest)fail('WORKER_RESERVATION_CONFLICT');return old;}
    const record={schemaVersion:'research-worker-external-reservation-v9',jobId:lease.jobId,leaseId:lease.leaseId,reservationDigest,reservedAt:clock()};
    await writeExclusive(target,record);return record;
  }
  async function hasReservation(lease){
    return await exists(join(d.reservations,`${lease.jobId}.${lease.leaseId}.json`));
  }
  async function transition(lease,status,extra,dir){
    const {path}=claimData(lease),row=await readJson(path);
    if(row.status!=='RUNNING'||row.leaseId!==lease.leaseId||row.workerId!==lease.workerId)fail('WORKER_LEASE_LOST');
    const next={...row,...extra,status,updatedAt:clock()};delete next.workerId;delete next.leaseId;delete next.leaseExpiresAt;
    await writeAtomic(path,next);await rename(path,join(dir,`${lease.jobId}.json`));
    await rm(join(d.heartbeats,`${lease.jobId}.${lease.leaseId}.json`),{force:true});claims.delete(lease);return clone(next);
  }
  async function complete(lease,{resultDigest,outcome}){
    if(!digest(resultDigest)||!['PREPARED','REVIEW_REQUIRED','INSUFFICIENT_EVIDENCE'].includes(outcome))fail('WORKER_RESULT_INVALID');
    return transition(lease,'SUCCEEDED',{resultDigest,outcome,completedAt:clock(),lastError:null},d.done);
  }
  async function failJob(lease,{code,retryable=false}){
    if(!safeCode(code)||typeof retryable!=='boolean')fail('WORKER_FAILURE_INVALID');
    const {path}=claimData(lease),row=await readJson(path);
    if(row.status!=='RUNNING'||row.leaseId!==lease.leaseId)fail('WORKER_LEASE_LOST');
    if(await hasReservation(lease))return transition(lease,'BLOCKED_UNCERTAIN',{lastError:code,blockedAt:clock()},d.blocked);
    if(retryable&&row.attempts<row.maxAttempts){
      const now=clock(),next={...row,status:'QUEUED',updatedAt:now,notBefore:new Date(Date.parse(now)+retryDelayMs).toISOString(),lastError:code};
      delete next.workerId;delete next.leaseId;delete next.leaseExpiresAt;
      await writeAtomic(path,next);await rename(path,join(d.queued,`${lease.jobId}.json`));
      await rm(join(d.heartbeats,`${lease.jobId}.${lease.leaseId}.json`),{force:true});claims.delete(lease);return clone(next);
    }
    return transition(lease,'FAILED',{lastError:code,failedAt:clock()},d.failed);
  }
  async function recoverExpired(){
    await initialize();const now=clock();if(!iso(now))fail('WORKER_CLOCK_INVALID');let recovered=0,blocked=0,failed=0;
    for(const name of await listJson(d.running)){
      const path=join(d.running,name),row=await readJson(path),jobId=name.split('.')[0];
      if(!stateValid(row)||row.jobId!==jobId)fail('WORKER_QUEUE_STATE_INVALID');
      if(row.status==='QUEUED'){await rename(path,join(d.queued,`${jobId}.json`));recovered++;continue;}
      if(row.status==='SUCCEEDED'){await rename(path,join(d.done,`${jobId}.json`));continue;}
      if(row.status==='FAILED'){await rename(path,join(d.failed,`${jobId}.json`));continue;}
      if(row.status==='BLOCKED_UNCERTAIN'){await rename(path,join(d.blocked,`${jobId}.json`));blocked++;continue;}
      const hbPath=join(d.heartbeats,`${jobId}.${row.leaseId}.json`);let expires=row.leaseExpiresAt;
      if(await exists(hbPath)){const hb=await readJson(hbPath);if(hb.leaseId===row.leaseId&&iso(hb.leaseExpiresAt))expires=hb.leaseExpiresAt;}
      if(iso(expires)&&expires>now)continue;
      const reservation=join(d.reservations,`${jobId}.${row.leaseId}.json`);
      if(await exists(reservation)){
        const next={...row,status:'BLOCKED_UNCERTAIN',updatedAt:now,blockedAt:now,lastError:'LEASE_EXPIRED_AFTER_EXTERNAL_RESERVATION'};
        delete next.workerId;delete next.leaseId;delete next.leaseExpiresAt;await writeAtomic(path,next);await rename(path,join(d.blocked,`${jobId}.json`));blocked++;
      }else if(row.attempts<row.maxAttempts){
        const next={...row,status:'QUEUED',updatedAt:now,notBefore:now,lastError:'LEASE_EXPIRED_RECOVERED'};
        delete next.workerId;delete next.leaseId;delete next.leaseExpiresAt;await writeAtomic(path,next);await rename(path,join(d.queued,`${jobId}.json`));recovered++;
      }else{
        const next={...row,status:'FAILED',updatedAt:now,failedAt:now,lastError:'LEASE_EXPIRED_MAX_ATTEMPTS'};
        delete next.workerId;delete next.leaseId;delete next.leaseExpiresAt;await writeAtomic(path,next);await rename(path,join(d.failed,`${jobId}.json`));failed++;
      }
      await rm(hbPath,{force:true});
    }
    return {recovered,blocked,failed};
  }
  async function pulse(workerId,{state='IDLE',taskKind=null,ttlMs=90000}={}){
    if(!id(workerId)||!['IDLE','PROCESSING','STOPPED'].includes(state)||(taskKind!==null&&!kinds.has(taskKind))||!integer(ttlMs,1000,600000))fail('WORKER_PULSE_INVALID');
    await initialize();const now=clock(),validUntil=state==='STOPPED'?now:new Date(Date.parse(now)+ttlMs).toISOString();
    const value={schemaVersion:'research-worker-heartbeat-v9',workerId,state,taskKind,heartbeatAt:now,validUntil};
    await writeAtomic(join(root,'worker-heartbeat.json'),value);return value;
  }
  async function status(){
    if(!await exists(root))return {schemaVersion:'research-worker-status-v9',available:false,reason:'WORKER_STORE_NOT_INSTALLED'};
    try{await secureDir(root);}catch{return {schemaVersion:'research-worker-status-v9',available:false,reason:'WORKER_STORE_UNAVAILABLE'};}
    const count=async key=>(await listJson(d[key])).length;
    const counts={queued:await count('queued'),running:await count('running'),succeeded:await count('done'),failed:await count('failed'),blocked:await count('blocked')};
    const now=clock(),pulsePath=join(root,'worker-heartbeat.json');let workerState='NOT_RUNNING',lastHeartbeatAt=null,currentTaskKind=null;
    if(await exists(pulsePath)){
      try{const p=await readJson(pulsePath);if(p.schemaVersion==='research-worker-heartbeat-v9'&&iso(p.heartbeatAt)&&iso(p.validUntil)){
        lastHeartbeatAt=p.heartbeatAt;currentTaskKind=kinds.has(p.taskKind)?p.taskKind:null;
        workerState=p.state==='STOPPED'?'NOT_RUNNING':p.validUntil>now?'ACTIVE':'STALE';
      }}catch{workerState='UNKNOWN';}
    }
    return {schemaVersion:'research-worker-status-v9',available:true,checkedAt:now,workerState,lastHeartbeatAt,currentTaskKind,counts,
      authority:{executionAuthority:'NONE',automaticActivation:false,providerCallsFromStatus:0}};
  }
  return Object.freeze({initialize,enqueue,claimNext,heartbeat,reserveExternal,complete,fail:failJob,recoverExpired,pulse,status});
}

export async function runResearchWorkerOnce(queue,{workerId,handler,retryableCodes=[],heartbeatEveryMs=15000,onState=async()=>{}}={}){
  if(!queue||typeof queue.claimNext!=='function'||!id(workerId)||typeof handler!=='function'||!Array.isArray(retryableCodes)||
    !retryableCodes.every(safeCode)||!integer(heartbeatEveryMs,1000,60000)||typeof onState!=='function')fail('WORKER_RUNNER_CONFIG_INVALID');
  await queue.recoverExpired();const claimed=await queue.claimNext(workerId);if(!claimed)return {status:'IDLE'};
  const {job,lease}=claimed;await onState({state:'PROCESSING',taskKind:job.task.kind});
  let timer=setInterval(()=>{void queue.heartbeat(lease).catch(()=>{});},heartbeatEveryMs);
  try{
    if(job.task.networkMode==='APPROVED_ONE_SHOT')await queue.reserveExternal(lease,job.jobDigest);
    const result=await handler(clone(job));
    if(!exact(result,['status','resultDigest'])||!digest(result.resultDigest))fail('WORKER_HANDLER_RESULT_INVALID');
    const outcome=result.status==='PREPARED_NOT_EXECUTED'?'PREPARED':result.status==='RESPONSE_RECEIVED_REVIEW_REQUIRED'?'REVIEW_REQUIRED':
      result.status==='INSUFFICIENT_EVIDENCE'?'INSUFFICIENT_EVIDENCE':null;
    if(!outcome)fail('WORKER_HANDLER_RESULT_INVALID');
    await queue.complete(lease,{resultDigest:result.resultDigest,outcome});
    return {status:'SUCCEEDED',jobId:job.jobId,taskKind:job.task.kind,outcome};
  }catch(e){
    const code=safeCode(e?.code)?e.code:'WORKER_HANDLER_UNAVAILABLE';
    const row=await queue.fail(lease,{code,retryable:job.task.networkMode==='NONE'&&retryableCodes.includes(code)});
    return {status:row.status,jobId:job.jobId,taskKind:job.task.kind,reason:code};
  }finally{clearInterval(timer);await onState({state:'IDLE',taskKind:null});}
}
function sleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(Object.assign(new Error('aborted'),{name:'AbortError'}));const t=setTimeout(resolve,ms);const stop=()=>{clearTimeout(t);reject(Object.assign(new Error('aborted'),{name:'AbortError'}));};signal?.addEventListener('abort',stop,{once:true});});}
export async function runResearchWorkerLoop(queue,{workerId,handler,retryableCodes=[],pollMs=5000,heartbeatEveryMs=15000,signal}={}){
  if(!(signal instanceof AbortSignal)||!integer(pollMs,250,60000))fail('WORKER_LOOP_CONFIG_INVALID');
  await queue.initialize();const pulse=state=>queue.pulse(workerId,{...state,ttlMs:Math.max(heartbeatEveryMs*4,pollMs*4,30000)});
  try{
    while(!signal.aborted){
      await pulse({state:'IDLE',taskKind:null});
      const result=await runResearchWorkerOnce(queue,{workerId,handler,retryableCodes,heartbeatEveryMs,onState:pulse});
      if(result.status==='IDLE')await sleep(pollMs,signal);
    }
  }catch(e){if(e?.name!=='AbortError')throw e;}finally{await queue.pulse(workerId,{state:'STOPPED',taskKind:null,ttlMs:1000}).catch(()=>{});}
}
export function researchWorkerJobDigest(job){if(!jobValid(job))fail('WORKER_JOB_INVALID');return jsonDigest(job);}
