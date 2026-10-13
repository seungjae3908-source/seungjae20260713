import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const policy = fs.readFileSync('api-server/src/lib/telegram-worker-ownership.ts','utf8');
const entry = fs.readFileSync('api-server/src/telegram-isolated-worker.ts','utf8');
const embedded = fs.readFileSync('api-server/src/index.ts','utf8');
const build = fs.readFileSync('api-server/build.mjs','utf8');
const runner = fs.readFileSync('ops/run-telegram-isolated-worker.sh','utf8');
const qa = fs.readFileSync('.github/workflows/telegram-only-staging-qa.yml','utf8');

test('embedded API is default and existing financial workers are unchanged',()=>{
  assert.match(policy,/owner === 'embedded'/u);
  assert.match(policy,/owner === 'isolated'/u);
  assert.match(policy,/TELEGRAM_WORKER_OWNER_INVALID/u);
  assert.match(embedded,/if \(embeddedTelegramWorkersAllowed\(process\.env\)\)/u);
  for(const lane of [
    'startUserTelegramDeliveryWorker();',
    'startTelegramIntelligenceWorker();',
    'startSignalIntelligenceTelegramSubscriber();',
  ]) assert.ok(embedded.includes(lane));
  for(const other of ['startTradeRecoveryWorker()','startMemberAutoTradingBackgroundWorker()'])
    assert.ok(embedded.includes(other));
});

test('standalone validates six rooms, lease, secrets and zero trading authority before starting',()=>{
  for(const marker of [
    'TELEGRAM_SINGLE_WRITER_LEASE','TELEGRAM_ISOLATED_CUTOVER_APPROVED',
    'TELEGRAM_ISOLATED_WORKER_TRADING_AUTHORITY_FORBIDDEN',
    'FUTURES_LIVE_EXECUTION_AUTHORITY','FUTURES_LIVE_CAPABILITY_ALLOWLIST',
    'SPOT_LIVE_CAPABILITY_ALLOWLIST','TELEGRAM_INTELLIGENCE_STATE_PATH',
    'SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH',
    'TELEGRAM_ISOLATED_SIX_ROOM_CONFIG_INVALID',
    'TELEGRAM_ISOLATED_PERSONAL_STORAGE_NOT_CONFIGURED',
  ])assert.ok(policy.includes(marker),marker);
  assert.ok(entry.indexOf('assertIsolatedTelegramWorkerEnvironment()') <
    entry.indexOf('startUserTelegramDeliveryWorker()'));
  for(const forbidden of [
    'startMemberAutoTradingBackgroundWorker','startTradeRecoveryWorker',
    'startPriceAlertMonitor','app.listen','createServer','placeOrder',
  ])assert.ok(!entry.includes(forbidden),forbidden);
  assert.match(entry,/const keepAlive = setInterval/u);
  assert.match(entry,/clearInterval\(keepAlive\)/u);
  assert.match(build,/telegram-isolated-worker\.mjs/u);
});

test('runner requires old PM2 disabled twice and holds exclusive persistent flock',()=>{
  for(const marker of [
    'set -Eeuo pipefail','umask 077','TELEGRAM_TARGET_SHA',
    'TELEGRAM_LEGACY_WRITER_NOT_QUIESCED',
    'LIVE_TELEGRAM_ACTIVATION_APPROVED',
    'PERSONAL_TELEGRAM_WORKER_ENABLED',
    'TELEGRAM_INTELLIGENCE_WORKER_ENABLED',
    'flock -n 9',
    'TELEGRAM_SINGLE_WRITER_LEASE=LOCK_HELD_V1',
    'TELEGRAM_ISOLATED_RELEASE_IDENTITY_MISMATCH',
    'TELEGRAM_ISOLATED_OWNER_APPROVAL_REQUIRED',
    'sha256sum --check --quiet',
  ]) assert.ok(runner.includes(marker),marker);
  assert.equal(runner.split('legacy_inactive\n').length-1,2,'two real owner probes');
  for(const forbidden of [
    'pm2 restart','pm2 reload','pm2 stop','pm2 delete',
    'psql ','curl ','sendMessage','LIVE_TRADING=true','AUTO_TRADING=true',
  ])assert.ok(!runner.includes(forbidden),forbidden);
  assert.ok(qa.includes('telegram-isolated-worker-contract.test.mjs'));
});
