/** Validates the actually running legacy API's three Telegram worker lanes.
 * Pure local-health policy; never touches orders, private API or Telegram Bot.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const validObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function inspectLegacyTelegramQuiescence(health, expectedSha, nowMs = Date.now()) {
  const fail = () => Object.freeze({ok:false,code:'TELEGRAM_LEGACY_RUNTIME_NOT_QUIESCED'});
  if (!SHA.test(String(expectedSha)) || !Number.isSafeInteger(nowMs) || nowMs <= 0
    || !validObject(health) || health.ok !== true || health.service !== 'api-server'
    || health.identityMatch !== true || health.identityStatus !== 'match'
    || health.deploySha !== expectedSha
    || health.processDeploySha !== expectedSha || health.deployMarkerSha !== expectedSha)
    return fail();
  const at = Date.parse(health.time ?? '');
  if (!Number.isFinite(at) || at > nowMs + 5_000 || nowMs - at > 15_000)
    return fail();
  const personal = health.userTelegramDelivery;
  const briefing = health.telegramIntelligenceWorker;
  const subscriber = health.signalTelegramSubscriber;
  if (!validObject(personal) || !validObject(briefing) || !validObject(subscriber)
    || personal.enabled !== false || personal.lastTickAt !== null
    || briefing.enabled !== false || briefing.state !== 'DISABLED'
    || subscriber.state !== 'DISABLED' || subscriber.inFlight !== 0)
    return fail();
  // This proof is strictly about three Telegram-only lanes; unrelated
  // trading, Paper and recovery workers need not be disabled.
  return Object.freeze({ok:true,code:'TELEGRAM_LEGACY_THREE_LANES_QUIESCED'});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const expectedSha = process.argv[2];
  let health = null;
  try {
    const bytes = readFileSync(0);
    if (bytes.length <= 32_768) health = JSON.parse(bytes.toString('utf8'));
  } catch { /* fail closed without leaking diagnostic bodies */ }
  const receipt = inspectLegacyTelegramQuiescence(health, expectedSha);
  if (receipt.ok) process.stdout.write(receipt.code + '\n');
  else {
    process.stderr.write(receipt.code + '\n');
    process.exitCode = 17;
  }
}
