#!/usr/bin/env node
// DORMANT: No work unless explicitly approved, SHA pinned, and --execute provided.
import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_LIMITS, runDurableMinuteBackfillCycle,
  validateBackfillScope } from '../src/four-market-minute-backfill-queue-v1.mjs';
import { assessMinuteManifestCapacity,
  forecastPublicMinuteArchiveFootprintV1 } from
  '../src/four-market-minute-roster-capacity-v1.mjs';
const script=fileURLToPath(import.meta.url);
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const fail=code=>{throw new Error(code);};
async function protectedQueueRoot(raw) {
  if (!isAbsolute(raw ?? '')) fail('MINUTE_QUEUE_ROOT_INVALID');
  const root=resolve(raw);
  const info=await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077))
    fail('MINUTE_QUEUE_ROOT_UNSAFE');
  return root;
}
async function privateManifest(file) {
  if (!isAbsolute(file ?? '')) fail('MINUTE_QUEUE_MANIFEST_PATH_INVALID');
  const fd=await open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const meta=await fd.stat();
    if (!meta.isFile() || meta.nlink!==1 || meta.mode&0o077
      || meta.size<1 || meta.size>512*1024)
      fail('MINUTE_QUEUE_MANIFEST_FILE_UNSAFE');
    let decoded;
    try { decoded=JSON.parse(await fd.readFile('utf8')); }
    catch { fail('MINUTE_QUEUE_MANIFEST_JSON_INVALID'); }
    validateBackfillScope(decoded);
    return decoded;
  } finally {await fd.close();}
}
async function main() {
  const arg=process.argv.slice(2);
  if (!arg.length || arg.length===1 && arg[0]==='--dry-run')
    return emit({status:'DISABLED',providerCalls:0,filesWritten:0,
      archiveTimerActivated:false,executionAuthority:'NONE'});
  if (arg.length===1 && arg[0]==='--capacity') {
    // Read a private operator scope only; absolutely no network, queue
    // state, API credentials, disk writes or trading authority.
    const manifest=await privateManifest(process.env.RESEARCH_MINUTE_QUEUE_MANIFEST);
    const capacity=assessMinuteManifestCapacity(manifest,{
      actionsPerCycle:QUEUE_LIMITS.maxActionsPerCycle,
    });
    return emit({
      status:'CAPACITY_AUDIT_ONLY',capacity,
      storageEstimate:forecastPublicMinuteArchiveFootprintV1({
        cryptoSpotSymbols:capacity.cryptoSpotSymbols,
        cryptoFuturesSymbols:capacity.cryptoFuturesSymbols,
      }),
      providerCalls:0,filesWritten:0,
      archiveTimerActivated:false,executionAuthority:'NONE',
    });
  }
  if (arg.length!==1 || !['--execute','--locked'].includes(arg[0])
    || process.env.RESEARCH_MINUTE_ARCHIVE_ENABLED!=='true')
    fail('MINUTE_OWNER_ACTIVATION_REQUIRED');
  const root=await protectedQueueRoot(process.env.RESEARCH_MINUTE_QUEUE_ROOT);
  // File-mode enforcement applies to flock-created lock too.
  process.umask(0o077);
  if (arg[0]==='--execute') {
    const lock=join(root,'.minute-archive.lock');
    try {
      const info=await lstat(lock);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink!==1
        || info.mode&0o077) fail('MINUTE_QUEUE_LOCK_FILE_UNSAFE');
    } catch(e) {if(e?.code!=='ENOENT')throw e;}
    const child=spawnSync('/usr/bin/flock',
      ['-n',lock,process.execPath,script,'--locked'],
      {stdio:'inherit',env:{...process.env,RESEARCH_MINUTE_LOCK_CHILD:'true'},
        timeout:210_000});
    if(child.error) fail('MINUTE_QUEUE_LOCK_SPAWN_FAILED');
    if(child.status!==0) {
      if(child.status===1) fail('MINUTE_QUEUE_LOCK_BUSY_OR_CHILD_FAILED');
      fail('MINUTE_QUEUE_WORKER_FAILED');
    }
    return;
  }
  if (process.env.RESEARCH_MINUTE_LOCK_CHILD!=='true')
    fail('MINUTE_QUEUE_LOCK_REQUIRED');
  const sha=String(process.env.RESEARCH_CODE_SHA??'').trim().toLowerCase();
  if(!/^[a-f0-9]{40}$/u.test(sha)) fail('MINUTE_QUEUE_SHA_REQUIRED');
  const repo=resolve(dirname(script),'../..');
  const actual=execFileSync('git',['rev-parse','HEAD'],
    {cwd:repo,encoding:'utf8',timeout:5_000}).trim();
  if(actual!==sha) fail('MINUTE_QUEUE_SHA_MISMATCH');
  const archiveRoot=process.env.RESEARCH_MINUTE_ARCHIVE_ROOT;
  if (!isAbsolute(archiveRoot??'') || resolve(archiveRoot)===root)
    fail('MINUTE_QUEUE_ARCHIVE_ROOT_INVALID');
  const manifest=await privateManifest(process.env.RESEARCH_MINUTE_QUEUE_MANIFEST);
  const free=await statfs(archiveRoot);
  const freeBytes=Number(free.bavail)*Number(free.bsize);
  if(!Number.isSafeInteger(freeBytes)) fail('MINUTE_QUEUE_DISK_INVALID');
  const result=await runDurableMinuteBackfillCycle({
    enabled:true,queueRoot:root,archiveRoot,manifest,researchSha:sha,
    maxActions:QUEUE_LIMITS.maxActionsPerCycle,freeBytes,
  });
  emit(result);
  if(['HOLD_DISK','HOLD_CAPACITY','NEEDS_REVIEW'].includes(result.status))
    process.exitCode=2;
}
main().catch(e=>{
  const reason=/^MINUTE_[A-Z0-9_]{1,80}$/u.test(e?.message??'')
    ?e.message:'MINUTE_QUEUE_OPERATOR_PREFLIGHT_FAILED';
  emit({status:'BLOCKED',reason,executionAuthority:'NONE'});
  process.exitCode=2;
});
