import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PaperJournalConflict,
  PaperJournalRecordKind,
  PaperJournalRepository,
  PaperJournalSyncRecord,
  PaperJournalSyncResult,
  StoredPaperJournalRecord,
} from '../../services/paper-journal.types';
import { InMemoryTradingRepository } from '../../services/trade-automation.repository';
import { TradeAutomationService } from '../../services/trade-automation.service';
import { encryptTradingCredentials } from '../../services/trade-credential-vault.service';
import { TradeExecutionService } from '../../services/trade-execution.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from '../../services/trade-automation.types';
import { normalizeTradingPolicy } from '../../services/trade-automation-risk.service';
import { InMemoryUserBrokerTelegramRepository } from './user-broker-telegram.repository';
import { TradeExecutionEventBridgeService } from './trade-execution-event-bridge.service';
import { queueManualPortfolioNotifications, CanonicalPortfolioSyncSink } from './user-broker-telegram.runtime';
import { UserBrokerTelegramService } from './user-broker-telegram.service';
import { TelegramDeliveryWorker, type TelegramDeliveryWorkerSource } from './user-broker-telegram.worker';
import type { TelegramTransport } from './user-broker-telegram.types';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const MASTER_KEY = Buffer.alloc(32, 23).toString('base64');

class JournalRepository implements PaperJournalRepository {
  records = new Map<string, StoredPaperJournalRecord>();
  mutations = 0;
  key(userId: string, kind: PaperJournalRecordKind, id: string) { return `${userId}:${kind}:${id}`; }
  async getRecord(userId: string, kind: PaperJournalRecordKind, id: string) { return this.records.get(this.key(userId, kind, id)) ?? null; }
  async upsertRecord(userId: string, record: PaperJournalSyncRecord, serverTime: string) {
    this.mutations += 1;
    const stored: StoredPaperJournalRecord = { ...record, createdAt: serverTime, serverUpdatedAt: serverTime };
    this.records.set(this.key(userId, record.kind, record.id), structuredClone(stored));
    return stored;
  }
  async listSnapshot(userId: string) { return [...this.records.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([, value]) => structuredClone(value)); }
  async getIdempotentResponse(_userId: string, _key: string): Promise<PaperJournalSyncResult | null> { return null; }
  async saveIdempotentResponse(_userId: string, _key: string, _result: PaperJournalSyncResult, _time: string) {}
  async saveConflict(_userId: string, _conflict: PaperJournalConflict) {}
  async getConflict(_userId: string, _id: string): Promise<PaperJournalConflict | null> { return null; }
  async markConflictResolved(_userId: string, _id: string, _time: string) {}
  async listJournalPayloads(userId: string) { return (await this.listSnapshot(userId)).filter((row) => row.kind === 'journal').map((row) => row.payload); }
  async deleteAll(_userId: string) { return { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 }; }
}

class FakeTransport implements TelegramTransport {
  sent: Array<{ chatId: string; text: string }> = [];
  constructor(private readonly fail = false) {}
  async send(chatId: string, text: string) {
    if (this.fail) return { ok: false, errorCode: 'FAKE_TELEGRAM_FAILURE' };
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

function input(): TradingPlanInput {
  const observedAt = new Date().toISOString();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'runtime-e2e', signalId: 'signal-runtime-e2e',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'limit', quantity: 0.001,
    quoteAmount: null, limitPrice: 100_000_000, estimatedKrw: 100_000, stopPrice: 98_000_000,
    targetPrices: [103_000_000], splitRatios: [1], signalReasons: ['runtime-e2e'],
    marketSnapshot: {
      observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0,
      spreadPercent: 0, orderbookGapPercent: 0, halted: false, availableBalance: 2_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000_000, plannedPrice: 100_000_000, marketStatus: 'OPEN',
      availableLiquidityKrw: 10_000_000, estimatedSlippagePercent: 0, estimatedFeePercent: 0.05,
      correlatedExposurePercent: 0, signalState: 'entry_ready', signalObservedAt: observedAt,
    },
  };
}

async function linked(service: UserBrokerTelegramService, chatId = 'chat-a') {
  const now = new Date();
  const link = await service.createTelegramLink(USER_A, now);
  const token = new URL(link.deepLink!).searchParams.get('start');
  assert.ok(token);
  await service.bindTelegramStart({ token, telegramChatId: chatId, telegramUserId: 'telegram-a', now });
}

test('paper approval -> execution bridge -> canonical journal -> Telegram A is isolated and idempotent', async () => {
  const trading = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(trading);
  const created = await automation.createPlan(USER_A, input(), normalizeTradingPolicy(DEFAULT_TRADING_POLICY), false);
  assert.ok(created.plan);
  const approved = await automation.approvePlan(USER_A, created.plan.id);
  const pending = await automation.createOrder(USER_A, approved);
  await trading.saveConnection({
    userId: USER_A,
    exchange: 'upbit',
    accountMode: 'paper',
    configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'paper', secretKey: 'paper' }, MASTER_KEY),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  const executed = await new TradeExecutionService(trading).execute(USER_A, approved, pending.order);
  assert.equal(executed.state, 'FILLED');

  const journal = new JournalRepository();
  const integrationRepo = new InMemoryUserBrokerTelegramRepository();
  const transport = new FakeTransport();
  const service = new UserBrokerTelegramService(integrationRepo, transport, new CanonicalPortfolioSyncSink(journal, USER_A), 'runtime_test_bot');
  await linked(service);
  const bridge = new TradeExecutionEventBridgeService(trading, service);
  const first = await bridge.syncUser(USER_A);
  assert.ok(first.inserted >= 2);
  assert.equal(journal.mutations, 1);
  const second = await bridge.syncUser(USER_A);
  assert.equal(second.inserted, 0);
  assert.equal(journal.mutations, 1);
  assert.equal((await bridge.syncUser(USER_B)).inserted, 0);

  const deliveries = await integrationRepo.listDeliveries(USER_A);
  const dueSource: TelegramDeliveryWorkerSource = { async listDue() { return deliveries.map((item) => ({ userId: item.userId, id: item.id })); } };
  const worker = new TelegramDeliveryWorker(dueSource, service);
  const result = await worker.runOnce();
  assert.equal(result.ordersSubmitted, 0);
  assert.equal(result.privateBrokerRequests, 0);
  assert.ok(transport.sent.length >= 2);
  assert.ok(transport.sent.every((item) => item.chatId === 'chat-a'));
});

test('risk reject creates no broker order and no portfolio mutation', async () => {
  const trading = new InMemoryTradingRepository();
  await trading.setGlobalEmergencyStop(true, USER_A);
  const automation = new TradeAutomationService(trading);
  const result = await automation.createPlan(USER_A, { ...input(), signalId: 'risk-reject' }, normalizeTradingPolicy(DEFAULT_TRADING_POLICY), true);
  assert.equal(result.plan, null);
  assert.equal((await trading.listOrders(USER_A)).length, 0);
  const journal = new JournalRepository();
  const service = new UserBrokerTelegramService(new InMemoryUserBrokerTelegramRepository(), new FakeTransport(), new CanonicalPortfolioSyncSink(journal, USER_A), 'runtime_test_bot');
  const sync = await new TradeExecutionEventBridgeService(trading, service).syncUser(USER_A);
  assert.equal(sync.ordersSubmitted, 0);
  assert.equal(journal.mutations, 0);
});

test('Telegram failure schedules retry without changing FILLED execution or portfolio journal', async () => {
  const repo = new InMemoryUserBrokerTelegramRepository();
  const journal = new JournalRepository();
  const service = new UserBrokerTelegramService(repo, new FakeTransport(true), new CanonicalPortfolioSyncSink(journal, USER_A), 'runtime_test_bot');
  await linked(service);
  const event = {
    id: '10000000-0000-0000-0000-000000000001', sourceEventId: 'fill-failure', userId: USER_A,
    brokerConnectionRef: 'upbit' as const, orderPlanId: 'plan', executionId: 'order', type: 'ORDER_FILLED' as const,
    source: 'PAPER_EXECUTION' as const, executionMethod: 'USER_APPROVED' as const, symbol: 'BTC', market: 'KRW',
    side: 'buy' as const, quantity: 0.01, price: 100_000_000, maskedAccount: null, strategy: 'runtime',
    remainingQuantity: 0, realizedPnl: null, averageEntryPrice: null, averageExitPrice: null,
    occurredAt: new Date().toISOString(), metadata: {},
  };
  const queued = await service.recordEvent(event);
  assert.equal(queued.deliveryQueued, true);
  assert.equal(journal.mutations, 1);
  const delivery = (await repo.listDeliveries(USER_A))[0];
  const processed = await service.processDelivery(USER_A, delivery.id);
  assert.equal(processed.state, 'RETRY_SCHEDULED');
  assert.equal(journal.mutations, 1);
});

test('manual canonical entry notifies Telegram with MANUAL source and never mutates broker or portfolio again', async () => {
  const repo = new InMemoryUserBrokerTelegramRepository();
  const transport = new FakeTransport();
  let portfolioSyncCalls = 0;
  const service = new UserBrokerTelegramService(repo, transport, { async accept() { portfolioSyncCalls += 1; } }, 'runtime_test_bot');
  await linked(service);
  const record: StoredPaperJournalRecord = {
    kind: 'journal', id: 'manual-1', version: 1, updatedAt: new Date().toISOString(), deletedAt: null,
    createdAt: new Date().toISOString(), serverUpdatedAt: new Date().toISOString(),
    payload: { source: 'TOSS_MANUAL', market: 'KR_STOCK', symbol: '005930', quantity: 10, entryPrice: 72_000 },
  };
  const queued = await queueManualPortfolioNotifications(USER_A, [record], service);
  assert.equal(queued.queued, 1);
  assert.equal(queued.brokerSubmitCount, 0);
  assert.equal(queued.privateApiRequests, 0);
  assert.equal(portfolioSyncCalls, 0);
  const delivery = (await repo.listDeliveries(USER_A))[0];
  await service.processDelivery(USER_A, delivery.id);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].text, /등록방식: 수동등록/);
});