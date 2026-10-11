import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyTelegramCodeOnlyDiff, TELEGRAM_CODE_ONLY_ALLOWED_FILES,
  TELEGRAM_VERIFIED_APP_TARGET_SHA, TELEGRAM_INTERVENING_AUTO_MERGE_SHA } from
  '../../ops/telegram-production-code-only-scope.mjs';

const wf=fs.readFileSync('.github/workflows/telegram-production-code-only-deploy.yml','utf8');
const deploy=fs.readFileSync('ops/deploy-production.sh','utf8');
const validFiles=[
  'api-server/src/services/telegram-intelligence-worker.service.ts',
  'api-server/src/services/signal-intelligence-telegram-subscriber.service.ts',
  'api-server/src/index.ts',
  '.github/workflows/telegram-production-code-only-deploy.yml',
  'ops/deploy-production.sh',
];
const compare=(files=validFiles)=>({
  status:'ahead',ahead_by:2,behind_by:0,total_commits:2,
  files:files.map(filename=>({filename,status:'modified'})),
});

test('only a strict bounded Telegram app-code diff can be deployed',()=>{
  assert.deepEqual(classifyTelegramCodeOnlyDiff(compare()),{
    ok:true,code:'TELEGRAM_CODE_ONLY_SCOPE_PASS',changedFileCount:5,
  });
  assert.equal(classifyTelegramCodeOnlyDiff(compare([...validFiles,
    'api-server/src/services/member-auto-trading-background-worker.service.ts'])).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff(compare([...validFiles,
    '.github/workflows/production-deploy.yml'])).code,'TELEGRAM_SCOPE_UNRELATED_CHANGE');
  assert.equal(classifyTelegramCodeOnlyDiff({...compare(),behind_by:1}).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff({...compare(),status:'diverged'}).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff({...compare(),total_commits:3}).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff(compare(validFiles.slice(1))).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff(compare([...validFiles,validFiles[0]])).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff({...compare(),
    files:[...compare().files,{filename:'ops/telegram-production-code-only-scope.mjs',status:'removed'}]}).ok,false);
});

test('pinned ancestor excludes later automatic-trading code and old mode stays strict',()=>{
  assert.equal(TELEGRAM_VERIFIED_APP_TARGET_SHA,'ceade3d9fb4cbb4bfcea42d548233aec79653e92');
  assert.equal(TELEGRAM_INTERVENING_AUTO_MERGE_SHA,'67c198a8358e22626495d7c7a5b239e9a40e7c0a');
  const appOnly=validFiles.filter(x=>x!=='ops/deploy-production.sh'
    &&x!=='.github/workflows/telegram-production-code-only-deploy.yml');
  assert.deepEqual(classifyTelegramCodeOnlyDiff(compare(appOnly),{pinnedAncestor:true}),{
    ok:true,code:'TELEGRAM_CODE_ONLY_SCOPE_PASS',changedFileCount:3,
  });
  assert.equal(classifyTelegramCodeOnlyDiff(compare(appOnly)).ok,false);
  assert.equal(classifyTelegramCodeOnlyDiff(compare([...appOnly,
    'api-server/src/services/member-auto-trading-background-worker.service.ts']),
    {pinnedAncestor:true}).ok,false);
  for(const requirement of [
    'TELEGRAM_PINNED_ANCESTOR_RELEASE_LINEAGE_CHANGED',
    'autoCommit.data.parents[0].sha!==target',
    'operatorCommit.data.parents[0].sha!==interveningAuto',
    'ops/deploy-telegram-operator.sh',
  ]) assert.ok(wf.includes(requirement),requirement);
});
test('only finite whitelisted paths are accepted',()=>{
  assert.equal(TELEGRAM_CODE_ONLY_ALLOWED_FILES.length,new Set(TELEGRAM_CODE_ONLY_ALLOWED_FILES).size);
  for(const p of TELEGRAM_CODE_ONLY_ALLOWED_FILES)assert.ok(!p.includes('..'));
  assert.ok(!TELEGRAM_CODE_ONLY_ALLOWED_FILES.includes('.github/workflows/production-deploy.yml'));
});

test('only release canary suppresses background workers; live PM2 is not disabled by this patch',()=>{
  const begin=deploy.indexOf('nohup env PORT=');
  const end=deploy.indexOf('echo $! >"$RELEASE_DIR/.canary.pid"',begin);
  assert.ok(begin>=0&&end>begin);
  const canary=deploy.slice(begin,end);
  assert.ok(canary.includes('LIVE_TELEGRAM_ACTIVATION_APPROVED=false'));
  assert.ok(canary.includes('BACKGROUND_WORKERS_ENABLED=false'));
  assert.equal((deploy.match(/BACKGROUND_WORKERS_ENABLED=false/g)||[]).length,1);
  const restartBegin=deploy.indexOf('restart_application_preserving_telegram() {');
  const restartEnd=deploy.indexOf('\n}\n',restartBegin);
  assert.ok(restartBegin>=0&&restartEnd>restartBegin);
  const restart=deploy.slice(restartBegin,restartEnd);
  assert.ok(!restart.includes('BACKGROUND_WORKERS_ENABLED=false'));
  assert.ok(deploy.includes('assert_live_trading_inactive_before_deploy'));
});

test('protected owner-only production workflow cannot run sends or migrations',()=>{
  for(const value of [
    'environment: production',
    'group: stock-app-production-live',
    'cancel-in-progress: false',
    "github.event.comment.user.login == 'seungjae3908-source'",
    "github.event.comment.author_association == 'OWNER'",
    "github.event.issue.number == 1555",
    "startsWith(github.event.comment.body, '/run-telegram-code-only-production ')",
    'Require only the immutably pinned Telegram ancestor with full-CI provenance',
    'Require exact-main successful PostgreSQL auth and Staging verdict',
    'Reject unrelated files between actual Production and exact main',
    'TELEGRAM_PINNED_RELEASE_SOURCE_CHANGED',
    "'ops/deploy-production.sh'",
    'TELEGRAM_PREDEPLOY_RUNTIME_MOVED',
    'Revalidate immutable main immediately before Production mutation',
    'StrictHostKeyChecking=yes',
    'ops/deploy-production.sh',
    'Read back exact Production application and worker health',
    'TELEGRAM_CODE_ONLY_DEPLOY_READBACK_OK',
  ]) assert.ok(wf.includes(value),'required '+value);
  for(const banned of [
    'sendMessage','setWebhook','deleteWebhook','api.telegram.org',
    'apply-production-', 'psql ', 'supabase db', 'LIVE_TRADING=true',
    'AUTO_TRADING=true', 'REAL_ORDER_ENABLED=true',
    'Replit', 'replit.com',
  ]) assert.ok(!wf.includes(banned),'forbidden '+banned);
  assert.ok(!wf.includes('workflow_dispatch:'));
});


test('sync source, deployment and rollback preserve Telegram and Signal V3 persisted ledgers',()=>{
  const start=deploy.indexOf('sync_source_tree() {');
  const end=deploy.indexOf('\n}\n',start);
  assert.ok(start>=0&&end>start);
  const sync=deploy.slice(start,end);
  assert.ok(sync.includes('rsync -a --delete'));
  assert.ok(sync.includes("--exclude='.runtime/'"));
  assert.ok(!sync.includes('--delete-excluded'));
  for(const route of [
    'sync_source_tree "$LIVE_DIR" "$BACKUP_DIR/source"',
    'sync_source_tree "$RELEASE_DIR" "$LIVE_DIR"',
    'sync_source_tree "$BACKUP_DIR/source" "$LIVE_DIR"',
  ])assert.ok(deploy.includes(route),route);
  const brief=fs.readFileSync('api-server/src/services/telegram-intelligence-worker.service.ts','utf8');
  const signal=fs.readFileSync('api-server/src/services/signal-intelligence-telegram-subscriber.service.ts','utf8');
  assert.ok(brief.includes('.runtime/telegram-intelligence-delivery-state.json'));
  assert.ok(signal.includes('.runtime/signal-intelligence-telegram-state.json'));
});

test('pinned deployment script Git blob always matches reviewed branch bytes',()=>{
  const actual=createHash('sha1').update('blob '+Buffer.byteLength(deploy,'utf8')+'\0')
    .update(deploy,'utf8').digest('hex');
  assert.equal(wf.split(actual).length-1,2);
});


test('strict predeploy reads vetted Signal V3 module before any Production mutation',()=>{
  const stage=wf.indexOf('Block release without two recent Staging Telegram network successes');
  const v3=wf.indexOf('Block release on stale Signal V3 or public endpoint HTTP 503');
  const mutation=wf.indexOf('Deploy exact code using existing canary, PM2 and rollback script');
  assert.ok(stage>=0&&v3>stage&&mutation>v3);
  const section=wf.slice(v3,mutation);
  assert.ok(section.includes('TELEGRAM_PREDEPLOY_REMOTE_READONLY=true'));
  assert.ok(section.includes('< ops/telegram-predeploy-signal-health.mjs'));
  assert.ok(section.includes('StrictHostKeyChecking=yes'));
  for (const forbidden of [
    'pm2 restart','systemctl restart','systemctl start',
    'sendMessage','psql ', 'setWebhook','LIVE_TRADING=true',
  ])assert.ok(!section.includes(forbidden),forbidden);
  const mod=fs.readFileSync('ops/telegram-predeploy-signal-health.mjs','utf8');
  assert.ok(mod.includes('verifiedSignalV3Coverage'));
  assert.ok(mod.includes("http://127.0.0.1:8790"));
  assert.ok(mod.includes("'/v1/signals'"));
  assert.ok(mod.includes("'investment-signal-intelligence-v3-cycle.timer'"));
  assert.ok(mod.includes('SIGNAL_V3_FRESH_PASS'));
  assert.ok(wf.includes("'ops/telegram-predeploy-signal-health.mjs':'832b8883cacf39617f3a08cfd7dd765aaa2ff2cf'"));
  assert.ok(wf.includes("['ops/deploy-production.sh',"));
});

test('Staging network gate needs two bounded independent green receipts, not latest green only',()=>{
  const stage=wf.slice(wf.indexOf('Block release without two recent Staging Telegram network successes'),
    wf.indexOf('Require pinned Production SSH credentials and host identity'));
  assert.ok(stage.includes("workflow_id:'telegram-only-staging-qa.yml'"));
  assert.ok(stage.includes("event:'issue_comment'"));
  assert.ok(stage.includes("r.conclusion!=='skipped'"));
  assert.ok(stage.includes('recent.length>=2&&green.length===recent.length'));
  assert.ok(stage.includes('now-Date.parse(green[0].created_at)<=10*60_000'));
  assert.ok(stage.includes('>=5*60_000'));
  assert.ok(stage.includes('<=30*60_000'));
  assert.ok(!stage.includes('workflow_dispatch'));
});
