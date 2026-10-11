import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyTelegramCodeOnlyDiff, TELEGRAM_CODE_ONLY_ALLOWED_FILES } from
  '../../ops/telegram-production-code-only-scope.mjs';

const wf=fs.readFileSync('.github/workflows/telegram-production-code-only-deploy.yml','utf8');
const validFiles=[
  'api-server/src/services/telegram-intelligence-worker.service.ts',
  'api-server/src/services/signal-intelligence-telegram-subscriber.service.ts',
  'api-server/src/index.ts',
  '.github/workflows/telegram-production-code-only-deploy.yml',
];
const compare=(files=validFiles)=>({
  status:'ahead',ahead_by:2,behind_by:0,total_commits:2,
  files:files.map(filename=>({filename,status:'modified'})),
});

test('only a strict bounded Telegram app-code diff can be deployed',()=>{
  assert.deepEqual(classifyTelegramCodeOnlyDiff(compare()),{
    ok:true,code:'TELEGRAM_CODE_ONLY_SCOPE_PASS',changedFileCount:4,
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

test('only finite whitelisted paths are accepted',()=>{
  assert.equal(TELEGRAM_CODE_ONLY_ALLOWED_FILES.length,new Set(TELEGRAM_CODE_ONLY_ALLOWED_FILES).size);
  for(const p of TELEGRAM_CODE_ONLY_ALLOWED_FILES)assert.ok(!p.includes('..'));
  assert.ok(!TELEGRAM_CODE_ONLY_ALLOWED_FILES.includes('.github/workflows/production-deploy.yml'));
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
    'Require exact main and post-merge full-CI provenance',
    'Require exact-main successful PostgreSQL auth and Staging verdict',
    'Reject unrelated files between actual Production and exact main',
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
