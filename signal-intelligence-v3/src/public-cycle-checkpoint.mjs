/**
 * V3 public scanner two-file checkpoint journal. Existing flock serializes
 * writes; a pending journal is replayed with no additional provider requests.
 * No Telegram, Paper, live execution or private-account authority.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const V3_PUBLIC_CYCLE_CHECKPOINT_SCHEMA='v3-public-cycle-durable-checkpoint-v1';
export const V3_PUBLIC_CYCLE_CHECKPOINT_MAX_BYTES=128*1024*1024;
const SHA=/^[0-9a-f]{40}$/u;
const CYCLE=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const bad=code=>new Error('V3_PUBLIC_CYCLE_CHECKPOINT_'+code);
const hash=data=>createHash('sha256').update(data).digest('hex');
function config(o){
  const {journalFile,cycleStateFile,snapshotFile,serviceSha}=o;
  if(![journalFile,cycleStateFile,snapshotFile].every(x=>typeof x==='string'&&isAbsolute(x))
    ||new Set([resolve(journalFile),resolve(cycleStateFile),resolve(snapshotFile)]).size!==3
    ||dirname(journalFile)!==dirname(cycleStateFile)
    ||dirname(cycleStateFile)!==dirname(snapshotFile)
    ||!SHA.test(serviceSha))throw bad('CONFIG_INVALID');
}
function validate(state,snapshot,sha,validateSnapshot){
  if(!state||state.schemaVersion!==2||state.serviceSha!==sha
    ||!state.cursors||typeof state.cursors!=='object'||Array.isArray(state.cursors)
    ||!Object.prototype.hasOwnProperty.call(state,'retained')
    ||!Object.prototype.hasOwnProperty.call(state,'rosterProgress')
    ||!snapshot||snapshot.serviceSha!==sha||snapshot.publicDataOnly!==true
    ||snapshot.safety?.executionAuthority!=='NONE'
    ||snapshot.safety?.privateTradingApiAllowed!==false
    ||snapshot.safety?.realOrderAllowed!==false
    ||!Array.isArray(snapshot.coverage)||snapshot.coverage.length!==12)
    throw bad('CONTRACT_INVALID');
  const ids=new Set(['KR','US','SPOT','FUTURES'].flatMap(m=>
    ['SCALPING_15M','SWING_60M','MID_LONG_1D'].map(s=>m+'_'+s)));
  const cycleId=snapshot.coverage[0]?.sourceCycleId,seen=new Set();
  if(!CYCLE.test(cycleId)||snapshot.coverage.some(l=>{
    if(!l||l.sourceCycleId!==cycleId||!ids.has(l.laneId)||seen.has(l.laneId)
      ||!Number.isSafeInteger(state.cursors[l.laneId])||state.cursors[l.laneId]<0
      ||l.cursorAfter!==state.cursors[l.laneId])return true;
    seen.add(l.laneId);return false;
  })||seen.size!==ids.size)throw bad('CYCLE_IDENTITY_INVALID');
  if(typeof validateSnapshot!=='function')throw bad('VALIDATOR_REQUIRED');
  try{validateSnapshot(snapshot);}catch{throw bad('SNAPSHOT_INVALID');}
}
function dataOf(sha,state,snapshot){
  return {schemaVersion:V3_PUBLIC_CYCLE_CHECKPOINT_SCHEMA,serviceSha:sha,state,snapshot};
}
async function safeRead(file){
  let before;
  try{before=await lstat(file);}catch(e){
    if(e?.code==='ENOENT')return null;throw bad('READ_FAILED');
  }
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
    ||(before.mode&0o022)!==0||before.size<1
    ||before.size>V3_PUBLIC_CYCLE_CHECKPOINT_MAX_BYTES)throw bad('UNSAFE_FILE');
  let fd;
  try{
    fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await fd.stat();
    if(!stat.isFile()||stat.ino!==before.ino||stat.dev!==before.dev||stat.size!==before.size)
      throw bad('FILE_REPLACED');
    const body=await fd.readFile({encoding:'utf8'});
    if(Buffer.byteLength(body,'utf8')!==stat.size)throw bad('FILE_REPLACED');
    let parsed;try{parsed=JSON.parse(body);}catch{throw bad('INVALID_JSON');}
    return {parsed,ino:stat.ino,dev:stat.dev};
  }catch(e){
    if(e?.message?.startsWith('V3_PUBLIC_CYCLE_CHECKPOINT_'))throw e;
    throw bad('READ_FAILED');
  }finally{await fd?.close();}
}
function verified(record,{serviceSha,validateSnapshot}){
  const payload=record.parsed;
  if(payload?.schemaVersion!==V3_PUBLIC_CYCLE_CHECKPOINT_SCHEMA
    ||payload?.serviceSha!==serviceSha
    ||typeof payload?.checksumSha256!=='string'
    ||!/^[a-f0-9]{64}$/u.test(payload.checksumSha256))throw bad('IDENTITY_INVALID');
  validate(payload.state,payload.snapshot,serviceSha,validateSnapshot);
  if(hash(JSON.stringify(dataOf(serviceSha,payload.state,payload.snapshot)))
    !==payload.checksumSha256)throw bad('DIGEST_MISMATCH');
  return payload;
}
async function safeUnlink(file,record){
  const stat=await lstat(file).catch(()=>{throw bad('FILE_CHANGED');});
  if(!stat.isFile()||stat.ino!==record.ino||stat.dev!==record.dev)
    throw bad('FILE_CHANGED');
  await unlink(file);
}
export async function recoverPublicV3CycleCheckpoint({
  journalFile,cycleStateFile,snapshotFile,serviceSha,atomicWrite,validateSnapshot,
}={}){
  config({journalFile,cycleStateFile,snapshotFile,serviceSha});
  if(typeof atomicWrite!=='function')throw bad('WRITER_REQUIRED');
  const record=await safeRead(journalFile);
  if(!record)return Object.freeze({recovered:false,executionAuthority:'NONE'});
  const parsed=verified(record,{serviceSha,validateSnapshot});
  await atomicWrite(cycleStateFile,parsed.state);
  await atomicWrite(snapshotFile,parsed.snapshot);
  await safeUnlink(journalFile,record);
  return Object.freeze({recovered:true,executionAuthority:'NONE'});
}
export async function commitPublicV3CycleCheckpoint({
  journalFile,cycleStateFile,snapshotFile,serviceSha,state,snapshot,
  atomicWrite,validateSnapshot,
}={}){
  config({journalFile,cycleStateFile,snapshotFile,serviceSha});
  if(typeof atomicWrite!=='function')throw bad('WRITER_REQUIRED');
  validate(state,snapshot,serviceSha,validateSnapshot);
  const data=dataOf(serviceSha,state,snapshot);
  const payload={...data,checksumSha256:hash(JSON.stringify(data))};
  if(Buffer.byteLength(JSON.stringify(payload,null,2),'utf8')+1>V3_PUBLIC_CYCLE_CHECKPOINT_MAX_BYTES)
    throw bad('SIZE_OUT_OF_BOUNDS');
  if(await safeRead(journalFile))throw bad('PENDING_RECOVERY_REQUIRED');
  await atomicWrite(journalFile,payload);
  const record=await safeRead(journalFile);
  if(!record)throw bad('JOURNAL_NOT_DURABLE');
  verified(record,{serviceSha,validateSnapshot});
  try{
    await atomicWrite(cycleStateFile,state);
    await atomicWrite(snapshotFile,snapshot);
  }catch{throw bad('COMMIT_PENDING_RECOVERY');}
  await safeUnlink(journalFile,record);
  return Object.freeze({committed:true,executionAuthority:'NONE'});
}
