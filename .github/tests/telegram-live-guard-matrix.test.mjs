import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('.github/workflows/telegram-production-release.yml','utf8');
const only = fs.readFileSync('.github/workflows/telegram-production-code-only-deploy.yml','utf8');

function segment(source,start,end) {
  const a=source.indexOf(start);
  const b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,'Expected real protected section '+start);
  return source.slice(a,b);
}
const onlyGate=segment(only,'const tradingKeys=[',"if(env.LIVE_TELEGRAM_ACTIVATION_APPROVED");
const beforeDb=segment(source,'const tradingExecutionFlags = [','if (hasTradingAuthority(env))');
const beforeRestart=segment(source,'const tradingKeys = [','if (fresh?.status');
const flags=[
  'LIVE_TRADING','AUTO_TRADING','REAL_ORDER_ENABLED',
  'PRIVATE_TRADING_API_ALLOWED','ORDER_EXECUTION_ENABLED',
  'LIVE_TRADING_ACTIVATION_APPROVED','SPOT_LIVE_LIMITED_ACTIVATION_APPROVED',
  'LIVE_AUTOMATIC_TRADING_ENABLED','MEMBER_AUTO_TRADING_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED','FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED',
  'BITGET_FUTURES_LIVE_ORDER_ENABLED','CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED',
  'CRYPTO_AUTO_TRADE_ENABLED','BITGET_AUTO_TRADE_ENABLED',
  'BITGET_LIVE_ORDER_ENABLED','UPBIT_LIVE_ORDER_ENABLED',
  'KIWOOM_LIVE_ORDER_ENABLED','TOSS_LIVE_ORDER_ENABLED',
];
const metadata=[
  'executionAuthority','FUTURES_LIVE_EXECUTION_AUTHORITY',
  'SPOT_LIVE_CAPABILITY_ALLOWLIST','SPOT_LIVE_MARKET_ALLOWLIST',
  'FUTURES_LIVE_CAPABILITY_ALLOWLIST','FUTURES_LIVE_MARKET_ALLOWLIST',
];
function declarations(block,name) {
  const match = new RegExp('const '+name+'\\s*=\\s*\\[([\\s\\S]*?)\\];').exec(block);
  assert.ok(match,'Missing '+name);
  return [...match[1].matchAll(/'([A-Z_]+)'/gu)].map(v=>v[1]).sort();
}
function scriptFunction(block,returnExpr) {
  return vm.runInNewContext('(function(env) { '+block+' \n return '+returnExpr+'; })');
}
const codeGate=scriptFunction(onlyGate,'true');
const fullGate=scriptFunction(beforeDb,'hasTradingAuthority(env)');
const activationGate=scriptFunction(beforeRestart,'activeTrading(env)');

test('code-only, pre-DB and pre-restart guards include the exact complete live/Paper flag vocabulary',()=>{
  for(const [block,name] of [
    [onlyGate,'tradingKeys'],[beforeDb,'tradingExecutionFlags'],[beforeRestart,'tradingKeys'],
  ]) {
    assert.deepEqual(declarations(block,name),[...flags].sort());
    for(const field of metadata)assert.ok(block.includes(field),'Missing '+field);
  }
});
test('manual futures authority, hidden allowlists, malformed booleans and provider enablement all veto',()=>{
  const examples=[
    {FUTURES_LIVE_EXECUTION_AUTHORITY:'FUTURES_LIVE_LIMITED'},
    {FUTURES_LIVE_CAPABILITY_ALLOWLIST:'ORDER_CREATE'},
    {FUTURES_LIVE_MARKET_ALLOWLIST:'CRYPTO_FUTURES'},
    {SPOT_LIVE_CAPABILITY_ALLOWLIST:'ORDER_CREATE'},
    {SPOT_LIVE_MARKET_ALLOWLIST:'US_STOCK'},
    {executionAuthority:'SPOT_LIVE_LIMITED'},
    {MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED:'true'},
    {BITGET_LIVE_ORDER_ENABLED:true},
    {LIVE_TRADING:'1'},
    {LIVE_TRADING:'malformed'},
  ];
  for(const state of examples) {
    assert.throws(()=>codeGate(state),/TELEGRAM_PRODUCTION_TRADING_AUTHORITY_ACTIVE/);
    assert.equal(fullGate(state),true);
    assert.equal(activationGate(state),true);
  }
  const inactive={LIVE_TRADING:'false',AUTO_TRADING:'0',
    executionAuthority:'NONE',FUTURES_LIVE_EXECUTION_AUTHORITY:'NONE'};
  assert.equal(codeGate(inactive),true);
  assert.equal(fullGate(inactive),false);
  assert.equal(activationGate(inactive),false);
});
test('both owner-protected checks run before Telegram storage and PM2 mutations',()=>{
  const pre=source.indexOf('Validate complete Telegram runtime and external reachability before any mutation');
  const receipt=source.indexOf('Preflight successful exact-SHA Production Deploy before any Telegram storage write');
  const apply=source.indexOf('Apply and verify Production personal Telegram storage atomically');
  const codePre=only.indexOf('Read-only prior Production PM2 identity and zero-trading gates');
  const codeDeploy=only.indexOf('Deploy exact code using existing canary, PM2 and rollback script');
  assert.ok(pre>=0&&receipt>pre&&apply>receipt);
  assert.ok(codePre>=0&&codeDeploy>codePre);
  for(const workflow of [source,only]) {
    assert.ok(workflow.includes('environment: production'));
    assert.ok(workflow.includes("github.event.comment.author_association == 'OWNER'"));
  }
});
