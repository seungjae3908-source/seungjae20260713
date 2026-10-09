import type { TradingPolicy } from './trade-automation.types';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import {
  ADMIN_MARKET_INITIAL_KRW,
  inspectAdminFourMarketPaperWallets,
} from './admin-four-market-paper-capital.service';
import {
  AUTOMATIC_PAPER_ACCOUNT_ID,
  automaticPaperCapitalPolicyReady,
  automaticPaperWalletServerEpochMs,
  selectAutomaticPaperAccountEquity,
  type MemberAutoTradingBackgroundRuntimeHealth,
} from './member-auto-trading-background-worker.service';

export type AutomaticPaperRuntimeMode = 'DISABLED' | 'PAPER_ONLY' | 'SHARED_BACKGROUND';

export type MemberAutomaticPaperReadinessInput = Readonly<{
  policy: TradingPolicy;
  wallet: StoredPaperJournalRecord | null;
  administratorFourMarket?: boolean;
  adminMarketWalletRecords?: readonly StoredPaperJournalRecord[];
  workerHealth: MemberAutoTradingBackgroundRuntimeHealth;
  workerMode: AutomaticPaperRuntimeMode;
  globalStopped: boolean;
  nowMs: number;
}>;

export function memberAutomaticPaperReadiness(input: MemberAutomaticPaperReadinessInput) {
  const { policy, workerHealth, workerMode, nowMs } = input;
  const blockers: string[] = [];
  const account = input.wallet && input.wallet.kind === 'account'
    && input.wallet.id === AUTOMATIC_PAPER_ACCOUNT_ID ? [input.wallet] : [];
  const equity = selectAutomaticPaperAccountEquity(account);
  const epoch = automaticPaperWalletServerEpochMs(account, nowMs);
  const adminWallets = input.administratorFourMarket === true
    ? inspectAdminFourMarketPaperWallets(input.adminMarketWalletRecords ?? [], nowMs)
    : null;
  const paperWalletReady = adminWallets
    ? adminWallets.ready : equity !== null && epoch !== null;
  if (!paperWalletReady) blockers.push(adminWallets
    ? 'BACKGROUND_ADMIN_FOUR_MARKET_WALLETS_REQUIRED' : 'BACKGROUND_PAPER_WALLET_REQUIRED');
  if (adminWallets && !adminWallets.ready) blockers.push(...adminWallets.blockers);
  const paperCapitalPolicyReady = adminWallets
    ? Number.isFinite(policy.totalCapitalKrw)
      && policy.totalCapitalKrw >= ADMIN_MARKET_INITIAL_KRW
    : automaticPaperCapitalPolicyReady(policy);
  if (!paperCapitalPolicyReady) blockers.push(adminWallets
    ? 'BACKGROUND_ADMIN_MARKET_POLICY_1M_REQUIRED' : 'BACKGROUND_PAPER_CAPITAL_POLICY_TOO_LOW');

  const enabledMarketCount = Object.values(policy.marketEnabled).filter((value) => value === true).length;
  const domesticBroker = policy.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom';
  const routableMarkets = [
    policy.marketEnabled.domestic_stock && policy.exchangeEnabled[domesticBroker],
    policy.marketEnabled.us_stock && policy.exchangeEnabled.kiwoom,
    policy.marketEnabled.crypto_spot && policy.exchangeEnabled.upbit,
    policy.marketEnabled.crypto_futures && policy.exchangeEnabled.bitget,
  ];
  const connectedPolicyMarketCount = routableMarkets.filter((value) => value === true).length;
  const strategyAllowlistReady = Array.isArray(policy.enabledStrategies)
    && policy.enabledStrategies.some((strategy) => typeof strategy === 'string' && strategy.trim().length > 0);
  if (policy.mode !== 'automatic' || policy.automaticEnabled !== true) blockers.push('BACKGROUND_MEMBER_AUTO_POLICY_OFF');
  if (policy.emergencyStopped || policy.newEntriesStopped || input.globalStopped) blockers.push('BACKGROUND_TRADING_STOP_ACTIVE');
  if (enabledMarketCount === 0) blockers.push('BACKGROUND_MEMBER_MARKETS_DISABLED');
  if (connectedPolicyMarketCount === 0) blockers.push('BACKGROUND_MARKET_PROVIDER_POLICY_DISABLED');
  if (adminWallets && connectedPolicyMarketCount !== 4) {
    blockers.push('BACKGROUND_ADMIN_FOUR_MARKETS_NOT_ENABLED');
  }
  if (!strategyAllowlistReady) blockers.push('BACKGROUND_STRATEGY_ALLOWLIST_REQUIRED');

  // A shared Worker might gain Live authority under separate environment
  // flags. This readiness contract is intentionally for isolated Paper only.
  const paperOnlyMode = workerMode === 'PAPER_ONLY' && workerHealth.liveModeRequested === false
    && workerHealth.liveEntriesArmed === false;
  if (!paperOnlyMode) blockers.push('BACKGROUND_PAPER_ONLY_WORKER_REQUIRED');

  const tickMs = Date.parse(workerHealth.lastTickAt ?? '');
  const workerTickFresh = workerHealth.enabled === true
    && workerHealth.tickOk === true
    && Number.isFinite(nowMs) && Number.isFinite(tickMs)
    && tickMs <= nowMs + 5_000
    && nowMs - tickMs <= 360_000;
  if (!workerTickFresh) blockers.push('BACKGROUND_WORKER_TICK_NOT_HEALTHY');
  if (workerHealth.newEntriesFailClosed !== false) blockers.push('BACKGROUND_NEW_ENTRIES_FAIL_CLOSED');

  const handoffReady = workerTickFresh && workerHealth.handoffStatus === 'READY'
    && workerHealth.handoffReady === true;
  if (!handoffReady) blockers.push('BACKGROUND_CANONICAL_HANDOFF_NOT_READY');

  const executionProjectionReady = workerTickFresh && workerHealth.executionSyncFailures === 0
    && workerHealth.executionSyncMissingReferences === 0
    && workerHealth.errorCode === null;
  if (!executionProjectionReady) blockers.push('BACKGROUND_EXECUTION_PROJECTION_NOT_HEALTHY');

  const uniqueBlockers = [...new Set(blockers)];
  return {
    readyForPaperEvaluation: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    workerMode,
    paperWalletReady,
    administratorFourMarket: adminWallets != null,
    adminMarketWalletsReady: adminWallets?.ready ?? null,
    paperCapitalPolicyReady,
    strategyAllowlistReady,
    enabledMarketCount,
    connectedPolicyMarketCount,
    paperOnlyMode,
    workerTickFresh,
    handoffReady,
    executionProjectionReady,
    // Paper-only runtime inspection never grants financial authority.
    realOrderAuthorityGranted: false as const,
  };
}
