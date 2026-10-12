import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertTradingCoreReceipt } = require('../.github/scripts/production-postdeploy-qa-evidence.cjs');

function fail(code) {
  throw new Error(`[production-telegram-active-readiness] ${code}`);
}

const [mode, file, targetRaw, runIdRaw] = process.argv.slice(2);
if (mode !== '--artifact') fail('USAGE_INVALID');
const targetSha = String(targetRaw ?? '').trim().toLowerCase();
const productionDeployRunId = Number(runIdRaw);
if (!/^[0-9a-f]{40}$/u.test(targetSha)) fail('TARGET_SHA_INVALID');
if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) fail('PRODUCTION_RUN_ID_INVALID');

const value = JSON.parse(readFileSync(path.resolve(String(file ?? '')), 'utf8'));
assertTradingCoreReceipt(value, { targetSha, productionDeployRunId });
if (value?.telegramActivationState !== 'ACTIVE_VERIFIED'
  || value?.telegramActivationReady !== true
  || value?.telegramPersonalActivationRequired !== false
  || value?.telegramUserConnectionRequired !== false
  || value?.telegramConnectedBefore !== true
  || value?.telegramRuntimeReady !== true
  || Number(value?.telegramDeliveryQueued) < 1
  || value?.telegramTestDelivered !== true
  || value?.memberAutoPolicyReady !== true) {
  fail('MEMBER_TELEGRAM_NOT_ACTIVE_VERIFIED');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  targetSha,
  productionDeployRunId,
  telegramActivationState: 'ACTIVE_VERIFIED',
  memberAutoPolicyReady: true,
  zeroFinancialMutation: true,
})}\n`);
