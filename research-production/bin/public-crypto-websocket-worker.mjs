#!/usr/bin/env node
// Explicitly enabled, public-only WebSocket source worker. Never auto deploy.
// No REST, brokerage APIs, secrets, trading, Paper or Telegram.
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planPublicCryptoMinuteWebsocketV1} from
  '../src/public-crypto-websocket-minute-v1.mjs';
import {createPublicCryptoWsLiveWorkerV1} from
  '../src/public-crypto-ws-live-worker-v1.mjs';

const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const fail=x=>{throw new Error(x);};
async function readRoster(path){
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)
    fail('LIVE_WS_ROSTER_ABSOLUTE_PATH_REQUIRED');
  let p=dirname(path);
  while(true){
    const st=await lstat(p);
    if(st.isSymbolicLink())fail('LIVE_WS_ROSTER_SYMLINK_ANCESTOR');
    const parent=dirname(p);if(parent===p)break;p=parent;
  }
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await fd.stat();
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)
      ||stat.size<2||stat.size>1024*1024)
      fail('LIVE_WS_ROSTER_FILE_UNSAFE');
    let input;
    try{input=JSON.parse(await fd.readFile('utf8'));}
    catch{fail('LIVE_WS_ROSTER_JSON_INVALID');}
    if(!input||typeof input!=='object'||Array.isArray(input)
      ||Object.keys(input).sort().join(',')!=='bitget,upbit')
      fail('LIVE_WS_ROSTER_SCHEMA_INVALID');
    return input;
  }finally{await fd.close();}
}
const isFlag=name=>process.env[name]==='true';
async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--dry-run')
    return emit({
      status:'DISABLED',actualSocketsOpened:0,sourceSidecarsWritten:0,
      publicProviderGETCount:0,executionAuthority:'NONE',
    });
  if(args.length!==1||args[0]!=='--execute')
    fail('LIVE_WS_EXECUTE_EXPLICIT_ONLY');
  if(![
    'RESEARCH_PUBLIC_WS_LIVE_ENABLED',
    'RESEARCH_PUBLIC_WS_OPERATOR_APPROVED',
    'RESEARCH_PUBLIC_WS_SOURCE_RIGHTS_CONFIRMED',
    'RESEARCH_PUBLIC_WS_HOST_CAPACITY_CONFIRMED',
  ].every(isFlag))fail('LIVE_WS_EXPLICIT_APPROVALS_REQUIRED');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||major===22&&minor<4
    ||typeof globalThis.WebSocket!=='function')
    fail('LIVE_WS_NODE_22_REQUIRED');
  // Protect against unreviewed drift in the deployed checkout.
  const folder=fileURLToPath(new URL('../../',import.meta.url));
  let checkoutSha;
  try{checkoutSha=execFileSync('git',['rev-parse','HEAD'],{
    cwd:folder,encoding:'utf8',stdio:['ignore','pipe','ignore'],
    timeout:3_000,
  }).trim();}catch{fail('LIVE_WS_CHECKOUT_SHA_UNAVAILABLE');}
  if(process.env.RESEARCH_PUBLIC_WS_PRODUCER_SHA!==checkoutSha
    ||!/^[a-f0-9]{40}$/u.test(checkoutSha))
    fail('LIVE_WS_PRODUCER_SHA_MISMATCH');
  const root=process.env.RESEARCH_PUBLIC_WS_SIDECAR_ROOT;
  const privateRoster=await readRoster(
    process.env.RESEARCH_PUBLIC_WS_ROSTER_MANIFEST);
  const plan=planPublicCryptoMinuteWebsocketV1({
    enabled:true,...privateRoster,nowMs:Date.now(),
  });
  const runner=createPublicCryptoWsLiveWorkerV1({
    enabled:true,operatorApproved:true,sourceRightsConfirmed:true,
    hostCapacityConfirmed:true,plan,root,producerSha:checkoutSha,
    logger:emit,
  });
  await runner.start({schedule:true});
  emit({event:'PUBLIC_WS_WORKER_STARTED',...runner.report()});
  const statusTimer=setInterval(async()=>{
    const report=runner.report();
    emit({event:'PUBLIC_WS_WORKER_STATUS',...report});
    if(report.status==='HALTED_MANUAL_REVIEW'){
      clearInterval(statusTimer);
      process.exitCode=2;
      await runner.stop();
    }
  },30_000);
  let closing=false;
  const stop=async(signal)=>{
    if(closing)return;
    closing=true;clearInterval(statusTimer);
    try{await runner.stop();emit({event:'PUBLIC_WS_WORKER_STOP',signal,
      ...runner.report()});}
    catch{process.exitCode=2;}
  };
  process.once('SIGTERM',()=>{void stop('SIGTERM');});
  process.once('SIGINT',()=>{void stop('SIGINT');});
}
main().catch(e=>{
  const reason=/^(?:LIVE_WS|WS_|MINUTE_)[A-Z0-9_]{1,90}$/u
    .test(e?.message??'')?e.message:'LIVE_WS_PREFLIGHT_FAILED';
  emit({status:'BLOCKED',reason,actualSocketsOpened:0,
    tradeAccountCalls:0,realOrders:0,paperOrders:0,
    executionAuthority:'NONE'});
  process.exitCode=2;
});
