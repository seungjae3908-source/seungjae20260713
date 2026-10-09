#!/usr/bin/env node
// Read-only server-local UTC cadence diagnostic, no provider calls, state
// modification, database access, Paper/Live order or profitability claim.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import {
  addPublicWatchCadenceAuditRow, createPublicWatchCadenceAudit,
  summarizePublicWatchCadenceAudit,
} from '../src/lightweight-market-watch-cadence.mjs';
const MAX_BYTES=2*1024*1024, MAX_LINES=2_000, MAX_LINE_BYTES=16*1024;
const SHA40=/^[a-f0-9]{40}$/u;

async function assertPrivateDirectory(path) {
  const x=await lstat(path);
  if (!x.isDirectory() || x.isSymbolicLink() || (x.mode & 0o022)!==0)
    throw new Error('WATCH_CADENCE_DIRECTORY_UNSAFE');
}
async function readDay(root, day, audit) {
  const path=join(root,'watch','cadence',day+'.jsonl');
  let before;
  try { before=await lstat(path); }
  catch(e) {
    if (e?.code==='ENOENT') return;
    throw new Error('WATCH_CADENCE_FILE_READ_FAILED');
  }
  if (!before.isFile() || before.nlink!==1 || before.size<1
    || before.size>MAX_BYTES || (before.mode & 0o022)!==0)
    throw new Error('WATCH_CADENCE_FILE_UNSAFE');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=await handle.stat();
    if (!opened.isFile() || opened.dev!==before.dev || opened.ino!==before.ino
      || opened.size!==before.size || opened.nlink!==1
      || (opened.mode & 0o022)!==0)
      throw new Error('WATCH_CADENCE_FILE_CHANGED');
    const data=await handle.readFile({encoding:'utf8'});
    if (!data.endsWith('\n') || Buffer.byteLength(data,'utf8')!==before.size)
      throw new Error('WATCH_CADENCE_FILE_TRUNCATED');
    const rows=data.slice(0,-1).split('\n');
    if (rows.length>MAX_LINES)
      throw new Error('WATCH_CADENCE_FILE_TOO_MANY_ROWS');
    for(const row of rows) {
      if (!row || Buffer.byteLength(row,'utf8')>MAX_LINE_BYTES)
        throw new Error('WATCH_CADENCE_BAD_LINE');
      let value;
      try {value=JSON.parse(row);}
      catch {throw new Error('WATCH_CADENCE_BAD_JSON');}
      if (typeof value.observedAt!=='string'||value.observedAt.slice(0,10)!==day)
        throw new Error('WATCH_CADENCE_WRONG_DAY');
      addPublicWatchCadenceAuditRow(audit,value);
    }
    const after=await handle.stat();
    if (after.dev!==before.dev||after.ino!==before.ino
      || after.size!==before.size||after.mtimeMs!==before.mtimeMs)
      throw new Error('WATCH_CADENCE_FILE_CHANGED_DURING_READ');
    audit.filesRead++;
  }finally{await handle.close();}
}
async function main() {
  if (process.argv.length!==2) throw new Error('WATCH_CADENCE_ARGS_FORBIDDEN');
  const root=process.env.RESEARCH_STATE_ROOT??'';
  const researchSha=process.env.RESEARCH_CODE_SHA??'';
  if (!root||!isAbsolute(root)||resolve(root)!==root||!SHA40.test(researchSha))
    throw new Error('WATCH_CADENCE_CONFIG_INVALID');
  const nowMs=Date.now();
  const audit=createPublicWatchCadenceAudit({researchSha,nowMs});
  // Do not start or initialize the worker or manufacture missing evidence.
  await assertPrivateDirectory(root);
  const dayDir=join(root,'watch','cadence');
  try { await assertPrivateDirectory(dayDir); }
  catch(e) {
    if (e?.code==='ENOENT') {
      process.stdout.write(JSON.stringify(summarizePublicWatchCadenceAudit(audit))+'\n');
      return;
    }
    throw e;
  }
  const yesterday=new Date(nowMs-24*60*60_000).toISOString().slice(0,10);
  const today=new Date(nowMs).toISOString().slice(0,10);
  await readDay(root,yesterday,audit);
  if(today!==yesterday) await readDay(root,today,audit);
  const report=summarizePublicWatchCadenceAudit(audit);
  process.stdout.write(JSON.stringify(report)+'\n');
  if(report.status==='INVALID')process.exitCode=2;
}
main().catch(() => {
  // No leaking root paths, ticker symbols, tokens or errors from fs / providers.
  process.stdout.write(JSON.stringify({
    contract:'public-watch-cadence-diagnostic-v1',status:'INVALID',
    sampleCount:null,cadenceWindowObserved:false,
    continuous24hProven:false,completeFourMarketCoverageProven:false,
    oosCredit:0,paperCredit:0,economicEvidenceCredit:0,
    profitabilityProven:false,formulaCandidateProduced:false,
    executionAuthority:'NONE',errors:['WATCH_CADENCE_READ_FAILED'],
  })+'\n');
  process.exitCode=2;
});
