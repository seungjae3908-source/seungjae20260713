import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ROOM_KEYS, verifyVaultSixRooms, roomPostPermission, makeTestText,
  createSanitizedReceipt, performSixRoomDelivery,
} from '../../ops/telegram-sixroom-test-delivery.mjs';

const script=fs.readFileSync('ops/telegram-sixroom-test-delivery.mjs','utf8');
const workflow=fs.readFileSync('.github/workflows/telegram-sixroom-test-delivery.yml','utf8');
const sha='a'.repeat(40);
const owner='11111111-1111-4111-8111-111111111111';
const token='123456:ABCDEF1234567890abcdefghijklmnop';
const rooms=Object.fromEntries(Object.keys(ROOM_KEYS).map((k,i)=>[k,'-100'+(1111111111+i)]));

function setup(overrides={}) {
  const calls=[],messages=[];
  const params={
    mainSha:sha,pm2Sha:sha,markerSha:sha,pm2Online:true,activationApproved:true,
    rooms,owner,ownerVerified:true,botToken:token,
    expectedBotUsername:'@my_test_bot',runId:'379999888',
    botGet:async (method,params)=>{
      calls.push({method,params});
      if(method==='getMe')return {is_bot:true,id:555,username:'my_test_bot'};
      if(method==='getChat')return {type:'supergroup',permissions:{can_send_messages:true}};
      if(method==='getChatMember')return {status:'administrator'};
      throw Error('unsafe method');
    },
    botSend:async (message)=>{
      messages.push(message);
      return {message_id:100+messages.length};
    },
    ...overrides,
  };
  return {params,calls,messages};
}

test('test message format is unambiguously non-trading and run-identifiable',()=>{
  const text=makeTestText('국내주식','12345');
  assert.ok(text.includes('테스트'));
  assert.ok(text.includes('실제 주문'));
  assert.ok(text.includes('국내주식'));
  assert.ok(text.includes('12345'));
  assert.throws(()=>makeTestText('국내주식','not-a-run'),/RUN_ID_INVALID/);
});

test('six unique Vault supergroup bindings and verified owner are required',()=>{
  assert.equal(verifyVaultSixRooms(rooms,owner,true),true);
  assert.equal(verifyVaultSixRooms(rooms,owner,false),false);
  assert.equal(verifyVaultSixRooms(rooms,'bad',true),false);
  assert.equal(verifyVaultSixRooms({...rooms,TELEGRAM_US_STOCK_CHAT_ID:rooms.TELEGRAM_KR_STOCK_CHAT_ID},owner,true),false);
  assert.equal(verifyVaultSixRooms({...rooms,TELEGRAM_US_STOCK_CHAT_ID:''},owner,true),false);
});

test('channel posting needs an administrator with posting rights, groups forbid banned bots',()=>{
  assert.equal(roomPostPermission({type:'channel'},{status:'member'}),false);
  assert.equal(roomPostPermission({type:'channel'},{status:'administrator',can_post_messages:false}),false);
  assert.equal(roomPostPermission({type:'channel'},{status:'administrator',can_post_messages:true}),true);
  assert.equal(roomPostPermission({type:'supergroup',permissions:{can_send_messages:false}},{status:'member'}),false);
  assert.equal(roomPostPermission({type:'supergroup'},{status:'administrator'}),true);
  assert.equal(roomPostPermission({type:'supergroup'},{status:'kicked'}),false);
});

test('one real TEST send per verified Vault room, only after all six rights PASS',async()=>{
  const t=setup();
  const r=await performSixRoomDelivery(t.params);
  assert.equal(r.classification,'SIX_ROOM_DELIVERY_CONFIRMED');
  assert.equal(r.telegramSends,6);
  assert.equal(r.telegramAccepted,6);
  assert.equal(r.roomsVerified,true);
  assert.equal(r.botIdentityVerified,true);
  assert.deepEqual(Object.values(r.roomResults),Array(6).fill('SENT_CONFIRMED'));
  assert.equal(t.messages.length,6);
  assert.equal(t.calls.filter(x=>x.method==='getChat').length,6);
  assert.equal(t.calls.filter(x=>x.method==='getChatMember').length,6);
  for(const m of t.messages){
    assert.equal(m.disable_notification,true);
    assert.equal(m.protect_content,true);
    assert.equal(m.link_preview_options.is_disabled,true);
    assert.ok(m.text.includes('테스트'));
  }
  assert.equal(r.financialMutations,0);
  assert.equal(r.dbWrites,0);
  assert.equal(r.webhookMutations,0);
  assert.equal(r.secretValuesRecorded,false);
  const receipt=JSON.stringify(r);
  assert.equal(receipt.includes(token),false);
  assert.equal(receipt.includes(owner),false);
  assert.equal(receipt.includes('-100111111111'),false);
});

test('runtime identity mismatch, missing owner or disabled Telegram blocks before any send',async()=>{
  for(const patch of [
    {pm2Sha:'b'.repeat(40)},
    {pm2Online:false},
    {activationApproved:false},
    {ownerVerified:false},
    {rooms:{...rooms,TELEGRAM_US_STOCK_CHAT_ID:rooms.TELEGRAM_KR_STOCK_CHAT_ID}},
  ]){
    const t=setup(patch);
    const result=await performSixRoomDelivery(t.params);
    assert.equal(result.telegramSends,0);
    assert.equal(result.telegramAccepted,0);
    assert.equal(t.messages.length,0);
    assert.notEqual(result.classification,'SIX_ROOM_DELIVERY_CONFIRMED');
  }
});

test('unreachable getMe, wrong bot and any one room permission failure prevent ALL sends',async()=>{
  const badBot=setup({botGet:async()=>{throw Error('RAW_TOKENS_MUST_NOT_LOG');}});
  const a=await performSixRoomDelivery(badBot.params);
  assert.equal(a.classification,'BOT_IDENTITY_UNVERIFIED');
  assert.equal(a.telegramSends,0);
  assert.ok(!JSON.stringify(a).includes('RAW_TOKENS_MUST_NOT_LOG'));
  const badRoom=setup();
  const get=badRoom.params.botGet;
  badRoom.params.botGet=async(method,params)=>{
    if(method==='getChatMember'&&params.chat_id===rooms.TELEGRAM_CRYPTO_FUTURES_CHAT_ID)
      return {status:'left'};
    return get(method,params);
  };
  const b=await performSixRoomDelivery(badRoom.params);
  assert.equal(b.classification,'SIX_ROOM_PERMISSION_BLOCKED');
  assert.equal(b.telegramSends,0);
  assert.equal(badRoom.messages.length,0);
});

test('ambiguous send response stops without retrying or falsely claiming complete delivery',async()=>{
  const t=setup();
  let count=0;
  t.params.botSend=async m=>{
    t.messages.push(m);count+=1;
    if(count===3)throw Error('TIMEOUT_UNKNOWN_OUTCOME');
    return {message_id:count};
  };
  const r=await performSixRoomDelivery(t.params);
  assert.equal(r.classification,'PARTIAL_OR_UNKNOWN_DELIVERY');
  assert.equal(r.telegramSends,3);
  assert.equal(r.telegramAccepted,2);
  assert.equal(r.roomResults.CRYPTO_SPOT,'SEND_UNCONFIRMED');
  assert.equal(r.roomResults.CRYPTO_FUTURES,'PREFLIGHT_PASS');
  assert.equal(t.messages.length,3);
  assert.ok(!JSON.stringify(r).includes('TIMEOUT_UNKNOWN_OUTCOME'));
});

test('workflow protects owner, immutable main, single attempt and Production approval',()=>{
  for(const marker of [
    "github.event.issue.number == 1555",
    "github.event.comment.user.login == 'seungjae3908-source'",
    "github.event.comment.author_association == 'OWNER'",
    "environment: production",
    "test \"$GITHUB_RUN_ATTEMPT\" = 1",
    "test \"$GITHUB_SHA\" = \"$TARGET_SHA\"",
    "/run-telegram-sixroom-test-send ",
    "TELEGRAM_SIXROOM_TEST_SEND_EXECUTE=true",
    "PROD_DATABASE_URL:",
    "StrictHostKeyChecking=yes",
    "TELEGRAM_TEST_SANITIZED_EVIDENCE_VALID",
    "TELEGRAM_TEST_SIX_ROOM_DELIVERY_UNCONFIRMED",
    "No automatic retry",
  ].filter(x=>x!=='No automatic retry')){
    assert.ok(workflow.includes(marker),marker);
  }
  assert.ok(!workflow.includes('staging-readiness.yml'));
  for(const forbidden of ['pm2 restart','pm2 reload','pm2 save','ops/deploy-production.sh',
    'setWebhook','withdrawFunds','LIVE_TRADING=true','AUTO_TRADING=true']){
    assert.ok(!workflow.includes(forbidden),forbidden);
  }
  assert.ok(script.includes('telegram_sixroom_prod_config_v1'));
  assert.ok(script.includes('telegram_sixroom_owner_member_id_v1'));
  assert.ok(script.includes("VAULT_SQL"));
  assert.ok(script.includes("method:isPost?'POST':'GET'"));
  assert.ok(script.includes("family:4,autoSelectFamily:false,timeout:15000"));
  assert.ok(!script.includes('console.log(botToken)'));
});

test('initial sanitization never contains secrets',()=>{
  const r=createSanitizedReceipt(sha,sha,sha,true,true);
  assert.equal(r.telegramSends,0);
  assert.equal(r.telegramAccepted,0);
  assert.equal(r.secretValuesRecorded,false);
  assert.equal(JSON.stringify(r).includes(token),false);
  assert.equal(Object.keys(r.roomResults).length,6);
});
