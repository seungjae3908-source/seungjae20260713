#!/usr/bin/env node
// No automatic activation. Explicitly approved one-window source recheck.
// Rechecked bars are immutable supplemental receipts, NOT original rewrites.
import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileMissingOriginalMinuteWindowV1 } from
  '../src/four-market-minute-gap-recheck-v1.mjs';
import { validateMinuteTask } from
  '../src/four-market-minute-archive-intake-v1.mjs';

const script=fileURLToPath(import.meta.url);
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
const fail=code=>{throw new Error(code);};
async function rootPrivate(root) {
  if(!isAbsolute(root??''))fail('MINUTE_RECHECK_ROOT_INVALID');
  let at=resolve(root);
  while(true){
    const meta=await lstat(at);
    if(!meta.isDirectory()||meta.isSymbolicLink())
      fail('MINUTE_RECHECK_ROOT_UNSAFE');
    if(at===resolve(root)&&(meta.mode&0o077))
      fail('MINUTE_RECHECK_ROOT_PRIVATE_REQUIRED');
    const parent=dirname(at);
    if(parent===at)break;
    at=parent;
  }
  return resolve(root);
}
async function manifest(path) {
  if(!isAbsolute(path??''))fail('MINUTE_RECHECK_MANIFEST_INVALID');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const meta=await fd.stat();
    if(!meta.isFile()||meta.nlink!==1||(meta.mode&0o077)
      ||meta.size<2||meta.size>4096)
      fail('MINUTE_RECHECK_MANIFEST_UNSAFE');
    let raw;
    try{raw=JSON.parse(await fd.readFile('utf8'));}
    catch{fail('MINUTE_RECHECK_MANIFEST_JSON_INVALID');}
    if(raw?.schemaVersion!=='research-minute-recheck-operator-task/v1'
      ||!raw.task||Object.keys(raw).length!==2)
      fail('MINUTE_RECHECK_MANIFEST_INVALID');
    return validateMinuteTask(raw.task);
  }finally{await fd.close();}
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--dry-run')
    return output({status:'DISABLED',providerGETCount:0,filesWritten:0,
      executionAuthority:'NONE'});
  const mode=args[0];
  if(args.length!==1||!['--inspect','--execute','--locked'].includes(mode)
    ||process.env.RESEARCH_MINUTE_RECHECK_ENABLED!=='true')
    fail('MINUTE_RECHECK_OWNER_APPROVAL_REQUIRED');
  if((mode==='--execute'||mode==='--locked')
    &&process.env.RESEARCH_MINUTE_RECHECK_WRITE_ALLOWED!=='true')
    fail('MINUTE_RECHECK_WRITE_APPROVAL_REQUIRED');
  const archiveRoot=await rootPrivate(process.env.RESEARCH_MINUTE_ARCHIVE_ROOT);
  const queueRoot=await rootPrivate(process.env.RESEARCH_MINUTE_QUEUE_ROOT);
  if(archiveRoot===queueRoot
    ||archiveRoot.startsWith(queueRoot+'/')
    ||queueRoot.startsWith(archiveRoot+'/'))
    fail('MINUTE_RECHECK_ROOTS_OVERLAP');
  process.umask(0o077);
  if(mode==='--execute'){
    const lock=join(queueRoot,'.minute-archive.lock');
    try{
      const st=await lstat(lock);
      if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077))
        fail('MINUTE_RECHECK_LOCK_UNSAFE');
    }catch(e){if(e?.code!=='ENOENT')throw e;}
    const child=spawnSync('/usr/bin/flock',
      ['-n',lock,process.execPath,script,'--locked'],
      {stdio:'inherit',env:{...process.env,RESEARCH_MINUTE_RECHECK_CHILD:'true'},
        timeout:120_000});
    if(child.error)fail('MINUTE_RECHECK_LOCK_SPAWN_FAILED');
    if(child.status!==0)fail('MINUTE_RECHECK_LOCK_BUSY_OR_WORKER_FAILED');
    return;
  }
  if(mode==='--locked' && process.env.RESEARCH_MINUTE_RECHECK_CHILD!=='true')
    fail('MINUTE_RECHECK_LOCK_REQUIRED');
  const sha=String(process.env.RESEARCH_CODE_SHA??'').toLowerCase();
  if(!/^[a-f0-9]{40}$/u.test(sha))fail('MINUTE_RECHECK_SHA_REQUIRED');
  const repo=resolve(dirname(script),'../..');
  const git=execFileSync('git',['rev-parse','HEAD'],{
    cwd:repo,encoding:'utf8',timeout:5_000,
  }).trim();
  if(git!==sha)fail('MINUTE_RECHECK_SHA_MISMATCH');
  const task=await manifest(process.env.RESEARCH_MINUTE_RECHECK_MANIFEST);
  const free=await statfs(archiveRoot);
  const freeBytes=Number(free.bavail)*Number(free.bsize);
  if(!Number.isSafeInteger(freeBytes))fail('MINUTE_RECHECK_DISK_UNVERIFIED');
  const response=await reconcileMissingOriginalMinuteWindowV1({
    enabled:true,persist:mode==='--locked',
    root:archiveRoot,task,researchSha:sha,freeBytes,
  });
  // Show only counts and fixed reason/status. Never OHLCV, internal paths,
  // provider payloads, tokens, private account data or order parameters.
  output({
    status:response.status,
    market:task.market,symbol:task.symbol,
    providerGETCount:response.providerGETCount??0,
    filesWritten:response.filesWritten??0,
    addedCandleCount:response.addedCandleCount??0,
    unverifiedMissingMinuteSlots:response.unverifiedMissingMinuteSlots??null,
    economicEvidenceCredit:0,oosCredit:0,paperCredit:0,
    profitabilityProven:false,executionAuthority:'NONE',
  });
  if(response.status==='HOLD_DISK'
    ||String(response.status).startsWith('BLOCKED_'))process.exitCode=2;
}
main().catch(error=>{
  const reason=/^MINUTE_[A-Z0-9_]{1,80}$/u.test(error?.message??'')
    ?error.message:'MINUTE_RECHECK_OPERATOR_PREFLIGHT_FAILED';
  output({status:'BLOCKED',reason,providerGETCount:0,
    filesWritten:0,executionAuthority:'NONE'});
  process.exitCode=2;
});
