import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareTelegramIsolatedRelease} from '../../ops/prepare-telegram-isolated-release.mjs';

const files=[
 'api-server/dist/telegram-isolated-worker.mjs',
 'ops/telegram-legacy-owner-runtime-proof.mjs',
 'ops/run-telegram-isolated-worker.sh',
];
const repo=()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-dormant-package-'));
 const checkout=path.join(base,'repo');
 fs.mkdirSync(checkout);
 execFileSync('git',['init','-q',checkout]);
 execFileSync('git',['-C',checkout,'config','user.email','qa@example.test']);
 execFileSync('git',['-C',checkout,'config','user.name','Offline QA']);
 for(const [i,rel] of files.entries()){
  const dest=path.join(checkout,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,'fixture '+i+'\n');
 }
 execFileSync('git',['-C',checkout,'add','.']);
 execFileSync('git',['-C',checkout,'commit','-qm','safe fixture']);
 const sha=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const output=path.join(base,'sealed-current');
 return {base,checkout,sha,output,close:()=>fs.rmSync(base,{force:true,recursive:true})};
};

test('create-only dormant package has exact SHA and runner-compatible digest manifest',()=>{
 const x=repo();try{
  const value=prepareTelegramIsolatedRelease({checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output});
  assert.equal(value.mode,'PREPARE_ONLY');
  assert.equal(value.workerStarted,false);
  assert.equal(value.productionAppChanged,false);
  assert.equal(value.pm2Restarts,0);
  assert.equal(value.telegramMessages,0);
  assert.equal(value.financialMutations,0);
  assert.equal(fs.readFileSync(path.join(x.output,'.deploy/current-sha'),'utf8').trim(),x.sha);
  for(const file of files){
   assert.equal(fs.readFileSync(path.join(x.checkout,file),'utf8'),fs.readFileSync(path.join(x.output,file),'utf8'));
   assert.equal(fs.lstatSync(path.join(x.output,file)).isSymbolicLink(),false);
  }
  const digest=spawnSync('sha256sum',['--check','--quiet','.deploy/telegram-sha256.manifest'],{cwd:x.output});
  assert.equal(digest.status,0);
  assert.equal(fs.statSync(x.output).mode&0o777,0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.output,'.deploy/preparation.json'),'utf8')),value);
 }finally{x.close()}
});

test('wrong source SHA fails before destination creation',()=>{
 const x=repo();try{
  const wrong=x.sha==='a'.repeat(40)?'b'.repeat(40):'a'.repeat(40);
  assert.throws(()=>prepareTelegramIsolatedRelease({checkedOutSha:wrong,checkoutRoot:x.checkout,destination:x.output}),/SOURCE_SHA_MISMATCH/);
  assert.equal(fs.existsSync(x.output),false);
 }finally{x.close()}
});

test('existing package is not overwritten or retried to green',()=>{
 const x=repo();try{
  prepareTelegramIsolatedRelease({checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output});
  const original=fs.readFileSync(path.join(x.output,'.deploy/telegram-sha256.manifest'),'utf8');
  assert.throws(()=>prepareTelegramIsolatedRelease({checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output}),/DESTINATION_EXISTS/);
  assert.equal(fs.readFileSync(path.join(x.output,'.deploy/telegram-sha256.manifest'),'utf8'),original);
 }finally{x.close()}
});

test('symlinked or multiply-linked source fails closed before materialization',()=>{
 const x=repo();try{
  const f=path.join(x.checkout,files[0]);
  const alias=path.join(x.base,'alias');
  fs.renameSync(f,alias);fs.symlinkSync(alias,f);
  assert.throws(()=>prepareTelegramIsolatedRelease({checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output}),/SOURCE_UNSAFE/);
  assert.equal(fs.existsSync(x.output),false);
  fs.rmSync(f);fs.copyFileSync(alias,f);
  fs.linkSync(f,path.join(x.base,'hardlink'));
  assert.throws(()=>prepareTelegramIsolatedRelease({checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output}),/SOURCE_UNSAFE/);
  assert.equal(fs.existsSync(x.output),false);
 }finally{x.close()}
});

test('absolute checkout/destination, no traversal into checkout or existing app',()=>{
 const x=repo();try{
  const args={checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output};
  assert.throws(()=>prepareTelegramIsolatedRelease({...args,destination:'relative'}),/INVALID_ARGUMENTS/);
  assert.throws(()=>prepareTelegramIsolatedRelease({...args,checkoutRoot:'relative'}),/INVALID_ARGUMENTS/);
  assert.throws(()=>prepareTelegramIsolatedRelease({...args,destination:path.join(x.checkout,'build')}),/UNSAFE_DESTINATION/);
  assert.throws(()=>prepareTelegramIsolatedRelease({...args,destination:'/opt/stock-app/telegram'}),/UNSAFE_DESTINATION/);
  const aliasParent=path.join(x.base,'symlink-parent');fs.symlinkSync(x.base,aliasParent);
  assert.throws(()=>prepareTelegramIsolatedRelease({...args,destination:path.join(aliasParent,'release')}),/UNSAFE_DESTINATION/);
 }finally{x.close()}
});

test('missing or empty required file never writes a runnable release marker',()=>{
 const x=repo();try{
  fs.writeFileSync(path.join(x.checkout,files[1]),'');
  assert.throws(()=>prepareTelegramIsolatedRelease({checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output}),/SOURCE_UNSAFE/);
  assert.equal(fs.existsSync(x.output),false);
 }finally{x.close()}
});

test('packager does not embed credentials and never runs Bot, PM2, DB or a worker',()=>{
 const code=fs.readFileSync(fileURLToPath(new URL('../../ops/prepare-telegram-isolated-release.mjs',import.meta.url)),'utf8');
 for(const forbidden of ['child_process.spawnSync(\'pm2\'','https://api.telegram.org','sendMessage(',"execFileSync('pm2'",'psql ', 'systemctl start']){
  assert.equal(code.includes(forbidden),false,forbidden);
 }
 assert.ok(code.includes("mode: 'PREPARE_ONLY'"));
 assert.ok(code.includes('workerStarted: false'));
});

test('modification of either tracked support script fails before release creation',()=>{
  for(const rel of files.filter(p=>p.startsWith('ops/'))){
    const x=repo();try{
      fs.appendFileSync(path.join(x.checkout,rel),'unreviewed change\\n');
      assert.throws(()=>prepareTelegramIsolatedRelease({
        checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output,
      }),/TRACKED_SOURCE_DRIFT/,rel);
      assert.equal(fs.existsSync(x.output),false);
    }finally{x.close()}
  }
});

test('generated standalone bundle may be untracked but tracked launch scripts must remain exact',()=>{
  const x=repo();try{
    fs.appendFileSync(path.join(x.checkout,files[0]),'generated-bundle\\n');
    const value=prepareTelegramIsolatedRelease({
      checkedOutSha:x.sha,checkoutRoot:x.checkout,destination:x.output,
    });
    assert.equal(value.sha,x.sha);
    assert.equal(value.mode,'PREPARE_ONLY');
    assert.equal(fs.readFileSync(path.join(x.output,files[0]),'utf8'),
      fs.readFileSync(path.join(x.checkout,files[0]),'utf8'));
  }finally{x.close()}
});

test('nested subdirectory is not accepted as the root of the advertised Git checkout',()=>{
  const x=repo();try{
    assert.throws(()=>prepareTelegramIsolatedRelease({
      checkedOutSha:x.sha,checkoutRoot:path.join(x.checkout,'ops'),destination:x.output,
    }),/SOURCE_ROOT_MISMATCH/);
    assert.equal(fs.existsSync(x.output),false);
  }finally{x.close()}
});
