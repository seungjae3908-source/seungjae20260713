import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
 personalOwnerTestText,validateOwnerPersonalBinding,
 createPersonalTestReceipt,performOwnerPersonalTest,
} from '../../ops/telegram-owner-personal-test-send.mjs';

const SHA='a'.repeat(40),TOKEN='123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop';
const CHAT='123456789',BOT_USERNAME='@owner_test_bot';
const binding=()=>({
 ownerUnique:true,ownerVerified:true,ownerConnections:1,
 allActiveConnections:1,privateChatId:CHAT,telegramUserId:CHAT,
});
function fixture(patch={}){
 const calls=[],messages=[];
 const args={
  mainSha:SHA,pm2Sha:SHA,markerSha:SHA,pm2Online:true,activationApproved:true,
  binding:binding(),botToken:TOKEN,expectedBotUsername:BOT_USERNAME,
  runId:'38499911111',
  botGet:async(method,params)=>{
   calls.push({method,params});
   if(method==='getMe')return {is_bot:true,id:987,username:'owner_test_bot'};
   if(method==='getChat')return {id:Number(CHAT),type:'private'};
   throw Error('unapproved bot GET');
  },
  botSend:async payload=>{
   messages.push(payload);return {message_id:12345,chat:{id:Number(CHAT)}};
  },
  ...patch,
 };
 return {args,calls,messages};
}
test('one approved owner gets exactly one non-trading private message and sanitized receipt',async()=>{
 const x=fixture(),v=await performOwnerPersonalTest(x.args);
 assert.equal(v.classification,'PERSONAL_BOT_API_ACCEPTED');
 assert.equal(v.telegramSends,1);assert.equal(v.telegramAccepted,1);
 assert.equal(x.calls.length,2);
 assert.deepEqual(x.calls.map(z=>z.method),['getMe','getChat']);
 assert.equal(x.messages.length,1);
 assert.equal(x.messages[0].chat_id,CHAT);
 assert.equal(x.messages[0].disable_notification,true);
 assert.equal(x.messages[0].protect_content,true);
 assert.equal(x.messages[0].link_preview_options.is_disabled,true);
 assert.match(x.messages[0].text,/실제 주문·체결/u);
 assert.equal(v.ownerVerified,true);assert.equal(v.privateChatVerified,true);
 assert.equal(v.botIdentityVerified,true);
 assert.equal(v.dbWrites,0);assert.equal(v.connectionMutations,0);
 assert.equal(v.financialMutations,0);assert.equal(v.webhookMutations,0);
 assert.equal(v.secretValuesRecorded,false);
 for(const secret of [TOKEN,CHAT,'PRIVATE_MEMBER_UUID'])assert.ok(!JSON.stringify(v).includes(secret));
});
test('an authorized run produces a clear TEST message, not a trading signal',()=>{
 const msg=personalOwnerTestText('38496644075');
 assert.match(msg,/개인 텔레그램 연결 테스트/u);
 assert.match(msg,/투자 신호·실제 주문·체결·매매 지시가 아닙니다/u);
 assert.match(msg,/38496644075/u);
 assert.throws(()=>personalOwnerTestText('bad'),/TEST_RUN_ID_INVALID/u);
 assert.throws(()=>personalOwnerTestText('0'),/TEST_RUN_ID_INVALID/u);
});
test('other members, groups, unsigned user chat, stale or duplicated owner links all block BEFORE GET',async()=>{
 const invalid=[
  {ownerUnique:false},{ownerVerified:false},{ownerConnections:2},
  {allActiveConnections:2},{privateChatId:'-1001234567890'},
  {telegramUserId:'123456788'},{privateChatId:''},
 ];
 for(const change of invalid){
  const x=fixture({binding:{...binding(),...change}});
  const receipt=await performOwnerPersonalTest(x.args);
  assert.equal(receipt.classification,'PERSONAL_OWNER_BINDING_BLOCKED');
  assert.equal(receipt.telegramSends,0);
  assert.equal(x.calls.length,0);assert.equal(x.messages.length,0);
 }
 assert.equal(validateOwnerPersonalBinding(binding()),true);
 assert.equal(validateOwnerPersonalBinding(null),false);
});
test('PM2 off, deployment SHA mismatch, telegram activation disabled or missing token blocks before post',async()=>{
 const changes=[
  {pm2Online:false},{pm2Sha:'b'.repeat(40)},{markerSha:null},
  {activationApproved:false},{botToken:'missing'},{expectedBotUsername:'??'},
  {mainSha:'bad'},
 ];
 for(const patch of changes){
  const x=fixture(patch);
  const receipt=await performOwnerPersonalTest(x.args);
  assert.equal(receipt.telegramSends,0);
  assert.equal(x.messages.length,0);
  assert.notEqual(receipt.classification,'PERSONAL_BOT_API_ACCEPTED');
 }
});
test('bot identity or wrong Telegram private chat type/id cannot dispatch a send',async()=>{
 const bad=[
  async()=>({is_bot:true,id:987,username:'imposter'}),
  async()=>({is_bot:false,id:987,username:'owner_test_bot'}),
  async()=>null,
 ];
 for(const bot of bad){
  const x=fixture({botGet:async(method,params)=>
   method==='getMe'?bot():{id:Number(CHAT),type:'private'}});
  const r=await performOwnerPersonalTest(x.args);
  assert.equal(r.telegramSends,0);assert.equal(x.messages.length,0);
  assert.equal(r.classification,'BOT_IDENTITY_UNVERIFIED');
 }
 for(const chat of [{type:'supergroup',id:Number(CHAT)},
  {type:'private',id:111111111},null]){
  const x=fixture({botGet:async(method)=>
   method==='getMe'?{is_bot:true,id:987,username:'owner_test_bot'}:chat});
  const r=await performOwnerPersonalTest(x.args);
  assert.equal(r.classification,'PERSONAL_CHAT_UNVERIFIED');
  assert.equal(r.telegramSends,0);assert.equal(x.messages.length,0);
 }
});
test('timeout, thrown error or wrong response chat remains UNKNOWN and never auto-retries',async()=>{
 for(const reply of [
  async()=>{throw Error('TOKEN_IN_ERROR_NEVER_RECORD');},
  async()=>null,
  async()=>({message_id:12,chat:{id:111111111}}),
 ]){
  const x=fixture({botSend:async v=>{x.messages.push(v);return reply();}});
  const r=await performOwnerPersonalTest(x.args);
  assert.equal(r.classification,'PERSONAL_SEND_UNCONFIRMED');
  assert.equal(r.telegramSends,1);
  assert.equal(r.telegramAccepted,0);
  assert.equal(x.messages.length,1);
  assert.ok(!JSON.stringify(r).includes('TOKEN_IN_ERROR'));
 }
});
test('protected one-shot test is read-only in SQL and never mutates link/delivery rows',()=>{
 const src=fs.readFileSync('ops/telegram-owner-personal-test-send.mjs','utf8');
 for(const value of ['BEGIN READ ONLY','default_transaction_read_only=on',
   'telegram_sixroom_owner_member_id_v1','public.telegram_connections',
   't.status=','t.revoked_at IS NULL','allActiveConnections',
   'method===','response.statusCode===200','maxBuffer:16384'])
   assert.ok(src.includes(value),value);
 for(const forbidden of ['pg_dump','INSERT INTO','UPDATE public.','DELETE FROM',
   'revokeTelegramConnection(','pm2 restart','pm2 reload',
   'systemctl start','systemctl restart','LIVE_TRADING=false',
   'AUTO_TRADING=false','withdraw','ordersSubmitted'])
   assert.ok(!src.includes(forbidden),forbidden);
});
