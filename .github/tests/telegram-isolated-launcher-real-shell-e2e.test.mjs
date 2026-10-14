import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const SHA='a'.repeat(40);
const hash=b=>createHash('sha256').update(b).digest('hex');
const filename='ops/run-telegram-isolated-worker.sh';
const ledgerProof='ops/telegram-legacy-owner-runtime-proof.mjs';
const output='api-server/dist/telegram-isolated-worker.mjs';
function fixture(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tg-launcher-host-'));
 const app=path.join(temp,'opt','stock-app');
 const root=path.join(temp,'opt','stock-app-data','telegram-isolated-v1');
 const release=path.join(root,'release','current');
 const lock=path.join(temp,'stock-app-deploy.lock');
 const bin=path.join(temp,'bin');
 const marker=path.join(temp,'sender-was-called');
 const pm2Json=path.join(temp,'pm2.json');
 const healthJson=path.join(temp,'health.json');
 const proof=path.join(release,ledgerProof);
 const worker=path.join(release,output);
 const dirs=[path.join(app,'.deploy'),path.join(app,'.runtime'),
   path.join(root,'state'),path.join(release,'.deploy'),path.join(release,'ops'),
   path.join(release,'api-server','dist'),bin];
 dirs.forEach(d=>fs.mkdirSync(d,{recursive:true,mode:0o700}));
 fs.writeFileSync(path.join(app,'.deploy','current-sha'),SHA+'\n');
 fs.writeFileSync(path.join(release,'.deploy','current-sha'),SHA+'\n');
 fs.copyFileSync(ledgerProof,proof);
 fs.copyFileSync(filename,path.join(release,filename));
 fs.writeFileSync(worker,'throw Error("REAL_WORKER_MUST_NOT_BE_STARTED_DURING_QA");\n');
 const manifest=[output,ledgerProof,filename].map(name=>
   hash(fs.readFileSync(path.join(release,name)))+'  '+name
 ).join('\n')+'\n';
 fs.writeFileSync(path.join(release,'.deploy','telegram-sha256.manifest'),manifest);
 fs.writeFileSync(pm2Json,JSON.stringify([{name:'stock-app',pm2_env:{
   status:'online',TELEGRAM_WORKER_OWNER:'isolated',DEPLOY_SHA:SHA,
   LIVE_TRADING:'true',FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED:'true',
 }}]));
 fs.writeFileSync(healthJson,JSON.stringify({
   ok:true,service:'api-server',route:'/api/health',
   identityMatch:true,identityStatus:'match',
   deploySha:SHA,processDeploySha:SHA,deployMarkerSha:SHA,
   backgroundWorkersEnabled:true,telegramWorkerOwner:'isolated',
   time:new Date().toISOString(),
   userTelegramDelivery:{enabled:false,lastTickAt:null,tickOk:null,deliveryConfirmed:false},
   telegramIntelligenceWorker:{enabled:false,state:'NOT_STARTED',lastTickAt:null},
   signalTelegramSubscriber:{state:'NOT_STARTED',inFlight:0,lastSourceStatus:null},
   telegramAiWatch:{state:'NOT_STARTED',inFlight:0},
 }));
 const sh=(name,lines)=>{
   const file=path.join(bin,name);
   fs.writeFileSync(file,'#!/bin/sh\n'+lines.join('\n')+'\n',{mode:0o700});
 };
 sh('pm2',['[ "$1" = jlist ] || exit 91','cat "$TG_PM2_JSON"']);
 sh('curl',[
   'for arg in "$@"; do',
   'case "$arg" in',
   ' -X|--request|--data|--data-binary|--upload-file) exit 97;;',
   'esac',
   'done',
   'cat "$TG_HEALTH_JSON"',
 ]);
 sh('node',[
   'if [ "$1" = "-e" ]; then',
   '  exec "$TG_REAL_NODE" "$@"',
   'fi',
   'if [ "$1" = "$TG_PROOF" ]; then',
   '  exec "$TG_REAL_NODE" "$@"',
   'fi',
   'if [ "$1" = "--enable-source-maps" ] && [ "$2" = "$TG_WORKER" ]; then',
   "  printf 'ONLY_MOCK_NODE_EXECUTED\\n' > \"$TG_SENDER_MARKER\"",
   "  echo 'MOCK_TELEGRAM_OWNER_STARTED_NO_SEND'",
   '  exit 0',
   'fi',
   "echo 'UNAPPROVED_NODE_INVOCATION' >&2",
   'exit 99',
 ]);
 const realRunner=fs.readFileSync(filename,'utf8');
 for (const absolute of [
   '/opt/stock-app-data/telegram-isolated-v1',
   '/opt/stock-app',
   '/var/lock/stock-app-deploy.lock',
 ])assert.ok(realRunner.includes(absolute),absolute);
 const runner=realRunner
   .replaceAll('/opt/stock-app-data/telegram-isolated-v1',root)
   .replaceAll('/opt/stock-app',app)
   .replaceAll('/var/lock/stock-app-deploy.lock',lock);
 const runnerFile=path.join(temp,'run-approved-test-copy.sh');
 fs.writeFileSync(runnerFile,runner,{mode:0o700});
 const launch=(patch={})=>spawnSync('bash',[runnerFile],{
   cwd:temp,encoding:'utf8',timeout:12000,maxBuffer:65536,
   env:{
     ...process.env,PATH:bin+':'+process.env.PATH,
     TG_REAL_NODE:process.execPath,TG_PM2_JSON:pm2Json,
     TG_HEALTH_JSON:healthJson,TG_PROOF:proof,TG_WORKER:worker,
     TG_SENDER_MARKER:marker,
     TELEGRAM_TARGET_SHA:SHA,TELEGRAM_WORKER_OWNER:'isolated',
     TELEGRAM_ISOLATED_CUTOVER_APPROVED:'true',...patch,
   },
 });
 return {temp,app,root,release,lock,bin,worker,marker,pm2Json,healthJson,
   launch,clean:()=>fs.rmSync(temp,{force:true,recursive:true})};
}
test('real dormant launcher reaches ONLY mocked node after two actual health proofs pass',()=>{
 const x=fixture();try{
  const oldMarker=fs.readFileSync(path.join(x.app,'.deploy','current-sha'),'utf8');
  const oldPm2=fs.readFileSync(x.pm2Json,'utf8');
  const result=x.launch();
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/MOCK_TELEGRAM_OWNER_STARTED_NO_SEND/u);
  assert.equal(fs.readFileSync(x.marker,'utf8'),'ONLY_MOCK_NODE_EXECUTED\n');
  assert.equal(fs.readFileSync(path.join(x.app,'.deploy','current-sha'),'utf8'),oldMarker);
  assert.equal(fs.readFileSync(x.pm2Json,'utf8'),oldPm2);
 }finally{x.clean();}
});
test('old embedded sender is refused without even consulting Bot or broker',()=>{
 const x=fixture();try{
  const data=JSON.parse(fs.readFileSync(x.pm2Json,'utf8'));
  data[0].pm2_env.TELEGRAM_WORKER_OWNER='embedded';
  fs.writeFileSync(x.pm2Json,JSON.stringify(data));
  const out=x.launch();
  assert.equal(out.status,13,out.stderr||out.stdout);
  assert.match(out.stderr,/TELEGRAM_LEGACY_WRITER_NOT_QUIESCED/u);
  assert.equal(fs.existsSync(x.marker),false);
 }finally{x.clean();}
});
test('in-flight old sender blocks isolated worker before mock start',()=>{
 const x=fixture();try{
  const h=JSON.parse(fs.readFileSync(x.healthJson,'utf8'));
  h.signalTelegramSubscriber.inFlight=1;
  fs.writeFileSync(x.healthJson,JSON.stringify(h));
  const out=x.launch();
  assert.equal(out.status,13,out.stderr||out.stdout);
  assert.match(out.stderr,/TELEGRAM_LEGACY_RUNTIME_HEALTH_UNPROVEN/u);
  assert.equal(fs.existsSync(x.marker),false);
 }finally{x.clean();}
});
test('tampered standalone file is rejected by sealed manifest',()=>{
 const x=fixture();try{
  fs.appendFileSync(x.worker,'TAMPER\n');
  const out=x.launch();
  assert.equal(out.status,12,out.stderr||out.stdout);
  assert.match(out.stderr,/TELEGRAM_ISOLATED_BINARY_HASH_INVALID/u);
  assert.equal(fs.existsSync(x.marker),false);
 }finally{x.clean();}
});
test('missing private state directory blocks before any node sender',()=>{
 const x=fixture();try{
  fs.rmSync(path.join(x.root,'state'),{recursive:true});
  const out=x.launch();
  assert.equal(out.status,13,out.stderr||out.stdout);
  assert.match(out.stderr,/TELEGRAM_ISOLATED_STATE_DIRECTORY_INVALID/u);
  assert.equal(fs.existsSync(x.marker),false);
 }finally{x.clean();}
});
test('missing approval and wrong expected SHA block without any HTTP request',()=>{
 for(const env of [
  {TELEGRAM_ISOLATED_CUTOVER_APPROVED:'false'},
  {TELEGRAM_TARGET_SHA:'b'.repeat(40)},
 ]){
  const x=fixture();try{
   const out=x.launch(env);
   assert.notEqual(out.status,0);
   assert.equal(fs.existsSync(x.marker),false);
  }finally{x.clean();}
 }
});
