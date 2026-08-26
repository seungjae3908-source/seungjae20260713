import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ScannerAlertCandidate, ScannerSignalCard } from '../../api-server/src/services/scanner-signal.types';
import { InMemoryTelegramSignalFollowupRepository } from '../../api-server/src/services/telegram-signal-followup.repository';
import {
  clearTelegramSignalFollowupState,
  deliverScannerTelegramFollowups,
  markTelegramSignalAnnounced,
} from '../../api-server/src/services/telegram-signal-followup.service';

function announcedAlert(): ScannerAlertCandidate {
  return {
    signalId: 'signal-restart-safe-1',
    expiresAt: '2026-08-28T00:00:00.000Z',
  } as unknown as ScannerAlertCandidate;
}

function followupCard(price = 105): ScannerSignalCard {
  return {
    signalId: 'signal-restart-safe-1',
    assetClass: 'stock',
    direction: 'LONG',
    symbol: '005930',
    market: 'KR',
    price,
    signalState: 'APPROVAL_PENDING',
    pricePlan: {
      entryZone: { from: 100, to: 102 },
      invalidation: 89,
      stopLoss: 90,
      targets: [105, 110, 115],
      riskReward: 2,
    },
  } as unknown as ScannerSignalCard;
}

async function withFollowupEnv(run: () => Promise<void>) {
  const previousEnabled = process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED;
  const previousRoom = process.env.TELEGRAM_STOCK_CHAT_ID;
  process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED = 'true';
  process.env.TELEGRAM_STOCK_CHAT_ID = 'stock-room-test';
  try {
    await run();
  } finally {
    if (previousEnabled == null) delete process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED;
    else process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED = previousEnabled;
    if (previousRoom == null) delete process.env.TELEGRAM_STOCK_CHAT_ID;
    else process.env.TELEGRAM_STOCK_CHAT_ID = previousRoom;
    clearTelegramSignalFollowupState();
  }
}

test('announced signal survives process-memory reset and TP followup is not duplicated after a second restart', async () => {
  await withFollowupEnv(async () => {
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(), 1_000, repository);

    clearTelegramSignalFollowupState(); // simulate API process restart
    const messages: string[] = [];
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async (input) => {
        messages.push(input.details ?? '');
        return { ok: true, attempts: 1 };
      },
      2_000,
      repository,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('TP1 가격 기준 도달');
    expect(messages[0]).toContain('체결을 의미하지 않습니다.');

    clearTelegramSignalFollowupState(); // second process restart
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async (input) => {
        messages.push(input.details ?? '');
        return { ok: true, attempts: 1 };
      },
      3_000,
      repository,
    );
    expect(messages).toHaveLength(1);
  });
});

test('failed Telegram followup restores the prior durable checkpoint so the event remains retryable', async () => {
  await withFollowupEnv(async () => {
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(), 1_000, repository);
    clearTelegramSignalFollowupState();

    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => ({ ok: false, attempts: 1, skipped: 'DELIVERY_FAILED' }),
      2_000,
      repository,
    );

    clearTelegramSignalFollowupState();
    let retried = 0;
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => {
        retried += 1;
        return { ok: true, attempts: 1 };
      },
      3_000,
      repository,
    );
    expect(retried).toBe(1);
  });
});

test('durable lifecycle migration is server-only and stores no member or trading authority fields', () => {
  const migration = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/supabase/migrations/2026082702_telegram_signal_followup_ledger.sql'),
    'utf8',
  );
  expect(migration).toContain('create table if not exists public.telegram_signal_followup_ledger');
  expect(migration).toContain('alter table public.telegram_signal_followup_ledger enable row level security');
  expect(migration).toContain('revoke all privileges on table public.telegram_signal_followup_ledger from public, anon, authenticated');
  expect(migration).toContain('grant all privileges on table public.telegram_signal_followup_ledger to service_role');
  expect(migration).not.toContain('user_id');
  expect(migration).not.toContain('telegram_chat_id');
  expect(migration).not.toContain('order_id');
  expect(migration).not.toContain('account_id');
});

test('initial public-room alert awaits durable lifecycle checkpoint and never grants trading authority', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/src/services/scanner-telegram-delivery.service.ts'),
    'utf8',
  );
  expect(source).toContain('await markTelegramSignalAnnounced(alert);');
  expect(source).not.toContain('ordersSubmitted: 1');
  expect(source).not.toContain("orderAuthority: 'EXECUTE'");
});
