import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod, link, mkdir, mkdtemp, readFile, readdir, rm,
  symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWatchStorageCapacity } from '../src/lightweight-market-watch-capacity-readback.mjs';
import { WATCH_CAPACITY_CONTRACT } from '../src/lightweight-market-watch-capacity.mjs';

const SHA = 'a'.repeat(40);
const nowMs = Date.parse('2026-10-10T09:00:00.000Z');
const day = '2026-10-09';
async function workspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'watch-capacity-'));
  try { return await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function dirs(root) {
  for (const category of ['events','outcomes','cadence'])
    await mkdir(join(root,'watch',category), { recursive: true, mode: 0o700 });
}
async function put(root, category='events', name=day+'.jsonl', data='{"public":true}\n') {
  const file = join(root,'watch',category,name);
  await writeFile(file,data,{ mode:0o600 });
  return file;
}
function runCli(root,sha=SHA) {
  const exe = new URL('../bin/lightweight-market-watch-capacity-status.mjs',import.meta.url).pathname;
  return spawnSync(process.execPath,[exe],{encoding:'utf8',env:{
    ...process.env,RESEARCH_STATE_ROOT:root,RESEARCH_CODE_SHA:sha,
  }});
}
test('missing watch directories are clearly incomplete, never a retention approval', async()=>{
  await workspace(async root=>{
    const report=await readWatchStorageCapacity(root,nowMs);
    assert.equal(report.contract,WATCH_CAPACITY_CONTRACT);
    assert.equal(report.status,'INSUFFICIENT_HISTORY');
    assert.equal(report.fileCount,0);
    assert.equal(report.missingCategoryCount,3);
    assert.equal(report.categoryMetadataComplete,false);
    assert.equal(report.sourceDataRead,false);
    assert.equal(report.continuous24hProven,false);
    assert.equal(report.archiveVerified,false);
    assert.equal(report.deletionAllowed,false);
    assert.equal(report.executionAuthority,'NONE');
    const cli=runCli(root);
    assert.equal(cli.status,0,cli.stdout+' '+cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status,'INSUFFICIENT_HISTORY');
    assert.equal((await readdir(root)).includes('watch'),false);
  });
});
test('private daily event, outcome, cadence metadata is counted without reading raw contents',async()=>{
  await workspace(async root=>{
    await dirs(root);
    const file=await put(root,'events',day+'.jsonl','{"secretApiKey":"NEVER_SHOW"}\n');
    await put(root,'outcomes',day+'.jsonl');
    await put(root,'cadence','2026-10-10.jsonl');
    const before=await readFile(file,'utf8');
    const v=await readWatchStorageCapacity(root,nowMs);
    assert.equal(v.fileCount,3);
    assert.equal(v.datedDayCount,2);
    assert.equal(v.missingCategoryCount,0);
    assert.equal(v.categoryMetadataComplete,true);
    assert.ok(v.totalTrackedBytes>0);
    assert.ok(Number.isSafeInteger(v.diskFreeBytes));
    assert.equal(v.sourceDataRead,false);
    assert.equal(v.retentionApplied,false);
    const cli=runCli(root);
    assert.equal(cli.status,0,cli.stdout+' '+cli.stderr);
    const report=JSON.parse(cli.stdout);
    assert.equal(report.fileCount,3);
    assert.equal(report.configuredResearchSha,SHA);
    assert.equal(report.exactReleaseAttested,false);
    assert.equal(report.privateApiAccessed,false);
    assert.equal(report.realOrders,0);
    assert.equal(report.paperOrders,0);
    assert.equal(JSON.stringify(report).includes('NEVER_SHOW'),false);
    assert.equal(JSON.stringify(report).includes(root),false);
    assert.equal(await readFile(file,'utf8'),before);
    assert.deepEqual((await readdir(join(root,'watch','events'))),[day+'.jsonl']);
  });
});
test('missing category after valid data is reported incomplete, never green',async()=>{
  await workspace(async root=>{
    await mkdir(join(root,'watch','events'),{recursive:true,mode:0o700});
    await put(root);
    const v=await readWatchStorageCapacity(root,nowMs);
    assert.equal(v.fileCount,1);
    assert.equal(v.missingCategoryCount,2);
    assert.equal(v.categoryMetadataComplete,false);
    assert.notEqual(v.status,'OBSERVING');
    assert.equal(v.continuous24hProven,false);
  });
});
test('non-regular symlink and hardlink never contribute file capacity',async()=>{
  await workspace(async root=>{
    await dirs(root);
    const target=join(root,'private-account.json');
    await writeFile(target,'do not change',{mode:0o600});
    const file=join(root,'watch','events',day+'.jsonl');
    await symlink(target,file);
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/FILE_UNSAFE/);
    await rm(file);
    await link(target,file);
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/FILE_UNSAFE/);
    assert.equal(await readFile(target,'utf8'),'do not change');
    const cli=runCli(root);
    assert.equal(cli.status,2);
    assert.equal(JSON.parse(cli.stdout).status,'INVALID');
    assert.equal(cli.stdout.includes(root),false);
  });
});
test('file permission, directory symlink and world-writable directory block diagnostics',async()=>{
  await workspace(async root=>{
    await dirs(root);
    const f=await put(root);
    await chmod(f,0o644);
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/FILE_UNSAFE/);
    await chmod(f,0o600);
    await chmod(join(root,'watch','events'),0o777);
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/DIRECTORY_UNSAFE/);
    await chmod(join(root,'watch','events'),0o700);
    await rm(join(root,'watch','cadence'),{recursive:true});
    await symlink(join(root,'watch','events'),join(root,'watch','cadence'),'dir');
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/DIRECTORY_UNSAFE/);
    const result=runCli(root);
    assert.equal(result.status,2);
    assert.equal(JSON.parse(result.stdout).executionAuthority,'NONE');
  });
});
test('unexpected, malformed, future or oversized files fail closed and do not disappear',async()=>{
  await workspace(async root=>{
    await dirs(root);
    const f=await put(root,'events',day+'.tmp','not-a-log');
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/UNEXPECTED_FILE/);
    await rm(f);
    await put(root,'events','2026-02-30.jsonl');
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/UNEXPECTED_FILE/);
    await rm(join(root,'watch','events','2026-02-30.jsonl'));
    await put(root,'events','2026-10-11.jsonl');
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/UNEXPECTED_FILE/);
    await rm(join(root,'watch','events','2026-10-11.jsonl'));
    const big=await put(root);
    const {truncate}=await import('node:fs/promises');
    await truncate(big,64*1024*1024+1);
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/FILE_UNSAFE/);
  });
});
test('hard scan ceiling refuses unbounded directories without deletion',async()=>{
  await workspace(async root=>{
    await dirs(root);
    for(let i=0;i<367;i++){
      const date=new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10);
      await put(root,'events',date+'.jsonl','{}\n');
    }
    await assert.rejects(readWatchStorageCapacity(root,nowMs),/DIRECTORY_LIMIT/);
    assert.equal((await readdir(join(root,'watch','events'))).length,367);
  });
});
test('invalid CLI configuration fails privately with fixed diagnostic code',async()=>{
  await workspace(async root=>{
    const result=runCli(root,'malformed-sha');
    assert.equal(result.status,2);
    const body=JSON.parse(result.stdout);
    assert.equal(body.status,'INVALID');
    assert.deepEqual(body.errorCodes,['WATCH_CAPACITY_READ_FAILED']);
    assert.equal(body.totalTrackedBytes,null);
    assert.equal(body.archiveVerified,false);
    assert.equal(body.deletionAllowed,false);
    assert.equal(body.realOrders,0);
    assert.equal(result.stdout.includes(root),false);
    assert.equal(result.stdout.includes('malformed-sha'),false);
  });
});
test('source remains read-only and never starts services, places orders or calls external providers',async()=>{
  const reader=await readFile(new URL('../src/lightweight-market-watch-capacity-readback.mjs',import.meta.url),'utf8');
  const cli=await readFile(new URL('../bin/lightweight-market-watch-capacity-status.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(reader,/writeFile\(|unlink\(|rename\(|mkdir\(|rm\(|fetch\(|placeOrder\(/);
  assert.doesNotMatch(cli,/fetch\(|exec\(|spawn\(|systemctl|placeOrder\(/);
  assert.match(reader,/statfs\(root\)/);
  assert.match(cli,/privateApiAccessed: false/);
});
