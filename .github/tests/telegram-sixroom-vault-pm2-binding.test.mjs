import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ROOMS,BIND_KEYS,TRADING_BOOLEAN_GATES,TRADING_AUTHORITY_KEYS,
  validateVault,tradingIsOff,flagsUnchanged,bindingValues,
  preflightBinding,runtimeBindingMatches,executeBinding,
} from '../../ops/telegram-sixroom-vault-pm2-binding.mjs';
const script=fs.readFileSync('ops/telegram-sixroom-vault-pm2-binding.mjs','utf8');
const sha='a'.repeat(40);
const oldDeployed='b'.repeat(40);
const runId='37900000001';
const secretMarker='NEVER_PUBLISH_VAULT_OWNER_OR_CHAT_IDS';
const proof={
  rooms:Object.fromEntries(ROOMS.map((key,i)=>[key,'-100'+String(11111111111+i)])),
  owner:'11111111-1111-4111-8111-111111111111',
  ownerVerified:true, roomsUnique:true, ownerUnique:true,
};
const bound=bindingValues(proof);
function runtime(changes={}) {
  return {
    DEPLOY_SHA:oldDeployed, status:'online',
    executionAuthority:'NONE', FUTURES_LIVE_EXECUTION_AUTHORITY:'NONE',
    LIVE_TRADING:'false',AUTO_TRADING:'false',
    REAL_ORDER_ENABLED:'false',PRIVATE_TRADING_API_ALLOWED:'false',
    TELEGRAM_BOT_TOKEN:'123456:ABCDEF1234567890abcdefghijklmnop',
    TELEGRAM_BOT_USERNAME:'test_bot',
    LIVE_TELEGRAM_ACTIVATION_APPROVED:'true',
    TELEGRAM_INTELLIGENCE_WORKER_ENABLED:'true',
    PERSONAL_TELEGRAM_WORKER_ENABLED:'true',
    TELEGRAM_AUTO_TRADING_CHAT_ID:proof.rooms.TELEGRAM_AUTO_TRADING_CHAT_ID,
    ...changes,
  };
}
function baseOptions(change={}) {
  return {
    mode:'plan',mainSha:sha,deployedSha:oldDeployed,
    pm2Sha:oldDeployed,markerSha:oldDeployed,
    pm2Online:true,runtime:runtime(),proof,
    watchEnabled:false,canonicalCwd:true,canonicalEntrypoint:true,
    ...change,
  };
}
function mockSnapshot(rt) {
  return {runtime:rt,pm2Sha:oldDeployed,markerSha:oldDeployed,
    pm2Online:true,watchEnabled:false,
    canonicalCwd:true,canonicalEntrypoint:true};
}
test('Vault must contain six unique supergroup IDs and eligible owner',()=>{
  assert.equal(ROOMS.length,6);
  assert.equal(BIND_KEYS.length,7);
  assert.equal(validateVault(proof),true);
  assert.equal(validateVault({...proof,ownerVerified:false}),false);
  assert.equal(validateVault({...proof,roomsUnique:false}),false);
  assert.equal(validateVault({...proof,owner:'not-a-uuid'}),false);
  assert.equal(validateVault({...proof,rooms:{...proof.rooms,
    TELEGRAM_KR_STOCK_CHAT_ID:proof.rooms.TELEGRAM_US_STOCK_CHAT_ID}}),false);
  assert.equal(validateVault({...proof,rooms:{...proof.rooms,
    TELEGRAM_US_STOCK_CHAT_ID:'-100123'}}),false);
});
test('existing AUTO room preserved and only missing binding KEY NAMES are reported',()=>{
  const receipt=preflightBinding(baseOptions());
  assert.equal(receipt.classification,'BINDING_READY');
  assert.equal(receipt.tradingSafe,true);
  assert.equal(receipt.vaultValid,true);
  assert.equal(receipt.autoRoomPreserved,true);
  assert.equal(receipt.changedKeys.length,6);
  assert.ok(receipt.changedKeys.includes('TELEGRAM_OWNER_MEMBER_ID'));
  assert.ok(!receipt.changedKeys.includes('TELEGRAM_AUTO_TRADING_CHAT_ID'));
  assert.equal(receipt.telegramSends,0);
  assert.equal(receipt.databaseWrites,0);
  assert.equal(receipt.financialMutations,0);
  assert.equal(receipt.secretValuesRecorded,false);
  const json=JSON.stringify(receipt);
  assert.equal(json.includes(proof.owner),false);
  assert.equal(json.includes(proof.rooms.TELEGRAM_KR_STOCK_CHAT_ID),false);
  assert.equal(json.includes(runtime().TELEGRAM_BOT_TOKEN),false);
  assert.equal(preflightBinding(baseOptions({
    runtime:runtime({...bound}),
  })).classification,'ALREADY_BOUND');
});
test('runtime collisions and stale Production identity fail closed',()=>{
  assert.equal(preflightBinding(baseOptions({
    runtime:runtime({TELEGRAM_US_STOCK_CHAT_ID:proof.rooms.TELEGRAM_KR_STOCK_CHAT_ID}),
  })).classification,'EXISTING_BINDING_CONFLICT');
  assert.equal(preflightBinding(baseOptions({
    runtime:runtime({TELEGRAM_AUTO_TRADING_CHAT_ID:proof.rooms.TELEGRAM_KR_STOCK_CHAT_ID}),
  })).classification,'AUTO_ROOM_ID_CONFLICT');
  assert.equal(preflightBinding(baseOptions({pm2Sha:sha}))
    .classification,'PRODUCTION_SHA_MISMATCH');
  assert.equal(preflightBinding(baseOptions({markerSha:sha}))
    .classification,'PRODUCTION_SHA_MISMATCH');
  assert.equal(preflightBinding(baseOptions({watchEnabled:true}))
    .classification,'PM2_RUNTIME_NOT_CANONICAL');
});
test('PM2 restart is prohibited when ANY financial authority is on or malformed',()=>{
  assert.equal(tradingIsOff(runtime()),true);
  for(const key of TRADING_BOOLEAN_GATES) {
    assert.equal(tradingIsOff(runtime({[key]:'true'})),false,key);
    assert.equal(preflightBinding(baseOptions({runtime:runtime({[key]:'true'})}))
      .classification,'FINANCIAL_AUTHORITY_NOT_OFF');
  }
  for(const key of TRADING_AUTHORITY_KEYS) {
    assert.equal(tradingIsOff(runtime({[key]:'LIVE'})),false,key);
  }
  assert.equal(tradingIsOff(runtime({executionAuthority:undefined})),false);
  assert.equal(preflightBinding(baseOptions({
    runtime:runtime({PERSONAL_TELEGRAM_WORKER_ENABLED:'false'}),
  })).classification,'TELEGRAM_WORKER_GATE_INACTIVE');
});
test('PM2 protected financial and Telegram flags cannot silently change',()=>{
  const old=runtime();
  assert.equal(flagsUnchanged(old,{...old,...bound}),true);
  assert.equal(flagsUnchanged(old,{...old,LIVE_TRADING:'true'}),false);
  assert.equal(flagsUnchanged(old,{...old,PERSONAL_TELEGRAM_WORKER_ENABLED:'false'}),false);
  assert.equal(runtimeBindingMatches({...old,...bound},proof),true);
  assert.equal(runtimeBindingMatches(old,proof),false);
});
test('PLAN never writes, restarts, saves or produces Telegram messages',async()=>{
  const flags={restarts:0,saves:0,guards:0};
  const r=await executeBinding({
    mode:'plan',mainSha:sha,deployedSha:oldDeployed,databaseUrl:'private',
    snapshots:()=>mockSnapshot(runtime()),
    vault:()=>proof,
    restart:()=>{flags.restarts++;},
    save:()=>{flags.saves++;},
    guard:()=>{flags.guards++;},
    wait:async()=>true,
  });
  assert.equal(r.classification,'BINDING_READY');
  assert.deepEqual(flags,{restarts:0,saves:0,guards:0});
  assert.equal(r.restartAttempts,0);
});
test('APPLY requires explicit owner authorization, preserving immutable wallet policy',async()=>{
  let restartCalls=0;
  const r=await executeBinding({
    mode:'apply',mainSha:sha,deployedSha:oldDeployed,
    ownerApproved:'false',runId,databaseUrl:'private',
    snapshots:()=>mockSnapshot(runtime()),
    vault:()=>proof,
    restart:()=>{restartCalls++;},
    save:()=>{throw new Error('MUST_NOT_SAVE');},
    wait:async()=>true,
  });
  assert.equal(r.classification,'OWNER_APPLY_APPROVAL_REQUIRED');
  assert.equal(r.restartAttempts,0);
  assert.equal(restartCalls,0);
});
test('approved APPLY runs one PM2 restart and requires post-health and unchanged trading flags',async()=>{
  let started=runtime(),restarts=0,saves=0,guarded=0;
  const r=await executeBinding({
    mode:'apply',mainSha:sha,deployedSha:oldDeployed,runId,
    ownerApproved:'true',databaseUrl:'private',
    snapshots:()=>mockSnapshot(started),
    vault:()=>proof,
    guard:()=>{guarded++;},
    restart:env=>{
      assert.equal(env.PROD_DATABASE_URL,undefined);
      assert.equal(env.TELEGRAM_BINDING_APPLY_APPROVED,undefined);
      assert.equal(env.LIVE_TRADING,'false');
      assert.equal(env.executionAuthority,'NONE');
      restarts++;
      started=runtime(env);
    },
    save:()=>{saves++;},
    wait:async()=>true,
  });
  assert.equal(r.classification,'BINDING_APPLIED_VERIFIED');
  assert.equal(r.restartAttempts,1);
  assert.equal(r.rollbackAttempts,0);
  assert.equal(restarts,1);
  assert.equal(saves,1);
  assert.equal(guarded,1);
  assert.equal(r.pm2Saved,true);
  assert.equal(r.postHealthVerified,true);
  assert.equal(runtimeBindingMatches(started,proof),true);
  assert.equal(r.financialMutations,0);
  assert.equal(r.telegramSends,0);
});
test('ambiguous apply outcome rolls back without repeating or claiming success',async()=>{
  let current=runtime(),restarts=0,saves=0;
  const r=await executeBinding({
    mode:'apply',mainSha:sha,deployedSha:oldDeployed,runId,
    ownerApproved:'true',databaseUrl:'private',
    snapshots:()=>mockSnapshot(current),
    vault:()=>proof,
    guard:()=>{},
    restart:env=>{restarts++;current=runtime(env);},
    save:()=>{saves++;},
    wait:async()=>restarts>1, // first health never validates; rollback does
  });
  assert.equal(r.classification,'APPLY_FAILED_ROLLED_BACK');
  assert.equal(r.restartAttempts,1);
  assert.equal(r.rollbackAttempts,1);
  assert.equal(r.pm2Saved,true);
  assert.equal(restarts,2);
  assert.equal(saves,1);
  assert.equal(current.TELEGRAM_KR_STOCK_CHAT_ID,'');
  assert.equal(current.TELEGRAM_OWNER_MEMBER_ID,'');
  assert.equal(current.TELEGRAM_AUTO_TRADING_CHAT_ID,proof.rooms.TELEGRAM_AUTO_TRADING_CHAT_ID);
});
test('source never writes Vault or issues trading/Telegram requests',()=>{
  for(const prohibited of [
    'sendMessage','setWebhook','ALTER TABLE','INSERT INTO','UPDATE public.',
    'withdrawalRequests','transferRequests',
  ]) {
    assert.ok(!script.includes(prohibited),prohibited);
  }
  assert.ok(script.includes("oneTimeGuard"));
  assert.ok(script.includes("openSync(filename,'wx',0o600)"));
  assert.ok(script.includes("pm2',['restart',PM2_NAME,'--update-env']"));
  assert.ok(script.includes("execFileSync('pm2',['save']"));
  assert.ok(script.includes("VAULT_SQL"));
  assert.ok(script.includes("PGSSLMODE:'require'"));
  assert.ok(script.includes("key.startsWith('GITHUB_')"));
  assert.ok(!script.includes("console.log(runtime)"));
});

test('protected GitHub workflow separates read-only PLAN from risky APPLY approval',()=>{
  const workflow=fs.readFileSync(
    '.github/workflows/telegram-sixroom-vault-pm2-binding.yml','utf8');
  for(const marker of [
    "github.event.issue.number == 1555",
    "github.event.comment.user.login == 'seungjae3908-source'",
    "github.event.comment.author_association == 'OWNER'",
    "environment: production",
    '/run-telegram-sixroom-binding-plan ',
    '/run-telegram-sixroom-binding-apply ',
    "test \"$GITHUB_SHA\" = \"$TARGET_SHA\"",
    'git merge-base --is-ancestor "$DEPLOYED_SHA" origin/main',
    'TELEGRAM_BINDING_APPLY_RETRY_FORBIDDEN',
    'TELEGRAM_BINDING_REQUIRED_CI_6_OF_6_VERIFIED',
    'TELEGRAM_BINDING_STAGING_NOT_READY',
    'STAGING_TELEGRAM_NETWORK_ONLY_PASS',
    'TELEGRAM_BINDING_UNSAFE_RECEIPT',
    'TELEGRAM_BINDING_NOT_READY',
    'TELEGRAM_BINDING_EXECUTE=true',
    "mode === 'apply'",
  ].filter(x=>x!=="mode === 'apply'")){
    assert.ok(workflow.includes(marker),marker);
  }
  for(const forbidden of [
    'sendMessage','setWebhook','pm2 restart','pm2 reload',
    'ops/deploy-production.sh','LIVE_TRADING=true',
    'AUTO_TRADING=true','Replit',
  ]){
    assert.ok(!workflow.includes(forbidden),forbidden);
  }
  assert.ok(workflow.includes("if: steps.command.outputs.mode == 'apply'"));
  assert.ok(workflow.includes("r.mode!==process.argv[5].toUpperCase()"));
  assert.ok(workflow.includes("r.restartAttempts!==0||r.rollbackAttempts!==0"));
  assert.ok(workflow.includes("r.secretValuesRecorded!==false"));
  assert.ok(workflow.includes("Post sanitized binding classification"));
  assert.ok(workflow.includes('flock -n /var/lock/stock-app-deploy.lock node --input-type=module -'));
});
