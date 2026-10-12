import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readV3StableSnapshot, sameV3SnapshotStat, V3_SNAPSHOT_MAX_BYTES,
} from '../src/public-snapshot-safe-read.mjs';

const metadata=(ino,size=8)=>({
  ino,size,mtimeMs:20,ctimeMs:30,isFile:()=>true,
});

test('retry one atomic replacement without reusing a stale snapshot',async()=>{
  const original=metadata(100),replacement=metadata(200);
  const stats=[original,replacement,replacement,replacement];
  const reads=['previous','replacement'];
  const result=await readV3StableSnapshot('snapshot.json',{
    fileStat:async()=>stats.shift(),
    fileRead:async()=>reads.shift(),
    cached:{...original,snapshot:{previous:true}},
  });
  assert.equal(result.cached,false);
  assert.equal(result.content,'replacement');
  assert.equal(result.metadata.ino,200);
  assert.equal(stats.length,0);
  assert.equal(reads.length,0);
  assert.equal(sameV3SnapshotStat(original,replacement),false);
});

test('second concurrent replacement fails closed, never serves a previous candidate',async()=>{
  const stats=[metadata(1),metadata(2),metadata(3),metadata(4)];
  let readCount=0;
  await assert.rejects(()=>readV3StableSnapshot('snapshot.json',{
    fileStat:async()=>stats.shift(),
    fileRead:async()=>{readCount++;return 'candidate';},
    cached:{...metadata(0),snapshot:{candidate:'STALE'}},
  }),/SNAPSHOT_FILE_CHANGED_DURING_READ/);
  assert.equal(readCount,2);
});

test('exactly unchanged metadata can reuse validated cache without a new read',async()=>{
  const prev=metadata(40);
  const result=await readV3StableSnapshot('snapshot.json',{
    cached:{...prev,snapshot:{trusted:true}},
    fileStat:async()=>metadata(40),
    fileRead:async()=>{throw Error('SHOULD_NOT_READ');},
  });
  assert.equal(result.cached,true);
  assert.equal(result.content,null);
});

test('empty, oversized and non-regular files fail closed before reading',async()=>{
  for(const size of [0,V3_SNAPSHOT_MAX_BYTES+1,NaN]){
    await assert.rejects(()=>readV3StableSnapshot('snapshot.json',{
      fileStat:async()=>metadata(1,size),
      fileRead:async()=>{throw Error('UNEXPECTED_FILE_READ');},
    }),/SNAPSHOT_SIZE_OUT_OF_BOUNDS/);
  }
  await assert.rejects(()=>readV3StableSnapshot('snapshot.json',{
    fileStat:async()=>({...metadata(2),isFile:()=>false}),
    fileRead:async()=>{throw Error('UNEXPECTED_FILE_READ');},
  }),/SNAPSHOT_NOT_A_FILE/);
});

test('a briefly missing newly published file can appear once; real absence stays missing',async()=>{
  let tries=0;
  const restored=await readV3StableSnapshot('snapshot.json',{
    fileStat:async()=>{
      tries++;
      if(tries===1)throw Object.assign(new Error('missing'),{code:'ENOENT'});
      return metadata(100);
    },
    fileRead:async()=>'{"safe":true}',
  });
  assert.equal(restored.content,'{"safe":true}');
  assert.equal(tries,3);
  await assert.rejects(()=>readV3StableSnapshot('snapshot.json',{
    fileStat:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});},
  }),{code:'ENOENT'});
});
