import type { MarketAlert } from './api';
import { evidenceInstant, evidenceRecord } from './server-evidence';

export type NotificationHistoryRow = {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  url: string | null;
  channel: string;
  read_at: string | null;
  created_at: string;
};

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Never allow script/data schemes, protocol-relative hosts or URL credentials. */
export function safeAlertUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (!text(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function historyRow(value: unknown, now: number): value is NotificationHistoryRow {
  return evidenceRecord(value) && text(value.id) && text(value.notification_type)
    && text(value.title) && typeof value.body === 'string' && text(value.channel)
    && safeAlertUrl(value.url) && evidenceInstant(value.created_at, now)
    && (value.read_at === null || (evidenceInstant(value.read_at, now)
      && Date.parse(value.read_at) >= Date.parse(value.created_at)));
}

export function parseNotificationHistory(value: unknown, now = Date.now()): { notifications: NotificationHistoryRow[]; count: number } {
  if (!evidenceRecord(value) || !Array.isArray(value.notifications) || value.notifications.length > 200
    || value.count !== value.notifications.length || !value.notifications.every((row) => historyRow(row, now))) {
    throw new Error('NOTIFICATION_HISTORY_INVALID');
  }
  const rows = value.notifications as NotificationHistoryRow[];
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('NOTIFICATION_HISTORY_INVALID');
  return { notifications: rows, count: rows.length };
}

export function parseNotificationRead(value: unknown, id: string, now = Date.now()): NotificationHistoryRow {
  if (!evidenceRecord(value) || !historyRow(value.notification, now)
    || value.notification.id !== id || value.notification.read_at === null) throw new Error('NOTIFICATION_READ_UNCONFIRMED');
  return value.notification;
}

function marketAlert(value: unknown, kind: MarketAlert['kind'], now: number): value is MarketAlert {
  return evidenceRecord(value) && text(value.id) && text(value.name) && text(value.title)
    && text(value.category) && value.kind === kind && safeAlertUrl(value.url)
    && (value.source === undefined || text(value.source))
    && ['high', 'medium', 'low'].includes(String(value.importance)) && typeof value.importance === 'string'
    && typeof value.ticker === 'string'
    && ((value.market === 'KR' && /^\d{6}$/.test(value.ticker))
      || (value.market === 'US' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value.ticker)))
    && evidenceInstant(value.time, now);
}

export type EvidencedAlert = MarketAlert & { source?: string };
export type EvidencedAlertFeed = { positive: EvidencedAlert[]; negative: EvidencedAlert[] };

export function parseAlertFeed(value: unknown, now = Date.now()): EvidencedAlertFeed {
  if (!evidenceRecord(value) || !Array.isArray(value.positive) || !Array.isArray(value.negative)
    || value.positive.length + value.negative.length > 200
    || !value.positive.every((row) => marketAlert(row, 'positive', now))
    || !value.negative.every((row) => marketAlert(row, 'negative', now))
    || value.dataStatus === 'unavailable' || value.error) throw new Error('ALERT_FEED_INVALID');
  const rows = [...value.positive, ...value.negative] as MarketAlert[];
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('ALERT_FEED_INVALID');
  return { positive: value.positive as MarketAlert[], negative: value.negative as MarketAlert[] };
}

export function alertRelativeTime(iso: string, now = Date.now()): string {
  if (!evidenceInstant(iso, now)) return '시각 미확인';
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}
