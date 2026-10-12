import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitPublicV3CycleCheckpoint, recoverPublicV3CycleCheckpoint } from '../src/public-cycle-checkpoint.mjs';
const SHA='a'.repeat(40),EPOCH='a12b34c5-0000-4bcd-8000-abcdefabcdef';
const LANES=['KR','US','SPOT','FUTURES'].flatMap(x=>['SCALPING_15M','SWING_60M','MID_LONG_1D'].map(y=>x+'_'+y));
const state=()=>({schemaVersion:2,serviceSha:SHA,
  cursors:Object.fromEntries(LANES.map(x=>[x,20])),retained:{},rosterProgress:{}});
const snapshot=()=>({serviceSha:SHA,publicDataOnly:true,generatedAt:new Date().toISOString(),
  safety:{executionAuthority:'NONE',privateTradingApiAllowed:false,realOrderAllowed:false},
  coverage:LANES.map(laneId=>({sourceCycleId:EPOCH,laneId,cursorAfter:20})),events:[]});
async function context(t){
  const dir=await mkdtemp(join(tmpdir(),'v3-checkpoint-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const journalFile=join(dir,'pending.json'),cycleStateFile=join(dir,'state.json'),
    snapshotFile=join(dir,'snapshot.json');
  const options={journalFile,cycleStateFile,snapshotFile,serviceSha:SHA,validateSnapshot:()=>true};
  const atomicWrite=async(p,obj)=>writeFile(p,JSON.stringify(obj)+'\n',{mode:0o600});
  return {options,atomicWrite};
}
test('complete two-file checkpoint and no new recovery required',async t=>{
  const {options,atomicWrite}=await context(t);
  assert.equal((await commitPublicV3CycleCheckpoint({...options,state:state(),snapshot:snapshot(),atomicWrite})).committed,true);
  assert.equal(JSON.parse(await readFile(options.cycleStateFile,'utf8')).cursors.KR_SCALPING_15M,20);
  await assert.rejects(lstat(options.journalFile),{code:'ENOENT'});
  assert.equal((await recoverPublicV3CycleCheckpoint({...options,atomicWrite})).recovered,false);
});
test('crash between cursor and snapshot is recovered from one immutable journal',async t=>{
  const {options,atomicWrite}=await context(t);
  await assert.rejects(commitPublicV3CycleCheckpoint({...options,state:state(),snapshot:snapshot(),
    atomicWrite:async(p,obj)=>{if(p===options.snapshotFile)throw Error('crash');await atomicWrite(p,obj);},
  }),/COMMIT_PENDING_RECOVERY/);
  await assert.rejects(readFile(options.snapshotFile,'utf8'),{code:'ENOENT'});
  assert.ok((await lstat(options.journalFile)).isFile());
  assert.equal((await recoverPublicV3CycleCheckpoint({...options,atomicWrite})).recovered,true);
  assert.equal(JSON.parse(await readFile(options.snapshotFile,'utf8')).coverage.length,12);
  await assert.rejects(lstat(options.journalFile),{code:'ENOENT'});
});
test('failure before cursor write preserves old state and recovers exact new state',async t=>{
  const {options,atomicWrite}=await context(t);
  const old=state();old.cursors.KR_SCALPING_15M=0;
  await atomicWrite(options.cycleStateFile,old);
  await assert.rejects(commitPublicV3CycleCheckpoint({...options,state:state(),snapshot:snapshot(),
    atomicWrite:async(p,obj)=>{if(p===options.cycleStateFile)throw Error('crash');await atomicWrite(p,obj);},
  }),/COMMIT_PENDING_RECOVERY/);
  assert.equal(JSON.parse(await readFile(options.cycleStateFile,'utf8')).cursors.KR_SCALPING_15M,0);
  await recoverPublicV3CycleCheckpoint({...options,atomicWrite});
  assert.equal(JSON.parse(await readFile(options.cycleStateFile,'utf8')).cursors.KR_SCALPING_15M,20);
});
test('corrupt journal remains blocked and is never discarded or overwritten',async t=>{
  const {options,atomicWrite}=await context(t);
  await writeFile(options.journalFile,'{BROKEN',{mode:0o600});
  await assert.rejects(recoverPublicV3CycleCheckpoint({...options,atomicWrite}),/INVALID_JSON/);
  await assert.rejects(commitPublicV3CycleCheckpoint({...options,state:state(),snapshot:snapshot(),atomicWrite}),/INVALID_JSON/);
  assert.equal(await readFile(options.journalFile,'utf8'),'{BROKEN');
});
test('symlink checkpoint cannot redirect read or clear another file',async t=>{
  const {options,atomicWrite}=await context(t);
  const target=join(options.journalFile,'..','private');
  await writeFile(target,'SECRET',{mode:0o600});
  await symlink(target,options.journalFile);
  await assert.rejects(recoverPublicV3CycleCheckpoint({...options,atomicWrite}),/UNSAFE_FILE/);
  assert.equal(await readFile(target,'utf8'),'SECRET');
});
test('previous release, invalid authority and inconsistent cursor epoch are rejected',async t=>{
  const {options,atomicWrite}=await context(t);
  await assert.rejects(commitPublicV3CycleCheckpoint({...options,state:state(),
    snapshot:{...snapshot(),safety:{executionAuthority:'LIVE'}},atomicWrite}),/CONTRACT_INVALID/);
  const wrong=snapshot();wrong.coverage[0].cursorAfter=100;
  await assert.rejects(commitPublicV3CycleCheckpoint({...options,state:state(),snapshot:wrong,atomicWrite}),/CYCLE_IDENTITY_INVALID/);
  await assert.rejects(commitPublicV3CycleCheckpoint({...options,state:state(),snapshot:snapshot(),
    atomicWrite:async(p,obj)=>{if(p===options.snapshotFile)throw Error('crash');await atomicWrite(p,obj);},
  }),/COMMIT_PENDING_RECOVERY/);
  await assert.rejects(recoverPublicV3CycleCheckpoint({...options,serviceSha:'b'.repeat(40),atomicWrite}),/IDENTITY_INVALID/);
  const tampered=JSON.parse(await readFile(options.journalFile,'utf8'));
  tampered.state.cursors.KR_SCALPING_15M=21;
  await atomicWrite(options.journalFile,tampered);
  await assert.rejects(recoverPublicV3CycleCheckpoint({...options,atomicWrite}),/CYCLE_IDENTITY_INVALID/);
});
