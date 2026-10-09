import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ROOM_NAMES, sanitizedSha, checkSixRoomConfig,
  botPermissionVerdict, classifyPreflight, parseDatabaseTarget,
} from '../../ops/telegram-sixroom-vault-readonly-preflight.mjs';

const rooms = {
  TELEGRAM_KR_STOCK_CHAT_ID:'-1001111111111',
  TELEGRAM_US_STOCK_CHAT_ID:'-1002222222222',
  TELEGRAM_CRYPTO_SPOT_CHAT_ID:'-1003333333333',
  TELEGRAM_CRYPTO_FUTURES_CHAT_ID:'-1004444444444',
  TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID:'-1005555555555',
  TELEGRAM_AUTO_TRADING_CHAT_ID:'-1006666666666',
};
const owner='11111111-1111-4111-8111-111111111111';
const sha='a'.repeat(40);
const workflow=fs.readFileSync('.github/workflows/telegram-sixroom-vault-readonly-preflight.yml','utf8');
const script=fs.readFileSync('ops/telegram-sixroom-vault-readonly-preflight.mjs','utf8');

test('Vault configuration must have six unique dedicated rooms and verified owner UUID',()=>{
  assert.equal(Object.keys(ROOM_NAMES).length,6);
  assert.deepEqual(checkSixRoomConfig(rooms,owner,true),{valid:true,reason:null});
  assert.equal(checkSixRoomConfig(rooms,owner,false).reason,'OWNER_DB_PROOF_INVALID');
  assert.equal(checkSixRoomConfig(rooms,'owner-user',true).reason,'OWNER_DB_PROOF_INVALID');
  assert.equal(checkSixRoomConfig(null,owner,true).reason,'VAULT_ROOMS_ABSENT');
  assert.equal(checkSixRoomConfig({...rooms,TELEGRAM_KR_STOCK_CHAT_ID:'-10011'},owner,true).reason,'VAULT_ROOM_ID_FORMAT_INVALID');
  assert.equal(checkSixRoomConfig({...rooms,TELEGRAM_KR_STOCK_CHAT_ID:rooms.TELEGRAM_US_STOCK_CHAT_ID},owner,true).reason,'VAULT_ROOM_IDS_DUPLICATED');
  const missing={...rooms};delete missing.TELEGRAM_US_STOCK_CHAT_ID;
  assert.equal(checkSixRoomConfig(missing,owner,true).reason,'VAULT_ROOMS_KEYS_INVALID');
  assert.equal(checkSixRoomConfig({...rooms,UNKNOWN_ID:'-1009999999999'},owner,true).reason,'VAULT_ROOMS_KEYS_INVALID');
});

test('Telegram group and channel permissions fail closed',()=>{
  for(const type of ['group','supergroup']){
    assert.equal(botPermissionVerdict({type},{status:'member'}),'PASS');
    assert.equal(botPermissionVerdict({type},{status:'restricted',can_send_messages:false}),'BOT_ROOM_SEND_FORBIDDEN');
  }
  assert.equal(botPermissionVerdict({type:'supergroup',permissions:{can_send_messages:false}},{status:'member'}),'BOT_ROOM_SEND_FORBIDDEN');\n  assert.equal(botPermissionVerdict({type:'channel'},{status:'creator'}),'PASS');
  assert.equal(botPermissionVerdict({type:'channel'},{status:'administrator',can_post_messages:true}),'PASS');
  assert.equal(botPermissionVerdict({type:'channel'},{status:'administrator',can_post_messages:false}),'BOT_CHANNEL_POST_FORBIDDEN');
  assert.equal(botPermissionVerdict({type:'channel'},{status:'member'}),'BOT_CHANNEL_POST_FORBIDDEN');
  assert.equal(botPermissionVerdict({type:'private'},{status:'member'}),'INVALID_ROOM_TYPE');
  assert.equal(botPermissionVerdict({type:'supergroup'},{status:'kicked'}),'BOT_NOT_A_ROOM_MEMBER');
  assert.equal(botPermissionVerdict({type:'supergroup'},null),'BOT_NOT_A_ROOM_MEMBER');
});

test('classification requires exact Production SHA, complete Vault and six Bot API rights',()=>{
  const proof={mainSha:sha,pm2Sha:sha,markerSha:sha,pm2Online:true,
    vaultValid:true,botIdentityVerified:true,autoRoomMismatch:false,
    roomResults:Object.fromEntries(Object.values(ROOM_NAMES).map(x=>[x,'PASS']))};
  assert.equal(classifyPreflight(proof),'READY_FOR_PROTECTED_BINDING_REVIEW');
  assert.equal(classifyPreflight({...proof,pm2Sha:'b'.repeat(40)}),'PRODUCTION_RUNTIME_SHA_MISMATCH');
  assert.equal(classifyPreflight({...proof,markerSha:null}),'PRODUCTION_RUNTIME_SHA_MISMATCH');
  assert.equal(classifyPreflight({...proof,mainSha:'b'.repeat(40)}),'PRODUCTION_NOT_AT_CURRENT_MAIN');
  assert.equal(classifyPreflight({...proof,pm2Online:false}),'PRODUCTION_PM2_OFFLINE');
  assert.equal(classifyPreflight({...proof,vaultValid:false,vaultReason:'VAULT_ROOMS_KEYS_INVALID'}),'VAULT_ROOMS_KEYS_INVALID');
  assert.equal(classifyPreflight({...proof,botIdentityVerified:false}),'BOT_IDENTITY_NOT_VERIFIED');
  assert.equal(classifyPreflight({...proof,autoRoomMismatch:true}),'AUTO_ROOM_CONFIG_MISMATCH');
  assert.equal(classifyPreflight({...proof,roomResults:{...proof.roomResults,US_STOCK:'ROOM_UNREACHABLE'}}),'BOT_SIXROOM_PERMISSION_BLOCKED');
});

test('PostgreSQL connection is constrained to the already deployed Supabase project',()=>{
  const site='https://bawcbkoyovbeajkrnduq.supabase.co';
  const direct=parseDatabaseTarget('postgresql://postgres:test_password@db.bawcbkoyovbeajkrnduq.supabase.co:5432/postgres',site);
  assert.equal(direct.user,'postgres');
  const pool=parseDatabaseTarget('postgresql://postgres.bawcbkoyovbeajkrnduq:test_password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',site);
  assert.equal(pool.user,'postgres.bawcbkoyovbeajkrnduq');
  assert.throws(()=>parseDatabaseTarget('postgresql://postgres.badproject:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',site),/PROJECT_MISMATCH/);
  assert.throws(()=>parseDatabaseTarget('postgresql://postgres:pw@evil.example:5432/postgres',site),/PROJECT_MISMATCH/);
  assert.throws(()=>parseDatabaseTarget('postgresql://postgres:pw@db.bawcbkoyovbeajkrnduq.supabase.co:5432/other',site),/PROJECT_MISMATCH/);
  assert.throws(()=>parseDatabaseTarget('https://db.bawcbkoyovbeajkrnduq.supabase.co/postgres',site),/URL_INVALID/);
  assert.throws(()=>parseDatabaseTarget('postgresql://postgres:pw@db.bawcbkoyovbeajkrnduq.supabase.co:5432/postgres','https://evil.example'),/SUPABASE_PROJECT_UNVERIFIED/);
  assert.equal(sanitizedSha('A'.repeat(40)),sha);
  assert.equal(sanitizedSha('not-a-commit'),null);
});

test('only owner can trigger protected readonly workflow; no mutation or secret logging',()=>{
  for(const expected of [
    "github.event.issue.number == 1555",
    "github.event.comment.user.login == 'seungjae3908-source'",
    "github.event.comment.author_association == 'OWNER'",
    'environment: production',
    '/run-telegram-sixroom-vault-preflight ',
    'ref: ${{ github.sha }}',
    'git merge-base --is-ancestor',
    'PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}',
    'TELEGRAM_SIXROOM_VAULT_PREFLIGHT_EXECUTE=true node --input-type=module -',
    'cat ops/telegram-sixroom-vault-readonly-preflight.mjs',
    'VAULT_PREFLIGHT_SANITIZED_EVIDENCE_VALID',
  ])assert.ok(workflow.includes(expected),expected);
  for(const forbidden of ['sendMessage','sendPhoto','setWebhook','pm2 restart','pm2 reload','pm2 save','ALTER TABLE','apply_migration']){
    assert.ok(!workflow.includes(forbidden),forbidden);
  }
  assert.ok(script.includes('vault.decrypted_secrets'));
  assert.ok(script.includes('telegram_sixroom_prod_config_v1'));
  assert.ok(script.includes('telegram_sixroom_owner_member_id_v1'));
  assert.ok(script.includes("spawnSync('psql'"));
  assert.ok(script.includes("method: 'GET'"));
  assert.ok(!/\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP\s+TABLE)\b/iu.test(script));
  assert.ok(!script.includes('console.log(proof)'));
  assert.ok(!script.includes('console.log(botToken)'));
});

test('issue receipt and GitHub report only sanitized proof and room codes',()=>{
  assert.ok(workflow.includes('Object.keys(report.roomResults ?? {}).sort().join()'));
  assert.ok(workflow.includes('report.secretValuesRecorded !== false'));
  assert.ok(workflow.includes('report.telegramSends !== 0'));
  assert.ok(workflow.includes('report.serverMutations !== 0'));
  assert.ok(workflow.includes('report.financialMutations !== 0'));
  assert.ok(workflow.includes('Actual Production PM2 SHA:'));
  assert.ok(workflow.includes('Actual deploy marker SHA:'));
  assert.ok(!workflow.includes('console.log(report)'));
});
