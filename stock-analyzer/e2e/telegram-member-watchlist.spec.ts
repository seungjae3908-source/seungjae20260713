import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { TELEGRAM_POLICY_SAFETY } from '../../api-server/src/services/telegram-alert-policy.service';
import type { PersonalTelegramAlertDispatchResult } from '../../api-server/src/services/personal-telegram-alert.service';
import { deliverMemberWatchlistTelegramForSignal } from '../../api-server/src/services/member-watchlist-telegram-producer.service';

function repositoryRoot() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? path.resolve(process.cwd(), '..')
    : process.cwd();
}

const baseSignal = {
  type: 'NEW_CANDIDATE' as const,
  id: 'candidate-1',
  serviceSha: 'a'.repeat(40),
  market: 'US_STOCK' as const,
  symbol: 'AAPL',
  strategy: 'swing-v1',
  timeframe: '1D',
  direction: 'BUY' as const,
  validationTier: 'RESEARCH_CANDIDATE' as const,
  occurredAt: '2026-08-27T00:00:00.000Z',
};

function delivered(userId: string): PersonalTelegramAlertDispatchResult {
  return {
    status: 'POLICY',
    reason: null,
    policy: {
      decision: {
        action: 'IMMEDIATE',
        reason: 'ALLOWED',
        userId,
        prioritySemantics: 'DELIVERY_URGENCY_ONLY',
        digestKey: null,
        digestWindowMs: null,
        safety: TELEGRAM_POLICY_SAFETY,
      },
      transport: { ok: true, attempts: 1 },
      safety: TELEGRAM_POLICY_SAFETY,
    },
  };
}

test('member watchlist Telegram producer is fail-closed OFF by default', async () => {
  let searches = 0;
  let sends = 0;
  const result = await deliverMemberWatchlistTelegramForSignal(baseSignal, {
    findSubscribers: async () => {
      searches += 1;
      return [{ userId: 'user-a' }];
    },
    deliver: async ({ userId }) => {
      sends += 1;
      return delivered(userId);
    },
  }, {});

  expect(result.reason).toBe('DISABLED');
  expect(searches).toBe(0);
  expect(sends).toBe(0);
});

test('member watchlist signal goes only through the linked-user personal policy gateway', async () => {
  const users: string[] = [];
  const events: Array<{ userId: string; signalType: string; market?: string }> = [];
  const alerts: Array<{ type: string; destinationChatId?: string; details?: string }> = [];

  const result = await deliverMemberWatchlistTelegramForSignal(baseSignal, {
    findSubscribers: async (market, symbol) => {
      expect(market).toBe('US_STOCK');
      expect(symbol).toBe('AAPL');
      return [{ userId: 'user-a' }, { userId: 'user-b' }];
    },
    deliver: async (input) => {
      users.push(input.userId);
      events.push(input.event);
      alerts.push(input.alert);
      return delivered(input.userId);
    },
  }, { MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED: 'true' });

  expect(result).toMatchObject({ eligible: true, matched: 2, attempted: 2, delivered: 2, failed: 0 });
  expect(users).toEqual(['user-a', 'user-b']);
  expect(events.map((event) => event.userId)).toEqual(['user-a', 'user-b']);
  expect(events.every((event) => event.signalType === 'BUY' && event.market === 'US')).toBe(true);
  expect(alerts.every((alert) => alert.type === 'strong_buy')).toBe(true);
  expect(alerts.every((alert) => alert.destinationChatId === undefined)).toBe(true);
  expect(alerts.every((alert) => alert.details?.includes('실제 주문/체결 아님'))).toBe(true);
});

test('stock/spot SHORT is never promoted into a new-entry personal Telegram signal', async () => {
  let searches = 0;
  const findSubscribers = async () => {
    searches += 1;
    return [{ userId: 'user-a' }];
  };
  const enabled = { MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED: 'true' };

  const stock = await deliverMemberWatchlistTelegramForSignal({
    ...baseSignal,
    direction: 'SHORT',
  }, { findSubscribers }, enabled);
  const spot = await deliverMemberWatchlistTelegramForSignal({
    ...baseSignal,
    market: 'CRYPTO_SPOT',
    symbol: 'KRW-BTC',
    direction: 'SHORT',
  }, { findSubscribers }, enabled);

  expect(stock.reason).toBe('INELIGIBLE');
  expect(spot.reason).toBe('INELIGIBLE');
  expect(searches).toBe(0);
});

test('crypto futures LONG and SHORT remain independent eligible directions', async () => {
  const signalTypes: string[] = [];

  for (const direction of ['LONG', 'SHORT'] as const) {
    const result = await deliverMemberWatchlistTelegramForSignal({
      ...baseSignal,
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      direction,
    }, {
      findSubscribers: async () => [{ userId: 'user-a' }],
      deliver: async (input) => {
        signalTypes.push(input.event.signalType);
        return delivered(input.userId);
      },
    }, { MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED: 'true' });
    expect(result.delivered).toBe(1);
  }

  expect(signalTypes).toEqual(['LONG', 'SHORT']);
});

test('member ownership is auth/RLS based and client identity overrides are rejected', () => {
  const root = repositoryRoot();
  const route = fs.readFileSync(path.join(root, 'api-server/src/routes/member-watchlist.ts'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'api-server/supabase/migrations/2026082704_member_watchlist_items.sql'),
    'utf8',
  );
  const sync = fs.readFileSync(path.join(root, 'stock-analyzer/src/lib/watchlist-sync.ts'), 'utf8');
  const producer = fs.readFileSync(
    path.join(root, 'api-server/src/services/member-watchlist-telegram-producer.service.ts'),
    'utf8',
  );

  expect(route).toContain('req.member?.id');
  expect(route).toContain('IDENTITY_OVERRIDE_REJECTED');
  expect(route).not.toContain('req.body.userId');
  expect(migration).toContain('auth.uid() = user_id');
  expect(migration).toContain("'UNRESOLVED'");
  expect(sync).toContain("request('/member-watchlist/sync'");
  expect(sync).not.toContain('deviceId:');
  expect(sync).not.toContain('userId:');
  expect(producer).toContain("MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED === 'true'");
  expect(producer).toContain('deliverPersonalTelegramAlert');
  expect(producer).not.toContain('sendTelegramAlert');
});
