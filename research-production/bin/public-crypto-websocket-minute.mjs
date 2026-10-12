#!/usr/bin/env node
// DORMANT public WebSocket planning only. Never opens a network connection.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { planPublicCryptoMinuteWebsocketV1 } from
  '../src/public-crypto-websocket-minute-v1.mjs';

const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const fail=code=>{throw new Error(code);};
async function readPrivateRoster(path){
  if(typeof path!=='string'||!isAbsolute(path))
    fail('WS_MINUTE_PRIVATE_ROSTER_PATH_REQUIRED');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const meta=await fd.stat();
    if(!meta.isFile()||meta.nlink!==1||(meta.mode&0o077)
      ||meta.size<2||meta.size>1024*1024)
      fail('WS_MINUTE_PRIVATE_ROSTER_FILE_UNSAFE');
    let value;
    try{value=JSON.parse(await fd.readFile('utf8'));}
    catch{fail('WS_MINUTE_PRIVATE_ROSTER_JSON_INVALID');}
    if(!value||typeof value!=='object'||Array.isArray(value)
      ||Object.keys(value).sort().join(',')!=='bitget,upbit')
      fail('WS_MINUTE_PRIVATE_ROSTER_SCHEMA_INVALID');
    return value;
  }finally{await fd.close();}
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--dry-run'){
    const r=planPublicCryptoMinuteWebsocketV1();
    return emit({contract:r.contract,status:r.status,plans:0,
      publicProviderGETCount:0,socketConnectionsOpened:0,
      archiveFilesWritten:0,executionAuthority:'NONE'});
  }
  if(args.length!==1||args[0]!=='--plan'
    ||process.env.RESEARCH_PUBLIC_WS_PLAN_ENABLED!=='true')
    fail('WS_MINUTE_EXPLICIT_PLAN_APPROVAL_REQUIRED');
  const input=await readPrivateRoster(
    process.env.RESEARCH_PUBLIC_WS_ROSTER_MANIFEST);
  const report=planPublicCryptoMinuteWebsocketV1({
    enabled:true,...input,nowMs:Date.now(),
  });
  return emit({
    contract:report.contract,status:report.status,
    plannedConnections:report.plannedConnections,
    plannedPublicChannels:report.plannedPublicChannels,
    symbolCount:report.symbolCount,
    venuePlanCounts:Object.freeze({
      upbit:report.plans.filter(p=>p.market==='CRYPTO_SPOT').length,
      bitget:report.plans.filter(p=>p.market==='CRYPTO_FUTURES').length,
    }),
    sourceRightsAndRetentionVerified:false,
    hostAndConnectionBudgetVerified:false,readyToConnect:false,
    publicProviderGETCount:0,socketConnectionsOpened:0,
    archiveFilesWritten:0,executionAuthority:'NONE',
  });
}
main().catch(e=>{
  const reason=/^(?:WS_MINUTE|MINUTE_ROSTER)_[A-Z0-9_]{1,80}$/u.test(
    e?.message??'')?e.message:'WS_MINUTE_OPERATOR_PREFLIGHT_FAILED';
  emit({status:'BLOCKED',reason,publicProviderGETCount:0,
    socketConnectionsOpened:0,archiveFilesWritten:0,
    executionAuthority:'NONE'});
  process.exitCode=2;
});
