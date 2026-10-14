import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const workflow=fs.readFileSync('.github/workflows/telegram-owner-personal-test-send.yml','utf8');
const source=fs.readFileSync('ops/telegram-owner-personal-test-send.mjs','utf8');

test('personal owner send only runs with immutable main, author owner and Production review',()=>{
 for(const s of [
 "if: github.event_name == 'pull_request'",
 "github.event_name == 'issue_comment'",
 "github.event.issue.number == 1555",
 "github.event.comment.user.login == 'seungjae3908-source'",
 "github.event.comment.author_association == 'OWNER'",
 "environment: production",
 'test "$GITHUB_RUN_ATTEMPT" = 1',
 'git rev-parse origin/main',
 'test "$GITHUB_SHA" = "$TARGET_SHA"',
 '/run-telegram-owner-personal-test-send ',
 'StrictHostKeyChecking=yes',
 ]){
  assert.ok(workflow.includes(s),s);
 }
});
test('personal owner protected workflow is single Bot attempt not trade or shared PM2 deploy',()=>{
 for(const expected of ['OWNER_PERSONAL_SINGLE_TEST_BOT_API_ACCEPTED',
  'telegram-owner-personal-test-send.mjs',
  'TELEGRAM_OWNER_PERSONAL_TEST_EXECUTE=true',
  'PERSONAL_BOT_API_ACCEPTED',
  'r.telegramSends>1','r.telegramAccepted>r.telegramSends',
  'connectionMutations','financialMutations'])
  assert.ok(workflow.includes(expected),expected);
 for(const forbidden of [
  'pm2 restart','pm2 stop','pm2 reload',
  'systemctl start','systemctl restart','setWebhook',
  'LIVE_TRADING=false','AUTO_TRADING=false','psql -c',
  'ops/deploy-production.sh',
 ]){
  assert.ok(!workflow.includes(forbidden),forbidden);
 }
});
test('remote personal transport is one POST after strict owner and private chat checks',()=>{
 for(const s of ['BEGIN READ ONLY;',
  "PGOPTIONS:'-c default_transaction_read_only=on",
  'telegram_sixroom_owner_member_id_v1','public.telegram_connections',
  "t.status='ACTIVE' AND t.revoked_at IS NULL",
  'ownerConnections===1','allActiveConnections===1',
  "chat?.type!=='private'", "result.telegramSends=1",
  "result.telegramAccepted=1","result.classification='PERSONAL_SEND_UNCONFIRMED'",
 ])assert.ok(source.includes(s),s);
 for(const s of ['INSERT INTO','DELETE FROM','UPDATE public.',
  'revokeTelegramConnection','api-server/dist/index.mjs','pm2 restart',
  'systemctl','withdrawal','transferFunds','privateProviderCall']){
  assert.ok(!source.includes(s),s);
 }
});
test('workflow never publishes bot token, private chat, user UUID, or delivery row',()=>{
 assert.ok(workflow.includes("No raw bot token/chat ID/member ID"));
 assert.ok(workflow.includes("No fake trading signal, fill, durable notification_deliveries SENT"));
 assert.ok(workflow.includes('Bot API acceptance is not a human read receipt.'));
 assert.ok(!workflow.includes('GHE{'));
 assert.ok(!workflow.includes('}EGH'));
 assert.ok(!workflow.includes('console.log(process.env.PROD_DATABASE_URL)'));
});
