import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  InMemoryPersonalTelegramDigestRepository,
} from '../../api-server/src/services/personal-telegram-digest.repository';
import { deliverPersonalTelegramAlert } from '../../api-server/src/services/personal-telegram-alert.service';
import {
  defaultTelegramAlertPolicy,
  type TelegramPolicyEvent,
} from '../../api-server/src/services/telegram-alert-policy.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function event(eventId: string, occurredAt: string): TelegramPolicyEvent {
  return {
    userId: USER_ID,
    eventId,
    market: 'KR',
    signalType: 'BUY',
    priority: 'IMPORTANT',
    symbol: '005930',
    occurredAt,
  };
}

function batchedPolicy() {
  return {
    ...defaultTelegramAlertPolicy(USER_ID),
    enabled: true,
    cooldownMs: 0,
    sameEventDedupeMs: 24 * 60 * 60_000,
    sameSymbolWindowMs: 60 * 60_000,
    sameSymbolRepeatLimit: 10,
    deliveryMode: 'BATCHED' as const,
    digest: { enabled: true, windowMs: 15 * 60_000 },
  };
}

function dependencies(digestRepository: InMemoryPersonalTelegramDigestRepository) {
  return {
    connectionRepository: {
      async getTelegramConnection() {
        return {
          userId: USER_ID,
          telegramChatId: 'linked-chat-only',
          telegramUserId: 'linked-user-only',
          status: 'ACTIVE' as const,
          connectedAt: '2026-08-27T00:00:00.000Z',
          revokedAt: null,
          updatedAt: '2026-08-27T00:00:00.000Z',
        };
      },
    },
    policyRepository: {
      async getPolicy() {
        return { policy: batchedPolicy(), source: 'STORED' as const };
      },
    },
    outboxRepository: {
      async enqueueDelivery() { throw new Error('IMMEDIATE_OUTBOX_MUST_NOT_BE_USED'); },
      async listPersonalAlertHistory() { return []; },
    },
    digestRepository,
  };
}

test('BATCHED policy appends two events to one durable digest window without contacting Telegram', async () => {
  const digestRepository = new InMemoryPersonalTelegramDigestRepository();
  const deps = dependencies(digestRepository);

  const first = await deliverPersonalTelegramAlert({
    userId: USER_ID,
    event: event('event-a', '2026-08-27T00:02:00.000Z'),
    alert: { type: 'strong_buy', symbol: '005930', market: 'KR', details: 'Scanner BUY 근거 A' },
    now: new Date('2026-08-27T00:02:00.000Z'),
  }, deps);
  const second = await deliverPersonalTelegramAlert({
    userId: USER_ID,
    event: event('event-b', '2026-08-27T00:03:00.000Z'),
    alert: { type: 'strong_buy', symbol: '005930', market: 'KR', details: 'Scanner BUY 근거 B' },
    now: new Date('2026-08-27T00:03:00.000Z'),
  }, deps);

  expect(first.status).toBe('POLICY');
  expect(second.status).toBe('POLICY');
  if (first.status !== 'POLICY' || second.status !== 'POLICY') return;
  expect(first.policy.decision.action).toBe('BATCHED');
  expect(second.policy.decision.action).toBe('BATCHED');
  expect(first.deliveryQueued).toBe(true);
  expect(second.deliveryQueued).toBe(true);
  expect(first.deliveryId).toBe(second.deliveryId);
  expect(first.digestItemCount).toBe(1);
  expect(second.digestItemCount).toBe(2);
  expect(first.digestDueAt).toBe('2026-08-27T00:15:00.000Z');
  expect(second.digestDueAt).toBe(first.digestDueAt);
  expect(first.policy.transport).toBeNull();
  expect(second.policy.transport).toBeNull();
});

test('same event cannot be appended twice to one digest and sent digest history contains every item', async () => {
  const repository = new InMemoryPersonalTelegramDigestRepository();
  const input = {
    userId: USER_ID,
    event: event('same-event', '2026-08-27T00:02:00.000Z'),
    alert: { type: 'strong_buy' as const, symbol: '005930', details: 'same event' },
    now: new Date('2026-08-27T00:02:00.000Z'),
    windowMs: 15 * 60_000,
  };
  const first = await repository.append(input);
  const duplicate = await repository.append({ ...input, now: new Date('2026-08-27T00:03:00.000Z') });
  expect(first.accepted).toBe(true);
  expect(duplicate.accepted).toBe(false);
  expect(duplicate.deliveryId).toBe(first.deliveryId);
  expect(duplicate.itemCount).toBe(1);

  expect(repository.markSent(USER_ID, first.dedupeKey, '2026-08-27T00:15:01.000Z')).toBe(true);
  const history = await repository.listSentHistory(USER_ID, '2026-08-27T00:00:00.000Z');
  expect(history).toHaveLength(1);
  expect(history[0].eventId).toBe('same-event');
  expect(history[0].deliveredAt).toBe('2026-08-27T00:15:01.000Z');
});

test('digest migration atomically reuses the personal outbox and stays service-role only', () => {
  const migration = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/supabase/migrations/2026082703_personal_telegram_digest_outbox.sql'),
    'utf8',
  );
  expect(migration).toContain('create or replace function public.append_personal_telegram_digest_item');
  expect(migration).toContain('from public.notification_deliveries');
  expect(migration).toContain('for update');
  expect(migration).toContain("current_row.delivery_kind <> 'PERSONAL_ALERT'");
  expect(migration).toContain("current_row.state <> 'PENDING'");
  expect(migration).toContain('current_count >= 20');
  expect(migration).toContain("where value->>'eventId' = event_id");
  expect(migration).toContain("'digestMode', 'BATCHED'");
  expect(migration).toContain("'PENDING', 0, p_window_end");
  expect(migration).toContain('security definer');
  expect(migration).toContain('revoke all on function public.append_personal_telegram_digest_item');
  expect(migration).toContain('to service_role');
  expect(migration).not.toContain('telegram_chat_id');
  expect(migration).not.toContain('account_number');
  expect(migration).not.toContain('order_id');
});

test('existing worker due-time contract delays a digest until its window closes and keeps activation gated', () => {
  const worker = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts'),
    'utf8',
  );
  const service = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/src/features/user-broker-telegram/user-broker-telegram.service.ts'),
    'utf8',
  );
  expect(worker).toContain(".or(`next_retry_at.is.null,next_retry_at.lte.${now}`)");
  expect(worker).toContain("process.env.PERSONAL_TELEGRAM_WORKER_ENABLED !== 'true'");
  expect(worker).toContain("process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true'");
  expect(service).toContain('if (kind === \'PERSONAL_ALERT\')');
  expect(service).toContain('destinationChatId: connection.telegramChatId');
  expect(service).not.toContain("orderAuthority: 'EXECUTE'");
});
