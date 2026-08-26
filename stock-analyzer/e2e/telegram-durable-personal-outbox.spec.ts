import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

const migration = source('../api-server/supabase/migrations/2026082701_personal_telegram_generic_outbox.sql');
const repository = source('../api-server/src/features/user-broker-telegram/user-broker-telegram.repository.ts');
const service = source('../api-server/src/features/user-broker-telegram/user-broker-telegram.service.ts');
const worker = source('../api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts');
const personal = source('../api-server/src/services/personal-telegram-alert.service.ts');

test('personal investment alerts reuse notification_deliveries instead of creating a competing queue', () => {
  expect(migration).toContain('alter table public.notification_deliveries');
  expect(migration).toContain("delivery_kind in ('EXECUTION_EVENT', 'PERSONAL_ALERT')");
  expect(migration).toContain('alter column event_id drop not null');
  expect(migration).toContain('add column if not exists payload jsonb');
  expect(migration).not.toMatch(/create table if not exists public\.(?:telegram_)?(?:alert_)?(?:outbox|delivery_queue)/i);
  expect(repository).toContain("delivery.kind ?? 'EXECUTION_EVENT'");
  expect(worker).toContain("from('notification_deliveries')");
});

test('generic outbox preserves the existing server-only privacy boundary', () => {
  expect(migration).toContain('alter table public.notification_deliveries enable row level security');
  expect(migration).toContain('revoke all privileges on table public.notification_deliveries from public, anon, authenticated');
  expect(migration).toContain('grant all privileges on table public.notification_deliveries to service_role');
  expect(personal).toContain('destinationChatId: _destinationChatId');
  expect(personal).not.toContain('telegramChatId: connection.telegramChatId');
  expect(service).toContain('payload: _payload');
});

test('runtime personal alerts are policy-evaluated against durable SENT history before enqueue', () => {
  expect(repository).toContain('listPersonalAlertHistory');
  expect(repository).toContain(".eq('delivery_kind', 'PERSONAL_ALERT')");
  expect(repository).toContain(".eq('state', 'SENT')");
  expect(personal).toContain('evaluateTelegramAlertPolicy(policyState.policy, input.event, history, now)');
  expect(personal).toContain("kind: 'PERSONAL_ALERT'");
  expect(personal).toContain('dedupeKey: `personal-alert:${input.event.eventId}`');
  expect(personal).toContain("state: 'PENDING'");
});

test('injected sender remains a direct deterministic test seam while runtime defaults to the durable queue', () => {
  expect(personal).toContain('if (dependencies.sender)');
  expect(personal).toContain('deliverTelegramAlertWithPolicy');
  expect(personal).toContain('const outboxRepository = dependencies.outboxRepository ?? runtimeRepository');
  expect(personal).toContain('deliveryQueued');
});

test('the existing worker processes personal alerts with the same bounded retry and dead-letter states', () => {
  expect(worker).toContain('sendTelegramAlert');
  expect(service).toContain("if (kind === 'PERSONAL_ALERT')");
  expect(service).toContain('MAX_DELIVERY_ATTEMPTS = 3');
  expect(service).toContain("'RETRY_SCHEDULED' as const");
  expect(service).toContain("'DEAD_LETTER' as const");
  expect(service).toContain('destinationChatId: connection.telegramChatId');
  expect(service).toContain('duplicateWindowMs: 0');
  expect(service).toContain('cooldownMs: 0');
});
