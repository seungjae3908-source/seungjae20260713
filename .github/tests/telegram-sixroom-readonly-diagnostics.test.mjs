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

test('protected approval never reads same-step outputs and accepts only main-lineage immutable SHAs',()=>{
 const checkout='- uses: actions/checkout@v4\n        with:\n          ref: ${{ github.sha }}\n          fetch-depth: 0';
 assert.ok(workflow.includes(checkout),'immutable checkout with full ancestry');
 const parsed=workflow.indexOf('- name: Parse exact owner diagnostic request');
 const verified=workflow.indexOf('- name: Verify immutable main ancestry after parsing');
 const ssh=workflow.indexOf('- name: Configure Production SSH without exposing credentials');
 assert.ok(parsed>0 && verified>parsed && ssh>verified);
 const parseStep=workflow.slice(parsed,verified);
 const verifyStep=workflow.slice(verified,ssh);
 assert.ok(parseStep.includes('fs.appendFileSync(process.env.GITHUB_OUTPUT'));
 assert.ok(!parseStep.includes('steps.command.outputs.main_sha'),'no same-step output reference');
 assert.ok(verifyStep.includes('EXPECTED_MAIN_SHA: ${{ steps.command.outputs.main_sha }}'));
 assert.ok(verifyStep.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'));
 assert.ok(verifyStep.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'));
 assert.ok(verifyStep.includes('git merge-base --is-ancestor "$EXPECTED_MAIN_SHA" origin/main'));
 assert.ok(!verifyStep.includes('test "$(git rev-parse origin/main)" = "$EXPECTED_MAIN_SHA"'), 'new main commits may not invalidate read-only inspection');
});


test('read-only source audit reports only missing key NAMES present in fixed config files', () => {
 const start=workflow.indexOf('function findMissingKeysInAlternateEnvFiles(');
 const end=workflow.indexOf('const evidence={',start);
 assert.ok(start>0&&end>start);
 const sourceAudit=vm.runInNewContext(workflow.slice(start,end)+'\nfindMissingKeysInAlternateEnvFiles;', {
   fs: {readFileSync: () => {throw new Error('injected read only');}}
 });
 const missing=[
   'TELEGRAM_KR_STOCK_CHAT_ID','TELEGRAM_US_STOCK_CHAT_ID',
   'TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID','TELEGRAM_OWNER_MEMBER_ID'
 ];
 const read=(file)=>{
   if(file==='/opt/stock-app/.env')return [
     '# TELEGRAM_KR_STOCK_CHAT_ID=-100900',
     'export TELEGRAM_US_STOCK_CHAT_ID="-100901"',
     'TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID=',
     'TELEGRAM_OWNER_MEMBER_ID="member-fixture"'
   ].join('\n');
   throw new Error('not found');
 };
 const found=Array.from(sourceAudit(missing,read));
 assert.deepEqual(found,['TELEGRAM_US_STOCK_CHAT_ID','TELEGRAM_OWNER_MEMBER_ID']);
 assert.ok(!JSON.stringify(found).includes('-100901'),'chat values must never enter evidence');
 assert.ok(workflow.includes('missingKeyFoundInEnvFiles:[]'));
 assert.ok(workflow.includes('telegramActivationApproved:false'));
 assert.ok(workflow.includes('personalTelegramWorkerEnabled:false'));
 assert.ok(workflow.includes('Telegram sends / financial mutations: 0 / 0'));
});


test('read-only verdict does not confuse present room config with active Telegram delivery', () => {
 const start=workflow.indexOf('if(!evidence.identityMatch)evidence.classification=');
 const end=workflow.indexOf('\n            }\n          }catch', start);
 assert.ok(start>0&&end>start,'production classification block');
 const classify=vm.runInNewContext('(evidence,rooms)=>{\n'+workflow.slice(start,end)+'\nreturn evidence.classification;\n}');
 const good={
   classification:'OK',identityMatch:true,missingCore:[],backgroundWorkersEnabled:true,
   telegramActivationApproved:true,telegramIntelligenceWorkerEnabled:true,personalTelegramWorkerEnabled:true
 };
 const check=(overrides={},rooms={missing:[],duplicates:[]})=>
   classify({...good,...overrides},rooms);
 assert.equal(check(),'OK');
 assert.equal(check({telegramActivationApproved:false}),'TELEGRAM_ACTIVATION_DISABLED');
 assert.equal(check({telegramIntelligenceWorkerEnabled:false}),'TELEGRAM_MARKET_WORKER_DISABLED');
 assert.equal(check({personalTelegramWorkerEnabled:false}),'TELEGRAM_PERSONAL_WORKER_DISABLED');
 assert.equal(check({backgroundWorkersEnabled:false}),'BACKGROUND_WORKERS_DISABLED');
 assert.equal(check({}, {missing:['TELEGRAM_KR_STOCK_CHAT_ID'],duplicates:[]}), 'SIX_ROOM_CONFIG_MISSING');
 assert.equal(check({}, {missing:[],duplicates:[['a','b']]}), 'SIX_ROOM_ROUTING_COLLISION');
 assert.equal(check({identityMatch:false}), 'PRODUCTION_SHA_MISMATCH');
});
