import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertIsolatedTelegramWorkerEnvironment,
  embeddedTelegramWorkersAllowed,
} from './telegram-worker-ownership';

const valid=(): NodeJS.ProcessEnv=>({
  TELEGRAM_WORKER_OWNER:'isolated',
  TELEGRAM_SINGLE_WRITER_LEASE:'LOCK_HELD_V1',
  TELEGRAM_ISOLATED_CUTOVER_APPROVED:'true',
  LIVE_TELEGRAM_ACTIVATION_APPROVED:'true',
  TELEGRAM_INTELLIGENCE_WORKER_ENABLED:'true',
  PERSONAL_TELEGRAM_WORKER_ENABLED:'true',
  TELEGRAM_BOT_TOKEN:'dummy-telegram-token',
  SUPABASE_URL:'https://example.supabase.co',
  SUPABASE_SECRET_KEY:'fake-only',
  TELEGRAM_KR_STOCK_CHAT_ID:'-1001111111111',
  TELEGRAM_US_STOCK_CHAT_ID:'-1002222222222',
  TELEGRAM_CRYPTO_SPOT_CHAT_ID:'-1003333333333',
  TELEGRAM_CRYPTO_FUTURES_CHAT_ID:'-1004444444444',
  TELEGRAM_AUTO_TRADING_CHAT_ID:'-1005555555555',
  TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID:'-1006666666666',
  TELEGRAM_INTELLIGENCE_STATE_PATH:
    '/opt/stock-app/.runtime/telegram-intelligence-delivery-state.json',
  SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH:
    '/opt/stock-app/.runtime/signal-intelligence-telegram-state.json',
  SIGNAL_INTELLIGENCE_AI_WATCH_STATE_PATH:
    '/opt/stock-app/.runtime/signal-ai-watch-delivery-state.json',
});
test('legacy embedded owner remains default unless separately switched',()=>{
 assert.equal(embeddedTelegramWorkersAllowed({}),true);
 assert.equal(embeddedTelegramWorkersAllowed({TELEGRAM_WORKER_OWNER:'embedded'}),true);
 assert.equal(embeddedTelegramWorkersAllowed(valid()),false);
 assert.throws(()=>embeddedTelegramWorkersAllowed({TELEGRAM_WORKER_OWNER:'unsafe'}),
  /TELEGRAM_WORKER_OWNER_INVALID/);
});
test('isolated owner requires explicit cutover, strict immutable paths and six distinct rooms',()=>{
 assert.doesNotThrow(()=>assertIsolatedTelegramWorkerEnvironment(valid()));
 for(const [name,value,code] of [
  ['TELEGRAM_SINGLE_WRITER_LEASE','NOT_HELD','TELEGRAM_ISOLATED_OWNER_OR_LEASE_NOT_APPROVED'],
  ['TELEGRAM_ISOLATED_CUTOVER_APPROVED','false','TELEGRAM_ISOLATED_OWNER_OR_LEASE_NOT_APPROVED'],
  ['LIVE_TELEGRAM_ACTIVATION_APPROVED','false','TELEGRAM_ISOLATED_DELIVERY_FLAGS_INCOMPLETE'],
  ['TELEGRAM_US_STOCK_CHAT_ID','-1001111111111','TELEGRAM_ISOLATED_SIX_ROOM_CONFIG_INVALID'],
  ['TELEGRAM_BOT_TOKEN','','TELEGRAM_ISOLATED_DELIVERY_FLAGS_INCOMPLETE'],
  ['SUPABASE_SECRET_KEY','','TELEGRAM_ISOLATED_PERSONAL_STORAGE_NOT_CONFIGURED'],
  ['SIGNAL_INTELLIGENCE_AI_WATCH_STATE_PATH',
    '/opt/stock-app/.runtime/../replay-ledger.json','TELEGRAM_ISOLATED_LEDGER_PATH_UNVERIFIED'],
  ['TELEGRAM_INTELLIGENCE_STATE_PATH',
    '/opt/stock-app/.runtime/other-brief-ledger.json','TELEGRAM_ISOLATED_LEDGER_PATH_UNVERIFIED'],
 ] as const){
  const env=valid(); env[name]=value;
  assert.throws(()=>assertIsolatedTelegramWorkerEnvironment(env),new RegExp(code),name);
 }
});
test('isolated process refuses all known spot/futures manual LIVE and withdrawal authority',()=>{
 for(const [name,value] of [
  ['LIVE_TRADING','true'], ['AUTO_TRADING','true'],
  ['SPOT_LIVE_LIMITED_ACTIVATION_APPROVED','true'],
  ['FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED','true'],
  ['FUTURES_LIVE_EXECUTION_AUTHORITY','MANUAL'],
  ['executionAuthority','TRADE'],
  ['SPOT_LIVE_MARKET_ALLOWLIST','BTC'],
  ['FUTURES_LIVE_CAPABILITY_ALLOWLIST','trade'],
  ['WITHDRAWAL_ENABLED','true'],
 ] as const){
  const env=valid(); env[name]=value;
  assert.throws(()=>assertIsolatedTelegramWorkerEnvironment(env),
    /TELEGRAM_ISOLATED_WORKER_TRADING_AUTHORITY_FORBIDDEN/,name);
 }
});
