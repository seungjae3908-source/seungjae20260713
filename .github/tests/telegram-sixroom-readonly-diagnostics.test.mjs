import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const workflow=fs.readFileSync('.github/workflows/telegram-sixroom-readonly-diagnostics.yml','utf8');
const release=fs.readFileSync('.github/workflows/telegram-production-release.yml','utf8');
const start=workflow.indexOf('const sixRoomKeys=[');
const end=workflow.indexOf('const evidence={',start);
assert.ok(start>0 && end>start);
const inspect=vm.runInNewContext(workflow.slice(start,end)+'\ninspectSixRoomBindings;');
const rooms={
 TELEGRAM_KR_STOCK_CHAT_ID:'-10001',TELEGRAM_US_STOCK_CHAT_ID:'-10002',
 TELEGRAM_CRYPTO_SPOT_CHAT_ID:'-10003',TELEGRAM_CRYPTO_FUTURES_CHAT_ID:'-10004',
 TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID:'-10005',TELEGRAM_AUTO_TRADING_CHAT_ID:'-10006',
 TELEGRAM_OWNER_MEMBER_ID:'owner'
};
test('six distinct rooms are complete',()=>{
 const result=inspect(rooms);assert.equal(result.missing.length,0);assert.equal(result.duplicates.length,0);
});
test('legacy stock fallback cannot hide missing dedicated US room',()=>{
 const result=inspect({...rooms,TELEGRAM_US_STOCK_CHAT_ID:'',TELEGRAM_STOCK_CHAT_ID:'-10001'});
 assert.deepEqual(Array.from(result.missing),['TELEGRAM_US_STOCK_CHAT_ID']);
});
test('trimmed room collisions report only variable names',()=>{
 const result=inspect({...rooms,TELEGRAM_AUTO_TRADING_CHAT_ID:' -10005 '});
 assert.deepEqual(Array.from(result.duplicates[0]),['TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID','TELEGRAM_AUTO_TRADING_CHAT_ID']);
 assert.equal(JSON.stringify(result).includes('-10005'),false);
});
test('owner member binding is required for holdings producer',()=>{
 const result=inspect({...rooms,TELEGRAM_OWNER_MEMBER_ID:''});
 assert.deepEqual(Array.from(result.missing),['TELEGRAM_OWNER_MEMBER_ID']);
});
test('production-only SSH, owner identity, protected environment and exact SHAs are required',()=>{
 for(const marker of ['github.event.issue.number == 1555',"github.event.comment.author_association == 'OWNER'",
   'environment: production','EXPECTED_DEPLOY_SHA=','git fetch --no-tags origin main',
   'financialMutationCount:0','telegramSends:0','secretValuesRecorded:false']) {
  assert.ok(workflow.includes(marker),marker);
 }
 for(const forbidden of ['setWebhook','sendMessage','JSON.stringify(runtime)','console.log(runtime)']) {
  assert.ok(!workflow.includes(forbidden),forbidden);
 }
});
test('the release failure logger emits only bounded diagnostic codes',()=>{
 assert.ok(release.includes("['TELEGRAM_SIX_ROOM_CONFIG_MISSING', 'TELEGRAM_SIX_ROOM_ROUTING_COLLISION'].includes(reason)"));
 assert.ok(release.includes('console.error(safeReason);'));
});
