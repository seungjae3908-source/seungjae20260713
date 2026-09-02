import { randomUUID } from 'node:crypto';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  TELEGRAM_POLICY_MARKETS,
  TELEGRAM_POLICY_PRIORITIES,
  TELEGRAM_POLICY_SIGNAL_TYPES,
  type TelegramPolicyDeliveryHistory,
  type TelegramPolicyEvent,
} from './telegram-alert-policy.service';
import type { StoredPersonalTelegramAlert } from '../features/user-broker-telegram/user-broker-telegram.types';

const MAX_DIGEST_HISTORY_ROWS = 256;
const MAX_DIGEST_ITEMS = 20;

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

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw storageError();
  const normalized = value.trim();
  if (!normalized) throw storageError();
  return normalized;
}

function validTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw storageError();
  return timestamp;
}

function assertValidEvent(event: TelegramPolicyEvent, userId: string): void {
  if (!event || typeof event !== 'object' || event.userId !== userId) throw storageError();
  requiredString(event.eventId);
  validTimestamp(event.occurredAt);
  if (!isOneOf(event.signalType, TELEGRAM_POLICY_SIGNAL_TYPES)) throw storageError();
  if (!isOneOf(event.priority, TELEGRAM_POLICY_PRIORITIES)) throw storageError();
  if (event.market != null && !isOneOf(event.market, TELEGRAM_POLICY_MARKETS)) throw storageError();
  if (event.symbol != null && typeof event.symbol !== 'string') throw storageError();
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

export function parsePersonalTelegramDigestHistoryEvent(
  value: unknown,
  userId: string,
  deliveredAt: string,
): TelegramPolicyDeliveryHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError();
  const event = value as Record<string, unknown>;
  if (requiredString(event.userId) !== userId) throw storageError();
  const eventId = requiredString(event.eventId);
  const signalType = event.signalType;
  const priority = event.priority;
  const market = event.market;
  if (!isOneOf(signalType, TELEGRAM_POLICY_SIGNAL_TYPES)) throw storageError();
  if (!isOneOf(priority, TELEGRAM_POLICY_PRIORITIES)) throw storageError();
  if (market != null && !isOneOf(market, TELEGRAM_POLICY_MARKETS)) throw storageError();
  const symbol = event.symbol == null ? undefined : requiredString(event.symbol);
  validTimestamp(event.occurredAt);
  return {
    userId,
    eventId,
    market: market ?? undefined,
    signalType,
    priority,
    symbol,
    deliveredAt: validTimestamp(deliveredAt),
  };
}

export function parsePersonalTelegramDigestAppendRow(value: unknown): {
  accepted: boolean;
  deliveryId: string;
  itemCount: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError();
  const row = value as Record<string, unknown>;
  if (typeof row.accepted !== 'boolean') throw storageError();
  const deliveryId = requiredString(row.delivery_id);
  const itemCount = row.item_count;
  if (typeof itemCount !== 'number' || !Number.isInteger(itemCount) || itemCount < 1 || itemCount > MAX_DIGEST_ITEMS) {
    throw storageError();
  }
  return { accepted: row.accepted, deliveryId, itemCount };
}

export class SupabasePersonalTelegramDigestRepository implements PersonalTelegramDigestRepository {
  async append(input: PersonalTelegramDigestAppendInput) {
    if (!hasSupabaseServerKey() || input.event.userId !== input.userId) throw storageError();
    assertValidEvent(input.event, input.userId);
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
    if (error || !Array.isArray(data) || data.length !== 1) throw storageError();
    const parsed = parsePersonalTelegramDigestAppendRow(data[0]);
    return {
      accepted: parsed.accepted,
      deliveryId: parsed.deliveryId,
      itemCount: parsed.itemCount,
      dueAt: window.dueAt,
      dedupeKey: window.dedupeKey,
    };
  }

  async listSentHistory(userId: string, since: string, limit = MAX_DIGEST_HISTORY_ROWS) {
    if (!hasSupabaseServerKey()) throw storageError();
    validTimestamp(since);
    const bounded = Math.min(512, Math.max(1, Number.isInteger(limit) ? limit : MAX_DIGEST_HISTORY_ROWS));
    const { data, error } = await getSupabase().from('notification_deliveries')
      .select('payload,updated_at')
      .eq('user_id', userId)
      .eq('delivery_kind', 'PERSONAL_ALERT')
      .eq('state', 'SENT')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(bounded);
    if (error || !Array.isArray(data)) throw storageError();

    const history: TelegramPolicyDeliveryHistory[] = [];
    const seen = new Set<string>();
    for (const row of data) {
      const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown>
        : null;
      if (!payload || payload.digestMode !== 'BATCHED') continue;
      if (!Array.isArray(payload.digestEvents)) throw storageError();
      const deliveredAt = validTimestamp(row.updated_at);
      for (const value of payload.digestEvents) {
        const item = parsePersonalTelegramDigestHistoryEvent(value, userId, deliveredAt);
        if (seen.has(item.eventId)) continue;
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
    assertValidEvent(input.event, input.userId);
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
    if (row.state !== 'PENDING' || row.events.some((event) => event.eventId === input.event.eventId) || row.events.length >= MAX_DIGEST_ITEMS) {
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
    row.deliveredAt = validTimestamp(deliveredAt);
    return true;
  }

  async listSentHistory(userId: string, since: string, limit = MAX_DIGEST_HISTORY_ROWS) {
    validTimestamp(since);
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
