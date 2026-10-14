import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wf=fs.readFileSync('.github/workflows/telegram-dormant-installed-readonly.yml','utf8');
const source=fs.readFileSync('ops/telegram-dormant-installed-readonly.mjs','utf8');
const installer=fs.readFileSync('ops/telegram-protected-dormant-install.sh','utf8');

test('only original owner command and protected Production environment can inspect host',()=>{
 for(const marker of [
  "github.event.issue.number == 1555",
  "github.event.comment.user.login == 'seungjae3908-source'",
  "github.event.comment.author_association == 'OWNER'",
  'environment: production',
  "test \"$GITHUB_RUN_ATTEMPT\" = 1",
  '/run-telegram-dormant-readback ',
  'group: stock-app-production-live',
  'StrictHostKeyChecking=yes',
 ])assert.ok(wf.includes(marker),marker);
 assert.ok(wf.includes("github.event_name == 'issue_comment'"));
 assert.ok(wf.includes("github.event_name == 'pull_request'"));
});

test('artifact SHA and digest must be pinned before server read',()=>{
 for(const marker of [
  "github.rest.actions.listWorkflowRuns",
  "run.run_attempt!==1",
  "artifact.workflow_run?.head_sha!==sha",
  'sha256sum --check --quiet',
  'telegram-dormant-artifact-extract.py',
  'manifest=',"git merge-base --is-ancestor",
  'git rev-parse origin/main',
 ])assert.ok(wf.includes(marker),marker);
});

test('remote inspection is strictly Node stdin with no PM2 or secret writer',()=>{
 assert.match(wf,/node --input-type=module -/u);
 assert.match(wf,/< ops\/telegram-dormant-installed-readonly\.mjs/u);
 for(const forbidden of [
  'pm2 restart','pm2 reload','pm2 stop','systemctl start',
  'BOT_POST','sendMessage(','writeFileSync(','unlinkSync(',
  'execSync(','chownSync(','chmodSync(', 'mkdirSync(',
 ])assert.equal(source.includes(forbidden),false,forbidden);
});

test('readback rechecks seal and uses the same conservative app keys as protected install',()=>{
 for(const marker of [
  'const endSeal=inspectSealedDormant',
  "DORMANT_CHANGED_DURING_READBACK",
  "SEALED_PRESENT_PM2_OWNER_UNEXPECTED",
  "key==='executionAuthority'",
  "!key.startsWith('PM2_')&&!key.startsWith('AXM_')",
 ])assert.ok(source.includes(marker),marker);
 for(const marker of [
  'k==="executionAuthority"',
  '!k.startsWith("PM2_")&&!k.startsWith("AXM_")',
  'pm_uptime','restart_time','TELEGRAM_WORKER_OWNER',
 ])assert.ok(installer.includes(marker),marker);
 assert.ok(wf.includes("DORMANT_CHANGED_DURING_READBACK"));
 assert.ok(wf.includes("SEALED_PRESENT_PM2_OWNER_UNEXPECTED"));
});

test('result does not authorize worker activation or rewrite server state',()=>{
 assert.match(source,/activationReady:false/u);
 for(const marker of ['telegramSends:0','pm2Mutations:0','databaseWrites:0',
  'financialMutations:0','secretValuesRecorded:false'])
  assert.ok(source.includes(marker),marker);
 assert.match(wf,/NO_START|No Start/u);
 assert.equal(wf.includes('run-telegram-dormant-install '),false);
});
