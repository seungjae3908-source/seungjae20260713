import { readFileSync } from 'node:fs';
import path from 'node:path';

function fail(code) {
  throw new Error(`[production-telegram-runtime-readiness] ${code}`);
}

const [mode, file, targetRaw, runIdRaw] = process.argv.slice(2);
if (mode !== '--artifact') fail('USAGE_INVALID');
const targetSha = String(targetRaw ?? '').trim().toLowerCase();
const productionDeployRunId = Number(runIdRaw);
if (!/^[0-9a-f]{40}$/u.test(targetSha)) fail('TARGET_SHA_INVALID');
if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
  fail('PRODUCTION_RUN_ID_INVALID');
}

const value = JSON.parse(readFileSync(path.resolve(String(file ?? '')), 'utf8'));
const zeroMutationKeys = [
  'orderRequests',
  'cancelRequests',
  'amendRequests',
  'transferRequests',
  'withdrawalRequests',
  'financialMutationCount',
  'privateTradingApiCount',
];
if (value?.schemaVersion !== 'production-telegram-runtime-readiness-v1'
  || value?.status !== 'ACTIVE_VERIFIED'
  || value?.targetSha !== targetSha
  || Number(value?.productionDeployRunId) !== productionDeployRunId
  || value?.identityMatch !== true
  || value?.workerStarted !== true
  || value?.personalWorkerStarted !== true
  || value?.signalSubscriberStarted !== true
  || value?.telegramConfigured !== true
  || value?.telegramBotIdentityVerified !== true
  || value?.telegramRoomsVerified !== true
  || value?.telegramWebhookVerified !== true
  || value?.telegramRoomDeliveryVerified !== true
  || value?.autoTradingRoomVerified !== true
  || value?.memberLinkRequiredForRuntimeActivation !== false
  || value?.telegramAccepted !== true
  || value?.telegramEditInPlaceAccepted !== true
  || value?.orderSubmitted !== false
  || value?.liveTradingAuthorityGranted !== false
  || value?.autoTradingAuthorityGranted !== false
  || value?.secretValuesRecorded !== false
  || zeroMutationKeys.some((key) => Number(value?.[key]) !== 0)) {
  fail('TELEGRAM_RUNTIME_NOT_ACTIVE_VERIFIED');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  targetSha,
  productionDeployRunId,
  telegramRuntimeState: 'ACTIVE_VERIFIED',
  autoTradingRoomVerified: true,
  memberConnectionIndependent: true,
  zeroFinancialMutation: true,
})}\n`);
