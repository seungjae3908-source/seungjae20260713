import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const wf=fs.readFileSync('.github/workflows/telegram-cutover-readonly.yml','utf8');
test('protected read-only audit cannot launch on unapproved PR, stale or wrong issue',()=>{
 for(const expected of [
  "if: github.event_name == 'pull_request'",
  "github.event_name == 'issue_comment'",
  "github.event.comment.author_association == 'OWNER'",
  "github.event.issue.number == 1555",
  "/run-telegram-cutover-readonly ",
  "environment: production",
  "StrictHostKeyChecking=yes",
  "git rev-parse origin/main",
  "group: stock-app-production-live",
 ])assert.ok(wf.includes(expected),expected);
});
test('host invocation is read-only, runs two samples, never starts a service',()=>{
 for(const expected of [
  "cat ops/telegram-cutover-readonly.mjs",
  "observeTelegramHandoff",
  "node --input-type=module -",
  "TELEGRAM_CUTOVER_READONLY_EVIDENCE_VALID",
  "value.activationReady!==false",
  "FOUR_LANES_QUIESCED_ONLY",
 ])assert.ok(wf.includes(expected),expected);
 for(const bad of ['pm2 restart','pm2 reload','pm2 stop','systemctl start',
  'systemctl restart','sendMessage(', 'api.telegram.org',
  'LIVE_TRADING=false','AUTO_TRADING=false','psql '])
  assert.equal(wf.includes(bad),false,bad);
});
test('report remains sanitized and cannot be interpreted as full activation',()=>{
 assert.ok(wf.includes('Activation: NO-GO'));
 assert.ok(wf.includes('value.telegramSends!==0'));
 assert.ok(wf.includes('value.financialMutations!==0'));
 assert.ok(wf.includes('value.privateValuesRecorded!==false'));
 assert.ok(!wf.includes('GHE{'));
});
