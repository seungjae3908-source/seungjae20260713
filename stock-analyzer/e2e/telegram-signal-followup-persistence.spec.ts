import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ScannerAlertCandidate,
  ScannerSignalCard,
  ScannerSignalState,
} from '../../api-server/src/services/scanner-signal.types';
import {
  InMemoryTelegramSignalFollowupRepository,
  type StoredTelegramSignalFollowupState,
  type TelegramSignalFollowupRepository,
} from '../../api-server/src/services/telegram-signal-followup.repository';
import {
  clearTelegramSignalFollowupState,
  deliverScannerTelegramFollowups,
  markTelegramSignalAnnounced,
} from '../../api-server/src/services/telegram-signal-followup.service';

const ANNOUNCED_AT = Date.parse('2026-09-01T00:00:00.000Z');
const EXPIRES_AT = '2026-09-03T00:00:00.000Z';
const LEDGER_TTL_MS = 7 * 24 * 60 * 60_000;

function announcedAlert(signalId = 'signal-restart-safe-1'): ScannerAlertCandidate {
  return {
    signalId,
    expiresAt: EXPIRES_AT,
  } as unknown as ScannerAlertCandidate;
}

function followupCard(
  signalId = 'signal-restart-safe-1',
  options: {
    price?: number;
    signalState?: ScannerSignalState;
    targets?: number[];
    stopLoss?: number;
  } = {},
): ScannerSignalCard {
  return {
    signalId,
    assetClass: 'stock',
    direction: 'LONG',
    symbol: '005930',
    market: 'KR',
    price: options.price ?? 105,
    signalState: options.signalState ?? 'APPROVAL_PENDING',
    pricePlan: {
      entryZone: { from: 100, to: 102 },
      invalidation: 89,
      stopLoss: options.stopLoss ?? 90,
      targets: options.targets ?? [105, 110, 115],
      riskReward: 2,
    },
  } as unknown as ScannerSignalCard;
}

async function withFollowupEnv(run: () => Promise<void>) {
  const previousEnabled = process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED;
  const previousRoom = process.env.TELEGRAM_STOCK_CHAT_ID;
  process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED = 'true';
  process.env.TELEGRAM_STOCK_CHAT_ID = 'stock-room-test';
  clearTelegramSignalFollowupState();
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

test('announced signal hydrates all durable fields after restart and TP followup is not duplicated', async () => {
  await withFollowupEnv(async () => {
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(), ANNOUNCED_AT, repository);

    clearTelegramSignalFollowupState();
    const messages: string[] = [];
    const firstSeenAt = ANNOUNCED_AT + 1_000;
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async (input) => {
        messages.push(input.details ?? '');
        return { ok: true, attempts: 1 };
      },
      firstSeenAt,
      repository,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('TP1 가격 기준 도달');
    expect(messages[0]).toContain('체결을 의미하지 않습니다.');

    const [stored] = await repository.list(['signal-restart-safe-1']);
    expect(stored).toEqual({
      signalId: 'signal-restart-safe-1',
      expiresAt: EXPIRES_AT,
      lastState: 'APPROVAL_PENDING',
      lastPrice: 105,
      reachedTargets: [0],
      stopReached: false,
      announcedAt: ANNOUNCED_AT,
      lastSeenAt: firstSeenAt,
    });

    clearTelegramSignalFollowupState();
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async (input) => {
        messages.push(input.details ?? '');
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 2_000,
      repository,
    );
    expect(messages).toHaveLength(1);
  });
});

test('canonical duplicate followup result is checkpointed and is not resent after restart', async () => {
  await withFollowupEnv(async () => {
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert('signal-duplicate'), ANNOUNCED_AT, repository);
    clearTelegramSignalFollowupState();

    let attempts = 0;
    await deliverScannerTelegramFollowups(
      [followupCard('signal-duplicate')],
      async () => {
        attempts += 1;
        return { ok: false, attempts: 1, skipped: 'DUPLICATE' };
      },
      ANNOUNCED_AT + 1_000,
      repository,
    );
    expect(attempts).toBe(1);

    clearTelegramSignalFollowupState();
    await deliverScannerTelegramFollowups(
      [followupCard('signal-duplicate')],
      async () => {
        attempts += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 2_000,
      repository,
    );
    expect(attempts).toBe(1);
  });
});

test('stop threshold checkpoint survives restart and is emitted only once', async () => {
  await withFollowupEnv(async () => {
    const signalId = 'signal-stop-safe';
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(signalId), ANNOUNCED_AT, repository);
    clearTelegramSignalFollowupState();

    let sends = 0;
    await deliverScannerTelegramFollowups(
      [followupCard(signalId, { price: 100, targets: [120], stopLoss: 90 })],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 1_000,
      repository,
    );
    expect(sends).toBe(0);

    clearTelegramSignalFollowupState();
    const details: string[] = [];
    await deliverScannerTelegramFollowups(
      [followupCard(signalId, { price: 89, targets: [120], stopLoss: 90 })],
      async (input) => {
        sends += 1;
        details.push(input.details ?? '');
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 2_000,
      repository,
    );
    expect(sends).toBe(1);
    expect(details[0]).toContain('손절 기준 가격 도달');
    const [stored] = await repository.list([signalId]);
    expect(stored.stopReached).toBe(true);
    expect(stored.lastPrice).toBe(89);

    clearTelegramSignalFollowupState();
    await deliverScannerTelegramFollowups(
      [followupCard(signalId, { price: 89, targets: [120], stopLoss: 90 })],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 3_000,
      repository,
    );
    expect(sends).toBe(1);
  });
});

test('REARMED, ENTRY_ZONE_LEFT, INVALIDATED and EXPIRED lifecycle semantics persist across restarts', async () => {
  await withFollowupEnv(async () => {
    const signalId = 'signal-lifecycle-safe';
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(signalId), ANNOUNCED_AT, repository);
    const messages: string[] = [];

    const deliverState = async (state: ScannerSignalState, offset: number) => {
      clearTelegramSignalFollowupState();
      await deliverScannerTelegramFollowups(
        [followupCard(signalId, { price: 100, signalState: state, targets: [1_000], stopLoss: 1 })],
        async (input) => {
          messages.push(input.details ?? '');
          return { ok: true, attempts: 1 };
        },
        ANNOUNCED_AT + offset,
        repository,
      );
    };

    await deliverState('ARMED', 1_000);
    expect(messages.at(-1)).toContain('진입구간을 벗어나');

    await deliverState('ENTRY_ZONE', 2_000);
    expect(messages.at(-1)).toContain('조건이 회복되어');

    await deliverState('INVALIDATED', 3_000);
    expect(messages.at(-1)).toContain('무효 상태로 전환');
    const afterInvalidated = messages.length;
    await deliverState('INVALIDATED', 4_000);
    expect(messages).toHaveLength(afterInvalidated);

    await deliverState('EXPIRED', 5_000);
    expect(messages.at(-1)).toContain('유효시간이 만료');
    const afterExpired = messages.length;
    await deliverState('EXPIRED', 6_000);
    expect(messages).toHaveLength(afterExpired);
  });
});

test('failed Telegram followup restores the prior durable checkpoint so the event remains retryable', async () => {
  await withFollowupEnv(async () => {
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(), ANNOUNCED_AT, repository);
    clearTelegramSignalFollowupState();

    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => ({ ok: false, attempts: 1, skipped: 'DELIVERY_FAILED' }),
      ANNOUNCED_AT + 1_000,
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
      ANNOUNCED_AT + 2_000,
      repository,
    );
    expect(retried).toBe(1);
  });
});

test('checkpoint persistence failure before delivery sends zero Telegram followups and remains retryable', async () => {
  await withFollowupEnv(async () => {
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(), ANNOUNCED_AT, repository);
    clearTelegramSignalFollowupState();

    const unavailableAtCheckpoint: TelegramSignalFollowupRepository = {
      list: (signalIds) => repository.list(signalIds),
      pruneBefore: (cutoffMs) => repository.pruneBefore(cutoffMs),
      save: async () => {
        throw new Error('checkpoint unavailable');
      },
    };
    let sends = 0;
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 1_000,
      unavailableAtCheckpoint,
    );
    expect(sends).toBe(0);

    clearTelegramSignalFollowupState();
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 2_000,
      repository,
    );
    expect(sends).toBe(1);
  });
});

test('initial durable save failure leaves no in-memory lifecycle checkpoint', async () => {
  await withFollowupEnv(async () => {
    const unavailable: TelegramSignalFollowupRepository = {
      list: async () => [],
      pruneBefore: async () => 0,
      save: async () => {
        throw new Error('initial save unavailable');
      },
    };
    await expect(markTelegramSignalAnnounced(announcedAlert(), ANNOUNCED_AT, unavailable)).rejects.toThrow(
      'initial save unavailable',
    );

    const healthy = new InMemoryTelegramSignalFollowupRepository();
    let sends = 0;
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 1_000,
      healthy,
    );
    expect(sends).toBe(0);
  });
});

test('repository prune and list failures fail closed before any Telegram followup send', async () => {
  await withFollowupEnv(async () => {
    let sends = 0;
    const sender = async () => {
      sends += 1;
      return { ok: true, attempts: 1 } as const;
    };
    const pruneFailure: TelegramSignalFollowupRepository = {
      pruneBefore: async () => {
        throw new Error('prune unavailable');
      },
      list: async () => [],
      save: async () => {},
    };
    await deliverScannerTelegramFollowups(
      [followupCard()],
      sender,
      ANNOUNCED_AT + 1_000,
      pruneFailure,
    );

    const listFailure: TelegramSignalFollowupRepository = {
      pruneBefore: async () => 0,
      list: async () => {
        throw new Error('list unavailable');
      },
      save: async () => {},
    };
    clearTelegramSignalFollowupState();
    await deliverScannerTelegramFollowups(
      [followupCard()],
      sender,
      ANNOUNCED_AT + 2_000,
      listFailure,
    );
    expect(sends).toBe(0);
  });
});

test('malformed durable lifecycle data is rejected and cannot fabricate a followup', async () => {
  await withFollowupEnv(async () => {
    const malformed = {
      signalId: 'signal-restart-safe-1',
      expiresAt: EXPIRES_AT,
      lastState: 'FABRICATED_STATE',
      lastPrice: 100,
      reachedTargets: [0],
      stopReached: false,
      announcedAt: ANNOUNCED_AT,
      lastSeenAt: ANNOUNCED_AT,
    } as unknown as StoredTelegramSignalFollowupState;
    const repository: TelegramSignalFollowupRepository = {
      pruneBefore: async () => 0,
      list: async () => [malformed],
      save: async () => {},
    };
    let sends = 0;
    await deliverScannerTelegramFollowups(
      [followupCard()],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + 1_000,
      repository,
    );
    expect(sends).toBe(0);
  });
});

test('7-day TTL pruning removes stale durable state and prevents stale lifecycle reuse', async () => {
  await withFollowupEnv(async () => {
    const signalId = 'signal-ttl-prune';
    const repository = new InMemoryTelegramSignalFollowupRepository();
    await markTelegramSignalAnnounced(announcedAlert(signalId), ANNOUNCED_AT, repository);
    clearTelegramSignalFollowupState();

    let sends = 0;
    await deliverScannerTelegramFollowups(
      [followupCard(signalId)],
      async () => {
        sends += 1;
        return { ok: true, attempts: 1 };
      },
      ANNOUNCED_AT + LEDGER_TTL_MS + 1,
      repository,
    );
    expect(sends).toBe(0);
    expect(await repository.list([signalId])).toEqual([]);
  });
});

test('durable lifecycle migration is service-role-only and stores no member or trading private fields', () => {
  const migration = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/supabase/migrations/2026082702_telegram_signal_followup_ledger.sql'),
    'utf8',
  );
  expect(migration).toContain('create table if not exists public.telegram_signal_followup_ledger');
  expect(migration).toContain('alter table public.telegram_signal_followup_ledger enable row level security');
  expect(migration).toContain('revoke all privileges on table public.telegram_signal_followup_ledger from public, anon, authenticated');
  expect(migration).toContain('grant all privileges on table public.telegram_signal_followup_ledger to service_role');
  expect(migration).not.toMatch(/\b(user_id|telegram_chat_id|chat_id|order_id|account_id|balance|holdings|profile_id)\b/);
});

test('production has no in-memory storage fallback and initial public alert awaits durable checkpoint', () => {
  const repositorySource = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/src/services/telegram-signal-followup.repository.ts'),
    'utf8',
  );
  expect(repositorySource).toContain("if (process.env.NODE_ENV !== 'production') return testFallbackRepository;");
  expect(repositorySource).toContain('throw storageError();');

  const deliverySource = fs.readFileSync(
    path.resolve(process.cwd(), '../api-server/src/services/scanner-telegram-delivery.service.ts'),
    'utf8',
  );
  expect(deliverySource).toContain("result.ok || result.skipped === 'DUPLICATE'");
  expect(deliverySource).toContain('await markTelegramSignalAnnounced(alert);');
  expect(deliverySource).toContain('initial alert lacks durable followup checkpoint; failing closed');
  expect(deliverySource).toContain('Freshness: ${freshness.status} · 유효성 ${freshness.validity}');
  expect(deliverySource).toContain('재검증 전 실시간 신호로 사용 금지');
  expect(deliverySource).not.toContain('ordersSubmitted: 1');
  expect(deliverySource).not.toContain("orderAuthority: 'EXECUTE'");
});
