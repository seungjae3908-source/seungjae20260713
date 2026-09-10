import { getSupabase, hasSupabaseServerKey } from '../../lib/supabase';
import { sendTelegramAlert } from '../../services/telegram-notification.service';
import { UserBrokerTelegramService } from './user-broker-telegram.service';
import { createSupabaseUserBrokerTelegramRepository } from './user-broker-telegram.repository';
import { HttpUserTelegramTransport } from './user-broker-telegram.transport';
import type { NotificationDelivery, PortfolioSyncSink, TelegramTransport } from './user-broker-telegram.types';

const noopPortfolioSink: PortfolioSyncSink = { async accept() {} };
const STALE_SENDING_LEASE_MS = 2 * 60 * 1000;

export interface TelegramDeliveryWorkerSource {
  listDue(now: string, limit: number): Promise<Array<Pick<NotificationDelivery, 'userId' | 'id'>>>;
}

export class TelegramDeliveryWorker {
  private running = false;
  constructor(
    private readonly source: TelegramDeliveryWorkerSource,
    private readonly service: UserBrokerTelegramService,
    private readonly batchSize = 50,
  ) {}

  async runOnce(now = new Date()) {
    const result = {
      scanned: 0,
      processed: 0,
      sent: 0,
      retryScheduled: 0,
      deadLetter: 0,
      ordersSubmitted: 0 as const,
      ordersCancelled: 0 as const,
      privateBrokerRequests: 0 as const,
    };
    if (this.running) return result;
    this.running = true;
    try {
      const due = await this.source.listDue(now.toISOString(), this.batchSize);
      result.scanned = due.length;
      for (const item of due) {
        const delivery = await this.service.processDelivery(item.userId, item.id, now);
        if (!delivery.processed) continue;
        result.processed += 1;
        if (delivery.state === 'SENT') result.sent += 1;
        if (delivery.state === 'RETRY_SCHEDULED') result.retryScheduled += 1;
        if (delivery.state === 'DEAD_LETTER') result.deadLetter += 1;
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}

export class SupabaseTelegramDeliveryWorkerSource implements TelegramDeliveryWorkerSource {
  async listDue(now: string, limit: number) {
    if (!hasSupabaseServerKey()) throw new Error('TELEGRAM_WORKER_SERVICE_ROLE_REQUIRED');
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error('TELEGRAM_WORKER_INVALID_TIME');
    const bounded = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50));
    const client = getSupabase();
    const staleBefore = new Date(nowMs - STALE_SENDING_LEASE_MS).toISOString();

    // A process can die after claiming a row but before finishDelivery(). Recover
    // only leases older than the maximum plausible Telegram request window so a
    // normal in-flight send is never stolen by another worker instance.
    const { error: recoveryError } = await client.from('notification_deliveries')
      .update({
        state: 'RETRY_SCHEDULED',
        next_retry_at: now,
        last_error_code: 'STALE_SENDING_RECOVERED',
        updated_at: now,
      })
      .eq('state', 'SENDING')
      .lte('updated_at', staleBefore);
    if (recoveryError) throw new Error('TELEGRAM_WORKER_STORAGE_UNAVAILABLE');

    const { data, error } = await client.from('notification_deliveries')
      .select('user_id,id')
      .in('state', ['PENDING', 'RETRY_SCHEDULED', 'FAILED'])
      .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
      .order('created_at', { ascending: true })
      .limit(bounded);
    if (error) throw new Error('TELEGRAM_WORKER_STORAGE_UNAVAILABLE');
    return (data ?? []).map((row) => ({ userId: String(row.user_id), id: String(row.id) }));
  }
}

export type TelegramWorkerControl = { worker: TelegramDeliveryWorker; stop: () => void };

function boundedInterval(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 10_000 && parsed <= 300_000 ? parsed : 30_000;
}

export function startUserTelegramDeliveryWorker(
  transportOverride?: TelegramTransport,
): TelegramWorkerControl | null {
  if (process.env.PERSONAL_TELEGRAM_WORKER_ENABLED !== 'true'
    || process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true') {
    console.log('[user-telegram-worker] disabled; explicit worker and activation gates are required');
    return null;
  }
  if (!hasSupabaseServerKey()) {
    console.error('[user-telegram-worker] blocked: service-role Supabase configuration is required');
    return null;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!transportOverride && !token) {
    console.error('[user-telegram-worker] blocked: Telegram bot token is not configured');
    return null;
  }
  const transport = transportOverride ?? new HttpUserTelegramTransport(token!);
  const repository = createSupabaseUserBrokerTelegramRepository();
  const service = new UserBrokerTelegramService(
    repository,
    transport,
    noopPortfolioSink,
    process.env.TELEGRAM_BOT_USERNAME?.trim() || null,
    sendTelegramAlert,
  );
  const worker = new TelegramDeliveryWorker(new SupabaseTelegramDeliveryWorkerSource(), service);
  const tick = () => void worker.runOnce().catch((error) => {
    console.error('[user-telegram-worker] delivery tick failed', { code: error instanceof Error ? error.message : 'UNKNOWN' });
  });
  const timer = setInterval(tick, boundedInterval(process.env.PERSONAL_TELEGRAM_WORKER_INTERVAL_MS));
  timer.unref?.();
  tick();
  return { worker, stop: () => clearInterval(timer) };
}
