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

test('Trading Core: provider -> Paper Auto -> Journal -> Telegram closes with zero real order authority', async ({ page }) => {
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });

  const statusBefore = await appApi<any>(page, '/api/trade-automation/status');
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

  const integrationBefore = await appApi<any>(page, '/api/user-integrations');
  expect(integrationBefore.ok).toBe(true);
  expect(integrationBefore.body?.ok).toBe(true);
  expect(integrationBefore.body?.telegramStorageAvailable).toBe(true);
  expect(integrationBefore.body?.telegram?.connected).toBe(true);
  expect(integrationBefore.body?.telegramRuntime?.deliveryReady).toBe(true);
  expect(integrationBefore.body?.telegramRuntime?.backgroundWorkersEnabled).toBe(true);
  expect(integrationBefore.body?.telegramRuntime?.personalWorkerEnabled).toBe(true);

  const originalPolicy = structuredClone(statusBefore.body.policy);
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
    expect(deliveryQueued).toBeGreaterThanOrEqual(1);

    const journal = await appApi<any>(
      page,
      `/api/paper-journal/unified-ledger?range=30D&source=APP_PAPER&strategy=${encodeURIComponent(canaryStrategy)}`,
    );
    expect(journal.ok, JSON.stringify(journal.body)).toBe(true);
    const journalText = JSON.stringify(journal.body);
    expect(journalText).toContain(canaryStrategy);
    expect(journalText).toContain(canarySignalId);
    journalVisible = true;

    const telegram = await appApi<any>(page, '/api/user-integrations/telegram/test', 'POST', {});
    expect(telegram.ok, JSON.stringify(telegram.body)).toBe(true);
    expect(telegram.body?.status).toBe('DELIVERED');
    expect(telegram.body?.testOnly).toBe(true);
    expect(telegram.body?.investmentSignal).toBe(false);
    expect(telegram.body?.ordersSubmitted).toBe(0);
    telegramDelivered = true;
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
    schemaVersion: 'production-trading-core-qa-v1',
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
    telegramDeliveryQueued: deliveryQueued,
    telegramTestDelivered: telegramDelivered,
    policyRestored: JSON.stringify(statusAfter.body?.policy) === JSON.stringify(originalPolicy),
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
