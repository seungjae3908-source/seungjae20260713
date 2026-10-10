import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeWatchStorageCapacity, WATCH_CAPACITY_POLICY} from '../src/lightweight-market-watch-capacity.mjs';
const GiB=1024**3;
const today='2026-10-10';
const file=(day,bytes,category='events')=>({day,bytes,category});
const run=(files,diskFreeBytes=37*GiB)=>summarizeWatchStorageCapacity({files,diskFreeBytes,nowUtcDay:today});
test('unknown 24h history is not a falsely approved retention plan',()=>{
 const x=run([]);assert.equal(x.status,'INSUFFICIENT_HISTORY');
 assert.equal(x.projectedDaysAboveFloor,null);
 assert.equal(x.retentionApplied,false);assert.equal(x.archiveVerified,false);
 assert.equal(x.deletionAllowed,false);assert.equal(x.continuous24hProven,false);
 assert.equal(x.executionAuthority,'NONE');
});
test('conservative capacity forecast uses only completed UTC days',()=>{
 const x=run([file('2026-10-08',2*1024**2),file('2026-10-09',4*1024**2),file(today,64*1024**2)]);
 assert.equal(x.lastSevenCompletedDaysAverageBytes,3*1024**2);
 assert.equal(x.fileCount,3);
 assert.equal(x.datedDayCount,3);
 assert.equal(x.status,'OBSERVATION_ONLY');
 assert.ok(x.projectedDaysAboveFloor>365);
});
test('host below app reserve or fewer than seven projected days cannot display green',()=>{
 const low=run([file('2026-10-09',64*1024**2)],4*GiB);
 assert.equal(low.status,'HOLD_LOW_DISK');
 const warn=run([file('2026-10-09',64*1024**2)],5*GiB+128*1024**2);
 assert.equal(warn.status,'HOLD_CAPACITY_RISK');
 assert.equal(warn.projectedDaysAboveFloor,2);
});
test('bad dates, duplicate identity, oversize, unexpected category, negative bytes fail closed',()=>{
 for(const fs of [
  [file('2026-02-30',2)],
  [file('2026-10-11',2)],
  [file(today,1),file(today,2)],
  [file(today,WATCH_CAPACITY_POLICY.maxFileBytes+1)],
  [file(today,-1)],
  [file(today,2,'private-orders')],
 ])assert.throws(()=>run(fs),/WATCH_CAPACITY_FILE_INVALID/);
 assert.throws(()=>run([], -1),/WATCH_CAPACITY_INPUT_INVALID/);
 assert.throws(()=>summarizeWatchStorageCapacity({files:[],diskFreeBytes:7*GiB,nowUtcDay:'2026-02-30'}),/WATCH_CAPACITY_INPUT_INVALID/);
});
test('daily ceiling never amounts to automatic deletion or order permission',()=>{
 const x=run([file('2026-10-09',WATCH_CAPACITY_POLICY.maxFileBytes,'cadence')]);
 assert.equal(x.profitabilityProven,false);
 assert.equal(x.retentionApplied,false);
 assert.equal(x.deletionAllowed,false);
 assert.equal(x.executionAuthority,'NONE');
});
