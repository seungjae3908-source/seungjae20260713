/**
 * Four-lane Telegram handoff READ-ONLY runtime audit.
 * No Bot API, orders, PM2 changes, DB queries, environment mutation or secrets emitted.
 * Supports old Production builds that cannot report TELEGRAM_WORKER_OWNER.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {get as httpGet} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const APP_ROOT='/opt/stock-app';
const SHA=/^[0-9a-f]{40}$/u;
const FLAGS=Object.freeze([
 'LIVE_TRADING','AUTO_TRADING','REAL_ORDER_ENABLED',
 'PRIVATE_TRADING_API_ALLOWED','ORDER_EXECUTION_ENABLED',
 'LIVE_TRADING_ACTIVATION_APPROVED','SPOT_LIVE_LIMITED_ACTIVATION_APPROVED',
 'LIVE_AUTOMATIC_TRADING_ENABLED','MEMBER_AUTO_TRADING_BACKGROUND_ENABLED',
 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED','MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED',
 'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED','BITGET_FUTURES_LIVE_ORDER_ENABLED',
 'CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED','CRYPTO_AUTO_TRADE_ENABLED',
 'BITGET_AUTO_TRADE_ENABLED','BITGET_LIVE_ORDER_ENABLED','UPBIT_LIVE_ORDER_ENABLED',
 'KIWOOM_LIVE_ORDER_ENABLED','TOSS_LIVE_ORDER_ENABLED',
 'TRANSFER_ENABLED','WITHDRAWAL_ENABLED','TOSS_ORDER_ENABLED','KIWOOM_ORDER_ENABLED',
 'UPBIT_ORDER_ENABLED','BITGET_ORDER_ENABLED',
]);
const LISTS=Object.freeze([
 'SPOT_LIVE_CAPABILITY_ALLOWLIST','SPOT_LIVE_MARKET_ALLOWLIST',
 'FUTURES_LIVE_CAPABILITY_ALLOWLIST','FUTURES_LIVE_MARKET_ALLOWLIST',
]);
const AUTHORITY=Object.freeze(['executionAuthority','FUTURES_LIVE_EXECUTION_AUTHORITY']);
const acceptedCode = value => typeof value==='string' && /^[A-Z0-9_]{3,80}$/u.test(value);
const sha = value => typeof value==='string' && SHA.test(value) ? value : null;
const flag = value => typeof value==='string' &&
 value.trim()!=='' && !['0','false'].includes(value.trim().toLowerCase());
function tradingAuthority(env) {
 return FLAGS.some(k=>flag(env[k]))
  ||LISTS.some(k=>typeof env[k]==='string' && env[k].trim()!=='')
  ||AUTHORITY.some(k=>!['','NONE'].includes(String(env[k]??'NONE').trim().toUpperCase()));
}
const emptyPm2=()=>({
 valid:false,sha:null,marker:null,pid:null,started:null,restarts:null,
 owner:'UNKNOWN',financialAuthority:null,canonical:false,online:false,
});
export function sanitizePm2Snapshot(raw, markerText) {
 const out=emptyPm2();
 if(!Array.isArray(raw))return out;
 const rows=raw.filter(v=>v?.name==='stock-app');
 if(rows.length!==1)return out;
 const row=rows[0];
 const env=row?.pm2_env;
 if(!env||typeof env!=='object'||Array.isArray(env))return out;
 const owner=typeof env.TELEGRAM_WORKER_OWNER==='string'&&env.TELEGRAM_WORKER_OWNER.trim()
  ?env.TELEGRAM_WORKER_OWNER.trim():'embedded';
 out.sha=sha(env.DEPLOY_SHA);
 out.marker=sha(String(markerText??'').trim());
 out.online=env.status==='online';
 out.canonical=env.pm_cwd===APP_ROOT &&
   env.pm_exec_path===APP_ROOT+'/api-server/dist/index.mjs';
 out.owner=['embedded','isolated'].includes(owner)?owner:'UNKNOWN';
 out.financialAuthority=tradingAuthority(env);
 out.pid=Number.isSafeInteger(row.pid)&&row.pid>0?row.pid:null;
 out.started=Number.isSafeInteger(env.pm_uptime)&&env.pm_uptime>0?env.pm_uptime:null;
 out.restarts=Number.isSafeInteger(env.restart_time)&&env.restart_time>=0
  ?env.restart_time:null;
 out.valid=out.online && out.canonical && Boolean(out.sha) &&
  out.sha===out.marker && out.pid!==null && out.started!==null &&
  out.restarts!==null;
 return out;
}
function freshHealth(h,p,nowMs){
 if(!p.valid || h?.ok!==true || h.service!=='api-server'
    ||h.route!=='/api/health' ||h.identityMatch!==true
    ||h.identityStatus!=='match'||h.backgroundWorkersEnabled!==true
    ||h.deploySha!==p.sha||h.processDeploySha!==p.sha
    ||h.deployMarkerSha!==p.sha ||h.telegramWorkerOwner!=='isolated')
  return false;
 const at=Date.parse(h.time??'');
 return Number.isFinite(at)&&at<=nowMs+5000&&nowMs-at>=0&&nowMs-at<=15000;
}
function fourLanesStopped(h) {
 const personal=h?.userTelegramDelivery;
 const brief=h?.telegramIntelligenceWorker;
 const signal=h?.signalTelegramSubscriber;
 const watch=h?.telegramAiWatch;
 return personal?.enabled===false && personal.lastTickAt===null
  &&personal.tickOk===null&&personal.deliveryConfirmed===false
  &&brief?.enabled===false&&brief.state==='NOT_STARTED'&&brief.lastTickAt===null
  &&signal?.state==='NOT_STARTED'&&signal.inFlight===0&&signal.lastSourceStatus===null
  &&watch?.state==='NOT_STARTED'&&watch.inFlight===0;
}
function sameProcess(a,b){
 return a.valid&&b.valid&&a.sha===b.sha&&a.marker===b.marker
  &&a.pid===b.pid&&a.started===b.started&&a.restarts===b.restarts
  &&a.owner===b.owner && a.financialAuthority===b.financialAuthority;
}
export function classifyTelegramHandoff({
 mainSha,first,second,firstHealth,secondHealth,nowMs=Date.now(),
}){
 const value={
   schemaVersion:'telegram-handoff-readonly-v1',mainSha:sha(mainSha),
   deployedSha:first?.sha??null,pm2Online:first?.online===true,
   stableProcess:false,owner:first?.owner??'UNKNOWN',
   manualFinancialAuthorityObserved:first?.financialAuthority??null,
   fourLanesQuiesced:false,probes:2,
   activationReady:false,
   classification:'INVALID_MAIN',
   telegramSends:0,pm2Restarts:0,databaseWrites:0,financialMutations:0,
   privateValuesRecorded:false,
 };
 if(!value.mainSha)return value;
 if(!first?.valid || !second?.valid){
  value.classification='PM2_OR_MARKER_UNVERIFIED';return value;
 }
 value.stableProcess=sameProcess(first,second);
 if(!value.stableProcess){
  value.classification='PM2_PROCESS_CHANGED';return value;
 }
 if(first.owner==='embedded'){
  value.classification='LEGACY_EMBEDDED_SENDER_ACTIVE';return value;
 }
 if(first.owner!=='isolated'){
  value.classification='OWNER_SWITCH_INVALID';return value;
 }
 if(!freshHealth(firstHealth,first,nowMs)||!freshHealth(secondHealth,second,nowMs)){
  value.classification='IN_PROCESS_OWNER_UNVERIFIED';return value;
 }
 if(!fourLanesStopped(firstHealth)||!fourLanesStopped(secondHealth)){
  value.classification='FOUR_LANES_NOT_QUIESCED';return value;
 }
 value.fourLanesQuiesced=true;
 value.classification='FOUR_LANES_QUIESCED_ONLY';
 // Other gates (owner approval, Bot, Signal V3, durable ledger, exclusive
 // sender lease) are NOT checked here, so activationReady stays false.
 return value;
}
async function readPm2() {
 try{
  const rows=JSON.parse(execFileSync('pm2',['jlist'],{
    encoding:'utf8',timeout:10000,maxBuffer:20000000,
    stdio:['ignore','pipe','pipe'],
  }));
  const marker=fs.readFileSync(APP_ROOT+'/.deploy/current-sha','utf8');
  return sanitizePm2Snapshot(rows,marker);
 }catch{return emptyPm2();}
}
async function readHealth() {
 return await new Promise(resolve=>{
  let settled=false;
  const done=x=>{if(!settled){settled=true;clearTimeout(timer);resolve(x);}};
  const timer=setTimeout(()=>{req?.destroy();done(null);},6000);
  let req=null;
  try{
   req=httpGet('http://127.0.0.1:8080/api/health',
    {timeout:5000,headers:{accept:'application/json'}},res=>{
     if(res.statusCode!==200){res.resume();done(null);return;}
     let size=0;const chunks=[];
     res.on('data',part=>{
       size+=part.length;
       if(size>65536){res.destroy();done(null);} else chunks.push(part);
     });
     res.on('error',()=>done(null));
     res.on('end',()=>{
       try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
       catch{done(null);}
     });
    });
   req.on('error',()=>done(null));
   req.on('timeout',()=>{req.destroy();done(null);});
  }catch{done(null);}
 });
}
export async function observeTelegramHandoff({
 mainSha,readPm2Impl=readPm2,readHealthImpl=readHealth,
 delayImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),nowImpl=()=>Date.now(),
}){
 const first=await readPm2Impl();
 const firstHealth=await readHealthImpl();
 await delayImpl(1100);
 const second=await readPm2Impl();
 const secondHealth=await readHealthImpl();
 return classifyTelegramHandoff({
  mainSha,first,second,firstHealth,secondHealth,nowMs:nowImpl(),
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.env.TELEGRAM_HANDOFF_READONLY!=='true'
  || !SHA.test(String(process.env.TELEGRAM_HANDOFF_MAIN_SHA??''))){
  console.error('TELEGRAM_HANDOFF_READONLY_APPROVAL_OR_SHA_REQUIRED');
  process.exitCode=17;
 }else{
  const receipt=await observeTelegramHandoff({mainSha:process.env.TELEGRAM_HANDOFF_MAIN_SHA});
  process.stdout.write(JSON.stringify(receipt)+'\n');
  if(!acceptedCode(receipt.classification))process.exitCode=17;
 }
}
