import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {
 inspectSealedDormant,sanitizePm2ForDormantReadback,auditTelegramDormantReadback,
} from '../../ops/telegram-dormant-installed-readonly.mjs';

const SHA='b'.repeat(40),OLD='3'.repeat(40);
const hash=x=>createHash('sha256').update(x).digest('hex');
const FILES=[
 'api-server/dist/telegram-isolated-worker.mjs',
 'ops/telegram-legacy-owner-runtime-proof.mjs',
 'ops/run-telegram-isolated-worker.sh',
];
function fixture(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tg-dormant-readback-'));
 const root=path.join(temp,'private');
 const release=path.join(root,'release','current');
 for(const rel of ['','release','release/current','release/current/api-server',
  'release/current/api-server/dist','release/current/ops','release/current/.deploy',
  'state'])
  fs.mkdirSync(path.join(root,rel),{recursive:true,mode:0o700});
 const write=(rel,text)=>fs.writeFileSync(path.join(release,rel),text,{mode:0o600});
 const contents=FILES.map((name,i)=>Buffer.from('sealed-fixture-'+i+'\n','utf8'));
 for(let i=0;i<FILES.length;i++)write(FILES[i],contents[i]);
 const manifest=FILES.map((name,i)=>hash(contents[i])+'  '+name+'\n').join('');
 write('.deploy/telegram-sha256.manifest',manifest);
 write('.deploy/current-sha',SHA+'\n');
 write('.deploy/preparation.json',JSON.stringify({
  schemaVersion:'telegram-isolated-dormant-package-v1',sha:SHA,mode:'PREPARE_ONLY',
  workerStarted:false,productionAppChanged:false,pm2Restarts:0,
  telegramMessages:0,financialMutations:0,paths:FILES,
 })+'\n');
 write('.deploy/installation.json',JSON.stringify({
  schemaVersion:'telegram-isolated-dormant-install-v1',sha:SHA,
  mode:'STAGED_INACTIVE',workerStarted:false,productionAppChanged:false,
  pm2Restarts:0,telegramMessages:0,financialMutations:0,
  manifestSha256:hash(Buffer.from(manifest)),
 })+'\n');
 const marker=path.join(release,'.deploy','current-sha');
 return {root,release,marker,sha:SHA,manifestSha:hash(Buffer.from(manifest)),
  clean:()=>fs.rmSync(temp,{recursive:true,force:true})};
}
function snapshot(options={}){
 const env={
  status:'online',DEPLOY_SHA:OLD,pm_uptime:1728700000000,restart_time:0,
  pm_cwd:'/opt/stock-app',pm_exec_path:'/opt/stock-app/api-server/dist/index.mjs',
  LIVE_TRADING:'true',TOSS_LIVE_ORDER_ENABLED:'true',
  TELEGRAM_WORKER_OWNER:'embedded',
  axm_monitor:{cpu:17},
  ...options.env,
 };
 return sanitizePm2ForDormantReadback([
  {name:'stock-app',pid:options.pid??9922,pm2_env:env},
 ],OLD);
}
const inspect=x=>inspectSealedDormant({
 root:x.root,sha:x.sha,expectedManifestSha:x.manifestSha,
});
const audit=(x,reads)=>auditTelegramDormantReadback({
 root:x.root,sha:x.sha,expectedManifestSha:x.manifestSha,
 readPm2Impl:()=>reads.shift()??null,waitImpl:async()=>{},
});

test('verifies exact sealed bytes and existing receipt without modifying the dormant candidate',()=>{
 const x=fixture();
 try {
  const markerBefore=fs.readFileSync(x.marker);
  const before=fs.readdirSync(x.release).sort();
  assert.deepEqual(inspect(x),{valid:true,code:'SEALED_DORMANT_BYTES_VERIFIED'});
  assert.deepEqual(fs.readFileSync(x.marker),markerBefore);
  assert.deepEqual(fs.readdirSync(x.release).sort(),before);
 }finally{x.clean();}
});

test('readback can verify post-check-failed installation without installing or claiming activation',async()=>{
 const x=fixture();
 try{
  const a=snapshot(),result=await audit(x,[a,a]);
  assert.equal(result.classification,'SEALED_DORMANT_BYTES_PM2_STABLE_NOW');
  assert.equal(result.sealed,true);
  assert.equal(result.pm2Stable,true);
  assert.equal(result.activationReady,false);
  assert.equal(result.owner,'embedded');
  assert.equal(result.deployedSha,OLD);
  assert.equal(result.telegramSends,0);
  assert.equal(result.pm2Mutations,0);
  assert.equal(result.databaseWrites,0);
  assert.equal(result.financialMutations,0);
  assert.equal(result.secretValuesRecorded,false);
  assert.equal(fs.readFileSync(x.marker,'utf8'),x.sha+'\n');
 }finally{x.clean();}
});

test('irrelevant PM2 telemetry drift is excluded without weakening LIVE identity',async()=>{
 const x=fixture();
 try{
  const a=snapshot({env:{axm_monitor:{cpu:3},volatileStatus:1}});
  const b=snapshot({env:{axm_monitor:{cpu:99},volatileStatus:2}});
  assert.deepEqual(a,b);
  const report=await audit(x,[a,b]);
  assert.equal(report.classification,'SEALED_DORMANT_BYTES_PM2_STABLE_NOW');
 }finally{x.clean();}
});

test('PID, restart count and financial/trading changes still fail closed',async()=>{
 for(const changed of [
  snapshot({pid:12345}),
  snapshot({env:{restart_time:1}}),
  snapshot({env:{LIVE_TRADING:'false'}}),
  snapshot({env:{TELEGRAM_WORKER_OWNER:'isolated'}}),
 ]) {
  const x=fixture();
  try{
   assert.notDeepEqual(changed,snapshot());
   const report=await audit(x,[snapshot(),changed]);
   assert.equal(report.classification,'SEALED_PRESENT_PM2_CHANGED_NOW');
   assert.equal(report.pm2Stable,false);
   assert.equal(report.activationReady,false);
  }finally{x.clean();}
 }
});

test('unverified or unavailable PM2 never counts as stable',async()=>{
 const x=fixture();
 try {
  const report=await audit(x,[snapshot(),null]);
  assert.equal(report.classification,'SEALED_PRESENT_PM2_UNVERIFIED');
  assert.equal(report.pm2Stable,false);
  assert.equal(report.activationReady,false);
 }finally{x.clean();}
});

test('tampering any file, receipt, marker or provenance fails closed',()=>{
 for(const tamper of [
  x=>fs.appendFileSync(path.join(x.release,FILES[0]),'tampered'),
  x=>fs.writeFileSync(x.marker,'c'.repeat(40)+'\n'),
  x=>fs.writeFileSync(path.join(x.release,'.deploy','installation.json'),
   JSON.stringify({workerStarted:true})),
  x=>fs.writeFileSync(path.join(x.release,'.deploy','preparation.json'),
   JSON.stringify({workerStarted:true})),
  x=>fs.writeFileSync(path.join(x.release,'.deploy','INSTALLATION_INCOMPLETE'),'BAD\n'),
 ]) {
  const x=fixture();
  try {
   tamper(x);
   assert.equal(inspect(x).valid,false);
  }finally{x.clean();}
 }
});

test('missing release, symlink and state-root mutation cannot be treated as installed',()=>{
 const cases=[
  x=>fs.rmSync(x.release,{recursive:true,force:true}),
  x=>{const f=path.join(x.release,FILES[2]);fs.unlinkSync(f);fs.symlinkSync(x.marker,f);},
  x=>fs.writeFileSync(path.join(x.root,'state','unexpected-worker-state'),'x'),
  x=>fs.chmodSync(path.join(x.root,'state'),0o755),
 ];
 for(const bad of cases){
  const x=fixture();
  try{bad(x);assert.equal(inspect(x).valid,false);}
  finally{x.clean();}
 }
});

test('a stale manifest digest is rejected even if local files and receipt match',()=>{
 const x=fixture();
 try{
  const proof=inspectSealedDormant({
   root:x.root,sha:x.sha,expectedManifestSha:'a'.repeat(64),
  });
  assert.equal(proof.code,'DORMANT_MANIFEST_PROVENANCE_MISMATCH');
 }finally{x.clean();}
});
