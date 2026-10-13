import { createHash } from 'node:crypto';
import type { TelegramAlertInput, TelegramAlertResult } from './telegram-notification.service';
import type { TelegramIntelligenceStateStore } from './telegram-intelligence-worker.service';
import { classifyTelegramSubscriberSend } from './signal-intelligence-telegram-subscriber.service';

export type AiWatchDeliveryStatus =
  'ACCEPTED' | 'ALREADY_RESERVED' | 'KNOWN_NO_SEND' | 'UNCONFIRMED';

/** SHA-independent per-source UTC day, to suppress replay after a deploy.
 * A new verified V3 signal can still be reported on another UTC day.
 * Material AI observations are informational, never trade/order approval.
 */
export function aiWatchDurableKey(input: {
  signalId: string; eventType: string; sourceDay: string;
  catalyst: string; technicalChange: string; contradiction: boolean;
}): string {
  if (!input || typeof input.signalId !== 'string'
    || input.signalId.length < 1 || input.signalId.length > 400
    || !['NEW_CANDIDATE', 'RESCAN_REQUESTED'].includes(input.eventType)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.sourceDay)
    || !Number.isFinite(Date.parse(input.sourceDay))
    || new Date(input.sourceDay).toISOString().slice(0,10) !== input.sourceDay
    || !['POSITIVE','NEGATIVE','MIXED','NONE'].includes(input.catalyst)
    || !['BREAKOUT','BREAKDOWN','FAILED_BREAKOUT','VOLUME_ANOMALY','VOLATILITY_EXPANSION','NONE']
      .includes(input.technicalChange)
    || typeof input.contradiction !== 'boolean') {
    throw new Error('TELEGRAM_AI_WATCH_IDENTITY_INVALID');
  }
  const normalized = JSON.stringify([
    'AI_WATCH_DURABLE_V1', input.signalId, input.eventType, input.sourceDay,
    input.catalyst, input.technicalChange, input.contradiction,
  ]);
  return 'telegram-intelligence:ai-watch-v1:'
    + createHash('sha256').update(normalized,'utf8').digest('hex');
}

/** At-most-once attempt: durable UNCONFIRMED reservation is fsynced BEFORE POST.
 * A timeout, crash or unknown outcome is not automatically retried or called SENT.
 */
export async function sendAiWatchWithDurableReceipt(
  store: TelegramIntelligenceStateStore,
  dedupeKey: string,
  alert: TelegramAlertInput,
  now: Date,
  deliver: (input: TelegramAlertInput) => Promise<TelegramAlertResult>,
): Promise<AiWatchDeliveryStatus> {
  if (!/^telegram-intelligence:ai-watch-v1:[0-9a-f]{64}$/.test(dedupeKey)
    || !Number.isFinite(now.getTime())) {
    throw new Error('TELEGRAM_AI_WATCH_SEND_SCOPE_INVALID');
  }
  if (await store.has(dedupeKey) || await store.hasUnconfirmed(dedupeKey))
    return 'ALREADY_RESERVED';
  await store.markUnconfirmed(dedupeKey, now);
  let sent: TelegramAlertResult;
  try {
    sent = await deliver(alert);
  } catch {
    return 'UNCONFIRMED';
  }
  const outcome = classifyTelegramSubscriberSend(sent);
  if (outcome === 'ACCEPTED') {
    await store.markDelivered(dedupeKey, now);
    return 'ACCEPTED';
  }
  if (outcome === 'KNOWN_NO_SEND') {
    await store.releaseExplicitNoSend(dedupeKey, now);
    return 'KNOWN_NO_SEND';
  }
  return 'UNCONFIRMED';
}
