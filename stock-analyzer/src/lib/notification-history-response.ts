const FUTURE_TOLERANCE_MS = 30_000;
const CHANNELS = new Set<NotificationHistoryChannel>(['web', 'push', 'telegram']);

export type NotificationHistoryChannel = 'web' | 'push' | 'telegram';

export type NotificationHistoryRow = {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  url: string | null;
  channel: NotificationHistoryChannel;
  read_at: string | null;
  created_at: string;
};

export type NotificationHistoryResponse = {
  notifications: NotificationHistoryRow[];
  count: number;
};

export class NotificationHistoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationHistoryContractError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotificationHistoryContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new NotificationHistoryContractError(`${label} must be a string`);
  }
  return value;
}

function timestampField(value: unknown, label: string): { iso: string; ms: number } {
  const iso = stringField(value, label);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new NotificationHistoryContractError(`${label} must be a valid timestamp`);
  }
  return { iso, ms };
}

export function parseNotificationHistory(
  input: unknown,
  nowMs = Date.now(),
): NotificationHistoryResponse {
  const envelope = record(input, 'notification history');
  if (!Array.isArray(envelope.notifications)) {
    throw new NotificationHistoryContractError('notification history notifications must be an array');
  }
  if (!Number.isInteger(envelope.count) || (envelope.count as number) < 0) {
    throw new NotificationHistoryContractError('notification history count must be a non-negative integer');
  }
  if (envelope.count !== envelope.notifications.length) {
    throw new NotificationHistoryContractError('notification history count mismatch');
  }

  const notifications = envelope.notifications.map((item, index): NotificationHistoryRow => {
    const row = record(item, `notification history notifications[${index}]`);
    const id = stringField(row.id, `notification history notifications[${index}].id`);
    if (!id.trim()) {
      throw new NotificationHistoryContractError(`notification history notifications[${index}].id must not be empty`);
    }
    const notificationType = stringField(
      row.notification_type,
      `notification history notifications[${index}].notification_type`,
    );
    const title = stringField(row.title, `notification history notifications[${index}].title`);
    const body = stringField(row.body, `notification history notifications[${index}].body`);
    const url = row.url;
    if (url !== null && typeof url !== 'string') {
      throw new NotificationHistoryContractError(`notification history notifications[${index}].url must be null or string`);
    }
    const channel = stringField(row.channel, `notification history notifications[${index}].channel`);
    if (!CHANNELS.has(channel as NotificationHistoryChannel)) {
      throw new NotificationHistoryContractError(`notification history notifications[${index}].channel is invalid`);
    }

    let readAt: string | null;
    if (row.read_at === null) {
      readAt = null;
    } else {
      readAt = timestampField(row.read_at, `notification history notifications[${index}].read_at`).iso;
    }

    const createdAt = timestampField(
      row.created_at,
      `notification history notifications[${index}].created_at`,
    );
    if (createdAt.ms > nowMs + FUTURE_TOLERANCE_MS) {
      throw new NotificationHistoryContractError(`notification history notifications[${index}].created_at is in the future`);
    }

    return {
      id,
      notification_type: notificationType,
      title,
      body,
      url,
      channel: channel as NotificationHistoryChannel,
      read_at: readAt,
      created_at: createdAt.iso,
    };
  });

  return { notifications, count: envelope.count as number };
}
