import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const expectedDeploySha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_TRADING_CORE_ARTIFACT_DIR ?? 'production-trading-core-artifacts',
);
const enabled = process.env.PRODUCTION_TRADING_CORE_QA === 'true';
const prepareMemberAutoPolicy = process.env.PRODUCTION_TRADING_CORE_PREPARE_POLICY === 'true';

test.skip(!enabled, 'Production Trading Core QA runs only in the dedicated protected workflow.');

if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
  if (!qaLogin || !qaPassword) throw new Error('Production QA login credential is required');
  if (!/^[0-9a-f]{40}$/.test(expectedDeploySha)) throw new Error('EXPECTED_DEPLOY_SHA must be exact');
  if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_DEPLOY_RUN_ID must be exact');
  }
}

type ApiResult<T> = { ok: boolean; status: number; body: T };

async function appApi<T>(
  page: Page,
  pathname: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET',
  body?: unknown,
): Promise<ApiResult<T>> {
  const accessToken = await productionReadOnlyAccessToken(page);
  if (!accessToken) throw new Error('PRODUCTION_TRADING_CORE_AUTH_TOKEN_MISSING');
  return page.evaluate(async ({ pathname, method, body, token }) => {
    const response = await fetch(pathname, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined
        ? { Accept: 'application/json', Authorization: `Bearer ${token}` }
        : { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 200) }; }
    return { ok: response.ok, status: response.status, body: payload };
  }, { pathname, method, body, token: accessToken }) as Promise<ApiResult<T>>;
}

function writeEvidence(value: unknown) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(artifactDir, 'production-trading-core-qa.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function providerState(connections: any[], provider: string) {
  return connections.find((row) => String(row?.exchange ?? row?.provider ?? '').toLowerCase() === provider) ?? null;
}

function memberAutoPolicyReadiness(policy: any) {
  const blockers: string[] = [];
  const requireTrue = (value: unknown, code: string) => {
    if (value !== true) blockers.push(code);
  };
  const requirePositive = (value: unknown, code: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) blockers.push(code);
  };

  if (policy?.mode !== 'automatic') blockers.push('MODE_NOT_AUTOMATIC');
  requireTrue(policy?.automaticEnabled, 'MEMBER_AUTOMATIC_DISABLED');
  if (policy?.emergencyStopped !== false) blockers.push('EMERGENCY_STOPPED');
  if (policy?.newEntriesStopped !== false) blockers.push('NEW_ENTRIES_STOPPED');
  for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
    requireTrue(policy?.marketEnabled?.[market], `MARKET_DISABLED:${market}`);
  }

  const domesticBroker = policy?.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom';
  for (const provider of ['kiwoom', 'upbit', 'bitget', domesticBroker]) {
    requireTrue(policy?.exchangeEnabled?.[provider], `PROVIDER_DISABLED:${provider}`);
  }
  if (policy?.stockBrokerByMarket?.us_stock !== 'kiwoom') blockers.push('US_STOCK_BROKER_NOT_KIWOOM');

  const leverage = Number(policy?.bitgetLeverage);
  if (!Number.isInteger(leverage) || leverage < 2 || leverage > 7) blockers.push('BITGET_LEVERAGE_OUT_OF_POLICY');
  requireTrue(policy?.riskOptimizationEnabled, 'RISK_OPTIMIZATION_DISABLED');
  if (!['limited-50', 'validated'].includes(String(policy?.pilotStage ?? ''))) {
    blockers.push('PILOT_LIVE_DISABLED');
  }
  for (const key of ['totalCapitalKrw', 'maxOrderKrw', 'maxInstrumentKrw', 'maxOpenPositions', 'maxDailyOrders']) {
    requirePositive(policy?.[key], `INVALID_LIMIT:${key}`);
  }
  for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
    requirePositive(policy?.maxAssetClassKrw?.[market], `INVALID_MARKET_LIMIT:${market}`);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    domesticBroker,
    bitgetLeverage: leverage,
    pilotStage: String(policy?.pilotStage ?? ''),
  };
}

function preparedMemberAutoPolicy(policy: any) {
  const domesticBroker = policy?.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom';
  const requestedLeverage = Number(policy?.bitgetLeverage);
  const bitgetLeverage = Number.isInteger(requestedLeverage)
    && requestedLeverage >= 2
    && requestedLeverage <= 7
    ? requestedLeverage
    : 2;
  return {
    ...policy,
    mode: 'automatic',
    automaticEnabled: true,
    emergencyStopped: false,
    newEntriesStopped: false,
    marketEnabled: {
      ...(policy?.marketEnabled ?? {}),
      domestic_stock: true,
      us_stock: true,
      crypto_spot: true,
      crypto_futures: true,
    },
    stockBrokerByMarket: {
      ...(policy?.stockBrokerByMarket ?? {}),
      domestic_stock: domesticBroker,
      us_stock: 'kiwoom',
    },
    exchangeEnabled: {
      ...(policy?.exchangeEnabled ?? {}),
      bitget: true,
      upbit: true,
      kiwoom: true,
      toss: true,
    },
    bitgetLeverage,
    riskOptimizationEnabled: true,
    pilotStage: policy?.pilotStage === 'validated' ? 'validated' : 'limited-50',
    confirmation: { acknowledged: true },
  };
}

test('Trading Core: provider -> Paper Auto -> Journal -> Telegram closes with zero real order authority', async ({ page }) => {
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });

  let statusBefore = await appApi<any>(page, '/api/trade-automation/status');
  expect(statusBefore.ok).toBe(true);
  expect(statusBefore.body?.ok).toBe(true);

  const autoServer = statusBefore.body?.liveAutomaticExecutionServerEnabled ?? {};
  for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
    expect(autoServer?.[provider], `Trading Core canary requires LIVE AUTO server gate OFF before QA: ${provider}`).toBe(false);
    const connection = providerState(statusBefore.body?.connections ?? [], provider);
    expect(connection, `missing provider connection ${provider}`).not.toBeNull();
    expect(connection?.configured, `${provider} must be configured`).toBe(true);
    expect(Boolean(connection?.lastVerifiedAt), `${provider} must be verified`).toBe(true);
    expect(connection?.lastErrorCode ?? null, `${provider} must have no verification error`).toBeNull();
  }

  let memberAutoPolicyPrepared = false;
  if (prepareMemberAutoPolicy) {
    const prepared = await appApi<any>(
      page,
      '/api/trade-automation/policy',
      'PUT',
      preparedMemberAutoPolicy(statusBefore.body.policy),
    );
    expect(prepared.ok, JSON.stringify(prepared.body)).toBe(true);
    expect(prepared.body?.ok).toBe(true);
    expect(memberAutoPolicyReadiness(prepared.body?.policy).ready).toBe(true);

    statusBefore = await appApi<any>(page, '/api/trade-automation/status');
    expect(statusBefore.ok).toBe(true);
    expect(statusBefore.body?.ok).toBe(true);
    expect(memberAutoPolicyReadiness(statusBefore.body?.policy).ready).toBe(true);
    for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
      expect(
        statusBefore.body?.liveAutomaticExecutionServerEnabled?.[provider],
        `Member policy preparation must not grant LIVE AUTO server authority: ${provider}`,
      ).toBe(false);
    }
    memberAutoPolicyPrepared = true;
  }

  const integrationBefore = await appApi<any>(page, '/api/user-integrations');
  expect(integrationBefore.ok).toBe(true);
  expect(integrationBefore.body?.ok).toBe(true);
  expect(integrationBefore.body?.telegramStorageAvailable).toBe(true);
  const telegramConnectedBefore = integrationBefore.body?.telegram?.connected === true;
  const telegramRuntimeReady = integrationBefore.body?.telegramRuntime?.deliveryReady === true
    && integrationBefore.body?.telegramRuntime?.backgroundWorkersEnabled === true
    && integrationBefore.body?.telegramRuntime?.personalWorkerEnabled === true;
  const telegramActivationState = telegramConnectedBefore && telegramRuntimeReady
    ? 'ACTIVE_VERIFIED' as const
    : 'READY_FOR_ACTIVATION' as const;

  const originalPolicy = structuredClone(statusBefore.body.policy);
  const originalPolicyReadiness = memberAutoPolicyReadiness(originalPolicy);
  const originalPreferences = structuredClone(integrationBefore.body.preferences ?? {});
  const canarySignalId = `trading-core-qa:${expectedDeploySha.slice(0, 12)}:${Date.now()}`;
  const canaryStrategy = 'TRADING_CORE_QA_CANARY';
  let paperAutomaticTriggered = false;
  let paperFilled = false;
  let journalVisible = false;
  let deliveryQueued = 0;
  let telegramDelivered = false;
  let syncInserted = 0;

  try {
    const qaPolicy = {
      ...originalPolicy,
      mode: 'automatic',
      automaticEnabled: true,
      emergencyStopped: false,
      newEntriesStopped: false,
      marketEnabled: {
        domestic_stock: false,
        us_stock: false,
        crypto_spot: true,
        crypto_futures: false,
      },
      exchangeEnabled: {
        bitget: false,
        upbit: true,
        kiwoom: false,
        toss: false,
      },
      enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
      enabledStrategies: [canaryStrategy],
      totalCapitalKrw: 1_000_000,
      maxOrderKrw: 100_000,
      maxInstrumentKrw: 1_000_000,
      maxAssetClassKrw: {
        domestic_stock: 1_000_000,
        us_stock: 1_000_000,
        crypto_spot: 1_000_000,
        crypto_futures: 1_000_000,
      },
      maxAssetPercent: 30,
      maxOpenPositions: 5,
      maxDailyOrders: 20,
      maxConsecutiveLosses: 3,
      riskOptimizationEnabled: true,
      pilotStage: 'validated',
      riskPerTradePercent: {
        ...(originalPolicy?.riskPerTradePercent ?? {}),
        upbit: 0.5,
      },
      totalDailyLossLimitPercent: 1,
      minExpectedValueR: 0.15,
      minStrategySampleSize: 50,
      minProfitFactor: 1.2,
      maxStrategyDrawdownPercent: 15,
      maxEstimatedSlippagePercent: 0.25,
      maxAverageSpreadPercent: 0.15,
      maxCorrelatedExposurePercent: 40,
      maxEconomicsAgeHours: 24,
      confirmation: { acknowledged: true },
    };
    const saved = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', qaPolicy);
    expect(saved.ok, JSON.stringify(saved.body)).toBe(true);
    expect(saved.body?.policy?.mode).toBe('automatic');
    expect(saved.body?.policy?.automaticEnabled).toBe(true);

    const preferences = await appApi<any>(page, '/api/user-integrations/notifications', 'PATCH', {
      ORDER_SUBMITTED: true,
      ORDER_PARTIALLY_FILLED: true,
      ORDER_FILLED: true,
    });
    expect(preferences.ok, JSON.stringify(preferences.body)).toBe(true);

    const now = new Date().toISOString();
    const plan = {
      exchange: 'upbit',
      accountMode: 'paper',
      stockBroker: null,
      stockExchange: null,
      strategyId: canaryStrategy,
      signalId: canarySignalId,
      symbol: 'BTC',
      market: 'KRW',
      side: 'buy',
      orderType: 'market',
      quantity: null,
      quoteAmount: 5_000,
      limitPrice: 100_000,
      estimatedKrw: 5_000,
      stopPrice: 99_000,
      targetPrices: [102_000],
      splitRatios: [100],
      leverage: null,
      marginMode: null,
      reduceOnly: false,
      invalidateAction: 'hold',
      signalReasons: ['TRADING_CORE_QA_CANARY', 'PAPER_ONLY_PRODUCTION_QA'],
      marketSnapshot: {
        observedAt: now,
        riskObservedAt: now,
        dataDelayMs: 0,
        oneMinuteMovePercent: 0,
        spreadPercent: 0.05,
        orderbookGapPercent: 0.05,
        halted: false,
        availableBalance: 1_000_000,
        accountValueKrw: 1_000_000,
        dailyPnlPercent: 0,
        weeklyPnlPercent: 0,
        assetExposurePercent: 0,
        accountExposureKrw: 0,
        instrumentExposureKrw: 0,
        strategyExposureKrw: 0,
        assetClassExposureKrw: 0,
        openRiskKrw: 0,
        openPositionCount: 0,
        dailyOrderCount: 0,
        consecutiveLosses: 0,
        currentPrice: 100_000,
        plannedPrice: 100_000,
        marketStatus: 'OPEN',
        availableLiquidityKrw: 1_000_000,
        estimatedSlippagePercent: 0.05,
        estimatedFeePercent: 0.05,
        correlatedExposurePercent: 0,
        signalState: 'entry_ready',
        signalObservedAt: now,
        source: 'PRODUCTION_TRADING_CORE_QA_CANARY',
      },
      entryPrice: 100_000,
      entryZoneLow: 99_900,
      entryZoneHigh: 100_100,
      estimatedSlippagePercent: 0.05,
      averageSpreadPercent: 0.05,
      economics: {
        sampleSize: 100,
        winProbability: 0.6,
        averageWinR: 2,
        averageLossR: 1,
        estimatedCostsR: 0.05,
        profitFactor: 2,
        maxDrawdownPercent: 5,
        marketRegime: 'bull',
        calibratedAt: now,
      },
    };
    const created = await appApi<any>(page, '/api/trade-automation/plans', 'POST', plan);
    expect(created.ok, JSON.stringify(created.body)).toBe(true);
    expect(created.body?.ok).toBe(true);
    expect(created.body?.automaticExecutionTriggered).toBe(true);
    expect(created.body?.orderSubmitted).toBe(false);
    expect(JSON.stringify(created.body)).toContain('FILLED');
    paperAutomaticTriggered = true;
    paperFilled = true;

    const synced = await appApi<any>(page, '/api/user-integrations/execution/sync', 'POST', {});
    expect(synced.ok, JSON.stringify(synced.body)).toBe(true);
    expect(synced.body?.ok).toBe(true);
    syncInserted = Number(synced.body?.inserted ?? 0);
    deliveryQueued = Number(synced.body?.deliveryQueued ?? 0);
    expect(syncInserted).toBeGreaterThanOrEqual(1);
    if (telegramActivationState === 'ACTIVE_VERIFIED') {
      expect(deliveryQueued).toBeGreaterThanOrEqual(1);
    } else {
      expect(deliveryQueued).toBe(0);
    }

    const journal = await appApi<any>(
      page,
      `/api/paper-journal/unified-ledger?range=30D&source=APP_PAPER&strategy=${encodeURIComponent(canaryStrategy)}`,
    );
    expect(journal.ok, JSON.stringify(journal.body)).toBe(true);
    const journalText = JSON.stringify(journal.body);
    expect(journalText).toContain(canaryStrategy);
    expect(journalText).toContain(canarySignalId);
    journalVisible = true;

    if (telegramActivationState === 'ACTIVE_VERIFIED') {
      const telegram = await appApi<any>(page, '/api/user-integrations/telegram/test', 'POST', {});
      expect(telegram.ok, JSON.stringify(telegram.body)).toBe(true);
      expect(telegram.body?.status).toBe('DELIVERED');
      expect(telegram.body?.testOnly).toBe(true);
      expect(telegram.body?.investmentSignal).toBe(false);
      expect(telegram.body?.ordersSubmitted).toBe(0);
      telegramDelivered = true;
    }
  } finally {
    const restorePreferences = await appApi<any>(
      page,
      '/api/user-integrations/notifications',
      'PATCH',
      originalPreferences,
    );
    expect(restorePreferences.ok, JSON.stringify(restorePreferences.body)).toBe(true);

    const restore = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', {
      ...originalPolicy,
      confirmation: { acknowledged: true },
    });
    expect(restore.ok, JSON.stringify(restore.body)).toBe(true);
  }

  const statusAfter = await appApi<any>(page, '/api/trade-automation/status');
  expect(statusAfter.ok).toBe(true);
  expect(statusAfter.body?.ok).toBe(true);
  expect(statusAfter.body?.actualOrderSubmittedByStatusRequest).toBe(false);

  writeEvidence({
    schemaVersion: 'production-trading-core-qa-v4',
    targetSha: expectedDeploySha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: {
      toss: 'PASS',
      kiwoom: 'PASS',
      upbit: 'PASS',
      bitget: 'PASS',
    },
    paperAutomaticTriggered,
    paperFilled,
    journalVisible,
    executionSyncInserted: syncInserted,
    telegramActivationState,
    telegramActivationReady: true,
    telegramUserConnectionRequired: !telegramConnectedBefore,
    telegramPersonalActivationRequired: !telegramConnectedBefore || !telegramRuntimeReady,
    telegramConnectedBefore,
    telegramRuntimeReady,
    telegramDeliveryQueued: deliveryQueued,
    telegramTestDelivered: telegramDelivered,
    policyRestored: JSON.stringify(statusAfter.body?.policy) === JSON.stringify(originalPolicy),
    memberAutoPolicyPrepared,
    memberAutoPolicyReady: originalPolicyReadiness.ready,
    memberAutoPolicyBlockers: originalPolicyReadiness.blockers,
    memberAutoDomesticBroker: originalPolicyReadiness.domesticBroker,
    memberAutoBitgetLeverage: originalPolicyReadiness.bitgetLeverage,
    memberAutoPilotStage: originalPolicyReadiness.pilotStage,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  });
});
