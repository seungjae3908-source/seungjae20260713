import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  ROOM_NAMES, sanitizedSha, checkSixRoomConfig,
  botPermissionVerdict, classifyPreflight, parseDatabaseTarget,
  classifyTelegramTransportError, readTelegram, probeTelegramIpv4Tls,
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
  assert.equal(botPermissionVerdict({type:'supergroup',permissions:{can_send_messages:false}},{status:'member'}),'BOT_ROOM_SEND_FORBIDDEN');
  assert.equal(botPermissionVerdict({type:'channel'},{status:'creator'}),'PASS');
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

test('Telegram GET transport failures are classified without ever exposing URL, token, or raw errors', async () => {
  const token = '123456:ABCDEF1234567890abcdefghijklmnop';
  const e = new TypeError('HTTPS failed: https://api.telegram.org/bot' + token + '/getMe');
  e.cause = { code: 'ENOTFOUND' };
  assert.equal(classifyTelegramTransportError(e), 'BOT_API_DNS_FAILED');
  assert.equal(classifyTelegramTransportError({cause:{code:'EAI_AGAIN'}}), 'BOT_API_DNS_FAILED');
  assert.equal(classifyTelegramTransportError({cause:{code:'ENETUNREACH'}}), 'BOT_API_NETWORK_UNREACHABLE');
  assert.equal(classifyTelegramTransportError({cause:{code:'CERT_HAS_EXPIRED'}}), 'BOT_API_TLS_FAILED');
  assert.equal(classifyTelegramTransportError({cause:{code:'UND_ERR_CONNECT_TIMEOUT'}}), 'BOT_API_TIMEOUT');
  assert.equal(classifyTelegramTransportError({name:'TimeoutError'}), 'BOT_API_TIMEOUT');
  assert.equal(classifyTelegramTransportError(new Error('secret')), 'BOT_API_TRANSPORT_FAILED');
  const denied = await readTelegram(token,'getMe',{},async () => ({
    status:401, ok:false, body: {ok:false,description:'SECRET_RESPONSE'},
  }));
  assert.deepEqual(denied,{status:'BOT_API_AUTH_REJECTED',data:null});
  const down = await readTelegram(token,'getMe',{},async () => {throw e});
  assert.deepEqual(down,{status:'BOT_API_DNS_FAILED',data:null});
  assert.equal(JSON.stringify(down).includes(token),false);
  assert.equal(JSON.stringify(down).includes('SECRET_RESPONSE'),false);
  assert.deepEqual(await readTelegram(token,'getMe',{},null),
    {status:'BOT_API_TRANSPORT_FAILED',data:null});
  const working = await readTelegram(token,'getMe',{},async () => ({
    status:200,ok:true,body:{ok:true,result:{is_bot:true,id:12345,username:'test_bot'}},
  }));
  assert.deepEqual(working,{status:'PASS',data:{is_bot:true,id:12345,username:'test_bot'}});
});

test('a non-ready Production preflight cannot end as a green workflow',()=>{
  assert.ok(workflow.includes('Block false-green when Production is not Telegram-ready'));
  assert.ok(workflow.includes('VAULT_PREFLIGHT_OPERATIONAL_NOT_READY'));
  assert.ok(workflow.includes("r.classification === 'READY_FOR_PROTECTED_BINDING_REVIEW'"));
  assert.ok(workflow.includes('git rev-parse origin/main'));
  assert.ok(workflow.includes('test "$GITHUB_SHA" = "$EXPECTED_MAIN_SHA"'));
  assert.ok(workflow.includes('Failure stage:'));
  assert.ok(workflow.includes('Bot API GET diagnostic:'));
  assert.ok(script.includes("result.failureStage = 'BOT_GETME'"));
  assert.ok(script.includes("import { request as httpsRequest } from 'node:https'"));
  assert.ok(script.includes("httpsRequest(url"));
  assert.ok(script.includes("bytes > 131072"));
  assert.ok(!script.includes("globalThis.fetch"));
  assert.ok(script.includes('result.botApiDiagnostic = botResponse.status'));
});

test('IPv4 TLS probe identifies network stage using no tokens or IP values', async () => {
  const goodLookup = (host, options, callback) => {
    assert.equal(host, 'api.telegram.org');
    assert.equal(options.family, 4);
    callback(null, '192.0.2.50', 4);
  };
  const neverConnect = () => { throw new Error('TLS should not be invoked'); };
  assert.equal(await probeTelegramIpv4Tls({
    lookupImpl: (_host,_options, callback) => callback(Object.assign(new Error('secret'), { code: 'ENOTFOUND' })),
    connectImpl: neverConnect,
  }), 'IPV4_DNS_FAILED');

  const ready = await probeTelegramIpv4Tls({
    lookupImpl: goodLookup,
    connectImpl: options => {
      assert.equal(options.host, 'api.telegram.org');
      assert.equal(options.servername, 'api.telegram.org');
      assert.equal(options.port, 443);
      assert.equal(options.family, 4);
      assert.equal(options.autoSelectFamily, false);
      assert.equal(options.rejectUnauthorized, true);
      const socket = new EventEmitter();
      socket.authorized = true;
      socket.destroyed = false;
      socket.destroy = () => { socket.destroyed = true; };
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket;
    },
  });
  assert.equal(ready, 'IPV4_TLS_READY');
  assert.equal(JSON.stringify(ready).includes('192.0.2.50'), false);

  const timeout = await probeTelegramIpv4Tls({
    lookupImpl: goodLookup,
    connectImpl: () => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit('timeout'));
      return socket;
    },
  });
  assert.equal(timeout, 'IPV4_TLS_TIMEOUT');

  const certFailure = await probeTelegramIpv4Tls({
    lookupImpl: goodLookup,
    connectImpl: () => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('private'), {code:'CERT_HAS_EXPIRED'})));
      return socket;
    },
  });
  assert.equal(certFailure, 'IPV4_TLS_CERT_FAILED');
});

test('preflight reuses Production IPv4 workaround and reports blocked path without widening access',()=>{
  assert.ok(script.includes("import { lookup as dnsLookup } from 'node:dns'"));
  assert.ok(script.includes("import { connect as tlsConnect } from 'node:tls'"));
  assert.ok(script.includes("family: 4, autoSelectFamily: false, timeout: 15000"));
  assert.ok(script.includes("result.networkPathProbe = await probeTelegramIpv4Tls()"));
  assert.ok(script.includes("'BOT_API_TIMEOUT'"));
  assert.ok(workflow.includes("Token-free IPv4 DNS/TLS path:"));
  assert.ok(workflow.includes("'IPV4_TLS_READY'"));
  assert.ok(workflow.includes("VAULT_PREFLIGHT_OPERATIONAL_NOT_READY"));
  assert.ok(!script.includes('console.log(botToken)'));
});
