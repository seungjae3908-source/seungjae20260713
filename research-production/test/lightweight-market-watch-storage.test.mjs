import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WATCH_STORAGE_LIMITS, appendBoundedWatchEvents, atomicDurableWatchJson,
  checkWatchDailyAppend,
} from '../src/lightweight-market-watch-storage.mjs';

const AT = '2026-10-09T00:03:00.000Z';
async function workspace(fn) {
  const root=await mkdtemp(join(tmpdir(), 'public-watch-storage-'));
  try {
    await mkdir(join(root,'watch','events'),{recursive:true,mode:0o700});
    await mkdir(join(root,'watch','outcomes'),{recursive:true,mode:0o700});
    await mkdir(join(root,'latest'),{recursive:true,mode:0o700});
    return await fn(root);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}
const row = (id='a') => ({
  eventId:id, market:'CRYPTO_FUTURES', source:'PUBLIC_DATA',
  kind:'PUBLIC_PRICE_OBSERVATION_ONLY', economicEvidenceCredit:0,
  oosCredit:0,paperCredit:0,executionAuthority:'NONE',
});

test('bounded watcher JSONL append records UTF8 lines privately and retains prior rows',async()=>{
  await workspace(async root=>{
    const path=join(root,'watch','events','2026-10-09.jsonl');
    await appendBoundedWatchEvents(root,[row('first')],AT,'events');
    await appendBoundedWatchEvents(root,[row('second'),row('third')],AT,'events');
    const data=await readFile(path,'utf8');
    const parsed=data.trimEnd().split('\n').map(x=>JSON.parse(x));
    assert.deepEqual(parsed.map(x=>x.eventId),['first','second','third']);
    assert.equal(data.endsWith('\n'),true);
    assert.equal((await stat(path)).mode & 0o077,0);
    await appendBoundedWatchEvents(root,[],AT,'events');
    assert.equal(await readFile(path,'utf8'),data);
    assert.equal(WATCH_STORAGE_LIMITS.dailyJsonlBytes,64*1024*1024);
    assert.equal(WATCH_STORAGE_LIMITS.jsonlLineBytes,16*1024);
  });
});

test('daily log threshold is fail-closed before oversize writes, no delete/archive attempt',()=>{
  const base={isFile:true,nlink:1,mode:0o100600};
  const max=WATCH_STORAGE_LIMITS.dailyJsonlBytes;
  assert.equal(checkWatchDailyAppend({...base,size:max-100,appendBytes:100}).afterAppendBytes,max);
  assert.throws(()=>checkWatchDailyAppend({...base,size:max-100,appendBytes:101}),/CAP_REACHED/);
  assert.throws(()=>checkWatchDailyAppend({...base,size:max+1,appendBytes:1}),/CAP_REACHED/);
  assert.throws(()=>checkWatchDailyAppend({...base,size:0,appendBytes:WATCH_STORAGE_LIMITS.singleAppendBytes+1}),/UNSAFE/);
  assert.throws(()=>checkWatchDailyAppend({...base,size:0,appendBytes:0}),/UNSAFE/);
  assert.throws(()=>checkWatchDailyAppend({...base,size:0,appendBytes:10,nlink:2}),/UNSAFE/);
  assert.throws(()=>checkWatchDailyAppend({...base,size:0,appendBytes:10,isFile:false}),/UNSAFE/);
  assert.throws(()=>checkWatchDailyAppend({...base,size:0,appendBytes:10,mode:0o100644}),/UNSAFE/);
});

test('symlink and hardlink logs cannot be written or escaped',async()=>{
  await workspace(async root=>{
    const target=join(root,'confidential-private.json');
    await writeFile(target,'do-not-modify\n',{mode:0o600});
    const log=join(root,'watch','events','2026-10-09.jsonl');
    await symlink(target,log);
    await assert.rejects(appendBoundedWatchEvents(root,[row()],AT,'events'));
    assert.equal(await readFile(target,'utf8'),'do-not-modify\n');
    await rm(log);
    await link(target,log);
    await assert.rejects(appendBoundedWatchEvents(root,[row()],AT,'events'),/UNSAFE/);
    assert.equal(await readFile(target,'utf8'),'do-not-modify\n');
  });
});

test('existing world-readable research log refuses append and keeps contents unchanged',async()=>{
  await workspace(async root=>{
    const file=join(root,'watch','outcomes','2026-10-09.jsonl');
    await writeFile(file,'{"preserve":true}\n',{mode:0o600});
    await chmod(file,0o644);
    await assert.rejects(appendBoundedWatchEvents(root,[row()],AT,'outcomes'),/UNSAFE/);
    assert.equal(await readFile(file,'utf8'),'{"preserve":true}\n');
  });
});

test('malformed dates, categories, row caps and oversize lines fail before producing output',async()=>{
  await workspace(async root=>{
    for(const [events,when,category] of [
      [[row()],'../../secret','events'],
      [[row()],'2026-02-30T00:00:00.000Z','events'],
      [[row()],AT,'../../unknown'],
      [Array(1025).fill(row()),AT,'events'],
      [[{payload:'x'.repeat(WATCH_STORAGE_LIMITS.jsonlLineBytes)}],AT,'events'],
    ]) await assert.rejects(appendBoundedWatchEvents(root,events,when,category));
    assert.equal((await readFile(join(root,'watch','events','2026-10-09.jsonl'),'utf8').catch(()=>null)),null);
  });
});

test('atomic persisted state is fsynced and private, then replaced without stale temp files',async()=>{
  await workspace(async root=>{
    const file=join(root,'latest','lightweight-market-watch.json');
    await atomicDurableWatchJson(file,{status:'MISSING',executionAuthority:'NONE'},WATCH_STORAGE_LIMITS.publicStatusJsonBytes);
    let content=JSON.parse(await readFile(file,'utf8'));
    assert.equal(content.status,'MISSING');
    await atomicDurableWatchJson(file,{status:'PARTIAL',executionAuthority:'NONE'},WATCH_STORAGE_LIMITS.publicStatusJsonBytes);
    content=JSON.parse(await readFile(file,'utf8'));
    assert.equal(content.status,'PARTIAL');
    assert.equal((await stat(file)).mode & 0o077,0);
    const entries=(await import('node:fs/promises')).readdir;
    assert.deepEqual((await entries(join(root,'latest'))).sort(),['lightweight-market-watch.json']);
    await assert.rejects(atomicDurableWatchJson(file,{raw:'x'.repeat(70_000)},WATCH_STORAGE_LIMITS.publicStatusJsonBytes),/OVERSIZE/);
    assert.equal(JSON.parse(await readFile(file,'utf8')).status,'PARTIAL');
    assert.deepEqual((await entries(join(root,'latest'))).sort(),['lightweight-market-watch.json']);
  });
});

test('atomic publisher refuses invalid byte cap and does not fake a successful state',async()=>{
  await workspace(async root=>{
    const file=join(root,'latest','lightweight-market-watch.json');
    await assert.rejects(atomicDurableWatchJson(file,{ok:true},WATCH_STORAGE_LIMITS.stateJsonBytes+1),/LIMIT_INVALID/);
    await assert.rejects(atomicDurableWatchJson(file,{ok:true},0),/LIMIT_INVALID/);
    assert.equal(await readFile(file,'utf8').catch(()=>null),null);
  });
});

test('existing watcher uses synced bounded append before its atomic cursor and status',async()=>{
  const bin=await readFile(new URL('../bin/lightweight-market-watch.mjs',import.meta.url),'utf8');
  assert.match(bin,/appendBoundedWatchEvents\(root, prospective\.outcomes,[\s\S]*'outcomes'\)/u);
  assert.match(bin,/appendBoundedWatchEvents\(root, allCandidates,[\s\S]*'events'\)/u);
  assert.match(bin,/atomicDurableWatchJson\(join\(root, 'watch', 'state-v1\.json'\), next\)/u);
  assert.match(bin,/atomicDurableWatchJson\(join\(root, 'latest', 'lightweight-market-watch\.json'\)/u);
  assert.ok(bin.indexOf('appendBoundedWatchEvents(root, allCandidates')
    < bin.indexOf("atomicDurableWatchJson(join(root, 'watch', 'state-v1.json')"));
  assert.doesNotMatch(bin,/LIVE_TRADING\s*=\s*true|AUTO_TRADING\s*=\s*true|placeOrder\(/u);
});
