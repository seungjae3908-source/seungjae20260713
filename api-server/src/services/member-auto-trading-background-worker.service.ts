import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveMemberTier, hasCapability, type MemberAccessProfile } from '../../../packages/member-access/src/index.js';
import {
  validateMemberAutoTradingPaperHandoff,
  type MemberAutoTradingPaperHandoff,
  type MemberAutoTradingPaperHandoffEntry,
} from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  createServiceRoleTradingRepository,
  type TradingRepository,
} from './trade-automation.repository';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { liveEntryArmPresent } from './member-auto-trading-live-arm.service';
import { liveConnectionVerificationFresh } from './live-connection-verification.service';
import { canonicalAiReviewEvidenceValid } from './member-auto-trading-ai-review-evidence.service';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import {
  createServiceRolePaperJournalRepository,
} from './paper-journal-supabase.repository';
import type { PaperJournalRepository } from './paper-journal.types';
import type {
  ExchangeConnection,
  TradingAssetClass,
  TradingExchange,
  TradingOrder,
  TradingPlan,
  TradingPlanInput,
  TradingPolicy,
  TradingSide,
} from './trade-automation.types';
import {
  resolveMemberAutoTradingKrwRate,
  type MemberAutoTradingFxQuote,
} from './member-auto-trading-fx.service';
import { persistMemberAutoTradingPaperPositionBridge } from './member-auto-trading-paper-position-bridge.service';
import { createVaultBackedAccountReaders } from '../features/account-readonly/account-readonly.runtime';
import type { AccountProvider, CanonicalAccountSnapshot } from '../features/account-readonly/account-readonly.contract';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import {
  automaticExitReason,
  buildAutomaticExitPlanInput
} from './member-auto-trading-exit-plan.service';
import {
  readMemberAutoTradingMarketMark,
  type MemberAutoTradingMarketMark,
} from './member-auto-trading-market-mark.service';
import { TradeExecutionEventBridgeService } from '../features/user-broker-telegram/trade-execution-event-bridge.service';
import { createSupabaseUserBrokerTelegramRepository } from '../features/user-broker-telegram/user-broker-telegram.repository';
import { CanonicalPortfolioSyncSink } from '../features/user-broker-telegram/user-broker-telegram.runtime';
import { UserBrokerTelegramService } from '../features/user-broker-telegram/user-broker-telegram.service';
import { readUserTelegramDeliveryWorkerHealth, userTelegramDeliveryWorkerHealthy, verifiedRecentTelegramDeliveryReceipt } from '../features/user-broker-telegram/user-broker-telegram.worker';
import type { TelegramTransport, UserTelegramConnection } from '../features/user-broker-telegram/user-broker-telegram.types';
import {
  evaluateRulePackPilotEntryGuard,
  deriveRulePackPilotExecutionPolicy,
  issueRulePackPilotDynamicCapReceipt,
  readRulePackPilotCapitalState,
  type RulePackPilotCapitalState,
} from './trade-rule-pack-pilot-capital.service';
import {
  isEvidenceBackedAutoStrategyId,
  RULE_PACK_PILOT_PROFILE,
} from './evidence-backed-auto-strategy-catalog.service';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
const DEFAULT_HANDOFF_PATH =
  '/opt/stock-app-data/paper-forward-v1/runtime-state/handoff/member-auto-trading-latest.json';
const MAX_MEMBERS_PER_TICK = 200;
const MAX_ENTRIES_PER_TICK = 40;
// A READY handoff without entries otherwise has no per-entry freshness clock.
// Keep a bounded publisher heartbeat even during quiet market periods.
const MAX_READY_HANDOFF_AGE_MS = 30 * 60_000;
const executionProjectionTransport: TelegramTransport = {
  async send() {
    return { ok: false, errorCode: 'TELEGRAM_DELIVERY_WORKER_REQUIRED' };
  },
};
type EligibleMember = Readonly<{
  userId: string;
  profile: MemberAccessProfile;
  policy: TradingPolicy;
}>;

type MemberRuntimeState = Readonly<{
  // Never use missing Paper equity as a zero-PnL proof to authorize entries.
  paperAccountReady: boolean;
  accountEquity: number;
  dailyPnlPercent: number;
  weeklyPnlPercent: number;
  consecutiveLosses: number;
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
}>;

export interface MemberAutoTradingBackgroundSource {
  readHandoff(nowMs: number): Promise<MemberAutoTradingPaperHandoff | null>;
  listEligibleMembers(): Promise<readonly EligibleMember[]>;
  memberBatchCycleCompleted?(): boolean;
  telegramDeliveryHealthy?(nowMs: number): boolean;
  memberTelegramConnected?(userId: string): Promise<boolean>;
  revalidateLiveAllFourReadiness?(userId: string): Promise<boolean>;
  tradingRepositoryFor(userId: string): TradingRepository;
  paperJournalRepositoryFor(userId: string): PaperJournalRepository;
  resolveFx(
    market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
    nowMs: number,
  ): Promise<MemberAutoTradingFxQuote>;
  readLiveAccountSnapshot(userId: string, provider: AccountProvider): Promise<CanonicalAccountSnapshot>;
  readMarketMark(
    market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
    symbol: string,
  ): Promise<MemberAutoTradingMarketMark>;
  syncExecutionEvents?(input: {
    userId: string;
    profile: MemberAccessProfile;
    repository: TradingRepository;
    paperJournalRepository: PaperJournalRepository;
  }): Promise<{ inserted: number; deliveryQueued: number; missingReferences: number }>;
}

export type MemberAutoTradingBackgroundRunResult = {
  handoffStatus: 'MISSING' | 'BLOCKED_DATA' | 'READY';
  handoffReady: boolean;
  newEntriesFailClosed: boolean;
  liveEntriesArmed: boolean;
  liveEntryWarmupComplete: boolean;
  liveEntriesSuppressedByWarmupOrArm: number;
  liveEntriesSuppressedByTelegram: number;
  liveExitsSuppressedByWarmupOrArm: number;
  liveExitsSuppressedByPolicy: number;
  runtimeRefreshes: number;
  executionSyncBlocks: number;
  overlapSkipped: boolean;
  liveOrderEligibleMembers: number;
  livePolicyReadyMembers: number;
  liveAllFourPolicyReadyMembers: number;
  liveReadinessCycleComplete: boolean;
  liveCycleOrderEligible: boolean;
  liveCyclePolicyReady: boolean;
  liveCycleAllFourPolicyReady: boolean;
  globalEmergencyStopActive: boolean;
  members: number;
  entries: number;
  evaluated: number;
  skipped: number;
  blocked: number;
  createdPlans: number;
  filledOrders: number;
  positionLifecycles: number;
  lifecycleIdempotent: number;
  duplicates: number;
  failures: number;
  livePlans: number;
  liveOrders: number;
  paperExitOrders: number;
  liveExitOrders: number;
  liveTrackedPositions: number;
  exitBlocked: number;
  privateTradingRequests: number;
  executionEventsInserted: number;
  notificationDeliveriesQueued: number;
  executionSyncMissingReferences: number;
  executionSyncFailures: number;
  liveEntryArmPresent: boolean;
};

export type MemberAutoTradingBackgroundRuntimeHealth = Readonly<{
  enabled: boolean;
  liveModeRequested: boolean;
  lastTickAt: string | null;
  tickOk: boolean | null;
  handoffStatus: MemberAutoTradingBackgroundRunResult['handoffStatus'];
  handoffReady: boolean;
  newEntriesFailClosed: boolean;
  liveEntryArmPresent: boolean;
  liveEntriesArmed: boolean;
  liveEntryWarmupComplete: boolean;
  startupWarmupObserved: boolean;
  firstWarmupTickLiveEntriesArmed: boolean | null;
  firstWarmupTickLiveOrders: number | null;
  firstWarmupTickLiveExitOrders: number | null;
  liveTrackedPositions: number;
  liveExitsSuppressedByWarmupOrArm: number;
  liveExitsSuppressedByPolicy: number;
  executionSyncFailures: number;
  executionSyncMissingReferences: number;
  liveOrderEligibleMembers: number;
  livePolicyReadyMembers: number;
  liveAllFourPolicyReadyMembers: number;
  liveReadinessCycleComplete: boolean;
  liveCycleOrderEligible: boolean;
  liveCyclePolicyReady: boolean;
  liveCycleAllFourPolicyReady: boolean;
  globalEmergencyStopActive: boolean;
  errorCode: string | null;
}>;

let backgroundRuntimeHealth: MemberAutoTradingBackgroundRuntimeHealth = Object.freeze({
  enabled: false,
  liveModeRequested: false,
  lastTickAt: null,
  tickOk: null,
  handoffStatus: 'MISSING',
  handoffReady: false,
  newEntriesFailClosed: true,
  liveEntryArmPresent: false,
  liveEntriesArmed: false,
  liveEntryWarmupComplete: false,
  startupWarmupObserved: false,
  firstWarmupTickLiveEntriesArmed: null,
  firstWarmupTickLiveOrders: null,
  firstWarmupTickLiveExitOrders: null,
  liveTrackedPositions: 0,
  liveExitsSuppressedByWarmupOrArm: 0,
  liveExitsSuppressedByPolicy: 0,
  executionSyncFailures: 0,
  executionSyncMissingReferences: 0,
  liveOrderEligibleMembers: 0,
  livePolicyReadyMembers: 0,
  liveAllFourPolicyReadyMembers: 0,
  liveReadinessCycleComplete: true,
  liveCycleOrderEligible: false,
  liveCyclePolicyReady: false,
  liveCycleAllFourPolicyReady: false,
  globalEmergencyStopActive: false,
  errorCode: null,
});

export function readMemberAutoTradingBackgroundRuntimeHealth() {
  return backgroundRuntimeHealth;
}


function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveMemberStockBroker(
  policy: TradingPolicy,
  market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
): 'kiwoom' | 'toss' | null {
  if (market === 'KR_STOCK') return policy.stockBrokerByMarket?.domestic_stock ?? 'kiwoom';
  if (market === 'US_STOCK') return 'kiwoom';
  return null;
}

export function marketMapping(
  market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
  policy: TradingPolicy,
): {
  exchange: TradingExchange;
  assetClass: TradingAssetClass;
  planMarket: string;
  stockBroker: 'kiwoom' | 'toss' | null;
} {
  if (market === 'KR_STOCK') {
    const stockBroker = resolveMemberStockBroker(policy, market);
    if (!stockBroker) throw new Error('BACKGROUND_STOCK_BROKER_REQUIRED');
    return {
      exchange: stockBroker,
      assetClass: 'domestic_stock',
      planMarket: 'KR',
      stockBroker,
    };
  }
  if (market === 'US_STOCK') {
    const stockBroker = resolveMemberStockBroker(policy, market);
    if (!stockBroker) throw new Error('BACKGROUND_STOCK_BROKER_REQUIRED');
    return {
      exchange: stockBroker,
      assetClass: 'us_stock',
      planMarket: 'US',
      stockBroker,
    };
  }
  if (market === 'CRYPTO_SPOT') {
    return { exchange: 'upbit', assetClass: 'crypto_spot', planMarket: 'KRW', stockBroker: null };
  }
  return { exchange: 'bitget', assetClass: 'crypto_futures', planMarket: 'USDT-FUTURES', stockBroker: null };
}

function sideFor(direction: MemberAutoTradingPaperHandoffEntry['identity']['direction']): TradingSide {
  if (direction === 'BUY') return 'buy';
  if (direction === 'LONG') return 'long';
  return 'short';
}

function currentPrice(entry: MemberAutoTradingPaperHandoffEntry) {
  const quote = record(entry.publicQuote);
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!positive(bid) || !positive(ask) || ask < bid) throw new Error('BACKGROUND_TOP_OF_BOOK_REQUIRED');
  const midpoint = (bid + ask) / 2;
  return {
    bid,
    ask,
    midpoint,
    executionPrice: entry.identity.direction === 'SHORT' ? bid : ask,
    spreadPercent: (ask - bid) / midpoint * 100,
  };
}

function recentMovePercent(entry: MemberAutoTradingPaperHandoffEntry, observedAtMs: number, midpoint: number) {
  const learning = record(entry.signal.learningSnapshot);
  const reference = Number(learning?.referencePrice ?? learning?.entryPrice);
  const dataTimestampMs = isoMs(learning?.dataTimestamp);
  if (!positive(reference) || dataTimestampMs == null
    || dataTimestampMs > observedAtMs || observedAtMs - dataTimestampMs > 60_000) {
    throw new Error('BACKGROUND_ONE_MINUTE_MOVE_EVIDENCE_REQUIRED');
  }
  return (midpoint - reference) / reference * 100;
}

function exitPlan(entry: MemberAutoTradingPaperHandoffEntry) {
  const learning = record(entry.signal.learningSnapshot);
  const stop = Number(learning?.stopLoss);
  const targets = [learning?.target1, learning?.target2]
    .map(Number)
    .filter((value): value is number => positive(value));
  if (!positive(stop) || targets.length === 0) throw new Error('BACKGROUND_EXIT_PLAN_REQUIRED');
  const price = currentPrice(entry).executionPrice;
  const long = entry.identity.direction !== 'SHORT';
  if ((long && stop >= price) || (!long && stop <= price)) throw new Error('BACKGROUND_STOP_DIRECTION_INVALID');
  if (targets.some((target) => long ? target <= price : target >= price)) {
    throw new Error('BACKGROUND_TARGET_DIRECTION_INVALID');
  }
  return { stop, targets };
}

function costPercent(entry: MemberAutoTradingPaperHandoffEntry, key: string) {
  const cost = record(entry.execution.costPolicy);
  const rate = Number(cost?.[key]);
  return finite(rate) && rate >= 0 ? rate * 100 : null;
}

// Only canonical, signal-bound upstream AI evidence may authorize the formula
// exception. An absent review means NO live order; never manufacture PASS.
export function formulaAiReviewReasonsForLive(
  entry: MemberAutoTradingPaperHandoffEntry,
  nowMs: number,
): string[] {
  const review = (entry as MemberAutoTradingPaperHandoffEntry & { aiReviewEvidence?: unknown }).aiReviewEvidence;
  if (!canonicalAiReviewEvidenceValid(review, entry.identity, entry.evaluatedAtMs)
    || !review || nowMs >= review.expiresAtMs || nowMs < review.reviewedAtMs) {
    throw new Error('BACKGROUND_FORMULA_AI_REVIEW_PROOF_REQUIRED');
  }
  return [
    `STRATEGY_RULE_PACK:${entry.identity.strategyId}`,
    'STRATEGY_RULE_PACK_GATE:PAPER_CANDIDATE',
    'AI_REVIEW_DECISION:PASS',
    'AI_REVIEW_LIVE_ELIGIBLE:PASS_ONLY_ELIGIBLE',
    `AI_REVIEW_EVIDENCE:${review.evidenceDigest}`,
    `AI_REVIEW_EXPIRES:${new Date(review.expiresAtMs).toISOString()}`,
  ];
}

function automaticPolicyHasRunnableMarket(policy: TradingPolicy) {
  if (policy.mode !== 'automatic' || !policy.automaticEnabled || policy.emergencyStopped || policy.newEntriesStopped) {
    return false;
  }
  const domesticBroker = policy.stockBrokerByMarket?.domestic_stock ?? 'kiwoom';
  return (policy.marketEnabled.domestic_stock && policy.exchangeEnabled[domesticBroker])
    || (policy.marketEnabled.us_stock && policy.exchangeEnabled.kiwoom)
    || (policy.marketEnabled.crypto_spot && policy.exchangeEnabled.upbit)
    || (policy.marketEnabled.crypto_futures && policy.exchangeEnabled.bitget);
}

function automaticPolicyHasAllFourMarkets(policy: TradingPolicy) {
  if (policy.mode !== 'automatic' || !policy.automaticEnabled || policy.emergencyStopped || policy.newEntriesStopped) {
    return false;
  }
  if (policy.pilotStage === 'approval-20') return false;
  const domesticBroker = policy.stockBrokerByMarket?.domestic_stock ?? 'kiwoom';
  return policy.marketEnabled.domestic_stock
    && policy.marketEnabled.us_stock
    && policy.marketEnabled.crypto_spot
    && policy.marketEnabled.crypto_futures
    && policy.exchangeEnabled[domesticBroker]
    && policy.exchangeEnabled.kiwoom
    && policy.exchangeEnabled.upbit
    && policy.exchangeEnabled.bitget;
}

export function liveAllFourConnectionVerificationReady(
  policy: TradingPolicy,
  connections: readonly ExchangeConnection[],
  nowMs = Date.now(),
) {
  if (!automaticPolicyHasAllFourMarkets(policy)) return false;
  const required: readonly TradingExchange[] = ['toss', 'kiwoom', 'upbit', 'bitget'];
  return required.every((exchange) =>
    liveConnectionVerificationFresh(
      connections.find((connection) => connection.exchange === exchange),
      nowMs,
    ));
}

function validateFormulaAiPilotEntry(
  member: EligibleMember,
  entry: MemberAutoTradingPaperHandoffEntry,
  runtime: MemberRuntimeState,
  pilot: RulePackPilotCapitalState,
  estimatedKrw: number,
  nowMs: number,
) {
  if (member.policy.pilotStage !== 'formula-ai-exception') return;
  const decision = evaluateRulePackPilotEntryGuard({
    pilot,
    strategyId: entry.identity.strategyId,
    symbol: entry.identity.symbol,
    signalId: entry.identity.signalId,
    estimatedKrw,
    policyMaxOrderKrw: member.policy.maxOrderKrw,
    policyTotalCapitalKrw: member.policy.totalCapitalKrw,
    openLivePositions: openAutomaticPlans(runtime, 'live').length,
    nowMs,
  });
  if (!decision.allowed) throw new Error(decision.blockers[0] ?? 'BACKGROUND_PILOT_ENTRY_BLOCKED');
}

function policyAllowsEntry(member: EligibleMember, entry: MemberAutoTradingPaperHandoffEntry) {
  const policy = member.policy;
  const mapping = marketMapping(entry.identity.market, policy);
  if (mapping.assetClass === 'crypto_futures' && !hasCapability(member.profile, 'canAccessFutures')) return false;
  if (policy.mode !== 'automatic' || !policy.automaticEnabled || policy.emergencyStopped || policy.newEntriesStopped) return false;
  if (!policy.marketEnabled[mapping.assetClass] || !policy.exchangeEnabled[mapping.exchange]) return false;
  const symbol = mapping.exchange === 'upbit'
    ? entry.identity.symbol.toUpperCase().replace(/^KRW-/u, '')
    : entry.identity.symbol.toUpperCase();
  const assets = policy.enabledAssets[mapping.exchange];
  if (assets.length > 0 && !assets.includes(symbol)) return false;
  if (policy.enabledStrategies.length > 0 && !policy.enabledStrategies.includes(entry.identity.strategyId)) return false;
  return true;
}

const EXIT_PARENT_REASON_PREFIX = 'AUTO_EXIT_ENTRY_PLAN:';
const POSITION_QUANTITY_TOLERANCE = 1e-8;

function reasonValue(plan: TradingPlan, prefix: string) {
  const reason = plan.signalReasons.find((value) => value.startsWith(prefix));
  return reason ? reason.slice(prefix.length) : null;
}

function backgroundAutomaticPlan(plan: TradingPlan) {
  return plan.executionMode === 'automatic'
    || plan.signalReasons.includes('CANONICAL_PAPER_HANDOFF')
    || plan.signalReasons.includes('CANONICAL_LIVE_AUTO_HANDOFF')
    || Boolean(reasonValue(plan, EXIT_PARENT_REASON_PREFIX));
}

type TrackedAutomaticPosition = Readonly<{
  plan: TradingPlan;
  order: TradingOrder;
  remainingQuantity: number;
  activeExit: boolean;
}>;

function trackedAutomaticPositions(
  runtime: MemberRuntimeState,
  accountMode: 'paper' | 'live',
): TrackedAutomaticPosition[] {
  const orderByPlan = new Map(runtime.orders.map((order) => [order.planId, order]));
  const exitsByParent = new Map<string, TradingOrder[]>();
  for (const exitPlan of runtime.plans) {
    if (exitPlan.accountMode !== accountMode || exitPlan.reduceOnly !== true || !backgroundAutomaticPlan(exitPlan)) continue;
    const parentId = reasonValue(exitPlan, EXIT_PARENT_REASON_PREFIX);
    if (!parentId) continue;
    const exitOrder = orderByPlan.get(exitPlan.id);
    if (!exitOrder) continue;
    const rows = exitsByParent.get(parentId) ?? [];
    rows.push(exitOrder);
    exitsByParent.set(parentId, rows);
  }
  return runtime.plans.flatMap((plan) => {
    if (plan.accountMode !== accountMode || plan.reduceOnly === true || !backgroundAutomaticPlan(plan)) return [];
    const order = orderByPlan.get(plan.id);
    if (!order || !['PARTIALLY_FILLED', 'FILLED'].includes(order.state) || !(order.filledQuantity > 0)) return [];
    const exits = exitsByParent.get(plan.id) ?? [];
    const exited = exits.reduce((sum, row) => (
      ['PARTIALLY_FILLED', 'FILLED'].includes(row.state) && row.filledQuantity > 0
        ? sum + row.filledQuantity
        : sum
    ), 0);
    const remainingQuantity = Math.max(0, order.filledQuantity - exited);
    if (!(remainingQuantity > POSITION_QUANTITY_TOLERANCE)) return [];
    return [{
      plan,
      order,
      remainingQuantity,
      activeExit: exits.some((row) => ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'RECOVERY_REQUIRED'].includes(row.state)),
    }];
  });
}

function openAutomaticPlans(runtime: MemberRuntimeState, accountMode: 'paper' | 'live') {
  const openPositionIds = new Set(trackedAutomaticPositions(runtime, accountMode).map((row) => row.plan.id));
  const orderByPlan = new Map(runtime.orders.map((order) => [order.planId, order]));
  return runtime.plans.filter((plan) => {
    if (plan.accountMode !== accountMode || plan.reduceOnly === true || !backgroundAutomaticPlan(plan)) return false;
    if (openPositionIds.has(plan.id)) return true;
    const order = orderByPlan.get(plan.id);
    return Boolean(order && ['SUBMITTED', 'ACCEPTED', 'RECOVERY_REQUIRED'].includes(order.state));
  });
}

function providerPositionQuantity(snapshot: CanonicalAccountSnapshot, position: TrackedAutomaticPosition) {
  if (!snapshot.connected || snapshot.stale || snapshot.status !== 'CONNECTED') {
    throw new Error('BACKGROUND_LIVE_ACCOUNT_SNAPSHOT_NOT_FRESH');
  }
  const symbol = normalizedSymbol(position.plan.symbol);
  const matches = (snapshot.positions ?? []).filter((row) =>
    normalizedSymbol(row.symbol) === symbol && finite(row.quantity) && Math.abs(row.quantity!) > POSITION_QUANTITY_TOLERANCE);
  if (matches.length !== 1) throw new Error('BACKGROUND_LIVE_POSITION_RECONCILIATION_REQUIRED');
  const row = matches[0]!;
  if (position.plan.exchange === 'bitget' && row.side) {
    const expected = position.plan.side === 'short' ? 'short' : 'long';
    if (String(row.side).toLowerCase() !== expected) throw new Error('BACKGROUND_LIVE_POSITION_SIDE_MISMATCH');
  }
  const quantity = Math.abs(Number(row.availableQuantity ?? row.quantity));
  if (!finite(quantity) || quantity <= 0
    || Math.abs(quantity - position.remainingQuantity) > Math.max(POSITION_QUANTITY_TOLERANCE, position.remainingQuantity * 1e-6)) {
    throw new Error('BACKGROUND_LIVE_POSITION_QUANTITY_DRIFT');
  }
  return quantity;
}

function currentConsecutiveLosses(journal: readonly Record<string, unknown>[]) {
  const closed = journal
    .filter((row) => typeof row.closedAt === 'string' && finite(Number(row.netPnl)))
    .sort((a, b) => Date.parse(String(b.closedAt)) - Date.parse(String(a.closedAt)));
  let count = 0;
  for (const row of closed) {
    if (Number(row.netPnl) < 0) count += 1;
    else break;
  }
  return count;
}

function pnlPercentSince(
  journal: readonly Record<string, unknown>[],
  equity: number,
  cutoffMs: number,
) {
  const pnl = journal.reduce((sum, row) => {
    const closedAt = isoMs(row.closedAt);
    const net = Number(row.netPnl);
    return closedAt != null && closedAt >= cutoffMs && finite(net) ? sum + net : sum;
  }, 0);
  return pnl / equity * 100;
}

async function memberRuntimeState(
  userId: string,
  repository: TradingRepository,
  paper: PaperJournalRepository,
  nowMs: number,
): Promise<MemberRuntimeState> {
  // A missing/broken Paper account must quarantine *new* entries but must
  // not hide already-filled real broker positions from guarded exit tracking.
  const [paperResult, plans, orders] = await Promise.all([
    paper.listSnapshot(userId)
      .then((records) => ({ records, validRead: true }))
      .catch(() => ({ records: [] as Awaited<ReturnType<PaperJournalRepository['listSnapshot']>>, validRead: false })),
    repository.listPlans(userId),
    repository.listOrders(userId),
  ]);
  const accounts = paperResult.records.filter((row) => row.kind === 'account' && row.deletedAt == null)
    .map((row) => record(row.payload))
    .filter((row): row is Record<string, unknown> => row != null);
  const paperAccountReady = paperResult.validRead
    && accounts.length === 1 && positive(Number(accounts[0]?.equity));
  const equity = paperAccountReady ? Number(accounts[0]!.equity) : 0;
  const journal = paperResult.records.filter((row) => row.kind === 'journal' && row.deletedAt == null)
    .map((row) => record(row.payload))
    .filter((row): row is Record<string, unknown> => row != null);
  return Object.freeze({
    paperAccountReady,
    accountEquity: equity,
    // These placeholders are not evidence: caller forbids all fresh entries
    // while paperAccountReady is false.
    dailyPnlPercent: paperAccountReady ? pnlPercentSince(journal, equity, nowMs - 24 * 60 * 60_000) : 0,
    weeklyPnlPercent: paperAccountReady ? pnlPercentSince(journal, equity, nowMs - 7 * 24 * 60 * 60_000) : 0,
    consecutiveLosses: paperAccountReady ? currentConsecutiveLosses(journal) : 0,
    plans,
    orders,
  });
}

function exposureState(
  runtime: MemberRuntimeState,
  policy: TradingPolicy,
  entry: MemberAutoTradingPaperHandoffEntry,
  nowMs: number,
  accountMode: TradingPlan['accountMode'] = 'paper',
) {
  const active = openAutomaticPlans(runtime, accountMode === 'live' ? 'live' : 'paper');
  const mapping = marketMapping(entry.identity.market, policy);
  const side = sideFor(entry.identity.direction);
  const sameInstrument = active.filter((plan) => plan.exchange === mapping.exchange
    && plan.symbol.toUpperCase() === entry.identity.symbol.toUpperCase());
  const sameStrategy = active.filter((plan) => plan.strategyId === entry.identity.strategyId);
  const sameClass = active.filter((plan) => marketMappingForPlan(plan).assetClass === mapping.assetClass);
  const sum = (plans: readonly TradingPlan[]) => plans.reduce((total, plan) => total + Math.max(0, Number(plan.estimatedKrw) || 0), 0);
  const accountExposureKrw = sum(active);
  const instrumentExposureKrw = sum(sameInstrument);
  return {
    accountExposureKrw,
    instrumentExposureKrw,
    strategyExposureKrw: sum(sameStrategy),
    assetClassExposureKrw: sum(sameClass),
    openRiskKrw: active.reduce((total, plan) => total + plannedRiskKrw(plan), 0),
    openPositionCount: active.length,
    dailyOrderCount: runtime.orders.filter((order) => {
      const plan = runtime.plans.find((candidate) => candidate.id === order.planId);
      const at = Date.parse(order.createdAt);
      return plan?.accountMode === accountMode
        && Number.isFinite(at) && at >= nowMs - 24 * 60 * 60_000;
    }).length,
    existingPositionSide: sameInstrument.find((plan) => plan.side === side)?.side
      ?? sameInstrument[0]?.side
      ?? null,
    assetExposurePercent: instrumentExposureKrw / Math.max(1, policy.totalCapitalKrw) * 100,
    availableBalance: Math.max(0, policy.totalCapitalKrw - accountExposureKrw),
  };
}

function marketMappingForPlan(plan: TradingPlan) {
  if (plan.exchange === 'upbit') return { assetClass: 'crypto_spot' as const };
  if (plan.exchange === 'bitget') return { assetClass: 'crypto_futures' as const };
  return { assetClass: plan.market === 'US' ? 'us_stock' as const : 'domestic_stock' as const };
}

function plannedRiskKrw(plan: TradingPlan) {
  const reference = Number(plan.entryPrice ?? plan.limitPrice ?? plan.marketSnapshot.currentPrice);
  const stop = Number(plan.stopPrice);
  return positive(reference) && positive(stop)
    ? Math.max(0, Number(plan.estimatedKrw) || 0) * Math.abs(reference - stop) / reference
    : Math.max(0, Number(plan.estimatedKrw) || 0);
}

function snapshotMarketStatus(entry: MemberAutoTradingPaperHandoffEntry) {
  const evidence = record(entry.execution.dataEvidence);
  const session = record(evidence?.session);
  if (entry.identity.market === 'KR_STOCK' || entry.identity.market === 'US_STOCK') {
    const status = String(session?.status ?? 'UNKNOWN').toUpperCase();
    return status === 'OPEN' ? 'OPEN' as const : status === 'HALTED' ? 'HALTED' as const : 'CLOSED' as const;
  }
  const status = String(evidence?.marketStatus ?? evidence?.contractStatus ?? '').toUpperCase();
  return status === 'TRADABLE' ? 'OPEN' as const : 'HALTED' as const;
}

function buildPlanInput(
  member: EligibleMember,
  entry: MemberAutoTradingPaperHandoffEntry,
  runtime: MemberRuntimeState,
  fx: MemberAutoTradingFxQuote,
  nowMs: number,
): TradingPlanInput {
  const mapping = marketMapping(entry.identity.market, member.policy);
  const quote = currentPrice(entry);
  const exits = exitPlan(entry);
  const evidence = record(entry.execution.dataEvidence);
  const observedAtMs = Number(evidence?.asOfMs);
  if (!finite(observedAtMs) || observedAtMs <= 0 || observedAtMs > nowMs) {
    throw new Error('BACKGROUND_MARKET_TIMESTAMP_INVALID');
  }
  const move = recentMovePercent(entry, observedAtMs, quote.midpoint);
  const quantity = Number(entry.riskEvidence.recommendedQuantity);
  if (!positive(quantity)) throw new Error('BACKGROUND_RISK_QUANTITY_REQUIRED');
  if (mapping.exchange === 'kiwoom' && !Number.isSafeInteger(quantity)) {
    throw new Error('BACKGROUND_STOCK_QUANTITY_MUST_BE_INTEGER');
  }
  const estimatedKrw = quantity * quote.executionPrice * fx.krwPerQuoteCurrency;
  if (!positive(estimatedKrw)) throw new Error('BACKGROUND_ORDER_KRW_INVALID');

  const exposure = exposureState(runtime, member.policy, entry, nowMs);
  const slippage = costPercent(entry, 'slippageRate');
  const fee = costPercent(entry, 'commissionRate');
  const averageSpread = costPercent(entry, 'spreadRate');
  if (slippage == null || fee == null || averageSpread == null) {
    throw new Error('BACKGROUND_COST_EVIDENCE_REQUIRED');
  }
  const marketStatus = snapshotMarketStatus(entry);
  const leverageEvidence = Number(evidence?.leverage);
  const marginModeEvidence = String(evidence?.marginMode ?? '').toLowerCase();
  let leverage: 2 | 3 | 4 | 5 | 6 | 7 | null = null;
  let marginMode: 'crossed' | 'isolated' | null = null;
  if (mapping.exchange === 'bitget') {
    if (!Number.isInteger(leverageEvidence)
      || leverageEvidence < 2
      || leverageEvidence > 7
      || leverageEvidence !== member.policy.bitgetLeverage) {
      throw new Error('BACKGROUND_LEVERAGE_EVIDENCE_MISMATCH');
    }
    if (marginModeEvidence !== 'isolated') {
      throw new Error('BACKGROUND_ISOLATED_MARGIN_EVIDENCE_REQUIRED');
    }
    leverage = leverageEvidence as 2 | 3 | 4 | 5 | 6 | 7;
    marginMode = 'isolated';
  }

  const side = sideFor(entry.identity.direction);
  const observedAt = new Date(observedAtMs).toISOString();
  const signalObservedAt = typeof entry.signal.timestampMs === 'number'
    ? new Date(entry.signal.timestampMs).toISOString()
    : observedAt;

  const stockExchangeRaw = String(
    evidence?.stockExchange ?? evidence?.exchange ?? evidence?.venue ?? '',
  ).trim().toUpperCase();
  const stockExchange = entry.identity.market === 'US_STOCK' && mapping.exchange === 'kiwoom'
    ? (['NASDAQ', 'NYSE', 'AMEX'].includes(stockExchangeRaw)
      ? stockExchangeRaw as 'NASDAQ' | 'NYSE' | 'AMEX'
      : null)
    : null;
  if (entry.identity.market === 'US_STOCK' && mapping.exchange === 'kiwoom' && !stockExchange) {
    throw new Error('BACKGROUND_US_STOCK_EXCHANGE_REQUIRED');
  }

  return {
    exchange: mapping.exchange,
    accountMode: 'paper',
    stockBroker: mapping.stockBroker,
    stockExchange,
    strategyId: entry.identity.strategyId,
    signalId: entry.identity.signalId,
    symbol: entry.identity.symbol,
    market: mapping.planMarket,
    side,
    orderType: 'market',
    quantity,
    quoteAmount: mapping.exchange === 'upbit' ? estimatedKrw : null,
    limitPrice: quote.executionPrice,
    estimatedKrw,
    stopPrice: exits.stop,
    targetPrices: exits.targets,
    splitRatios: [100],
    leverage,
    marginMode,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: [
      'CANONICAL_PAPER_HANDOFF',
      `HANDOFF_ID:${entry.handoffId}`,
      `FX:${fx.source}`,
      ...(mapping.stockBroker ? [`STOCK_BROKER:${mapping.stockBroker.toUpperCase()}`] : []),
      'TOP_OF_BOOK_GAP_PROXY',
    ],
    marketSnapshot: {
      observedAt,
      riskObservedAt: observedAt,
      dataDelayMs: nowMs - observedAtMs,
      oneMinuteMovePercent: move,
      spreadPercent: quote.spreadPercent,
      orderbookGapPercent: quote.spreadPercent,
      halted: marketStatus !== 'OPEN',
      availableBalance: exposure.availableBalance,
      accountValueKrw: member.policy.totalCapitalKrw,
      dailyPnlPercent: runtime.dailyPnlPercent,
      weeklyPnlPercent: runtime.weeklyPnlPercent,
      assetExposurePercent: exposure.assetExposurePercent,
      accountExposureKrw: exposure.accountExposureKrw,
      instrumentExposureKrw: exposure.instrumentExposureKrw,
      strategyExposureKrw: exposure.strategyExposureKrw,
      assetClassExposureKrw: exposure.assetClassExposureKrw,
      openRiskKrw: exposure.openRiskKrw,
      openPositionCount: exposure.openPositionCount,
      dailyOrderCount: exposure.dailyOrderCount,
      consecutiveLosses: runtime.consecutiveLosses,
      existingPositionSide: exposure.existingPositionSide,
      liquidationDistancePercent: mapping.exchange === 'bitget'
        ? Number(evidence?.liquidationDistancePct)
        : null,
      openOrderExposureKrw: exposure.accountExposureKrw,
      currentPrice: quote.midpoint,
      plannedPrice: quote.executionPrice,
      marketStatus,
      providerTimeOffsetMs: nowMs - observedAtMs,
      source: `member-auto-trading-paper-handoff-v1:${String(evidence?.provider ?? 'PUBLIC')}:TOP_OF_BOOK`,
      availableLiquidityKrw: null,
      estimatedSlippagePercent: slippage,
      estimatedFeePercent: fee,
      correlatedExposurePercent: null,
      signalState: 'entry_ready',
      signalObservedAt,
    },
    entryPrice: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    estimatedSlippagePercent: null,
    averageSpreadPercent: null,
    economics: null,
  };
}


export function liveBackgroundEnabled() {
  return process.env.MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED === 'true'
    && process.env.AUTO_TRADING === 'true'
    && process.env.LIVE_AUTOMATIC_TRADING_ENABLED === 'true'
    && process.env.LIVE_TRADING === 'true'
    && process.env.REAL_ORDER_ENABLED === 'true'
    && process.env.PRIVATE_TRADING_API_ALLOWED === 'true';
}

function normalizedSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/^KRW-/u, '');
}

function expectedBalanceCurrency(market: MemberAutoTradingPaperHandoffEntry['identity']['market']) {
  if (market === 'KR_STOCK' || market === 'CRYPTO_SPOT') return 'KRW';
  if (market === 'US_STOCK') return 'USD';
  return 'USDT';
}

function availableBalanceKrw(
  snapshot: CanonicalAccountSnapshot,
  market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
  fx: MemberAutoTradingFxQuote,
) {
  if (!snapshot.connected || snapshot.stale || snapshot.status !== 'CONNECTED') {
    throw new Error('BACKGROUND_LIVE_ACCOUNT_SNAPSHOT_NOT_FRESH');
  }
  const currency = expectedBalanceCurrency(market);
  const candidates = [
    ...(snapshot.balances ?? [])
      .filter((row) => String(row.currency).toUpperCase() === currency)
      .flatMap((row) => finite(row.available) && row.available! >= 0 ? [row.available!] : []),
    ...(snapshot.accounts ?? [])
      .filter((row) => String(row.currency ?? '').toUpperCase() === currency)
      .flatMap((row) => finite(row.buyingPower) && row.buyingPower! >= 0 ? [row.buyingPower!] : []),
  ];
  if (!candidates.length) return null;
  const value = Math.max(...candidates) * fx.krwPerQuoteCurrency;
  return finite(value) && value >= 0 ? value : null;
}

function tradeMarketForPlan(plan: TradingPlan): MemberAutoTradingPaperHandoffEntry['identity']['market'] {
  if (plan.exchange === 'upbit') return 'CRYPTO_SPOT';
  if (plan.exchange === 'bitget') return 'CRYPTO_FUTURES';
  return plan.market === 'US' ? 'US_STOCK' : 'KR_STOCK';
}

/**
 * Unmatched external holdings cannot be valued from automatic plan notional.
 * Refuse a new Live entry rather than assuming zero external exposure. Exit
 * tracking is separately protected and must not depend on this entry guard.
 */
export function assertCanonicalLiveProviderPositions(
  snapshot: Pick<CanonicalAccountSnapshot, 'provider' | 'positions'>,
  plans: readonly TradingPlan[],
) {
  if (!Array.isArray(snapshot.positions)) throw new Error('BACKGROUND_LIVE_PROVIDER_POSITIONS_UNAVAILABLE');
  for (const position of snapshot.positions) {
    // Upbit publishes the KRW settlement cash balance in positions, but
    // KRW is not an open coin exposure and is checked independently as cash.
    if (snapshot.provider === 'upbit' && normalizedSymbol(position.symbol) === 'KRW') continue;
    if (!finite(position.quantity)) throw new Error('BACKGROUND_LIVE_PROVIDER_POSITION_QUANTITY_UNAVAILABLE');
    if (Math.abs(position.quantity) <= POSITION_QUANTITY_TOLERANCE) continue;
    const matching = plans.filter((plan) => normalizedSymbol(plan.symbol) === normalizedSymbol(position.symbol));
    if (matching.length === 0) throw new Error('BACKGROUND_LIVE_EXTERNAL_POSITION_UNRECONCILED');
    const declaredSide = String(position.side ?? '').trim().toLowerCase();
    if (declaredSide && matching.some((plan) => plan.exchange === 'bitget')
      && !matching.some((plan) => plan.exchange === 'bitget' && plan.side === declaredSide)) {
      throw new Error('BACKGROUND_LIVE_PROVIDER_POSITION_SIDE_MISMATCH');
    }
  }
}

async function liveJournalRiskState(
  source: MemberAutoTradingBackgroundSource,
  repository: TradingRepository,
  userId: string,
  runtime: MemberRuntimeState,
  snapshot: CanonicalAccountSnapshot,
  policy: TradingPolicy,
  nowMs: number,
  fxCache: Map<string, MemberAutoTradingFxQuote>,
) {
  const fxFor = async (market: MemberAutoTradingPaperHandoffEntry['identity']['market']) => {
    let fx = fxCache.get(market);
    if (!fx) {
      fx = await source.resolveFx(market, nowMs);
      fxCache.set(market, fx);
    }
    return fx;
  };
  const payloads = await readTradeAutomationJournalPayloads(repository, userId);
  const journal = buildUnifiedTradeJournal(payloads, { range: 'ALL', source: 'APP_AUTO' }, new Date(nowMs));
  const closed = journal.trades.filter((trade) => trade.source === 'APP_AUTO' && trade.status === 'CLOSED' && trade.closedAt);
  const pnlKrw = async (cutoff: number) => {
    let total = 0;
    for (const trade of closed) {
      const closedAt = Date.parse(trade.closedAt ?? '');
      if (!Number.isFinite(closedAt) || closedAt < cutoff) continue;
      if (!finite(trade.netPnl)) throw new Error('BACKGROUND_LIVE_REALIZED_PNL_EVIDENCE_REQUIRED');
      const fx = await fxFor(trade.market);
      total += trade.netPnl! * fx.krwPerQuoteCurrency;
    }
    return total;
  };
  // A pending order is NOT proof of an owned broker position. Bind provider
  // holdings only to canonically filled/partially-filled entry quantities,
  // and fail closed until ambiguous fills are reconciled.
  const livePlans = trackedAutomaticPositions(runtime, 'live').map((row) => row.plan);
  assertCanonicalLiveProviderPositions(snapshot, livePlans);
  const liveBySymbol = new Map(livePlans.map((plan) => [normalizedSymbol(plan.symbol), plan]));
  let unrealizedKrw = 0;
  for (const position of snapshot.positions ?? []) {
    if (snapshot.provider === 'upbit' && normalizedSymbol(position.symbol) === 'KRW') continue;
    if (!finite(position.quantity) || Math.abs(position.quantity!) <= POSITION_QUANTITY_TOLERANCE) continue;
    const matched = liveBySymbol.get(normalizedSymbol(position.symbol));
    if (!matched) throw new Error('BACKGROUND_LIVE_EXTERNAL_POSITION_UNRECONCILED');
    if (!finite(position.unrealizedPnl)) continue;
    const fx = await fxFor(tradeMarketForPlan(matched));
    unrealizedKrw += position.unrealizedPnl! * fx.krwPerQuoteCurrency;
  }
  const dailyKrw = await pnlKrw(nowMs - 24 * 60 * 60_000) + unrealizedKrw;
  const weeklyKrw = await pnlKrw(nowMs - 7 * 24 * 60 * 60_000) + unrealizedKrw;
  const equityBase = Math.max(1, policy.totalCapitalKrw);
  const ordered = closed
    .filter((trade) => finite(trade.netPnl))
    .sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? ''));
  let consecutiveLosses = 0;
  for (const trade of ordered) {
    if (Number(trade.netPnl) < 0) consecutiveLosses += 1;
    else break;
  }
  return {
    dailyPnlPercent: dailyKrw / equityBase * 100,
    weeklyPnlPercent: weeklyKrw / equityBase * 100,
    consecutiveLosses,
  };
}

async function buildLivePlanInput(input: {
  source: MemberAutoTradingBackgroundSource;
  repository: TradingRepository;
  member: EligibleMember;
  entry: MemberAutoTradingPaperHandoffEntry;
  runtime: MemberRuntimeState;
  paperInput: TradingPlanInput;
  snapshot: CanonicalAccountSnapshot;
  fx: MemberAutoTradingFxQuote;
  fxCache: Map<string, MemberAutoTradingFxQuote>;
  nowMs: number;
}): Promise<TradingPlanInput> {
  const exposure = exposureState(input.runtime, input.member.policy, input.entry, input.nowMs, 'live');
  const readOnlyAvailableBalance = availableBalanceKrw(input.snapshot, input.entry.identity.market, input.fx);
  const risk = await liveJournalRiskState(
    input.source, input.repository, input.member.userId, input.runtime, input.snapshot,
    input.member.policy, input.nowMs, input.fxCache,
  );
  const availableBalance = readOnlyAvailableBalance ?? 0;
  const accountValueKrw = Math.max(1, Math.min(
    input.member.policy.totalCapitalKrw,
    Math.max(availableBalance, exposure.accountExposureKrw || 1),
  ));
  const slippage = finite(input.paperInput.marketSnapshot.estimatedSlippagePercent)
    ? input.paperInput.marketSnapshot.estimatedSlippagePercent
    : null;
  return {
    ...input.paperInput,
    accountMode: 'live',
    signalReasons: [
      ...input.paperInput.signalReasons,
      ...(input.member.policy.pilotStage === 'formula-ai-exception'
        ? formulaAiReviewReasonsForLive(input.entry, input.nowMs) : []),
      'CANONICAL_LIVE_AUTO_HANDOFF',
      'ACCOUNT_READONLY_PRECHECK',
    ],
    marketSnapshot: {
      ...input.paperInput.marketSnapshot,
      availableBalance,
      accountValueKrw,
      dailyPnlPercent: risk.dailyPnlPercent,
      weeklyPnlPercent: risk.weeklyPnlPercent,
      consecutiveLosses: risk.consecutiveLosses,
      accountExposureKrw: exposure.accountExposureKrw,
      instrumentExposureKrw: exposure.instrumentExposureKrw,
      strategyExposureKrw: exposure.strategyExposureKrw,
      assetClassExposureKrw: exposure.assetClassExposureKrw,
      openRiskKrw: exposure.openRiskKrw,
      openPositionCount: Math.max(
        exposure.openPositionCount,
        (input.snapshot.positions ?? []).filter((row) => finite(row.quantity) && Math.abs(row.quantity!) > 0).length,
      ),
      dailyOrderCount: exposure.dailyOrderCount,
      assetExposurePercent: exposure.assetExposurePercent,
      existingPositionSide: exposure.existingPositionSide,
      correlatedExposurePercent: exposure.assetExposurePercent,
      source: `${input.paperInput.marketSnapshot.source}+account-readonly-live-precheck`,
    },
    estimatedSlippagePercent: slippage,
    averageSpreadPercent: input.paperInput.marketSnapshot.spreadPercent,
    economics: null,
  };
}

async function executeAutomaticPlan(input: {
  repository: TradingRepository;
  userId: string;
  planInput: TradingPlanInput;
  policy: TradingPolicy;
  emergencyStopped: boolean;
}) {
  const automation = new TradeAutomationService(input.repository);
  const execution = new TradeExecutionService(input.repository);
  const created = await automation.createPlan(
    input.userId, input.planInput, input.policy, input.emergencyStopped,
  );
  if (!created.plan) return { created, plan: null, order: null, orderDuplicate: false };
  let plan = created.plan;
  if (plan.state === 'APPROVAL_PENDING') plan = await automation.beginAutomaticPlan(input.userId, plan.id);
  if (plan.state !== 'SUBMITTED') return { created, plan, order: null, orderDuplicate: false };
  const createdOrder = await automation.createOrder(input.userId, plan);
  const order = createdOrder.duplicate
    ? createdOrder.order
    : await execution.execute(input.userId, plan, createdOrder.order);
  return { created, plan, order, orderDuplicate: createdOrder.duplicate };
}

async function processAutomaticExit(input: {
  source: MemberAutoTradingBackgroundSource;
  repository: TradingRepository;
  member: EligibleMember;
  position: TrackedAutomaticPosition;
  fxCache: Map<string, MemberAutoTradingFxQuote>;
  now: Date;
  live: boolean;
}) {
  if (input.position.activeExit) {
    return { status: 'IDEMPOTENT' as const, privateRequests: 0, orderCreated: false };
  }
  const market = tradeMarketForPlan(input.position.plan);
  const mark = await input.source.readMarketMark(market, input.position.plan.symbol);
  const initialReason = automaticExitReason(input.position.plan, mark.price);
  if (!initialReason) return { status: 'HOLD' as const, privateRequests: 0, orderCreated: false };

  let fx = input.fxCache.get(market);
  if (!fx) {
    fx = await input.source.resolveFx(market, input.now.getTime());
    input.fxCache.set(market, fx);
  }

  let exitInput = buildAutomaticExitPlanInput({
    entryPlan: input.position.plan,
    entryOrder: input.position.order,
    mark,
    fx,
    reason: initialReason,
    remainingQuantity: input.position.remainingQuantity,
  });
  let privateRequests = 0;

  if (input.live) {
    if (!liveBackgroundEnabled()) {
      return { status: 'HOLD' as const, privateRequests: 0, orderCreated: false };
    }
    const provider = input.position.plan.exchange as AccountProvider;
    const accountSnapshot = await input.source.readLiveAccountSnapshot(input.member.userId, provider);
    privateRequests += 1;
    const providerQuantity = providerPositionQuantity(accountSnapshot, input.position);
    exitInput = { ...exitInput, quantity: providerQuantity };
    const preview = await new TradeExecutionService(input.repository).previewLiveRiskSnapshot(
      input.member.userId,
      exitInput,
      { fxKrwPerQuoteCurrency: fx.krwPerQuoteCurrency, now: input.now },
    );
    privateRequests += preview.providerRequests;
    const confirmedPrice = Number(preview.snapshot.currentPrice);
    const confirmedReason = automaticExitReason(input.position.plan, confirmedPrice);
    if (confirmedReason !== initialReason) {
      return { status: 'BLOCKED_RECHECK' as const, privateRequests, orderCreated: false };
    }
    exitInput = {
      ...exitInput,
      marketSnapshot: {
        ...preview.snapshot,
        source: `${preview.snapshot.source ?? 'provider-private-preflight'}+automatic-exit`,
        signalState: 'approved',
        signalObservedAt: preview.snapshot.observedAt,
      },
      estimatedSlippagePercent: preview.snapshot.estimatedSlippagePercent,
      averageSpreadPercent: preview.snapshot.spreadPercent,
    };
  }

  const persistentStop = await input.repository.getGlobalEmergencyStop();
  const execution = await executeAutomaticPlan({
    repository: input.repository,
    userId: input.member.userId,
    planInput: exitInput,
    policy: input.member.policy,
    emergencyStopped: input.member.policy.emergencyStopped
      || persistentStop
      || process.env.TRADING_EMERGENCY_STOP === 'true',
  });
  if (!execution.plan || !execution.order) {
    return { status: 'BLOCKED_PLAN' as const, privateRequests, orderCreated: false };
  }
  const orderCreated = !execution.orderDuplicate;
  if (['REJECTED', 'RECOVERY_REQUIRED'].includes(execution.order.state)) {
    return { status: 'BLOCKED_ORDER' as const, privateRequests, orderCreated };
  }
  return {
    status: ['FILLED', 'PARTIALLY_FILLED', 'ACCEPTED'].includes(execution.order.state)
      ? 'EXIT_SUBMITTED' as const
      : 'HOLD' as const,
    privateRequests,
    orderCreated,
  };
}

function intervalMs(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(parsed)))
    : DEFAULT_INTERVAL_MS;
}

function errorCode(error: unknown) {
  const value = error instanceof Error ? error.message.split(':')[0] : 'BACKGROUND_AUTOMATION_FAILED';
  return /^[A-Z0-9_]+$/u.test(value) ? value : 'BACKGROUND_AUTOMATION_FAILED';
}

export function selectRotatingHandoffEntries<T>(
  entries: readonly T[], offset: number, limit: number,
): { entries: readonly T[]; nextOffset: number } {
  if (!entries.length) return { entries: [], nextOffset: 0 };
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset % entries.length : 0;
  const take = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
  const selected = entries.slice(start, start + take);
  return { entries: selected, nextOffset: start + selected.length >= entries.length ? 0 : start + selected.length };
}

export class MemberAutoTradingBackgroundWorker {
  private running = false;
  private liveEntryWarmupComplete = false;
  // Preserve stop/error evidence across paginated member batches. A later
  // eligible member must never erase a blocked member from the same rotation.
  private liveCycleHardWarmupBlocked = false;
  private liveCycleOrderEligibleSeen = false;
  private liveCyclePolicyReadySeen = false;
  private liveCycleAllFourPolicyReadySeen = false;
  private liveCycleAllFourWitnessUserId: string | null = null;
  private handoffEntryOffset = 0;

  constructor(private readonly source: MemberAutoTradingBackgroundSource) {}

  async runOnce(now = new Date()): Promise<MemberAutoTradingBackgroundRunResult> {
    const liveModeRequested = liveBackgroundEnabled();
    const liveEntryArmPresentThisTick = liveModeRequested ? await liveEntryArmPresent(now.getTime()) : false;
    const liveExitsArmedThisTick = liveModeRequested
      && this.liveEntryWarmupComplete
      && liveEntryArmPresentThisTick;
    const liveTelegramHealthyThisTick = !liveModeRequested
      || this.source.telegramDeliveryHealthy?.(now.getTime()) === true;
    const liveEntriesArmedThisTick = liveExitsArmedThisTick
      && liveTelegramHealthyThisTick && !this.liveCycleHardWarmupBlocked;
    const result: MemberAutoTradingBackgroundRunResult = {
      handoffStatus: 'MISSING',
      handoffReady: false,
      newEntriesFailClosed: liveModeRequested && !liveTelegramHealthyThisTick,
      liveEntriesArmed: liveEntriesArmedThisTick,
      liveEntryWarmupComplete: this.liveEntryWarmupComplete,
      liveEntriesSuppressedByWarmupOrArm: 0,
      liveEntriesSuppressedByTelegram: 0,
      liveExitsSuppressedByWarmupOrArm: 0,
  liveExitsSuppressedByPolicy: 0,
      runtimeRefreshes: 0,
      executionSyncBlocks: 0,
      overlapSkipped: false,
      liveOrderEligibleMembers: 0,
      livePolicyReadyMembers: 0,
      liveAllFourPolicyReadyMembers: 0,
      liveReadinessCycleComplete: true,
      liveCycleOrderEligible: false,
      liveCyclePolicyReady: false,
      liveCycleAllFourPolicyReady: false,
      globalEmergencyStopActive: false,
      members: 0,
      entries: 0,
      evaluated: 0,
      skipped: 0,
      blocked: 0,
      createdPlans: 0,
      filledOrders: 0,
      positionLifecycles: 0,
      lifecycleIdempotent: 0,
      duplicates: 0,
      failures: 0,
      livePlans: 0,
      liveOrders: 0,
      paperExitOrders: 0,
      liveExitOrders: 0,
      liveTrackedPositions: 0,
      exitBlocked: 0,
      privateTradingRequests: 0,
      executionEventsInserted: 0,
      notificationDeliveriesQueued: 0,
      executionSyncMissingReferences: 0,
      executionSyncFailures: 0,
      liveEntryArmPresent: liveEntryArmPresentThisTick,
    };
    if (this.running) {
      result.overlapSkipped = true;
      return result;
    }
    this.running = true;
    try {
      const nowMs = now.getTime();
      // A broken new-entry handoff cannot suppress guarded existing exits.
      let handoff: MemberAutoTradingPaperHandoff | null = null;
      try {
        handoff = await this.source.readHandoff(nowMs);
        if (handoff?.status === 'READY'
          && (!Number.isFinite(handoff.evaluatedAtMs)
            || nowMs < handoff.evaluatedAtMs
            || nowMs - handoff.evaluatedAtMs > MAX_READY_HANDOFF_AGE_MS)) {
          throw new Error('BACKGROUND_PAPER_HANDOFF_STALE');
        }
        if (handoff) result.handoffStatus = handoff.status;
      } catch {
        handoff = null;
        result.handoffStatus = 'BLOCKED_DATA';
        result.failures += 1;
      }
      result.handoffReady = handoff?.status === 'READY';
      if (!result.handoffReady) {
        result.newEntriesFailClosed = true;
        this.handoffEntryOffset = 0;
      }

      const members = (await this.source.listEligibleMembers()).slice(0, MAX_MEMBERS_PER_TICK);
      result.members = members.length;
      result.liveOrderEligibleMembers = members.filter((member) =>
        hasCapability(member.profile, 'canAccessAutoTrading')
        && hasCapability(member.profile, 'canPlaceOrders')
        && member.policy.mode === 'automatic'
        && member.policy.automaticEnabled
        && !member.policy.emergencyStopped
        && !member.policy.newEntriesStopped).length;
      const batch = selectRotatingHandoffEntries(
        result.handoffReady ? handoff!.entries : [],
        this.handoffEntryOffset,
        MAX_ENTRIES_PER_TICK,
      );
      this.handoffEntryOffset = batch.nextOffset;
      const entries = batch.entries;
      result.entries = entries.length;
      const fxCache = new Map<string, MemberAutoTradingFxQuote>();
      let paperAccountMissingThisTick = false;
      let memberAuditFailedThisTick = false;

      for (const member of members) {
        // Losing membership must revoke ALL execution while preserving
        // read-only visibility of previously filled automatic Live positions.
        const memberCanRunAutomation = hasCapability(member.profile, 'canAccessAutoTrading');
        const memberAutoExecutionEnabled = memberCanRunAutomation
          && member.policy.mode === 'automatic'
          && member.policy.automaticEnabled && !member.policy.emergencyStopped;
        const repository = this.source.tradingRepositoryFor(member.userId);
        const paper = this.source.paperJournalRepositoryFor(member.userId);
        let runtime: MemberRuntimeState;
        let persistentGlobalStop = false;
        try {
          [runtime, persistentGlobalStop] = await Promise.all([
            memberRuntimeState(member.userId, repository, paper, nowMs),
            repository.getGlobalEmergencyStop(),
          ]);
        } catch {
          memberAuditFailedThisTick = true;
          result.blocked += entries.length;
          result.newEntriesFailClosed = true;
          continue;
        }
        if (!runtime.paperAccountReady && memberAutoExecutionEnabled) {
          paperAccountMissingThisTick = true;
          result.newEntriesFailClosed = true;
          result.failures += 1;
        }
        const environmentGlobalStop = process.env.TRADING_EMERGENCY_STOP === 'true';
        if (persistentGlobalStop || environmentGlobalStop) result.globalEmergencyStopActive = true;
        if (!memberCanRunAutomation) {
          if (liveModeRequested) {
            const protectedPositions = trackedAutomaticPositions(runtime, 'live');
            result.liveTrackedPositions += protectedPositions.length;
            result.liveExitsSuppressedByPolicy += protectedPositions.length;
            if (protectedPositions.length) result.newEntriesFailClosed = true;
          }
          result.skipped += entries.length;
          continue;
        }
        if (hasCapability(member.profile, 'canPlaceOrders')
          && automaticPolicyHasRunnableMarket(member.policy)
          && !persistentGlobalStop
          && !environmentGlobalStop) {
          result.livePolicyReadyMembers += 1;
        }
        if (hasCapability(member.profile, 'canPlaceOrders')
          && hasCapability(member.profile, 'canAccessFutures')
          && automaticPolicyHasAllFourMarkets(member.policy)
          && !persistentGlobalStop
          && !environmentGlobalStop) {
          result.liveAllFourPolicyReadyMembers += 1;
          this.liveCycleAllFourWitnessUserId ??= member.userId;
        }

        const refreshRuntime = async () => {
          runtime = await memberRuntimeState(member.userId, repository, paper, nowMs);
          result.runtimeRefreshes += 1;
        };
        const syncExecutionProjection = async () => {
          if (!this.source.syncExecutionEvents) return true;
          try {
            const synced = await this.source.syncExecutionEvents({
              userId: member.userId,
              profile: member.profile,
              repository,
              paperJournalRepository: paper,
            });
            result.executionEventsInserted += synced.inserted;
            result.notificationDeliveriesQueued += synced.deliveryQueued;
            result.executionSyncMissingReferences += synced.missingReferences;
            if (synced.missingReferences > 0) {
              result.executionSyncBlocks += 1;
              result.newEntriesFailClosed = true;
              return false;
            }
            return true;
          } catch {
            // Notification/journal fan-out must never change canonical order state.
            // A projection failure instead fail-closes subsequent new entries for this tick.
            result.executionSyncFailures += 1;
            result.executionSyncBlocks += 1;
            result.newEntriesFailClosed = true;
            return false;
          }
        };

        let formulaAiPilotCapital: RulePackPilotCapitalState | null = null;
        let entryProjectionHealthy = await syncExecutionProjection();
        let exitChanged = false;
        for (const position of memberAutoExecutionEnabled && runtime.paperAccountReady
          ? trackedAutomaticPositions(runtime, 'paper') : []) {
          try {
            const exit = await processAutomaticExit({
              source: this.source,
              repository,
              member,
              position,
              fxCache,
              now,
              live: false,
            });
            if (exit.status === 'EXIT_SUBMITTED' && exit.orderCreated) {
              result.paperExitOrders += 1;
              exitChanged = true;
            } else if (exit.status.startsWith('BLOCKED')) {
              result.exitBlocked += 1;
            }
          } catch (error) {
            const code = errorCode(error);
            if (code.startsWith('BACKGROUND_') || code.includes('RISK') || code.includes('BLOCKED')) {
              result.exitBlocked += 1;
            } else {
              result.failures += 1;
            }
          }
        }

        if (liveModeRequested) {
          const livePositions = trackedAutomaticPositions(runtime, 'live');
          result.liveTrackedPositions += livePositions.length;
          if (!memberAutoExecutionEnabled) {
            // Emergency-stop / AUTO OFF must not erase existing Live positions
            // from observation, nor silently run them under manual authority.
            result.liveExitsSuppressedByPolicy += livePositions.length;
            if (livePositions.length) result.newEntriesFailClosed = true;
          } else if (!liveExitsArmedThisTick || !hasCapability(member.profile, 'canPlaceOrders')) {
            result.liveExitsSuppressedByWarmupOrArm += livePositions.length;
          } else {
            for (const position of livePositions) {
              try {
                const exit = await processAutomaticExit({
                  source: this.source,
                  repository,
                  member,
                  position,
                  fxCache,
                  now,
                  live: true,
                });
                result.privateTradingRequests += exit.privateRequests;
                if (exit.status === 'EXIT_SUBMITTED' && exit.orderCreated) {
                  result.liveExitOrders += 1;
                  exitChanged = true;
                } else if (exit.status.startsWith('BLOCKED')) {
                  result.exitBlocked += 1;
                }
              } catch (error) {
                const code = errorCode(error);
                if (code.startsWith('BACKGROUND_') || code.includes('RISK') || code.includes('BLOCKED')) {
                  result.exitBlocked += 1;
                } else {
                  result.failures += 1;
                }
              }
            }
          }
        }

        if (exitChanged) {
          entryProjectionHealthy = (await syncExecutionProjection()) && entryProjectionHealthy;
          try {
            await refreshRuntime();
          } catch {
            result.exitBlocked += 1;
            result.newEntriesFailClosed = true;
            continue;
          }
        }

        if (!entryProjectionHealthy) {
          result.blocked += entries.length;
          continue;
        }

        // AUTO OFF members remain visible for read-only Live position
        // monitoring. No Paper or Live auto entries/exits are submitted.
        if (!memberAutoExecutionEnabled) {
          result.skipped += entries.length;
          continue;
        }
        // Maintain eligible Live exits above even when Paper storage is
        // absent. Do not create Paper or Live entries using placeholder equity.
        if (!runtime.paperAccountReady) {
          result.blocked += entries.length;
          continue;
        }
        for (const entry of entries) {
          if (!policyAllowsEntry(member, entry)) {
            result.skipped += 1;
            continue;
          }
          result.evaluated += 1;
          try {
            // Always re-read canonical exposure at the entry boundary. This also
            // covers a prior entry that mutated an order and then failed during
            // lifecycle/projection post-processing before its normal refresh.
            await refreshRuntime();
            let fx = fxCache.get(entry.identity.market);
            if (!fx) {
              fx = await this.source.resolveFx(entry.identity.market, nowMs);
              fxCache.set(entry.identity.market, fx);
            }
            let paperInput = buildPlanInput(member, entry, runtime, fx, nowMs);
            let paperEntryPolicy = member.policy;
            if (member.policy.pilotStage === 'formula-ai-exception'
              && paperInput.estimatedKrw > member.policy.maxOrderKrw) {
              // Compounding beyond the stored base cap requires an immutable
              // signal-specific review and signed worker-only provenance.
              formulaAiReviewReasonsForLive(entry, nowMs);
              formulaAiPilotCapital ??= await readRulePackPilotCapitalState(
                repository, member.userId, now,
              );
              validateFormulaAiPilotEntry(
                member, entry, runtime, formulaAiPilotCapital, paperInput.estimatedKrw, nowMs,
              );
              paperEntryPolicy = deriveRulePackPilotExecutionPolicy(
                member.policy, formulaAiPilotCapital,
              );
              paperInput = issueRulePackPilotDynamicCapReceipt(
                member.userId, paperInput, nowMs,
              );
            }
            const persistentStop = await repository.getGlobalEmergencyStop();
            const paperRun = await executeAutomaticPlan({
              repository,
              userId: member.userId,
              planInput: paperInput,
              policy: paperEntryPolicy,
              emergencyStopped: member.policy.emergencyStopped
                || persistentStop
                || process.env.TRADING_EMERGENCY_STOP === 'true',
            });
            let paperMirrorReady = false;
            if (!paperRun.plan || !paperRun.order) {
              result.blocked += 1;
            } else {
              if (paperRun.created.duplicate || paperRun.orderDuplicate) result.duplicates += 1;
              else result.createdPlans += 1;
              if (paperRun.order.state === 'FILLED') {
                result.filledOrders += paperRun.orderDuplicate ? 0 : 1;
                const lifecycle = await persistMemberAutoTradingPaperPositionBridge({
                  repository,
                  userId: member.userId,
                  plan: paperRun.plan,
                  order: paperRun.order,
                  entry,
                  now,
                });
                if (lifecycle.status === 'PERSISTED') {
                  result.positionLifecycles += 1;
                  paperMirrorReady = true;
                } else if (lifecycle.status === 'IDEMPOTENT') {
                  result.lifecycleIdempotent += 1;
                  paperMirrorReady = true;
                } else {
                  result.blocked += 1;
                }
              } else if (paperRun.order.state === 'REJECTED' || paperRun.order.state === 'RECOVERY_REQUIRED') {
                result.blocked += 1;
              }
              await refreshRuntime();
              entryProjectionHealthy = await syncExecutionProjection();
              if (!entryProjectionHealthy) {
                result.blocked += 1;
                break;
              }
            }

            // Live admission requires a canonical filled Paper mirror AND
            // persisted/idempotent lifecycle proof for this exact candidate.
            // A rejected Paper order or failed bridge must never lead to Live IO.
            if (liveModeRequested && !paperMirrorReady) {
              result.newEntriesFailClosed = true;
              result.blocked += 1;
              continue;
            }

            if (liveModeRequested && hasCapability(member.profile, 'canPlaceOrders')) {
              if (!liveExitsArmedThisTick) result.liveEntriesSuppressedByWarmupOrArm += 1;
              else if (!liveTelegramHealthyThisTick) result.liveEntriesSuppressedByTelegram += 1;
            }

            if (liveEntriesArmedThisTick && hasCapability(member.profile, 'canPlaceOrders')) {
              let liveMember = member;
              if (member.policy.pilotStage === 'formula-ai-exception') {
                formulaAiReviewReasonsForLive(entry, nowMs);
                formulaAiPilotCapital ??= await readRulePackPilotCapitalState(repository, member.userId, now);
                validateFormulaAiPilotEntry(
                  member,
                  entry,
                  runtime,
                  formulaAiPilotCapital,
                  paperInput.estimatedKrw,
                  nowMs,
                );
                liveMember = Object.freeze({
                  ...member,
                  policy: deriveRulePackPilotExecutionPolicy(member.policy, formulaAiPilotCapital),
                });
              }
              const provider = marketMapping(entry.identity.market, liveMember.policy).exchange as AccountProvider;
              const accountSnapshot = await this.source.readLiveAccountSnapshot(member.userId, provider);
              const liveSeed = await buildLivePlanInput({
                source: this.source,
                repository,
                member: liveMember,
                entry,
                runtime,
                paperInput,
                snapshot: accountSnapshot,
                fx,
                fxCache,
                nowMs,
              });
              const livePreview = await new TradeExecutionService(repository).previewLiveRiskSnapshot(
                member.userId,
                liveSeed,
                { fxKrwPerQuoteCurrency: fx.krwPerQuoteCurrency, now },
              );
              result.privateTradingRequests += livePreview.providerRequests;
              let liveInput: TradingPlanInput = {
                ...liveSeed,
                marketSnapshot: {
                  ...livePreview.snapshot,
                  dailyPnlPercent: liveSeed.marketSnapshot.dailyPnlPercent,
                  weeklyPnlPercent: liveSeed.marketSnapshot.weeklyPnlPercent,
                  consecutiveLosses: liveSeed.marketSnapshot.consecutiveLosses,
                  accountExposureKrw: liveSeed.marketSnapshot.accountExposureKrw,
                  instrumentExposureKrw: liveSeed.marketSnapshot.instrumentExposureKrw,
                  strategyExposureKrw: liveSeed.marketSnapshot.strategyExposureKrw,
                  assetClassExposureKrw: liveSeed.marketSnapshot.assetClassExposureKrw,
                  openRiskKrw: liveSeed.marketSnapshot.openRiskKrw,
                  correlatedExposurePercent: liveSeed.marketSnapshot.correlatedExposurePercent,
                  source: `${livePreview.snapshot.source ?? 'provider-private-preflight'}+member-live-auto`,
                },
                estimatedSlippagePercent: livePreview.snapshot.estimatedSlippagePercent,
                averageSpreadPercent: livePreview.snapshot.spreadPercent,
              };
              if (member.policy.pilotStage === 'formula-ai-exception'
                && liveInput.estimatedKrw > member.policy.maxOrderKrw) {
                liveInput = issueRulePackPilotDynamicCapReceipt(
                  member.userId, liveInput, nowMs,
                );
              }
              // Recheck after private preflight: a Telegram outage during the tick
              // must never allow a new automatic live order.
              // Global delivery proof cannot prove that THIS member's channel
              // is still connected. Check the actual connection separately.
              let memberTelegramReady = false;
              try {
                memberTelegramReady = await this.source.memberTelegramConnected?.(member.userId) === true;
              } catch {
                memberTelegramReady = false;
              }
              if (!memberTelegramReady) {
                result.newEntriesFailClosed = true;
                result.liveEntriesSuppressedByTelegram += 1;
                result.blocked += 1;
                break;
              }
              if (this.source.telegramDeliveryHealthy?.(Date.now()) !== true) {
                result.newEntriesFailClosed = true;
                result.liveEntriesSuppressedByTelegram += 1;
                result.blocked += 1;
                break;
              }
              // The operator may revoke the arm during provider preflight.
              if (!await liveEntryArmPresent()) {
                result.newEntriesFailClosed = true;
                result.liveEntriesSuppressedByWarmupOrArm += 1;
                result.blocked += 1;
                break;
              }
              const liveRun = await executeAutomaticPlan({
                repository,
                userId: member.userId,
                planInput: liveInput,
                policy: liveMember.policy,
                emergencyStopped: liveMember.policy.emergencyStopped
                  || persistentStop
                  || process.env.TRADING_EMERGENCY_STOP === 'true',
              });
              if (!liveRun.plan || !liveRun.order) {
                result.blocked += 1;
              } else {
                if (!liveRun.created.duplicate) result.livePlans += 1;
                else result.duplicates += 1;
                if (!liveRun.orderDuplicate
                  && ['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'RECOVERY_REQUIRED'].includes(liveRun.order.state)) {
                  result.liveOrders += 1;
                }
                if (liveRun.order.state === 'REJECTED') result.blocked += 1;
                await refreshRuntime();
                entryProjectionHealthy = await syncExecutionProjection();
                if (!entryProjectionHealthy) {
                  result.blocked += 1;
                  break;
                }
              }
            }
          } catch (error) {
            const code = errorCode(error);
            // Missing signal-specific AI proof is not a normal completed Live
            // readiness state. Preserve the paper journal, but expose this
            // failure to the UI and the protected activation warmup as blocked.
            if (code === 'BACKGROUND_FORMULA_AI_REVIEW_PROOF_REQUIRED') {
              result.newEntriesFailClosed = true;
            }
            if (code.startsWith('BACKGROUND_')
              || code.includes('RISK')
              || code.includes('LIMIT')
              || code.includes('BLOCKED')) result.blocked += 1;
            else result.failures += 1;
          }
        }

        if (!entryProjectionHealthy) result.newEntriesFailClosed = true;
      }

      if (liveModeRequested) {
        const cycleComplete = this.source.memberBatchCycleCompleted?.() ?? true;
        this.liveCycleOrderEligibleSeen ||= result.liveOrderEligibleMembers > 0;
        this.liveCyclePolicyReadySeen ||= result.livePolicyReadyMembers > 0;
        this.liveCycleAllFourPolicyReadySeen ||= result.liveAllFourPolicyReadyMembers > 0;
        if (cycleComplete
          && this.liveCycleAllFourPolicyReadySeen
          && this.liveCycleAllFourWitnessUserId
          && this.source.revalidateLiveAllFourReadiness) {
          const witnessStillReady = await this.source.revalidateLiveAllFourReadiness(
            this.liveCycleAllFourWitnessUserId,
          );
          if (!witnessStillReady) {
            this.liveCycleOrderEligibleSeen = false;
            this.liveCyclePolicyReadySeen = false;
            this.liveCycleAllFourPolicyReadySeen = false;
          this.liveCycleAllFourWitnessUserId = null;
          }
        }
        result.liveReadinessCycleComplete = cycleComplete;
        result.liveCycleOrderEligible = this.liveCycleOrderEligibleSeen;
        result.liveCyclePolicyReady = this.liveCyclePolicyReadySeen;
        result.liveCycleAllFourPolicyReady = this.liveCycleAllFourPolicyReadySeen;

        const hardWarmupBlock = !result.handoffReady
          || result.liveExitsSuppressedByPolicy > 0
          || paperAccountMissingThisTick
          || result.executionSyncFailures > 0
          || result.executionSyncMissingReferences > 0
          || result.globalEmergencyStopActive
          || memberAuditFailedThisTick;
        this.liveCycleHardWarmupBlocked ||= hardWarmupBlock;
        if (this.liveCycleHardWarmupBlocked) {
          this.liveEntryWarmupComplete = false;
          result.newEntriesFailClosed = true;
          // Publish effective readiness, not a pre-block witness snapshot.
          // Otherwise a failed earlier batch is reported ready on a later one.
          result.liveCycleOrderEligible = false;
          result.liveCyclePolicyReady = false;
          result.liveCycleAllFourPolicyReady = false;
          this.liveCycleOrderEligibleSeen = false;
          this.liveCyclePolicyReadySeen = false;
          this.liveCycleAllFourPolicyReadySeen = false;
          this.liveCycleAllFourWitnessUserId = null;
          // A completed blocked rotation is never ready. The NEXT complete
          // rotation can retry after the offending condition is remedied.
          if (cycleComplete) this.liveCycleHardWarmupBlocked = false;
        } else if (cycleComplete) {
          this.liveEntryWarmupComplete = this.liveCycleOrderEligibleSeen
            && this.liveCyclePolicyReadySeen
            && this.liveCycleAllFourPolicyReadySeen;
          if (!this.liveEntryWarmupComplete) result.newEntriesFailClosed = true;
          this.liveCycleOrderEligibleSeen = false;
          this.liveCyclePolicyReadySeen = false;
          this.liveCycleAllFourPolicyReadySeen = false;
          this.liveCycleAllFourWitnessUserId = null;
        }
      } else {
        this.liveEntryWarmupComplete = false;
        this.liveCycleHardWarmupBlocked = false;
        this.liveCycleOrderEligibleSeen = false;
        this.liveCyclePolicyReadySeen = false;
        this.liveCycleAllFourPolicyReadySeen = false;
          this.liveCycleAllFourWitnessUserId = null;
      }
      result.liveEntryWarmupComplete = this.liveEntryWarmupComplete;
      return result;
    } catch (error) {
      this.liveEntryWarmupComplete = false;
      this.liveCycleHardWarmupBlocked = false;
      this.liveCycleOrderEligibleSeen = false;
      this.liveCyclePolicyReadySeen = false;
      this.liveCycleAllFourPolicyReadySeen = false;
          this.liveCycleAllFourWitnessUserId = null;
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export function memberTelegramProofMatchesCurrentBinding(
  connection: Pick<UserTelegramConnection, 'status' | 'telegramChatId' | 'connectedAt'> | null | undefined,
  receipt: { state?: string | null; updated_at?: string | null } | null | undefined,
  nowMs = Date.now(),
) {
  if (connection?.status !== 'ACTIVE' || !connection.telegramChatId?.trim()) return false;
  const boundMs = Date.parse(connection.connectedAt ?? '');
  if (!Number.isFinite(boundMs) || boundMs > nowMs + 5_000) return false;
  const confirmedAt = verifiedRecentTelegramDeliveryReceipt(receipt, nowMs);
  return confirmedAt != null && Date.parse(confirmedAt) >= boundMs;
}

export class SupabaseMemberAutoTradingBackgroundSource implements MemberAutoTradingBackgroundSource {
  private readonly accountReaders = createVaultBackedAccountReaders();
  private memberBatchCursor: string | null = null;
  private lastMemberBatchCompletedCycle = true;

  constructor(
    private readonly client: SupabaseClient = getSupabase(),
    private readonly handoffPath = process.env.MEMBER_AUTO_TRADING_HANDOFF_PATH?.trim()
      || DEFAULT_HANDOFF_PATH,
  ) {
    if (!hasSupabaseServerKey()) throw new Error('TRADE_AUTOMATION_SERVICE_ROLE_REQUIRED');
  }

  async readHandoff(nowMs: number) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.resolve(this.handoffPath), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    return validateMemberAutoTradingPaperHandoff(parsed, nowMs);
  }

  async listEligibleMembers() {
    let query = this.client.from('trade_automation_profiles')
      .select('user_id,payload')
      // Include previously automatic members after their policy is switched
      // off, so outstanding Live positions remain visible to the supervisor.
      .order('user_id', { ascending: true })
      .limit(MAX_MEMBERS_PER_TICK + 1);
    if (this.memberBatchCursor) query = query.gt('user_id', this.memberBatchCursor);
    const { data, error } = await query;
    if (error) throw new Error('BACKGROUND_POLICY_LIST_FAILED');
    const fetched = data ?? [];
    const hasMore = fetched.length > MAX_MEMBERS_PER_TICK;
    const batch = fetched.slice(0, MAX_MEMBERS_PER_TICK);
    const lastUserId = String(batch.at(-1)?.user_id ?? '').trim();
    this.lastMemberBatchCompletedCycle = !hasMore;
    this.memberBatchCursor = hasMore && lastUserId ? lastUserId : null;
    const rows = batch.flatMap((row) => {
      const userId = String(row.user_id ?? '').trim();
      if (!userId) return [];
      const policy = normalizeTradingPolicy((row.payload ?? {}) as Partial<TradingPolicy>);
      return [{ userId, policy }];
    });
    if (rows.length === 0) return [];
    const { data: profiles, error: profileError } = await this.client.from('profiles')
      .select('id,role,status,membership_level,is_active,membership_expires_at').in('id', rows.map((row) => row.userId));
    if (profileError) throw new Error('BACKGROUND_MEMBER_LIST_FAILED');
    const byId = new Map((profiles ?? []).map((profile) => [String(profile.id), profile as MemberAccessProfile & { id: string }]));
    // Never silently drop an automation profile: an absent membership row
    // could hide stored Live fills from the safety supervisor.
    if (rows.some((row) => !byId.has(row.userId))) {
      throw new Error('BACKGROUND_MEMBER_ACCESS_PROFILE_MISSING');
    }
    return rows.map((row) => Object.freeze({
      userId: row.userId,
      policy: row.policy,
      profile: byId.get(row.userId)!,
    }));
  }

  memberBatchCycleCompleted() {
    return this.lastMemberBatchCompletedCycle;
  }

  telegramDeliveryHealthy(nowMs: number) {
    return userTelegramDeliveryWorkerHealthy(readUserTelegramDeliveryWorkerHealth(), nowMs);
  }

  async memberTelegramConnected(userId: string) {
    const connection = await createSupabaseUserBrokerTelegramRepository()
      .getTelegramConnection(userId);
    if (connection?.status !== 'ACTIVE' || !connection.telegramChatId) return false;
    // The member may have revoked and rebound to a different chat. A SENT
    // proof for the old binding must never arm a new Live entry.
    const nowMs = Date.now();
    const bindingMs = Date.parse(connection.connectedAt);
    if (!Number.isFinite(bindingMs) || bindingMs > nowMs + 5_000) return false;
    const { data, error } = await this.client.from('notification_deliveries')
      .select('state,updated_at')
      .eq('user_id', userId)
      .eq('delivery_kind', 'EXECUTION_EVENT')
      .in('state', ['SENT', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'FAILED'])
      .gte('updated_at', new Date(Math.max(bindingMs, nowMs - 24 * 60 * 60_000)).toISOString())
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw new Error('BACKGROUND_MEMBER_TELEGRAM_SENT_RECEIPT_REQUIRED');
    return memberTelegramProofMatchesCurrentBinding(connection, data?.[0] ?? null, nowMs);
  }

  async revalidateLiveAllFourReadiness(userId: string) {
    const { data: policyRows, error: policyError } = await this.client.from('trade_automation_profiles')
      .select('user_id,payload')
      .eq('user_id', userId)
      .limit(1);
    if (policyError) throw new Error('BACKGROUND_LIVE_READINESS_REVALIDATION_FAILED');
    const policyRow = policyRows?.[0];
    if (!policyRow?.payload) return false;

    const { data: profileRows, error: profileError } = await this.client.from('profiles')
      .select('id,role,status,membership_level,is_active,membership_expires_at')
      .eq('id', userId)
      .limit(1);
    if (profileError) throw new Error('BACKGROUND_LIVE_READINESS_REVALIDATION_FAILED');
    const profile = profileRows?.[0] as (MemberAccessProfile & { id: string }) | undefined;
    if (!profile) return false;

    const policy = normalizeTradingPolicy(policyRow.payload as Partial<TradingPolicy>);
    const nowMs = Date.now();
    const repository = createServiceRoleTradingRepository(userId, this.client);
    const paperRepository = createServiceRolePaperJournalRepository(userId, this.client);
    const [persistentGlobalStop, connections, runtime] = await Promise.all([
      repository.getGlobalEmergencyStop(),
      repository.getConnections(userId),
      memberRuntimeState(userId, repository, paperRepository, nowMs),
    ]);
    return hasCapability(profile, 'canAccessAutoTrading')
      && hasCapability(profile, 'canPlaceOrders')
      && hasCapability(profile, 'canAccessFutures')
      && automaticPolicyHasAllFourMarkets(policy)
      && liveAllFourConnectionVerificationReady(policy, connections, nowMs)
      && runtime.paperAccountReady
      && !persistentGlobalStop
      && process.env.TRADING_EMERGENCY_STOP !== 'true'
      // A globally healthy Telegram worker cannot attest a specific user's
      // channel. Reject full-cycle warmup when the witness has no ACTIVE binding.
      && await this.memberTelegramConnected(userId);
  }

  tradingRepositoryFor(userId: string) {
    return createServiceRoleTradingRepository(userId, this.client);
  }

  paperJournalRepositoryFor(userId: string) {
    return createServiceRolePaperJournalRepository(userId, this.client);
  }

  async syncExecutionEvents(input: {
    userId: string;
    profile: MemberAccessProfile;
    repository: TradingRepository;
    paperJournalRepository: PaperJournalRepository;
  }) {
    const integration = new UserBrokerTelegramService(
      createSupabaseUserBrokerTelegramRepository(),
      executionProjectionTransport,
      new CanonicalPortfolioSyncSink(input.paperJournalRepository, input.userId),
    );
    const result = await new TradeExecutionEventBridgeService(input.repository, integration)
      .syncUser(input.userId, deriveMemberTier(input.profile));
    return {
      inserted: result.inserted,
      deliveryQueued: result.deliveryQueued,
      missingReferences: result.missingReferences,
    };
  }

  resolveFx(market: MemberAutoTradingPaperHandoffEntry['identity']['market'], nowMs: number) {
    return resolveMemberAutoTradingKrwRate(market, { nowMs });
  }

  async readLiveAccountSnapshot(userId: string, provider: AccountProvider) {
    const reader = this.accountReaders[provider];
    if (!reader) throw new Error('BACKGROUND_LIVE_ACCOUNT_READER_UNAVAILABLE');
    return reader({ userId, accessToken: 'service-role-background' });
  }

  readMarketMark(
    market: MemberAutoTradingPaperHandoffEntry['identity']['market'],
    symbol: string,
  ) {
    return readMemberAutoTradingMarketMark(market, symbol);
  }
}

export function startMemberAutoTradingBackgroundWorker(): { stop(): void } | null {
  if (process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED !== 'true') {
    backgroundRuntimeHealth = Object.freeze({
      ...backgroundRuntimeHealth,
      enabled: false,
      liveModeRequested: false,
      lastTickAt: null,
      tickOk: null,
      handoffStatus: 'MISSING',
      handoffReady: false,
      newEntriesFailClosed: true,
      liveEntryArmPresent: false,
      liveEntriesArmed: false,
      liveEntryWarmupComplete: false,
      startupWarmupObserved: false,
      firstWarmupTickLiveEntriesArmed: null,
      firstWarmupTickLiveOrders: null,
      firstWarmupTickLiveExitOrders: null,
      liveTrackedPositions: 0,
      liveExitsSuppressedByWarmupOrArm: 0,
  liveExitsSuppressedByPolicy: 0,
      executionSyncFailures: 0,
      executionSyncMissingReferences: 0,
      liveOrderEligibleMembers: 0,
      livePolicyReadyMembers: 0,
      liveAllFourPolicyReadyMembers: 0,
      liveReadinessCycleComplete: true,
      liveCycleOrderEligible: false,
      liveCyclePolicyReady: false,
      liveCycleAllFourPolicyReady: false,
      globalEmergencyStopActive: false,
      errorCode: null,
    });
    console.log('[member-auto-trading-background] disabled; explicit enable flag is required');
    return null;
  }
  if (!hasSupabaseServerKey()) {
    backgroundRuntimeHealth = Object.freeze({
      ...backgroundRuntimeHealth,
      enabled: true,
      liveModeRequested: liveBackgroundEnabled(),
      lastTickAt: null,
      tickOk: false,
      handoffStatus: 'MISSING',
      handoffReady: false,
      newEntriesFailClosed: true,
      liveEntryArmPresent: false,
      liveEntriesArmed: false,
      liveEntryWarmupComplete: false,
      startupWarmupObserved: false,
      firstWarmupTickLiveEntriesArmed: null,
      firstWarmupTickLiveOrders: null,
      firstWarmupTickLiveExitOrders: null,
      liveTrackedPositions: 0,
      liveExitsSuppressedByWarmupOrArm: 0,
  liveExitsSuppressedByPolicy: 0,
      executionSyncFailures: 0,
      executionSyncMissingReferences: 0,
      liveOrderEligibleMembers: 0,
      livePolicyReadyMembers: 0,
      liveAllFourPolicyReadyMembers: 0,
      liveReadinessCycleComplete: true,
      liveCycleOrderEligible: false,
      liveCyclePolicyReady: false,
      liveCycleAllFourPolicyReady: false,
      globalEmergencyStopActive: false,
      errorCode: 'TRADE_AUTOMATION_SERVICE_ROLE_REQUIRED',
    });
    console.error('[member-auto-trading-background] blocked: service-role Supabase configuration is required');
    return null;
  }
  backgroundRuntimeHealth = Object.freeze({
    ...backgroundRuntimeHealth,
    enabled: true,
    liveModeRequested: liveBackgroundEnabled(),
    lastTickAt: null,
    tickOk: null,
    handoffStatus: 'MISSING',
    handoffReady: false,
    newEntriesFailClosed: true,
    liveEntryArmPresent: false,
    liveEntriesArmed: false,
    liveEntryWarmupComplete: false,
    startupWarmupObserved: false,
    firstWarmupTickLiveEntriesArmed: null,
    firstWarmupTickLiveOrders: null,
    firstWarmupTickLiveExitOrders: null,
    liveTrackedPositions: 0,
    liveExitsSuppressedByWarmupOrArm: 0,
  liveExitsSuppressedByPolicy: 0,
    executionSyncFailures: 0,
    executionSyncMissingReferences: 0,
    liveOrderEligibleMembers: 0,
    livePolicyReadyMembers: 0,
    liveAllFourPolicyReadyMembers: 0,
    liveReadinessCycleComplete: true,
    liveCycleOrderEligible: false,
    liveCyclePolicyReady: false,
    liveCycleAllFourPolicyReady: false,
    globalEmergencyStopActive: false,
    errorCode: null,
  });
  const worker = new MemberAutoTradingBackgroundWorker(new SupabaseMemberAutoTradingBackgroundSource());
  const tick = async () => {
    try {
      const result = await worker.runOnce(new Date());
      if (result.overlapSkipped) return;
      const warmupObservedNow = !backgroundRuntimeHealth.startupWarmupObserved
        && result.liveEntryWarmupComplete;
      backgroundRuntimeHealth = Object.freeze({
        enabled: true,
        liveModeRequested: liveBackgroundEnabled(),
        lastTickAt: new Date().toISOString(),
        tickOk: result.failures === 0 && result.executionSyncFailures === 0
          && result.executionSyncMissingReferences === 0,
        handoffStatus: result.handoffStatus,
        handoffReady: result.handoffReady,
        newEntriesFailClosed: result.newEntriesFailClosed,
        liveEntryArmPresent: result.liveEntryArmPresent,
        liveEntriesArmed: result.liveEntriesArmed,
        liveEntryWarmupComplete: result.liveEntryWarmupComplete,
        startupWarmupObserved: backgroundRuntimeHealth.startupWarmupObserved || warmupObservedNow,
        firstWarmupTickLiveEntriesArmed: warmupObservedNow
          ? result.liveEntriesArmed
          : backgroundRuntimeHealth.firstWarmupTickLiveEntriesArmed,
        firstWarmupTickLiveOrders: warmupObservedNow
          ? result.liveOrders
          : backgroundRuntimeHealth.firstWarmupTickLiveOrders,
        firstWarmupTickLiveExitOrders: warmupObservedNow
          ? result.liveExitOrders
          : backgroundRuntimeHealth.firstWarmupTickLiveExitOrders,
        liveTrackedPositions: result.liveTrackedPositions,
        liveExitsSuppressedByWarmupOrArm: result.liveExitsSuppressedByWarmupOrArm,
        liveExitsSuppressedByPolicy: result.liveExitsSuppressedByPolicy,
        executionSyncFailures: result.executionSyncFailures,
        executionSyncMissingReferences: result.executionSyncMissingReferences,
        liveOrderEligibleMembers: result.liveOrderEligibleMembers,
        livePolicyReadyMembers: result.livePolicyReadyMembers,
        liveAllFourPolicyReadyMembers: result.liveAllFourPolicyReadyMembers,
        liveReadinessCycleComplete: result.liveReadinessCycleComplete,
        liveCycleOrderEligible: result.liveCycleOrderEligible,
        liveCyclePolicyReady: result.liveCyclePolicyReady,
        liveCycleAllFourPolicyReady: result.liveCycleAllFourPolicyReady,
        globalEmergencyStopActive: result.globalEmergencyStopActive,
        errorCode: result.failures > 0 ? 'BACKGROUND_AUTOMATION_TICK_PARTIAL_FAILURE'
          : result.executionSyncFailures > 0 || result.executionSyncMissingReferences > 0
            ? 'BACKGROUND_EXECUTION_PROJECTION_UNAVAILABLE' : null,
      });
      if (result.handoffStatus !== 'READY' || result.evaluated > 0
        || result.paperExitOrders > 0 || result.liveExitOrders > 0
        || result.exitBlocked > 0 || result.executionSyncBlocks > 0
        || result.liveEntriesSuppressedByWarmupOrArm > 0
        || result.liveEntriesSuppressedByTelegram > 0
        || result.liveExitsSuppressedByWarmupOrArm > 0
        || result.liveExitsSuppressedByPolicy > 0 || result.failures > 0) {
        console.log('[member-auto-trading-background] tick', result);
      }
    } catch (error) {
      backgroundRuntimeHealth = Object.freeze({
        ...backgroundRuntimeHealth,
        enabled: true,
        liveModeRequested: liveBackgroundEnabled(),
        lastTickAt: new Date().toISOString(),
        tickOk: false,
        newEntriesFailClosed: true,
        liveEntriesArmed: false,
        liveEntryWarmupComplete: false,
        liveReadinessCycleComplete: true,
        liveCycleOrderEligible: false,
        liveCyclePolicyReady: false,
        liveCycleAllFourPolicyReady: false,
        errorCode: errorCode(error),
      });
      console.error('[member-auto-trading-background] tick failed', {
        errorCode: errorCode(error),
      });
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs(process.env.MEMBER_AUTO_TRADING_BACKGROUND_INTERVAL_MS));
  timer.unref?.();
  console.log(liveBackgroundEnabled()
    ? '[member-auto-trading-background] started in Paper+Live guarded mode'
    : '[member-auto-trading-background] started in Paper-only mode');
  return { stop: () => clearInterval(timer) };
}
