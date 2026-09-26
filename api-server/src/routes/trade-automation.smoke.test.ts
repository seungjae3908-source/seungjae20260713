import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, {
  setTradeAutomationRepositoryFactoryForTests,
  setTradeExitPreviewReadersFactoryForTests,
} from './trade-automation';
import type { AuthenticatedRequest } from '../middleware/auth';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import { marketIntelligenceNotAvailable, tradingMarket } from '../services/market-intelligence-client.service';
import {
  marketIntelligenceSymbolForTradingPlan,
  setTradingPlanMarketIntelligenceRunnerForTests,
} from '../services/trade-market-intelligence.service';
import type { TradingPlanInput } from '../services/trade-automation.types';
import { createScannerPaperPlansRouter } from './scanner-paper-plans';
import { ProductPaperSourceRegistry } from '../services/product-paper-source-registry.service';
import type { ScannerResponse, ScannerSignalCard } from '../services/scanner-signal.types';
import { getScannerStrategyProfile } from '../services/scanner-strategy-profile.service';

const USER = '11111111-1111-1111-1111-111111111111';
const repository = new InMemoryTradingRepository();
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

function scannerCardFixture({ now, market, symbol, action }: { now: number; market: string; symbol: string; action: 'BUY' | 'LONG' | 'SHORT' }): ScannerSignalCard {
  const assetClass = market === 'KR' || market === 'US' ? 'stock' : market === 'UPBIT_KRW' ? 'coin_spot' : 'coin_futures';
  return {
    signalId: `server-signal-${market}-${action}`, assetClass: assetClass as any, market: market as any, symbol,
    direction: action === 'BUY' ? 'LONG' : action, action: action as any, strategyMode: 'swing',
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    strongSignalEligible: true, signalState: 'READY_FOR_APPROVAL', dataState: 'complete',
    dataSources: ['test-only-public-source'], matched: ['trend_alignment'], exchange: null, name: 'test-only',
    currency: market === 'KR' ? 'KRW' : market === 'US' ? 'USD' : 'USDT', assetType: assetClass as any,
    listingStatus: 'LISTED', price: 100, changePercent: 1, score: 80, confidence: 80,
    dataCompleteness: 100, riskScore: 10, riskLevel: 'LOW', liquidity: 10000, volume: 100,
    tradingValue: 10000, spreadPercent: 0.1, volatilityPercent: 1, notMatched: [], unverified: [],
    evidence: [], warnings: [], pricePlan: { entryZone: { from: 99, to: 101 }, invalidation: 95, stopLoss: 95, targets: [110], riskReward: 2 },
  } as ScannerSignalCard;
}

async function startScannerPlanServer(dependencies: Parameters<typeof createScannerPaperPlansRouter>[0]) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use((req, _res, next) => {
    const row = req as AuthenticatedRequest;
    row.member = { id: USER, login_name: 'test', display_name: 'test', role: 'user', membership_level: 'associate', status: 'approved', is_active: true };
    row.membershipLevel = 'associate';
    next();
  });
  app.use('/api/trade-automation', createScannerPaperPlansRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/trade-automation/scanner/plans` };
}

test('actual Scanner HTTP route remains fail-closed when the server-owned Paper evidence owner is absent', async () => {
  const now = Date.UTC(2026, 8, 17);
  const sha = 'a'.repeat(40);
  const registry = new ProductPaperSourceRegistry(() => now);
  const timeframe = getScannerStrategyProfile('KR_STOCK', 'SWING').primaryTimeframe;
  const card = scannerCardFixture({ now, market: 'KR', symbol: '005930', action: 'BUY' });
  registry.captureScanner(USER, { requestId: 'server-run', timeframe, cards: [card], execution: { cancelled: false } } as ScannerResponse, sha);
  const { server, url } = await startScannerPlanServer({ registry, sourceSha: () => sha, now: () => now });
  const valid = { mode: 'approval', accountMode: 'paper', adapter: 'paper', market: 'KR', symbol: '005930',
    timeframe, side: 'BUY', searchRunId: 'server-run', signalId: card.signalId };
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) });
    assert.equal(response.status, 503);
    const payload = await response.json() as Record<string, any>;
    assert.equal(payload.serverVerified, true);
    assert.equal(payload.ok, false); assert.equal(payload.executionConnected, false);
    assert.equal(payload.error, 'SERVER_OWNED_SCANNER_PAPER_EVIDENCE_REQUIRED');
    assert.equal(payload.plan, undefined); assert.equal(payload.position, undefined);
    assert.equal(payload.orderSubmitted, false); assert.equal(payload.exchangeRequestSent, false);
    assert.equal(payload.privateTradingApiAllowed, false); assert.equal(payload.evidenceCredit, 0);
    for (const change of [{ side: undefined }, { accountMode: 'live' }, { canonicalEvidence: { genuine: true } }, { profitGate: { decision: 'ELIGIBLE' } }, { leverage: 3 }, { symbol: '000660' }]) {
      const rejected = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...valid, ...change }) });
      assert.ok(rejected.status >= 400 && rejected.status < 500);
      const rejectedPayload = await rejected.json() as Record<string, any>;
      assert.equal(rejectedPayload.orderSubmitted, false);
      assert.equal(rejectedPayload.exchangeRequestSent, false);
    }
  } finally { await close(server); }
});

test('Scanner canonical Paper consumer preserves exact identity across all four market aliases and creates zero live/economic authority', async () => {
  const now = Date.UTC(2026, 8, 17);
  const sha = 'b'.repeat(40);
  const cases = [
    { requestMarket: 'KR', canonicalMarket: 'KR_STOCK', cardMarket: 'KR', symbol: '005930', action: 'BUY' },
    { requestMarket: 'US', canonicalMarket: 'US_STOCK', cardMarket: 'US', symbol: 'AAPL', action: 'BUY' },
    { requestMarket: 'UPBIT', canonicalMarket: 'CRYPTO_SPOT', cardMarket: 'UPBIT_KRW', symbol: 'KRW-BTC', action: 'BUY' },
    { requestMarket: 'BITGET', canonicalMarket: 'CRYPTO_FUTURES', cardMarket: 'BITGET_USDT_FUTURES', symbol: 'BTCUSDT', action: 'SHORT' },
  ] as const;
  for (const item of cases) {
    const registry = new ProductPaperSourceRegistry(() => now);
    const timeframe = getScannerStrategyProfile(item.canonicalMarket, 'SWING').primaryTimeframe;
    const card = scannerCardFixture({ now, market: item.cardMarket, symbol: item.symbol, action: item.action });
    const runId = `server-run-${item.requestMarket}`;
    registry.captureScanner(USER, { requestId: runId, timeframe, cards: [card], execution: { cancelled: false } } as ScannerResponse, sha);
    let sourceCandidate: any = null;
    let cycleCandidate: any = null;
    const { server, url } = await startScannerPlanServer({
      registry,
      sourceSha: () => sha,
      now: () => now,
      ownerSource: async ({ paperCandidate }) => {
        sourceCandidate = paperCandidate;
        return {
          admissionBundle: { schemaVersion: 'scanner-paper-admission-evidence-bundle-v1' } as any,
          profitGate: { decision: 'ELIGIBLE', eligible: true, reasons: [], executionAuthority: 'NONE' },
          profitEvidence: { status: 'READY', expectedNetEdge: 0.01, expectedNetReturn: 0.01, riskRewardRatio: 2, sampleSize: 30,
            costPolicyId: paperCandidate.signal.strategyIdentity.costPolicyVersion, executionAuthority: 'NONE' },
          state: { owner: 'server' }, cycle: { owner: 'server' }, ledgerAdapter: { owner: 'server' },
          learningAdapter: { owner: 'server' }, stateStore: { owner: 'server' },
          simulatedOnly: true, executionAuthority: 'NONE', liveOrderAllowed: false, privateTradingApiAllowed: false,
          productionMutationAllowed: false, naturalSampleCredit: 0,
        } as any;
      },
      resolveAdmission: ({ bundle }: any) => {
        assert.equal(bundle.schemaVersion, 'scanner-paper-admission-evidence-bundle-v1');
        return { status: 'BRIDGE_READY', blockers: [], candidate: sourceCandidate, evidenceDigest: '1'.repeat(64) } as any;
      },
      resolveSimulation: ({ candidate }: any) => ({
        schemaVersion: 'canonical-paper-simulation-authority-v1', status: 'READY', blockers: [],
        marketAdapterIdentity: { market: candidate.signal.market }, executionPolicy: { version: 'public-evidence-simulated-paper-v1' },
        orderPolicy: { version: 'public-evidence-simulated-market-order-v1' },
        execution: { dataEvidence: { dataQuality: 'READY', ...(candidate.signal.market === 'CRYPTO_FUTURES' ? { leverage: 3 } : {}) },
          costPolicy: { version: candidate.signal.strategyIdentity.costPolicyVersion } },
        order: { type: 'MARKET', direction: candidate.signal.direction, quantity: 1 },
        quote: { bid: 99, ask: 100 }, executionAuthority: 'NONE', simulatedOnly: true, liveOrderAllowed: false,
        privateTradingApiAllowed: false, orderSubmitted: false, exchangeRequestSent: false, productionMutationAllowed: false,
      }) as any,
      runCycle: async (input: any) => {
        cycleCandidate = input.candidates[0];
        const sample = {
          paperSampleId: `sample-${item.requestMarket}`, status: 'OPEN',
          identity: { candidateId: cycleCandidate.candidateId, signalId: cycleCandidate.signal.signalId },
          fill: { filledQuantity: 1, fillPrice: 100, notional: 100 },
        };
        const position = {
          positionId: `position-${item.requestMarket}`, candidateId: cycleCandidate.candidateId,
          signalId: cycleCandidate.signal.signalId, market: cycleCandidate.signal.market, symbol: cycleCandidate.signal.symbol,
          direction: cycleCandidate.signal.direction, quantity: 1, entryFillPrice: 100, lifecycleState: 'OPEN',
        };
        return { state: { samples: [sample], positions: [position] }, summary: { entries: 1, replayed: false } } as any;
      },
    });
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        mode: 'approval', accountMode: 'paper', adapter: 'paper', market: item.requestMarket, symbol: item.symbol,
        timeframe, side: item.action, searchRunId: runId, signalId: card.signalId,
      }) });
      const body = await response.json() as Record<string, any>;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true); assert.equal(body.serverVerified, true); assert.equal(body.executionConnected, true);
      assert.equal(body.plan.candidateId, sourceCandidate.candidateId);
      assert.equal(body.plan.market, item.canonicalMarket); assert.equal(body.plan.side, item.action);
      assert.equal(body.plan.leverage, item.canonicalMarket === 'CRYPTO_FUTURES' ? 3 : null);
      assert.equal(body.plan.leverageProvenance, item.canonicalMarket === 'CRYPTO_FUTURES'
        ? 'CANONICAL_SIMULATION_DATA_EVIDENCE' : 'NOT_APPLICABLE_CASH_OR_SPOT');
      assert.equal(cycleCandidate.leverage, body.plan.leverage);
      assert.equal(body.position.candidateId, sourceCandidate.candidateId);
      assert.equal(cycleCandidate.signal.strategyIdentity.parameterHash, sourceCandidate.signal.strategyIdentity.parameterHash);
      assert.equal(cycleCandidate.signal.strategyIdentity.researchCodeSha, sha);
      assert.equal(cycleCandidate.sampleExecutionReady, true);
      assert.equal(body.orderSubmitted, false); assert.equal(body.exchangeRequestSent, false);
      assert.equal(body.privateTradingApiAllowed, false); assert.equal(body.liveOrderEnabled, false);
      assert.equal(body.naturalSampleCredit, 0); assert.equal(body.evidenceCredit, 0);
      assert.equal(body.profitabilityClaimAllowed, false);
    } finally { await close(server); }
  }
});

async function unavailableMarketIntelligence(
  input: Pick<TradingPlanInput, 'exchange' | 'market' | 'symbol'>,
) {
  return marketIntelligenceNotAvailable(
    tradingMarket(input),
    marketIntelligenceSymbolForTradingPlan(input),
    'TEST_MARKET_INTELLIGENCE_UNAVAILABLE',
  );
}

async function startServer(authenticated = true, role: 'regular' | 'admin' = 'regular') {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => {
    const authenticatedRequest = req as AuthenticatedRequest;
    authenticatedRequest.member = {
      id: USER, login_name: 'test', display_name: 'test', role, membership_level: role,
      status: 'approved', is_active: true,
    };
    authenticatedRequest.accessToken = 'test';
    next();
  });
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.beforeEach(async () => {
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  setTradingPlanMarketIntelligenceRunnerForTests(unavailableMarketIntelligence);
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  await repository.setGlobalEmergencyStop(false, USER);
});
test.after(() => {
  setTradeAutomationRepositoryFactoryForTests(null);
  setTradeExitPreviewReadersFactoryForTests(null);
  setTradingPlanMarketIntelligenceRunnerForTests(null);
  delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
});

test('exit preview re-reads the real position in read-only mode and never submits a trade', async () => {
  let reads = 0;
  setTradeExitPreviewReadersFactoryForTests(() => ({
    toss: async () => {
      reads += 1;
      const checkedAt = new Date().toISOString();
      return {
        provider: 'toss' as const,
        readOnly: true as const,
        connected: true,
        status: 'CONNECTED' as const,
        accounts: null,
        balances: null,
        positions: [{
          market: 'KR',
          symbol: '005930',
          quantity: 20,
          availableQuantity: 20,
          averageEntryPrice: 70_000,
          currentPrice: 72_000,
          marketValue: 1_440_000,
          unrealizedPnl: 40_000,
          unrealizedPnlPercent: 2.86,
          leverage: null,
          liquidationPrice: null,
          marginMode: null,
          side: null,
        }],
        openOrders: null,
        checkedAt,
        lastGoodAt: checkedAt,
        stale: false,
        errorCode: null,
        orderRequests: 0 as const,
        cancelRequests: 0 as const,
        amendRequests: 0 as const,
        transferRequests: 0 as const,
        withdrawalRequests: 0 as const,
        credentialsReturned: false as const,
        liveTradingEnabled: false as const,
        autoTradingEnabled: false as const,
      };
    },
  }));

  const { server, baseUrl } = await startServer();
  try {
    const missingConfirmation = await fetch(`${baseUrl}/api/trade-automation/positions/exit-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'toss', market: 'KR', symbol: '005930', percent: 25 }),
    });
    assert.equal(missingConfirmation.status, 409);
    assert.equal(reads, 0);

    const response = await fetch(`${baseUrl}/api/trade-automation/positions/exit-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmed: true,
        provider: 'toss',
        market: 'KR',
        symbol: '005930',
        percent: 25,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      preview: {
        provider: string;
        exitQuantity: number;
        side: string;
        reduceOnly: boolean;
        stale: boolean;
      };
      privateAccountReadPerformed: boolean;
      orderSubmitted: boolean;
      orderCanceled: boolean;
      orderAmended: boolean;
      privateTradingMutationSent: boolean;
      executionAuthority: string;
      executionReadiness: {
        connectionConfigured: boolean;
        providerVerified: boolean;
        manualServerGateEnabled: boolean;
        readyForManualExitEvaluation: boolean;
        blockers: string[];
        orderSubmissionPerformedByPreview: boolean;
        executionAuthorityGrantedByPreview: boolean;
      };
    };
    assert.equal(reads, 1);
    assert.equal(body.preview.provider, 'toss');
    assert.equal(body.preview.exitQuantity, 5);
    assert.equal(body.preview.side, 'sell');
    assert.equal(body.preview.reduceOnly, true);
    assert.equal(body.preview.stale, false);
    assert.equal(body.privateAccountReadPerformed, true);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.orderCanceled, false);
    assert.equal(body.orderAmended, false);
    assert.equal(body.privateTradingMutationSent, false);
    assert.equal(body.executionAuthority, 'NONE');
    assert.equal(body.executionReadiness.readyForManualExitEvaluation, false);
    assert.equal(body.executionReadiness.connectionConfigured, false);
    assert.equal(body.executionReadiness.orderSubmissionPerformedByPreview, false);
    assert.equal(body.executionReadiness.executionAuthorityGrantedByPreview, false);
    assert.ok(body.executionReadiness.blockers.includes('LIVE_CONNECTION_NOT_CONFIGURED'));
  } finally {
    setTradeExitPreviewReadersFactoryForTests(null);
    await close(server);
  }
});

test('status is authenticated, automatic execution defaults off, and never returns credential values', async () => {
  const unauthenticated = await startServer(false);
  try {
    const response = await fetch(`${unauthenticated.baseUrl}/api/trade-automation/status`);
    assert.equal(response.status, 401);
  } finally { await close(unauthenticated.server); }

  const authenticated = await startServer();
  try {
    const response = await fetch(`${authenticated.baseUrl}/api/trade-automation/status`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /encryptedCredentials|accessKey|secretKey|passphrase/);
    const body = JSON.parse(text) as {
      policy: { mode: string; automaticEnabled: boolean };
      liveExecutionServerEnabled: Record<string, boolean>;
      liveAutomaticExecutionServerEnabled: Record<string, boolean>;
      actualOrderSubmittedByStatusRequest: boolean;
    };
    assert.equal(body.policy.mode, 'approval');
    assert.equal(body.policy.automaticEnabled, false);
    assert.deepEqual(body.liveExecutionServerEnabled, { bitget: false, upbit: false, kiwoom: false, toss: false });
    assert.deepEqual(body.liveAutomaticExecutionServerEnabled, { bitget: false, upbit: false, kiwoom: false, toss: false });
    assert.equal(body.actualOrderSubmittedByStatusRequest, false);
  } finally { await close(authenticated.server); }
});

test('automatic policy cannot be enabled without explicit final confirmation', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/policy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'automatic',
        automaticEnabled: true,
        exchangeEnabled: { upbit: true },
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'AUTOMATIC_TRADING_CONFIRMATION_REQUIRED');
  } finally { await close(server); }
});

test('persistent global emergency stop requires admin capability and exact confirmation', async () => {
  const regular = await startServer(true, 'regular');
  try {
    const denied = await fetch(`${regular.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: true, confirmation: 'STOP_ALL_TRADING' }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { error: string }).error, 'ADMIN_REQUIRED');
  } finally { await close(regular.server); }

  const admin = await startServer(true, 'admin');
  try {
    const missingConfirmation = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stopped: true }),
    });
    assert.equal(missingConfirmation.status, 409);

    const stopped = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: true, confirmation: 'STOP_ALL_TRADING' }),
    });
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json() as {
      persistentGlobalEmergencyStopped: boolean;
      automaticTradingEnabledByThisRequest: boolean;
    };
    assert.equal(stoppedBody.persistentGlobalEmergencyStopped, true);
    assert.equal(stoppedBody.automaticTradingEnabledByThisRequest, false);

    const status = await fetch(`${admin.baseUrl}/api/trade-automation/status`);
    const statusBody = await status.json() as { emergencyStopSources: { persistentGlobal: boolean } };
    assert.equal(statusBody.emergencyStopSources.persistentGlobal, true);

    const resumed = await fetch(`${admin.baseUrl}/api/trade-automation/admin/emergency-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopped: false, confirmation: 'RESUME_NEW_ORDER_EVALUATION' }),
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as { automaticTradingEnabledByThisRequest: boolean }).automaticTradingEnabledByThisRequest, false);
  } finally { await close(admin.server); }
});

test('connection registration rejects withdrawal permission and does not echo secrets', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const rejected = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: { accessKey: 'access-secret', secretKey: 'signing-secret' },
        permissions: ['orders', 'withdrawal'],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(await rejected.text(), /access-secret|signing-secret/);

    const accepted = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: { accessKey: 'access-secret', secretKey: 'signing-secret' },
        permissions: ['orders'],
        accountMode: 'paper',
      }),
    });
    assert.equal(accepted.status, 200);
    const text = await accepted.text();
    assert.doesNotMatch(text, /access-secret|signing-secret/);
    const body = JSON.parse(text) as { credentialsReturned: boolean; accountMode: string };
    assert.equal(body.credentialsReturned, false);
    assert.equal(body.accountMode, 'paper');
  } finally { await close(server); }
});


test('live trading connection requires explicit purpose plus read+orders and never activates by credential save', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const credentials = { accessKey: 'live-access-secret', secretKey: 'live-signing-secret' };

    for (const [name, payload, expected] of [
      ['missing purpose', {
        credentials, accountMode: 'live', permissions: ['read', 'orders'],
      }, 'LIVE_EXECUTION_PURPOSE_CONFIRMATION_REQUIRED'],
      ['missing read', {
        credentials, accountMode: 'live', purpose: 'live_execution', permissions: ['orders'],
      }, 'LIVE_EXECUTION_READ_AND_ORDER_PERMISSIONS_REQUIRED'],
      ['extra transfer', {
        credentials, accountMode: 'live', purpose: 'live_execution', permissions: ['read', 'orders', 'transfer'],
      }, 'WITHDRAWAL_OR_TRANSFER_PERMISSION_NOT_ALLOWED'],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400, name);
      const text = await response.text();
      assert.match(text, new RegExp(expected), name);
      assert.doesNotMatch(text, /live-access-secret|live-signing-secret/, name);
    }

    const accepted = await fetch(`${baseUrl}/api/trade-automation/connections/upbit`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials,
        accountMode: 'live',
        purpose: 'live_execution',
        permissions: ['read', 'orders'],
      }),
    });
    assert.equal(accepted.status, 200);
    const text = await accepted.text();
    assert.doesNotMatch(text, /live-access-secret|live-signing-secret/);
    const body = JSON.parse(text) as {
      configured: boolean;
      accountMode: string;
      credentialsReturned: boolean;
      liveExecutionActivated: boolean;
      providerMutationRequests: number;
    };
    assert.equal(body.configured, true);
    assert.equal(body.accountMode, 'live');
    assert.equal(body.credentialsReturned, false);
    assert.equal(body.liveExecutionActivated, false);
    assert.equal(body.providerMutationRequests, 0);

    const missingVerifyConfirmation = await fetch(`${baseUrl}/api/trade-automation/connections/upbit/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missingVerifyConfirmation.status, 409);
    assert.equal(
      (await missingVerifyConfirmation.json() as { error: string }).error,
      'LIVE_EXECUTION_VERIFICATION_CONFIRMATION_REQUIRED',
    );

    const nativeFetch = globalThis.fetch;
    let financialMutationRequests = 0;
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith(baseUrl)) return nativeFetch(input, init);
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (url.includes('api.upbit.com/v1/orders') && method !== 'GET') {
          financialMutationRequests += 1;
          throw new Error('TEST_FINANCIAL_MUTATION_FORBIDDEN');
        }
        if (url.includes('api.upbit.com/v1/accounts')) {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`UNEXPECTED_LIVE_VERIFY_REQUEST:${method}:${url}`);
      };

      const verified = await globalThis.fetch(`${baseUrl}/api/trade-automation/connections/upbit/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      assert.equal(verified.status, 200);
      const verifiedBody = await verified.json() as {
        verified: boolean;
        credentialsReturned: boolean;
        liveExecutionActivated: boolean;
        automaticLiveExecutionActivated: boolean;
        orderRequests: number;
        cancelRequests: number;
        amendRequests: number;
        transferRequests: number;
        withdrawalRequests: number;
        realOrderSubmitted: boolean;
      };
      assert.equal(verifiedBody.verified, true);
      assert.equal(verifiedBody.credentialsReturned, false);
      assert.equal(verifiedBody.liveExecutionActivated, false);
      assert.equal(verifiedBody.automaticLiveExecutionActivated, false);
      assert.equal(verifiedBody.orderRequests, 0);
      assert.equal(verifiedBody.cancelRequests, 0);
      assert.equal(verifiedBody.amendRequests, 0);
      assert.equal(verifiedBody.transferRequests, 0);
      assert.equal(verifiedBody.withdrawalRequests, 0);
      assert.equal(verifiedBody.realOrderSubmitted, false);
      assert.equal(financialMutationRequests, 0);

      const readinessResponse = await nativeFetch(`${baseUrl}/api/trade-automation/status`);
      assert.equal(readinessResponse.status, 200);
      const readinessBody = await readinessResponse.json() as {
        liveExecutionReadiness: Record<string, {
          connectionConfigured: boolean;
          providerVerified: boolean;
          manualServerGateEnabled: boolean;
          automaticServerGateEnabled: boolean;
          readyForManualOrderEvaluation: boolean;
          readyForAutomaticOrderEvaluation: boolean;
          blockers: string[];
          orderSubmissionPerformedByStatusRequest: boolean;
        }>;
      };
      const upbitReadiness = readinessBody.liveExecutionReadiness.upbit;
      assert.equal(upbitReadiness.connectionConfigured, true);
      assert.equal(upbitReadiness.providerVerified, true);
      assert.equal(upbitReadiness.manualServerGateEnabled, false);
      assert.equal(upbitReadiness.automaticServerGateEnabled, false);
      assert.equal(upbitReadiness.readyForManualOrderEvaluation, false);
      assert.equal(upbitReadiness.readyForAutomaticOrderEvaluation, false);
      assert.ok(upbitReadiness.blockers.includes('MANUAL_LIVE_SERVER_GATE_OFF'));
      assert.ok(upbitReadiness.blockers.includes('AUTOMATIC_LIVE_SERVER_GATE_OFF'));
      assert.equal(upbitReadiness.orderSubmissionPerformedByStatusRequest, false);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  } finally { await close(server); }
});

test('automatic policy executes US-stock Paper without per-order approval or private credentials', async () => {
  const { server, baseUrl } = await startServer();
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  try {
    const policyResponse = await nativeFetch(`${baseUrl}/api/trade-automation/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'automatic',
        automaticEnabled: true,
        marketEnabled: {
          domestic_stock: true,
          us_stock: true,
          crypto_spot: true,
          crypto_futures: true,
        },
        exchangeEnabled: { bitget: true, upbit: true, kiwoom: true },
        enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
        enabledStrategies: [],
        confirmation: { acknowledged: true },
      }),
    });
    assert.equal(policyResponse.status, 200);
    const savedPolicy = await policyResponse.json() as {
      policy: { mode: string; automaticEnabled: boolean; marketEnabled: Record<string, boolean> };
    };
    assert.equal(savedPolicy.policy.mode, 'automatic');
    assert.equal(savedPolicy.policy.automaticEnabled, true);
    assert.deepEqual(savedPolicy.policy.marketEnabled, {
      domestic_stock: true,
      us_stock: true,
      crypto_spot: true,
      crypto_futures: true,
    });

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) {
        outbound += 1;
        throw new Error('external blocked');
      }
      return nativeFetch(input, init);
    };

    const observedAt = new Date().toISOString();
    const body = {
      exchange: 'kiwoom',
      accountMode: 'paper',
      stockExchange: 'NASDAQ',
      strategyId: 'trend-breakout-v1',
      signalId: 'us-paper-auto-signal',
      symbol: 'AAPL',
      market: 'US',
      side: 'buy',
      orderType: 'market',
      quoteAmount: null,
      quantity: 10,
      limitPrice: null,
      estimatedKrw: 100000,
      stopPrice: 90,
      targetPrices: [110],
      splitRatios: [100],
      signalReasons: ['trend', 'breakout'],
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
        currentPrice: 100,
        plannedPrice: 100,
        marketStatus: 'OPEN',
        availableLiquidityKrw: 1000000,
        estimatedSlippagePercent: 0.1,
        estimatedFeePercent: 0.05,
        signalState: 'entry_ready',
        signalObservedAt: observedAt,
      },
    };

    const response = await globalThis.fetch(`${baseUrl}/api/trade-automation/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as {
      ok: boolean;
      plan: { id: string; state: string; riskEnvelope?: { version: number; investmentKrw: number } };
      order: { state: string; exchangeOrderId: string | null };
      automaticExecutionTriggered: boolean;
      orderSubmitted: boolean;
    };
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.state, 'SUBMITTED');
    assert.equal(payload.plan.riskEnvelope?.version, 1);
    assert.equal(payload.plan.riskEnvelope?.investmentKrw, 100000);
    assert.equal(payload.automaticExecutionTriggered, true);
    assert.equal(payload.order.state, 'FILLED');
    assert.match(String(payload.order.exchangeOrderId), /^paper-/u);
    assert.equal(payload.orderSubmitted, false);
    assert.equal(outbound, 0);

    const queueResponse = await globalThis.fetch(`${baseUrl}/api/trade-automation/approval-queue`);
    assert.equal(queueResponse.status, 200);
    const queueBody = await queueResponse.json() as { items: Array<{ id: string }> };
    assert.equal(queueBody.items.some((item) => item.id === payload.plan.id), false);

    const redundantApproval = await globalThis.fetch(`${baseUrl}/api/trade-automation/plans/${payload.plan.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(redundantApproval.status, 400);
    assert.equal((await redundantApproval.json() as { error: string }).error, 'TRADE_PLAN_NOT_APPROVAL_PENDING');
  } finally {
    globalThis.fetch = nativeFetch;
    await close(server);
  }
});
