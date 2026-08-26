import { randomUUID } from 'node:crypto';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import type {
  TelegramPolicyDeliveryHistory,
  TelegramPolicyEvent,
} from './telegram-alert-policy.service';
import type { StoredPersonalTelegramAlert } from '../features/user-broker-telegram/user-broker-telegram.types';

const MAX_DIGEST_HISTORY_ROWS = 256;

export type PersonalTelegramDigestAppendInput = {
  userId: string;
  event: TelegramPolicyEvent;
  alert: StoredPersonalTelegramAlert;
  now: Date;
  windowMs: number;
};

export type PersonalTelegramDigestAppendResult = {
  accepted: boolean;
  deliveryId: string | null;
  itemCount: number;
  dueAt: string;
  dedupeKey: string;
};

export interface PersonalTelegramDigestRepository {
  append(input: PersonalTelegramDigestAppendInput): Promise<PersonalTelegramDigestAppendResult>;
  listSentHistory(userId: string, since: string, limit?: number): Promise<TelegramPolicyDeliveryHistory[]>;
}

function storageError(): Error {
  return new Error('USER_BROKER_TELEGRAM_STORAGE_UNAVAILABLE');
}

function validWindow(windowMs: number): boolean {
  return Number.isFinite(windowMs) && windowMs > 0 && windowMs <= 7 * 24 * 60 * 60 * 1000;
}

function normalizedSummary(event: TelegramPolicyEvent, alert: StoredPersonalTelegramAlert): string {
  const details = String(alert.details ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return [
    `[${event.priority}]`,
    event.market ?? 'GLOBAL',
    event.signalType,
    event.symbol?.normalize('NFKC').trim().toUpperCase().slice(0, 32) || '-',
    details || '세부내용 N/A',
  ].join(' · ').slice(0, 180);
}

function windowFor(now: Date, windowMs: number) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !validWindow(windowMs)) throw storageError();
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  if (endMs <= nowMs) throw storageError();
  return {
    startMs,
    dueAt: new Date(endMs).toISOString(),
    dedupeKey: `personal-digest:${windowMs}:${startMs}`,
  };
}

function historyFromEvent(value: unknown, userId: string, deliveredAt: string): TelegramPolicyDeliveryHistory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (String(event.userId ?? '') !== userId) return null;
  const eventId = String(event.eventId ?? '').trim();
  const signalType = String(event.signalType ?? '').trim() as TelegramPolicyDeliveryHistory['signalType'];
  const priority = String(event.priority ?? '').trim() as TelegramPolicyDeliveryHistory['priority'];
  if (!eventId || !signalType || !priority) return null;
  return {
    userId,
    eventId,
    market: event.market == null ? undefined : String(event.market) as TelegramPolicyDeliveryHistory['market'],
    signalType,
    priority,
    symbol: event.symbol == null ? undefined : String(event.symbol),
    deliveredAt,
  };
}

export class SupabasePersonalTelegramDigestRepository implements PersonalTelegramDigestRepository {
  async append(input: PersonalTelegramDigestAppendInput) {
    if (!hasSupabaseServerKey() || input.event.userId !== input.userId) throw storageError();
    const window = windowFor(input.now, input.windowMs);
    const deliveryId = randomUUID();
    const { data, error } = await getSupabase().rpc('append_personal_telegram_digest_item', {
      p_user_id: input.userId,
      p_delivery_id: deliveryId,
      p_dedupe_key: window.dedupeKey,
      p_window_end: window.dueAt,
      p_event: structuredClone(input.event),
      p_summary: normalizedSummary(input.event, input.alert),
      p_created_at: input.now.toISOString(),
    });
    if (error || !Array.isArray(data) || !data.length) throw storageError();
    const row = data[0] as Record<string, unknown>;
    return {
      accepted: row.accepted === true,
      deliveryId: row.delivery_id ? String(row.delivery_id) : null,
      itemCount: Number.isInteger(Number(row.item_count)) ? Number(row.item_count) : 0,
      dueAt: window.dueAt,
      dedupeKey: window.dedupeKey,
    };
  }

  async listSentHistory(userId: string, since: string, limit = MAX_DIGEST_HISTORY_ROWS) {
    if (!hasSupabaseServerKey()) throw storageError();
    const bounded = Math.min(512, Math.max(1, Number.isInteger(limit) ? limit : MAX_DIGEST_HISTORY_ROWS));
    const { data, error } = await getSupabase().from('notification_deliveries')
      .select('payload,updated_at')
      .eq('user_id', userId)
      .eq('delivery_kind', 'PERSONAL_ALERT')
      .eq('state', 'SENT')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(bounded);
    if (error) throw storageError();

    const history: TelegramPolicyDeliveryHistory[] = [];
    const seen = new Set<string>();
    for (const row of data ?? []) {
      const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown>
        : null;
      if (!payload || payload.digestMode !== 'BATCHED' || !Array.isArray(payload.digestEvents)) continue;
      const deliveredAt = String(row.updated_at ?? '');
      for (const value of payload.digestEvents) {
        const item = historyFromEvent(value, userId, deliveredAt);
        if (!item || seen.has(item.eventId)) continue;
        seen.add(item.eventId);
        history.push(item);
        if (history.length >= bounded) return history;
      }
    }
    return history;
  }
}

export class InMemoryPersonalTelegramDigestRepository implements PersonalTelegramDigestRepository {
  private rows = new Map<string, {
    deliveryId: string;
    dueAt: string;
    events: TelegramPolicyEvent[];
    summaries: string[];
    state: 'PENDING' | 'SENT';
    deliveredAt: string | null;
  }>();

  async append(input: PersonalTelegramDigestAppendInput) {
    if (input.event.userId !== input.userId) throw storageError();
    const window = windowFor(input.now, input.windowMs);
    const key = `${input.userId}:${window.dedupeKey}`;
    let row = this.rows.get(key);
    if (!row) {
      row = {
        deliveryId: randomUUID(),
        dueAt: window.dueAt,
        events: [],
        summaries: [],
        state: 'PENDING',
        deliveredAt: null,
      };
      this.rows.set(key, row);
    }
    if (row.state !== 'PENDING' || row.events.some((event) => event.eventId === input.event.eventId) || row.events.length >= 20) {
      return { accepted: false, deliveryId: row.deliveryId, itemCount: row.events.length, dueAt: row.dueAt, dedupeKey: window.dedupeKey };
    }
    row.events.push(structuredClone(input.event));
    row.summaries.push(normalizedSummary(input.event, input.alert));
    return { accepted: true, deliveryId: row.deliveryId, itemCount: row.events.length, dueAt: row.dueAt, dedupeKey: window.dedupeKey };
  }

  markSent(userId: string, dedupeKey: string, deliveredAt: string) {
    const row = this.rows.get(`${userId}:${dedupeKey}`);
    if (!row) return false;
    row.state = 'SENT';
    row.deliveredAt = deliveredAt;
    return true;
  }

  async listSentHistory(userId: string, since: string, limit = MAX_DIGEST_HISTORY_ROWS) {
    const bounded = Math.min(512, Math.max(1, Number.isInteger(limit) ? limit : MAX_DIGEST_HISTORY_ROWS));
    return [...this.rows.entries()]
      .filter(([key, row]) => key.startsWith(`${userId}:`) && row.state === 'SENT' && row.deliveredAt && row.deliveredAt >= since)
      .flatMap(([, row]) => row.events.map((event) => ({
        userId,
        eventId: event.eventId,
        market: event.market,
        signalType: event.signalType,
        priority: event.priority,
        symbol: event.symbol,
        deliveredAt: row.deliveredAt!,
      })))
      .slice(0, bounded);
  }
}

export function createSupabasePersonalTelegramDigestRepository(): PersonalTelegramDigestRepository {
  return new SupabasePersonalTelegramDigestRepository();
}
