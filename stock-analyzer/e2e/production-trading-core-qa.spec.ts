import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
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
const requireTelegramActivation = process.env.PRODUCTION_TRADING_CORE_REQUIRE_TELEGRAM === 'true';

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
  const pilotStage = String(policy?.pilotStage ?? '');
  if (!['approval-20', 'limited-50', 'validated', 'formula-ai-exception'].includes(pilotStage)) {
    blockers.push('PILOT_STAGE_INVALID');
  }
  const livePilotReady = ['limited-50', 'validated', 'formula-ai-exception'].includes(pilotStage);
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
    pilotStage,
    livePilotReady,
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
    confirmation: { acknowledged: true },
  };
}

test('Trading Core: provider -> Paper Auto -> Journal closes with optional Telegram and zero real order authority', async ({ page }) => {
  // The authorized Telegram worker ticks every 30s by default; its delivery
  // cadence must not race against the 30s poll boundary during Production QA.
  test.setTimeout(4 * 60_000);
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

  // Collect separate, member-scoped Worker readiness BEFORE any temporary
  // canary policy changes. A synthetic fill is not a real background tick.
  const paperRuntime = await appApi<any>(page, '/api/trade-automation/paper-runtime-readiness');
  expect(paperRuntime.ok, JSON.stringify(paperRuntime.body)).toBe(true);
  expect(paperRuntime.body?.readOnlyProbe).toBe(true);
  expect(paperRuntime.body?.memberScope).toBe('SELF');
  expect(paperRuntime.body?.financialMutationCount).toBe(0);
  expect(paperRuntime.body?.privateProviderRequests).toBe(0);
  expect(paperRuntime.body?.orderSubmitted).toBe(false);
  expect(paperRuntime.body?.exchangeRequestSent).toBe(false);
  expect(paperRuntime.body?.realOrderAuthorityGranted).toBe(false);
  const paperRuntimeBlockersBeforeQa: string[] = Array.isArray(paperRuntime.body?.blockers)
    ? paperRuntime.body.blockers.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  const paperRuntimeReadyBeforeQa = paperRuntime.body?.readyForPaperEvaluation === true;
  expect(paperRuntimeReadyBeforeQa).toBe(paperRuntimeBlockersBeforeQa.length === 0);

  const originalPolicy = structuredClone(statusBefore.body.policy);
  // Protected Production QA must not clear a member's explicit safety stop.
  if (originalPolicy?.emergencyStopped !== false || originalPolicy?.newEntriesStopped !== false) {
    throw new Error('PRODUCTION_TRADING_CORE_MEMBER_STOP_ACTIVE');
  }
  // The member policy guard is intentionally monotonic: tightening risk budgets
  // cannot be undone by a subsequent member PUT. Refuse non-restorable baselines.
  if (originalPolicy?.riskOptimizationEnabled !== true) {
    throw new Error('PRODUCTION_TRADING_CORE_RISK_BASELINE_NOT_RESTORABLE');
  }
  const minimumCanaryKrw = 5_000;
  if ([
    originalPolicy?.totalCapitalKrw,
    originalPolicy?.maxOrderKrw,
    originalPolicy?.maxInstrumentKrw,
    originalPolicy?.maxAssetClassKrw?.crypto_spot,
  ].some((value) => typeof value !== 'number' || value < minimumCanaryKrw)) {
    throw new Error('PRODUCTION_TRADING_CORE_CANARY_BUDGET_TOO_LOW');
  }
  const qaCapitalKrw: number = originalPolicy.totalCapitalKrw;
  const originalPolicyReadiness = memberAutoPolicyReadiness(originalPolicy);
  let preparedPolicyReadiness = originalPolicyReadiness;
  let memberAutoPolicyPrepared = false;
  let memberAutoResumePrepared = false;
  let integrationBefore: ApiResult<any>;
  try {
    // The shared journal repository must remain readable, but an
    // automation_research release explicitly excludes Telegram connection and
    // delivery. Only a release that opts into Telegram may be blocked by an
    // external bot/chat recovery state or Worker readiness.
    integrationBefore = await appApi<any>(page, '/api/user-integrations');
    expect(integrationBefore.ok).toBe(true);
    expect(integrationBefore.body?.ok).toBe(true);
    expect(integrationBefore.body?.telegramStorageAvailable).toBe(true);
    if (requireTelegramActivation && integrationBefore.body?.telegram?.recoveryRequired === true) {
      throw new Error(`PRODUCTION_TRADING_CORE_TELEGRAM_RECONNECT_REQUIRED:${String(
        integrationBefore.body?.telegram?.recoveryErrorCode ?? 'TELEGRAM_CONNECTION_RECOVERY_REQUIRED',
      ).replace(/[^A-Z0-9_:-]/giu, '_').slice(0, 120)}`);
    }
    if (requireTelegramActivation && integrationBefore.body?.telegram?.connected !== true) {
      throw new Error('PRODUCTION_TRADING_CORE_TELEGRAM_CONNECTION_REQUIRED');
    }
    if (requireTelegramActivation && integrationBefore.body?.telegram?.connected === true) {
      const worker = integrationBefore.body?.telegramRuntime ?? {};
      if (worker.deliveryReady !== true || worker.backgroundWorkersEnabled !== true
        || worker.personalWorkerEnabled !== true || worker.personalWorkerStarted !== true
        || worker.workerActivationApproved !== true) {
        throw new Error('PRODUCTION_TRADING_CORE_TELEGRAM_WORKER_NOT_READY');
      }
    }

    if (prepareMemberAutoPolicy) {
      const prepared = await appApi<any>(
        page,
        '/api/trade-automation/policy',
        'PUT',
        preparedMemberAutoPolicy(statusBefore.body.policy),
      );
      expect(prepared.ok, JSON.stringify(prepared.body)).toBe(true);
      expect(prepared.body?.ok).toBe(true);
      // From this point every later failure must restore the captured policy.
      memberAutoPolicyPrepared = true;
      preparedPolicyReadiness = memberAutoPolicyReadiness(prepared.body?.policy);
      expect(preparedPolicyReadiness.ready).toBe(true);

      statusBefore = await appApi<any>(page, '/api/trade-automation/status');
      expect(statusBefore.ok).toBe(true);
      expect(statusBefore.body?.ok).toBe(true);
      preparedPolicyReadiness = memberAutoPolicyReadiness(statusBefore.body?.policy);
      expect(preparedPolicyReadiness.ready).toBe(true);
      for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
        expect(
          statusBefore.body?.liveAutomaticExecutionServerEnabled?.[provider],
          `Member policy preparation must not grant LIVE AUTO server authority: ${provider}`,
        ).toBe(false);
      }
    }
  } catch (preflightError) {
    // Member policy preparation may have resumed STOP before later assertions fail.
    // Restore the exact captured policy even when the main canary never starts.
    if (memberAutoPolicyPrepared) {
      try {
        const restored = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', {
          ...originalPolicy,
          confirmation: { acknowledged: true },
        });
        if (!restored.ok || restored.body?.ok !== true) {
          throw new Error(`POLICY_RESTORE_HTTP_${restored.status}`);
        }
        const verified = await appApi<any>(page, '/api/trade-automation/status');
        if (!verified.ok || verified.body?.ok !== true
          || !isDeepStrictEqual(verified.body?.policy, originalPolicy)) {
          throw new Error('POLICY_RESTORE_STATE_MISMATCH');
        }
      } catch (restoreError) {
        throw new Error('PRODUCTION_TRADING_CORE_PREFLIGHT_RESTORE_FAILED', {
          cause: new AggregateError([preflightError, restoreError]),
        });
      }
    }
    throw preflightError;
  }

  const telegramConnectedBefore = requireTelegramActivation
    && integrationBefore.body?.telegram?.connected === true;
  const telegramRuntimeReady = requireTelegramActivation
    && integrationBefore.body?.telegramRuntime?.deliveryReady === true
    && integrationBefore.body?.telegramRuntime?.backgroundWorkersEnabled === true
    && integrationBefore.body?.telegramRuntime?.personalWorkerEnabled === true
    && integrationBefore.body?.telegramRuntime?.personalWorkerStarted === true
    && integrationBefore.body?.telegramRuntime?.workerActivationApproved === true;
  const telegramActivationState = telegramConnectedBefore && telegramRuntimeReady
    ? 'ACTIVE_VERIFIED' as const
    : 'READY_FOR_ACTIVATION' as const;

  const originalPreferences = structuredClone(integrationBefore.body.preferences ?? {});
  const canarySignalId = `trading-core-qa:${expectedDeploySha.slice(0, 12)}:${Date.now()}`;
  const canaryStrategy = 'TRADING_CORE_QA_CANARY';
  let paperAutomaticTriggered = false;
  let paperFilled = false;
  let journalVisible = false;
  let deliveryQueued = 0;
  let telegramDelivered = false;
  let telegramFillDeliveryConfirmed = false;
  let syncInserted = 0;

  try {
    // Only reversible canary scope changes. Do not lower risk ceilings or raise
    // risk floors: member writes enforce monotonic risk hardening and cannot
    // restore stronger limits after an exploratory QA override.
    const qaPolicy = {
      ...originalPolicy,
      mode: 'automatic',
      automaticEnabled: true,
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
      confirmation: { acknowledged: true },
    };
    const saved = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', qaPolicy);
    expect(saved.ok, JSON.stringify(saved.body)).toBe(true);
    expect(saved.body?.policy?.mode).toBe('automatic');
    expect(saved.body?.policy?.automaticEnabled).toBe(true);

    // A Telegram-excluded release must not accidentally queue or deliver the
    // Paper canary even when the member reconnects Telegram independently.
    // Preserve and restore the member's exact preferences around the canary.
    const preferences = await appApi<any>(page, '/api/user-integrations/notifications', 'PATCH', {
      ORDER_SUBMITTED: requireTelegramActivation,
      ORDER_PARTIALLY_FILLED: requireTelegramActivation,
      ORDER_FILLED: requireTelegramActivation,
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
        availableBalance: qaCapitalKrw,
        accountValueKrw: qaCapitalKrw,
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

    const canaryOrderId = String(created.body?.order?.id ?? '');
    expect(canaryOrderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(created.body?.order?.planId).toBe(created.body?.plan?.id);
    expect(created.body?.order?.state).toBe('FILLED');
    expect(created.body?.plan?.accountMode).toBe('paper');
    expect(created.body?.plan?.executionMode).toBe('automatic');
    // Production QA must not replay and reclassify an unrelated user's historic
    // event history. The exact new, owned simulated fill is the only sync scope.
    const synced = await appApi<any>(page, '/api/user-integrations/execution/sync', 'POST', {
      orderId: canaryOrderId,
    });
    expect(synced.ok, JSON.stringify(synced.body)).toBe(true);
    expect(synced.body?.ok).toBe(true);
    expect(synced.body?.scopedToOrder).toBe(true);
    expect(Number(synced.body?.scanned ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(synced.body?.missingReferences ?? -1)).toBe(0);
    expect(synced.body?.privateApiRequests).toBe(0);
    expect(synced.body?.ordersSubmitted).toBe(0);
    expect(synced.body?.ordersCancelled).toBe(0);
    syncInserted = Number(synced.body?.inserted ?? 0);
    deliveryQueued = Number(synced.body?.deliveryQueued ?? 0);
    const filledDeliveryIds: string[] = Array.isArray(synced.body?.filledDeliveryIds)
      ? synced.body.filledDeliveryIds.filter((id: unknown) =>
        typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      : [];
    expect(syncInserted).toBeGreaterThanOrEqual(1);
    if (telegramActivationState === 'ACTIVE_VERIFIED') {
      expect(deliveryQueued).toBeGreaterThanOrEqual(1);
      expect(filledDeliveryIds.length).toBeGreaterThanOrEqual(1);
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
      // Poll authenticated user-owned delivery receipts for the exact fresh fill.
      // A separate [TEST] bot message is not proof that this fill was delivered.
      await expect.poll(async () => {
        const current = await appApi<any>(page, '/api/user-integrations');
        if (!current.ok || current.body?.ok !== true || !Array.isArray(current.body?.deliveries)) return false;
        return filledDeliveryIds.some((id) => current.body.deliveries.some((delivery: any) =>
          delivery?.id === id && delivery?.state === 'SENT'
          && (delivery?.kind ?? 'EXECUTION_EVENT') === 'EXECUTION_EVENT'));
      }, { timeout: 90_000, intervals: [1_000, 2_000, 3_000, 5_000] }).toBe(true);
      telegramFillDeliveryConfirmed = true;
      const telegram = await appApi<any>(page, '/api/user-integrations/telegram/test', 'POST', {});
      expect(telegram.ok, JSON.stringify(telegram.body)).toBe(true);
      expect(telegram.body?.status).toBe('DELIVERED');
      expect(telegram.body?.testOnly).toBe(true);
      expect(telegram.body?.investmentSignal).toBe(false);
      expect(telegram.body?.ordersSubmitted).toBe(0);
      telegramDelivered = true;
    }
  } finally {
    // A preferences restoration failure must never skip policy restoration.
    const restoreFailures: string[] = [];
    try {
      const restorePreferences = await appApi<any>(
        page,
        '/api/user-integrations/notifications',
        'PATCH',
        originalPreferences,
      );
      if (!restorePreferences.ok || restorePreferences.body?.ok !== true) {
        restoreFailures.push(`PREFERENCES_HTTP_${restorePreferences.status}`);
      }
    } catch {
      restoreFailures.push('PREFERENCES_REQUEST_FAILED');
    }

    try {
      const restoredPolicy = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', {
        ...originalPolicy,
        confirmation: { acknowledged: true },
      });
      if (!restoredPolicy.ok || restoredPolicy.body?.ok !== true) {
        restoreFailures.push(`POLICY_HTTP_${restoredPolicy.status}`);
      } else {
        const verified = await appApi<any>(page, '/api/trade-automation/status');
        if (!verified.ok || verified.body?.ok !== true
          || !isDeepStrictEqual(verified.body?.policy, originalPolicy)) {
          restoreFailures.push('POLICY_STATE_MISMATCH');
        }
      }
    } catch {
      restoreFailures.push('POLICY_REQUEST_FAILED');
    }
    if (restoreFailures.length > 0) {
      throw new Error(`PRODUCTION_TRADING_CORE_RESTORE_FAILED:${restoreFailures.join(',')}`);
    }
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
    // Independent Production background Worker readiness, never inferred from
    // the directly created and simulated one-order QA canary.
    paperRuntimeReadOnlyVerified: true,
    paperRuntimeReadyBeforeQa,
    paperRuntimeBlockersBeforeQa,
    paperRuntimeWalletReadyBeforeQa: paperRuntime.body?.paperWalletReady === true,
    paperRuntimeWorkerFreshBeforeQa: paperRuntime.body?.workerTickFresh === true,
    journalVisible,
    executionSyncInserted: syncInserted,
    telegramActivationState,
    telegramActivationReady: true,
    telegramRequiredForQa: requireTelegramActivation,
    telegramDeliverySuppressedDuringQa: !requireTelegramActivation,
    telegramUserConnectionRequired: !telegramConnectedBefore,
    telegramPersonalActivationRequired: !telegramConnectedBefore || !telegramRuntimeReady,
    telegramConnectedBefore,
    telegramRuntimeReady,
    telegramDeliveryQueued: deliveryQueued,
    telegramTestDelivered: telegramDelivered,
    telegramFillDeliveryConfirmed,
    policyRestored: isDeepStrictEqual(statusAfter.body?.policy, originalPolicy),
    memberAutoPolicyPrepared,
    memberAutoResumePrepared,
    memberAutoPolicyReady: preparedPolicyReadiness.ready,
    memberAutoPolicyBlockers: preparedPolicyReadiness.blockers,
    memberAutoDomesticBroker: preparedPolicyReadiness.domesticBroker,
    memberAutoBitgetLeverage: preparedPolicyReadiness.bitgetLeverage,
    memberAutoPilotStage: preparedPolicyReadiness.pilotStage,
    memberAutoLivePilotReady: preparedPolicyReadiness.livePilotReady,
    memberAutoOriginalPilotStage: originalPolicyReadiness.pilotStage,
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
