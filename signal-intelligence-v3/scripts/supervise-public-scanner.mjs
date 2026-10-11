#!/usr/bin/env node
// Optional future runtime only. NEVER launched by this Draft/CI.
// This supervisor reads PUBLIC Signal V3 market feeds through an already
// bundled producer; no private brokerage connection, orders or Telegram.
// Production/Staging activation requires an independent explicit approval.
import {spawn} from 'node:child_process';
import {appendFile,mkdir,open,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createPublicOnlyCycleController} from '../src/public-cycle-supervisor.mjs';
import {createPublicReadOnlyRuntimeReceipt} from '../src/public-runtime-receipt-window.mjs';

const env=process.env;
const sha=String(env.SIGNAL_INTELLIGENCE_SERVICE_SHA??'').trim().toLowerCase();
const stateDir=String(env.SIGNAL_INTELLIGENCE_STATE_DIR??'');
const producer=String(env.SIGNAL_INTELLIGENCE_PRODUCER_PATH??'');
const interval=Number(env.SIGNAL_INTELLIGENCE_PUBLIC_MIN_INTERVAL_MS??120000);
const lockFile=path.join(stateDir,'.public-readonly-supervisor.lock');
const healthFile=path.join(stateDir,'public-readonly-supervisor-health.json');
const receiptFile=path.join(stateDir,'public-readonly-runtime-receipts.jsonl');
const snapshotFile=path.join(stateDir,'latest-snapshot.json');
if(env.SIGNAL_INTELLIGENCE_PUBLIC_SUPERVISOR_ACK!=='READ_ONLY_DRIFT'
 || !/^[0-9a-f]{40}$/u.test(sha) || !path.isAbsolute(stateDir)
 || !path.isAbsolute(producer) || !producer.endsWith('.mjs')
 || !Number.isInteger(interval) || interval<60000 || interval>3600000
 || env.LIVE_TRADING!=='false' || env.AUTO_TRADING!=='false'
 || env.PRIVATE_API_ENABLED!=='false'
 || env.ORDER_AUTHORITY!=='false' || env.SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY!=='NONE')
 throw Error('PUBLIC_SUPERVISOR_EXPLICIT_READONLY_GATE_REQUIRED');

await mkdir(stateDir,{recursive:true});
let lock;
try{lock=await open(lockFile,'wx',0o600);}
catch(e){if(e?.code==='EEXIST')throw Error('PUBLIC_SUPERVISOR_ALREADY_OWNED');throw e;}
await lock.writeFile(JSON.stringify({pid:process.pid,sha,startedAt:new Date().toISOString()}));
let stopping=false,child=null;
for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{
  stopping=true;
  if(child&&!child.killed)child.kill('SIGTERM');
});
const scheduler=createPublicOnlyCycleController({serviceSha:sha,minIntervalMs:interval});
let run=0;
async function saveHealth(){
 const filename=healthFile+'.'+String(process.pid)+'.tmp';
 await writeFile(filename,JSON.stringify({
  ...scheduler.health(),lastWriteAt:new Date().toISOString(),
  producerReadOnly:true,brokerApiAllowed:false,
  privateApiAllowed:false,telegramSent:false,tradeAuthority:'NONE',
 },null,2)+'\n',{encoding:'utf8',mode:0o600});
 await rename(filename,healthFile);
}
function runProducer(timeoutMs=15*60000){
 return new Promise((resolve)=>{
   let settled=false;let guard;
   const finish=(result)=>{
     if(settled)return;
     settled=true;clearTimeout(guard);child=null;
     resolve(result);
   };
   child=spawn(process.execPath,[producer],{
     cwd:path.dirname(producer),stdio:['ignore','ignore','ignore'],
     env:{
       PATH:env.PATH??'/usr/bin:/bin',
       HOME:env.HOME??stateDir,
       NODE_ENV:'production',
       SIGNAL_INTELLIGENCE_SERVICE_SHA:sha,
       SIGNAL_INTELLIGENCE_STATE_DIR:stateDir,
       SIGNAL_INTELLIGENCE_STATE_FILE:snapshotFile,
       SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE:'true',
       SIGNAL_INTELLIGENCE_PUBLIC_PROFILE_MODE:'RESEARCH_V3',
       LIVE_TRADING:'false',AUTO_TRADING:'false',
       PRIVATE_API_ENABLED:'false',ORDER_AUTHORITY:'false',
       SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY:'NONE',
     },
   });
   guard=setTimeout(()=>{
     if(child&&!child.killed)child.kill('SIGTERM');
     finish({ok:false,error:'PUBLIC_SUPERVISOR_CYCLE_DEADLINE'});
   },timeoutMs);
   child.once('error',()=>finish({ok:false,error:'PUBLIC_SUPERVISOR_CHILD_SPAWN_FAILED'}));
   child.once('exit',(code,signal)=>finish({
     ok:code===0&&!signal,
     error:code===0&&!signal?null:'PUBLIC_SUPERVISOR_CHILD_EXIT_NONZERO',
   }));
 });
}
try{
 while(!stopping){
   const claim=scheduler.start();
   if(!claim.allowed){
     await new Promise(resolve=>setTimeout(resolve,Math.min(2000,Math.max(100,claim.waitMs??1000))));
     continue;
   }
   const result=await runProducer();
   let evidence;
   if(result.ok){
     try{
       const raw=await readFile(snapshotFile,'utf8');
       if(Buffer.byteLength(raw,'utf8')>512000)
         throw Error('PUBLIC_SUPERVISOR_OVERSIZE_SNAPSHOT');
       evidence=JSON.parse(raw);
     }catch{
       evidence=null;
     }
   }
   const finished=scheduler.finish({snapshot:evidence,error:result.error});
   const receipt=createPublicReadOnlyRuntimeReceipt({
     serviceSha:sha,startedAtMs:claim.startedAt,finishedAtMs:Date.now(),
     producerSucceeded:finished.ok,snapshot:finished.ok?evidence:null,
   });
   // Sanitized append-only observations; never claim signed runtime attestation.
   await appendFile(receiptFile,JSON.stringify(receipt)+'\n',{
     encoding:'utf8',mode:0o600,flag:'a',
   });
   await saveHealth();
   run++;
   // Never share raw source data in stdout/stderr.
   process.stdout.write(JSON.stringify({
     event:'public_scanner_supervised_cycle',cycle:run,
     completed:scheduler.health().completed,failed:scheduler.health().failed,
     nextAllowedAt:scheduler.health().nextAllowedAt,
     executionAuthority:'NONE',marketVerified:false,
   })+'\n');
 }
}finally{
 stopping=true;
 if(child&&!child.killed)child.kill('SIGTERM');
 try{await saveHealth();}catch{}
 try{await lock.close();}catch{}
 try{await unlink(lockFile);}catch{}
}
