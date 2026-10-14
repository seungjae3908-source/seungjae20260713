import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareTelegramIsolatedRelease } from '../../ops/prepare-telegram-isolated-release.mjs';

/** Runs the REAL protected host script in an isolated fake filesystem and fake PM2.
 * No production paths, credentials, Bot access, network, or real PM2 invocation.
 */
const OLD_SHA = '3'.repeat(40);
const FILES = [
  'api-server/dist/telegram-isolated-worker.mjs',
  'ops/telegram-legacy-owner-runtime-proof.mjs',
  'ops/run-telegram-isolated-worker.sh',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const call = (exe, args, opts={}) => execFileSync(exe,args,{encoding:'utf8',...opts}).trim();

function fixture(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tg-host-install-e2e-'));
  const checkout=path.join(temp,'checkout');
  const packageRoot=path.join(temp,'package');
  const app=path.join(temp,'opt','stock-app');
  const base=path.join(temp,'opt','stock-app-data','telegram-isolated-v1');
  const locks=path.join(temp,'var','lock');
  const bin=path.join(temp,'bin');
  const pm2Json=path.join(temp,'pm2.json');
  for(const dir of [checkout,path.join(app,'.deploy'),path.join(base,'incoming'),
     path.join(base,'release'),locks,bin])
    fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(app,'.deploy','current-sha'),OLD_SHA+'\n');
  fs.writeFileSync(path.join(bin,'pm2'),
    '#!/bin/sh\nif [ "$1" != "jlist" ]; then exit 77; fi\ncat "$TG_TEST_PM2_JSON"\n',
    {mode:0o700});
  call('git',['init','-q',checkout]);
  call('git',['-C',checkout,'config','user.email','qa@example.test']);
  call('git',['-C',checkout,'config','user.name','Offline Telegram QA']);
  for(const [i,name] of FILES.entries()){
    const full=path.join(checkout,name);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full,'fixture-'+i+'\n');
  }
  call('git',['-C',checkout,'add','.']);
  call('git',['-C',checkout,'commit','-qm','isolated exact-source fixture']);
  const sha=call('git',['-C',checkout,'rev-parse','HEAD']);
  prepareTelegramIsolatedRelease({
    checkedOutSha:sha,checkoutRoot:checkout,destination:packageRoot,
  });
  const incoming=path.join(base,'incoming',sha);
  fs.mkdirSync(incoming,{recursive:true});
  const tarFile=path.join(incoming,'telegram-dormant-payload.tar');
  call('tar',['-C',packageRoot,'-cf',tarFile,
    ...FILES,'.deploy/telegram-sha256.manifest','.deploy/preparation.json',
    '.deploy/current-sha']);
  const tarSha=hash(fs.readFileSync(tarFile));
  // Rewrite ONLY this sandbox copy's fixed paths; original source is unchanged.
  const originalInstaller=fs.readFileSync('ops/install-telegram-isolated-dormant-package.mjs','utf8');
  const oldDecl="const ROOT='/opt/stock-app-data/telegram-isolated-v1/release';";
  assert.ok(originalInstaller.includes(oldDecl));
  const installer=originalInstaller.replace(oldDecl,
    "const ROOT='"+path.join(base,'release')+"';");
  const installerFile=path.join(incoming,'install-telegram-isolated-dormant-package.mjs');
  fs.writeFileSync(installerFile,installer);
  const installerSha=hash(Buffer.from(installer));
  let runner=fs.readFileSync('ops/telegram-protected-dormant-install.sh','utf8');
  for(const [find,to] of [
    ['/opt/stock-app-data/telegram-isolated-v1',base],
    ['/opt/stock-app/.deploy/current-sha',path.join(app,'.deploy','current-sha')],
    ['/var/lock/stock-app-deploy.lock',path.join(locks,'stock-app-deploy.lock')],
  ]){
    assert.ok(runner.includes(find),find);
    runner=runner.replaceAll(find,to);
  }
  const runnerPath=path.join(temp,'protected-guard.sh');
  fs.writeFileSync(runnerPath,runner,{mode:0o700});
  const pm2Data=[
    {name:'stock-app',pid:44444,pm2_env:{
      status:'online',DEPLOY_SHA:OLD_SHA,
      LIVE_TRADING:'true',TOSS_LIVE_ORDER_ENABLED:'true',
      TELEGRAM_WORKER_OWNER:'embedded',
    }},
  ];
  fs.writeFileSync(pm2Json,JSON.stringify(pm2Data));
  const execute=(options={})=>spawnSync('bash',[
      runnerPath,sha,options.tarSha??tarSha,options.installerSha??installerSha,
    ],{
      env:{...process.env,
        TELEGRAM_DORMANT_PROTECTED_REVIEW:options.approved===false?'false':'true',
        TG_TEST_PM2_JSON:pm2Json,PATH:bin+':'+process.env.PATH,
      },
      cwd:temp,encoding:'utf8',timeout:20000,maxBuffer:65536,
    });
  return {temp,app,base,pm2Json,incoming,runnerPath,sha,
    installerFile,tarFile,tarSha,installerSha,execute,
    release:path.join(base,'release','current'),
    clean:()=>fs.rmSync(temp,{force:true,recursive:true})};
}

test('real protected shell installs only dormant bytes and preserves live PM2 identity',()=>{
  const x=fixture();
  try {
    const pm2Before=fs.readFileSync(x.pm2Json,'utf8');
    const markerBefore=fs.readFileSync(path.join(x.app,'.deploy/current-sha'),'utf8');
    const run=x.execute();
    assert.equal(run.error,undefined,String(run.error));
    assert.equal(run.status,0,run.stderr||run.stdout);
    assert.match(run.stdout,/TELEGRAM_DORMANT_INSTALLED_INACTIVE_PM2_UNCHANGED/u);
    const receipt=JSON.parse(fs.readFileSync(
      path.join(x.incoming,'installation-receipt.json'),'utf8'));
    assert.equal(receipt.mode,'STAGED_INACTIVE');
    assert.equal(receipt.workerStarted,false);
    assert.equal(receipt.pm2Restarts,0);
    assert.equal(receipt.telegramMessages,0);
    assert.equal(receipt.financialMutations,0);
    assert.equal(fs.readFileSync(path.join(x.release,'.deploy/current-sha'),'utf8'),x.sha+'\n');
    assert.equal(fs.readFileSync(x.pm2Json,'utf8'),pm2Before);
    assert.equal(fs.readFileSync(path.join(x.app,'.deploy/current-sha'),'utf8'),markerBefore);
    const state=path.join(x.base,'state');
    assert.equal(fs.statSync(state).mode&0o777,0o700);
    assert.equal(fs.readdirSync(state).length,0,
      'dormant install must not write sender state or any ledger');
  } finally { x.clean(); }
});

test('tampered JS installer is refused BEFORE reading PM2 or making release executable',()=>{
  const x=fixture();
  try {
    fs.appendFileSync(x.installerFile,'//tampered\n');
    const run=x.execute();
    assert.equal(run.status,22,run.stderr||run.stdout);
    assert.match(run.stderr,/TELEGRAM_DORMANT_INSTALLER_SOURCE_MISMATCH/u);
    assert.equal(fs.existsSync(x.release),false);
  } finally {x.clean();}
});

test('wrong payload checksum blocks before any installation',()=>{
  const x=fixture();
  try {
    const run=x.execute({tarSha:'f'.repeat(64)});
    assert.equal(run.status,22,run.stderr||run.stdout);
    assert.equal(fs.existsSync(x.release),false);
  } finally{x.clean();}
});

test('wrong active PM2 identity and inactive process fail closed without any app restart',()=>{
  for(const change of [
    row=>{row.pm2_env.DEPLOY_SHA='a'.repeat(40);},
    row=>{row.pm2_env.status='stopped';},
  ]){
    const x=fixture();
    try {
      const rows=JSON.parse(fs.readFileSync(x.pm2Json,'utf8'));
      change(rows[0]);
      fs.writeFileSync(x.pm2Json,JSON.stringify(rows));
      const run=x.execute();
      assert.equal(run.status,26,run.stderr||run.stdout);
      assert.equal(fs.existsSync(x.release),false);
      assert.equal(fs.readFileSync(path.join(x.app,'.deploy/current-sha'),'utf8'),OLD_SHA+'\n');
    }finally{x.clean();}
  }
});

test('approval missing, duplicate current release and incorrect install SHA fail closed',()=>{
  const x=fixture();
  try {
    const missing=x.execute({approved:false});
    assert.equal(missing.status,21,missing.stderr||missing.stdout);
    assert.equal(fs.existsSync(x.release),false);
    const wrong=x.execute({installerSha:'f'.repeat(64)});
    assert.equal(wrong.status,22,wrong.stderr||wrong.stdout);
    assert.equal(fs.existsSync(x.release),false);
    const first=x.execute();
    assert.equal(first.status,0,first.stderr||first.stdout);
    const second=x.execute();
    assert.equal(second.status,22,second.stderr||second.stdout);
  }finally{x.clean();}
});

test('symlinked and permissive pre-existing sender state directory block install',()=>{
  for(const unsafe of ['symlink','permissive']){
    const x=fixture();
    try {
      const state=path.join(x.base,'state');
      if(unsafe==='symlink')fs.symlinkSync(x.temp,state);
      else fs.mkdirSync(state,{mode:0o755});
      const run=x.execute();
      assert.equal(run.status,22,run.stderr||run.stdout);
      assert.equal(fs.existsSync(x.release),false);
      assert.equal(fs.readFileSync(path.join(x.app,'.deploy/current-sha'),'utf8'),OLD_SHA+'\n');
      if(unsafe==='permissive')
        assert.equal(fs.statSync(state).mode&0o777,0o755,
          'must not silently chmod operator-owned directory');
    }finally{x.clean();}
  }
});
