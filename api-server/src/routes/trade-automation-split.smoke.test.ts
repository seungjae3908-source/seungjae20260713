// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, {
  setTradeAutomationRepositoryFactoryForTests,
  setTradeSplitOrderRepositoryFactoryForTests,
} from './trade-automation';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { marketIntelligenceNotAvailable, tradingMarket } from '../services/market-intelligence-client.service';
import {
  marketIntelligenceSymbolForTradingPlan,
  setTradingPlanMarketIntelligenceRunnerForTests,
} from '../services/trade-market-intelligence.service';
import type {
  CancelSplitChildrenInput,
  CreateSplitOrdersInput,
  SplitOrderRepository,
} from '../services/trade-split-order.repository';
import type { SplitTradingOrder } from '../services/trade-split-order-materializer.service';
import type { TradingOrderEvent } from '../services/trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

async function unavailableMarketIntelligence(input) {
  return marketIntelligenceNotAvailable(
    tradingMarket(input),
    marketIntelligenceSymbolForTradingPlan(input),
    'TEST_MARKET_INTELLIGENCE_UNAVAILABLE',
  );
}

class SharedSplitRepository implements SplitOrderRepository {
  private createInFlight: Promise<SplitTradingOrder[]> | null = null;

  constructor(private trading: InMemoryTradingRepository) {}

  async listOrdersByPlan(userId: string, planId: string, approvedPlanVersion?: number) {
    return (await this.trading.listOrders(userId))
      .filter((order) => order.planId === planId
        && 'legSequenceNo' in order
        && (approvedPlanVersion === undefined || order.approvedPlanVersion === approvedPlanVersion))
      .sort((left, right) => left.legSequenceNo - right.legSequenceNo) as SplitTradingOrder[];
  }

  async createSplitOrdersAtomic(input: CreateSplitOrdersInput) {
    const existing = await this.listOrdersByPlan(input.userId, input.planId, input.expectedPlanVersion);
    if (existing.length > 0) return existing;
    if (this.createInFlight) return this.createInFlight;

    this.createInFlight = (async () => {
      const replay = await this.listOrdersByPlan(input.userId, input.planId, input.expectedPlanVersion);
      if (replay.length > 0) return replay;
      for (const [index, order] of input.orders.entries()) {
        await this.trading.saveOrder(order);
        await this.trading.appendEvent(input.events[index]!);
      }
      return this.listOrdersByPlan(input.userId, input.planId, input.expectedPlanVersion);
    })();

    try {
      return await this.createInFlight;
    } finally {
      this.createInFlight = null;
    }
  }

  async activateNextChildAtomic(order: SplitTradingOrder, event: TradingOrderEvent) {
    const current = await this.trading.getOrder(order.userId, order.id) as SplitTradingOrder | null;
    if (!current || current.state !== 'PLANNED' || current.version !== order.version) return null;
    const activated = {
      ...current,
      state: 'SUBMITTED' as const,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.trading.saveOrder(activated);
    await this.trading.appendEvent(event);
    return activated;
  }

  async cancelPlannedChildrenAtomic(input: CancelSplitChildrenInput) {
    const current = await this.listOrdersByPlan(input.userId, input.planId, input.approvedPlanVersion);
    const pending = current.filter((order) => order.state === 'PLANNED' && order.legSequenceNo >= input.fromSequenceNo);
    if (pending.length !== input.events.length) return null;
    for (const [index, order] of pending.entries()) {
      await this.trading.saveOrder({
        ...order,
        state: 'CANCELED',
        version: order.version + 1,
        updatedAt: new Date().toISOString(),
      });
      await this.trading.appendEvent(input.events[index]!);
    }
    return this.listOrdersByPlan(input.userId, input.planId, input.approvedPlanVersion);
  }
}

async function startServer(repository: InMemoryTradingRepository) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.member = {
      id: USER,
      login_name: 'split-test',
      display_name: 'split-test',
      role: 'regular',
      membership_level: 'regular',
      status: 'approved',
      is_active: true,
    };
    req.accessToken = 'split-test-token';
    next();
  });
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('concurrent paper split approval stays idempotent, revalidates next leg, and makes zero private requests', async () => {
  const repository = new InMemoryTradingRepository();
  const splitRepository = new SharedSplitRepository(repository);
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  setTradeSplitOrderRepositoryFactoryForTests(() => splitRepository);
  setTradingPlanMarketIntelligenceRunnerForTests(unavailableMarketIntelligence);
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  await repository.setGlobalEmergencyStop(false, USER);

  const { server, baseUrl } = await startServer(repository);
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    const connection = await nativeFetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: { accessKey: 'split-access', secretKey: 'split-secret' },
        permissions: ['orders'],
        accountMode: 'paper',
      }),
    });
    assert.equal(connection.status, 200);

    const observedAt = new Date().toISOString();
    const planned = await nativeFetch(`${baseUrl}/api/trade-automation/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        exchange: 'upbit',
        accountMode: 'paper',
        strategyId: 'split-route-v1',
        signalId: `split-route-${Date.now()}`,
        symbol: 'BTC',
        market: 'KRW',
        side: 'buy',
        orderType: 'limit',
        quantity: 1,
        quoteAmount: 100000,
        limitPrice: 100000,
        estimatedKrw: 100000,
        stopPrice: 95000,
        targetPrices: [110000],
        splitRatios: [50, 30, 20],
        signalReasons: ['route split fence'],
        marketSnapshot: {
          observedAt,
          riskObservedAt: observedAt,
          dataDelayMs: 0,
          oneMinuteMovePercent: 0,
          spreadPercent: 0.1,
          orderbookGapPercent: 0.1,
          halted: false,
          availableBalance: 1000000,
          accountValueKrw: 5000000,
          dailyPnlPercent: 0,
          assetExposurePercent: 0,
          openPositionCount: 0,
          dailyOrderCount: 0,
          consecutiveLosses: 0,
          currentPrice: 100000,
          plannedPrice: 100000,
          marketStatus: 'OPEN',
          availableLiquidityKrw: 1000000,
          estimatedSlippagePercent: 0.1,
          estimatedFeePercent: 0.05,
          signalState: 'condition_maintained',
          signalObservedAt: observedAt,
        },
      }),
    });
    assert.equal(planned.status, 200);
    const plannedBody = await planned.json();
    const planId = plannedBody.plan.id;
    assert.equal(plannedBody.plan.state, 'APPROVAL_PENDING');
    assert.equal('riskEnvelope' in plannedBody.plan, false);

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) {
        outbound += 1;
        throw new Error('external request blocked');
      }
      return nativeFetch(input, init);
    }) as typeof fetch;

    const responses = await Promise.all([
      globalThis.fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }),
      globalThis.fetch(`${baseUrl}/api/trade-automation/plans/${planId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }),
    ]);
    const approvals = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await response.text(),
    })));

    const successful = approvals.filter((response) => response.status === 200);
    assert.equal(successful.length, 1, JSON.stringify(approvals));
    const body = JSON.parse(successful[0]!.body);
    assert.equal(body.plan.riskEnvelope.version, 1);
    assert.equal(body.plan.riskEnvelope.investmentKrw, 100000);
    assert.equal(body.plan.riskEnvelope.maxSplitCount, 3);
    assert.equal(body.plan.riskEnvelope.allowCancelUnfilled, true);
    assert.equal(body.order.legSequenceNo, 1);
    assert.equal(body.order.state, 'FILLED');
    assert.equal(body.order.requestedQuantity, 0.5);
    assert.equal(body.order.requestedQuoteAmount, 50000);
    assert.deepEqual(body.splitOrders.map((order) => order.state), ['FILLED', 'SUBMITTED', 'PLANNED']);
    assert.equal(body.nextChild.legSequenceNo, 2);
    assert.equal(body.nextChild.requestedQuantity, 0.3);
    assert.equal(body.aggregateState, 'PARTIALLY_FILLED');

    const orders = await repository.listOrders(USER) as SplitTradingOrder[];
    assert.equal(orders.length, 3);
    assert.equal(orders.filter((order) => order.state === 'FILLED').length, 1);
    assert.equal(orders.filter((order) => order.state === 'SUBMITTED').length, 1);
    assert.equal(orders.filter((order) => order.state === 'PLANNED').length, 1);

    const events = await repository.listEvents(USER);
    assert.equal(events.filter((event) => event.reason === 'PAPER_BROKER_ACCEPTED').length, 1);
    assert.equal(events.filter((event) => event.reason === 'PAPER_BROKER_FILLED').length, 1);
    assert.equal(events.filter((event) => event.reason === 'SPLIT_REVALIDATION_PASSED').length, 1);
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    await close(server);
    setTradeAutomationRepositoryFactoryForTests(null);
    setTradeSplitOrderRepositoryFactoryForTests(null);
    setTradingPlanMarketIntelligenceRunnerForTests(null);
    delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
  }
});