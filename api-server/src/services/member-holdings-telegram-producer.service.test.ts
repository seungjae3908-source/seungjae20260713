import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fanoutMemberHoldingScannerAlert,
  memberHoldingsTelegramProducerEnabled,
  type MemberHoldingProducerRepository,
  type MemberHoldingStockHolder,
} from './member-holdings-telegram-producer.service';
import { deliverScannerTelegramAlerts } from './scanner-telegram-delivery.service';
import type { MemberHoldingTelegramEvidence } from './member-holdings-telegram-alert.service';
import type { ScannerAlertCandidate } from './scanner-signal.types';

function stockAlert(): ScannerAlertCandidate {
  return {
    idempotencyKey: 'scanner-event-005930-20260825',
    signalId: 'signal-005930-20260825',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    direction: 'LONG',
    action: 'BUY',
    state: 'APPROVAL_PENDING',
    entryZone: { from: 80_000, to: 81_000 },
    stopLoss: 77_000,
    targets: [84_000, 86_000],
    expiresAt: '2026-08-25T06:30:00.000Z',
    evidence: ['거래량 증가 evidence', '추세 조건 통과 evidence'],
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function holders(): MemberHoldingStockHolder[] {
  return [
    {
      userId: '11111111-1111-1111-1111-111111111111',
      ticker: '005930',
      name: '삼성전자',
      market: 'KR',
      averageEntryPrice: 78_000,
    },
    {
      userId: '22222222-2222-2222-2222-222222222222',
      ticker: '005930',
      name: '삼성전자',
      market: 'KR',
      averageEntryPrice: 79_000,
    },
  ];
}

function repository(rows: MemberHoldingStockHolder[]): MemberHoldingProducerRepository {
  return {
    listApprovedStockHolders: async () => rows,
  };
}

test('member holdings producer is exact-true opt-in and otherwise stays disabled', async () => {
  assert.equal(memberHoldingsTelegramProducerEnabled(undefined), false);
  assert.equal(memberHoldingsTelegramProducerEnabled('false'), false);
  assert.equal(memberHoldingsTelegramProducerEnabled('1'), false);
  assert.equal(memberHoldingsTelegramProducerEnabled('TRUE'), true);

  let reads = 0;
  const result = await fanoutMemberHoldingScannerAlert(stockAlert(), {
    enabled: false,
    repository: {
      listApprovedStockHolders: async () => {
        reads += 1;
        return holders();
      },
    },
  });
  assert.equal(result.status, 'DISABLED');
  assert.equal(reads, 0);
  assert.deepEqual(result, {
    status: 'DISABLED', matchedCount: 0, policyCount: 0, skippedCount: 0, errorCount: 0,
  });
});

test('canonical stock holder fanout uses one public quote and never fabricates AI evidence', async () => {
  let quoteReads = 0;
  const captured: MemberHoldingTelegramEvidence[] = [];
  const result = await fanoutMemberHoldingScannerAlert(stockAlert(), {
    enabled: true,
    repository: repository(holders()),
    quoteReader: async (symbol) => {
      quoteReads += 1;
      assert.equal(symbol, '005930');
      return { price: 82_000, changePercent: 1.25 };
    },
    now: () => new Date('2026-08-25T06:00:00.000Z'),
    deliver: async (evidence) => {
      captured.push(evidence);
      return { status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null };
    },
  });

  assert.equal(quoteReads, 1);
  assert.deepEqual(result, {
    status: 'PROCESSED', matchedCount: 2, policyCount: 0, skippedCount: 2, errorCount: 0,
  });
  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((item) => item.averageEntryPrice), [78_000, 79_000]);
  for (const evidence of captured) {
    assert.equal(evidence.assetClass, 'stock');
    assert.equal(evidence.market, 'KR');
    assert.equal(evidence.symbol, '005930');
    assert.equal(evidence.currentPrice, 82_000);
    assert.equal(evidence.changePercent, 1.25);
    assert.equal(evidence.occurredAt, '2026-08-25T06:00:00.000Z');
    assert.deepEqual(evidence.triggerReasons, stockAlert().evidence);
    assert.deepEqual(evidence.tradePlan?.targetPrices, [84_000, 86_000]);
    assert.equal(evidence.tradePlan?.stopLoss, 77_000);
    assert.equal(evidence.tradePlan?.entryPrices, undefined);
    assert.equal(evidence.ai, undefined);
    assert.equal(evidence.performance, undefined);
    assert.equal(evidence.news, undefined);
    assert.equal('quantity' in evidence, false);
    assert.match(evidence.eventId, /^scanner-holding:/u);
  }
});

test('coin alerts stay unwired until a canonical coin holdings source exists', async () => {
  let reads = 0;
  const coinAlert: ScannerAlertCandidate = {
    ...stockAlert(),
    assetClass: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
  };
  const result = await fanoutMemberHoldingScannerAlert(coinAlert, {
    enabled: true,
    repository: {
      listApprovedStockHolders: async () => {
        reads += 1;
        return [];
      },
    },
  });
  assert.equal(result.status, 'UNSUPPORTED_ASSET');
  assert.equal(reads, 0);
});

test('storage or quote failure sends zero member alerts and remains fail-closed', async () => {
  let delivered = 0;
  const storageFailure = await fanoutMemberHoldingScannerAlert(stockAlert(), {
    enabled: true,
    repository: {
      listApprovedStockHolders: async () => {
        throw new Error('storage unavailable');
      },
    },
    deliver: async () => {
      delivered += 1;
      return { status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null };
    },
  });
  assert.equal(storageFailure.status, 'STORAGE_UNAVAILABLE');
  assert.equal(delivered, 0);

  const quoteFailure = await fanoutMemberHoldingScannerAlert(stockAlert(), {
    enabled: true,
    repository: repository(holders()),
    quoteReader: async () => {
      throw new Error('quote unavailable');
    },
    deliver: async () => {
      delivered += 1;
      return { status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null };
    },
  });
  assert.equal(quoteFailure.status, 'QUOTE_UNAVAILABLE');
  assert.equal(quoteFailure.matchedCount, 2);
  assert.equal(delivered, 0);
});

test('scanner runtime invokes member producer independently of public room configuration', async () => {
  let producerCalls = 0;
  let publicSends = 0;
  await deliverScannerTelegramAlerts(
    [stockAlert()],
    async () => {
      publicSends += 1;
      return { ok: true, attempts: 1 };
    },
    () => null,
    {},
    async (alert) => {
      producerCalls += 1;
      assert.equal(alert.signalId, 'signal-005930-20260825');
      return {
        status: 'PROCESSED', matchedCount: 1, policyCount: 0, skippedCount: 1, errorCount: 0,
      };
    },
  );
  assert.equal(producerCalls, 1);
  assert.equal(publicSends, 0);
});
