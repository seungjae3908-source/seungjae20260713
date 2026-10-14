import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareTelegramIsolatedRelease} from '../../ops/prepare-telegram-isolated-release.mjs';
import {installTelegramDormantPackage} from '../../ops/install-telegram-isolated-dormant-package.mjs';

const files=[
 'api-server/dist/telegram-isolated-worker.mjs',
 'ops/telegram-legacy-owner-runtime-proof.mjs',
 'ops/run-telegram-isolated-worker.sh',
];
function make(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'tg-dormant-install-'));
 const checkout=path.join(base,'repo'),source=path.join(base,'package'),releaseRoot=path.join(base,'release');
 fs.mkdirSync(checkout);fs.mkdirSync(releaseRoot);
 execFileSync('git',['init','-q',checkout]);
 execFileSync('git',['-C',checkout,'config','user.email','qa@example.test']);
 execFileSync('git',['-C',checkout,'config','user.name','QA']);
 files.forEach((f,i)=>{
  const target=path.join(checkout,f);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,'fixture '+i+'\n');
 });
 execFileSync('git',['-C',checkout,'add','.']);
 execFileSync('git',['-C',checkout,'commit','-qm','fixture']);
 const sha=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 prepareTelegramIsolatedRelease({checkedOutSha:sha,checkoutRoot:checkout,destination:source});
 return {base,source,releaseRoot,sha,
  install:()=>installTelegramDormantPackage({packageDir:source,expectedSha:sha,releaseRoot}),
  close:()=>fs.rmSync(base,{force:true,recursive:true})};
}
test('create-only dormant installation seals exact files and inert receipt',()=>{
 const x=make();try{
  const receipt=x.install(),target=path.join(x.releaseRoot,'current');
  assert.equal(receipt.mode,'STAGED_INACTIVE');assert.equal(receipt.workerStarted,false);
  assert.equal(receipt.productionAppChanged,false);assert.equal(receipt.pm2Restarts,0);
  assert.equal(receipt.telegramMessages,0);assert.equal(receipt.financialMutations,0);
  assert.equal(fs.statSync(target).mode&0o777,0o700);
  assert.equal(fs.readFileSync(path.join(target,'.deploy/current-sha'),'utf8'),x.sha+'\n');
  files.forEach(f=>assert.deepEqual(fs.readFileSync(path.join(target,f)),fs.readFileSync(path.join(x.source,f))));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,'.deploy/installation.json'),'utf8')),receipt);
  const verify=spawnSync('sha256sum',['--check','--quiet','.deploy/telegram-sha256.manifest'],{cwd:target});
  assert.equal(verify.status,0);
 }finally{x.close();}
});
test('existing release cannot be overwritten or silently reused',()=>{
 const x=make();try{
  x.install();const marker=fs.readFileSync(path.join(x.releaseRoot,'current/.deploy/current-sha'),'utf8');
  assert.throws(()=>x.install(),/DESTINATION_EXISTS/u);
  assert.equal(fs.readFileSync(path.join(x.releaseRoot,'current/.deploy/current-sha'),'utf8'),marker);
 }finally{x.close();}
});
test('tampered worker or manifest fails before destination creation',()=>{
 for(const file of [files[0],'.deploy/telegram-sha256.manifest']){
  const x=make();try{
   fs.appendFileSync(path.join(x.source,file),'TAMPER\n');
   assert.throws(()=>x.install(),/DIGEST_MISMATCH|MANIFEST_INVALID/u);
   assert.equal(fs.existsSync(path.join(x.releaseRoot,'current')),false);
  }finally{x.close();}
 }
});
test('wrong SHA and forged non-inert receipt are rejected',()=>{
 const x=make();try{
  const wrong=x.sha==='a'.repeat(40)?'b'.repeat(40):'a'.repeat(40);
  assert.throws(()=>installTelegramDormantPackage({packageDir:x.source,expectedSha:wrong,releaseRoot:x.releaseRoot}),
    /SOURCE_SHA_MISMATCH/u);
  const f=path.join(x.source,'.deploy/preparation.json');
  const receipt=JSON.parse(fs.readFileSync(f,'utf8'));receipt.workerStarted=true;
  fs.writeFileSync(f,JSON.stringify(receipt)+'\n');
  assert.throws(()=>x.install(),/PREPARATION_INVALID/u);
  assert.equal(fs.existsSync(path.join(x.releaseRoot,'current')),false);
 }finally{x.close();}
});
test('symlinked and multiply linked inputs are rejected',()=>{
 for(const hard of [false,true]){
  const x=make();try{
   const original=path.join(x.source,files[0]),copy=path.join(x.base,'copy');
   fs.renameSync(original,copy);
   if(hard)fs.linkSync(copy,original);else fs.symlinkSync(copy,original);
   assert.throws(()=>x.install(),/UNSAFE_INPUT/u);
   assert.equal(fs.existsSync(path.join(x.releaseRoot,'current')),false);
  }finally{x.close();}
 }
});
test('unsafe roots and relative paths are rejected',()=>{
 const x=make();try{
  assert.throws(()=>installTelegramDormantPackage({packageDir:'relative',expectedSha:x.sha,releaseRoot:x.releaseRoot}),
   /INVALID_ARGUMENTS/u);
  assert.throws(()=>installTelegramDormantPackage({packageDir:x.source,expectedSha:x.sha,releaseRoot:'/opt/stock-app/tg'}),
   /UNSAFE_ROOT/u);
  assert.throws(()=>installTelegramDormantPackage({packageDir:x.source,expectedSha:x.sha,releaseRoot:x.source}),
   /UNSAFE_ROOT/u);
  const link=path.join(x.base,'link');fs.symlinkSync(x.releaseRoot,link);
  assert.throws(()=>installTelegramDormantPackage({packageDir:x.source,expectedSha:x.sha,releaseRoot:link}),
   /UNSAFE_ROOT/u);
 }finally{x.close();}
});
test('materializer is offline-only and fixed-target CLI cannot modify a running app',()=>{
 const src=fs.readFileSync('ops/install-telegram-isolated-dormant-package.mjs','utf8');
 for(const forbidden of ['pm2 restart','pm2 stop','systemctl start','sendMessage(',
  'api.telegram.org','psql ','LIVE_TRADING=true','execFileSync(']){
   assert.equal(src.includes(forbidden),false,forbidden);
 }
 assert.match(src,/STAGED_INACTIVE/u);
 assert.match(src,/const ROOT='\/opt\/stock-app-data\/telegram-isolated-v1\/release'/u);
});
