import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TradingRepository } from './trade-automation.repository';
import type { TradingOrder, TradingPlan, TradingPlanInput, TradingPolicy } from './trade-automation.types';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import {
  isEvidenceBackedAutoStrategyId,
  RULE_PACK_PILOT_PROFILE,
} from './evidence-backed-auto-strategy-catalog.service';

export type RulePackPilotLossReference = Readonly<{ closedAt: string; signalId: string }>;
export type RulePackPilotCapitalState = Readonly<{
  initialOperatingCapitalKrw: number;
  operatingCapitalKrw: number;
  reserveKrw: number;
  highWaterMarkKrw: number;
  maxEntryKrw: number;
  realizedNetPnlKrw: number;
  compoundedProfitKrw: number;
  settledTradeCount: number;
  dailyRealizedPnlKrw: number;
  dailyLosingTrades: number;
  consecutiveLosses: number;
  latestLossBySymbol: Readonly<Record<string, RulePackPilotLossReference>>;
  settlementReady: boolean;
  blockers: readonly string[];
  reserveWithdrawalAutomatic: false;
}>;
export type RulePackPilotRealizedTrade = Readonly<{
  id: string;
  symbol: string;
  signalId: string;
  closedAt: string;
  netPnlKrw: number;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function roundKrw(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function kstDay(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year + '-' + byType.month + '-' + byType.day;
}
function normalizedSymbol(value: string) {
  return value.trim().toUpperCase().replace(/^KRW-/u, '');
}

// Canonical TradingRepository.listOrders/listPlans are presently bounded to
// 500/200 newest rows. A truncated history must never reset the high-water
// mark and re-credit old profits as new compoundable gains.
export function rulePackPilotLedgerHistoryComplete(orderCount: number, planCount: number): boolean {
  return Number.isSafeInteger(orderCount) && Number.isSafeInteger(planCount)
    && orderCount >= 0 && planCount >= 0 && orderCount < 500 && planCount < 200;
}

export function deriveRulePackPilotCapitalFromTrades(
  trades: readonly RulePackPilotRealizedTrade[],
  now = new Date(),
): RulePackPilotCapitalState {
  let operatingCapitalKrw = RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw;
  let reserveKrw = 0;
  let highWaterMarkKrw = RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw;
  let realizedNetPnlKrw = 0;
  let compoundedProfitKrw = 0;
  let consecutiveLosses = 0;
  let dailyRealizedPnlKrw = 0;
  let dailyLosingTrades = 0;
  const latestLossBySymbol: Record<string, RulePackPilotLossReference> = {};
  const blockers: string[] = [];
  const seenTradeIds = new Set<string>();
  let settledTradeCount = 0;
  const today = kstDay(now);
  const nowMs = now.getTime();

  const sorted = [...trades].sort((left, right) => {
    const time = Date.parse(left.closedAt) - Date.parse(right.closedAt);
    return time !== 0 ? time : left.id.localeCompare(right.id);
  });

  // Multiple fills can share the same recorded millisecond. Crediting a
  // winning row before a simultaneous loss would manufacture HWM earnings
  // according to arbitrary order IDs. Settle an equal-time batch at net PnL.
  let batchTimestamp: number | null = null;
  let batchPnlKrw = 0;
  let batchLosses = 0;
  let batchWins = 0;
  const settleBatch = () => {
    if (batchTimestamp == null) return;
    if (!finite(batchPnlKrw)) {
      blockers.push('PILOT_CAPITAL_SETTLEMENT_OVERFLOW');
    } else if (batchPnlKrw < 0) {
      if (operatingCapitalKrw + batchPnlKrw < 0) {
        blockers.push('PILOT_CAPITAL_NEGATIVE_EQUITY_UNSUPPORTED');
      }
      operatingCapitalKrw = Math.max(0, operatingCapitalKrw + batchPnlKrw);
    } else if (batchPnlKrw > 0) {
      const totalBefore = operatingCapitalKrw + reserveKrw;
      const totalAfter = totalBefore + batchPnlKrw;
      const newHighProfit = Math.max(0, totalAfter - highWaterMarkKrw);
      const recoveryProfit = Math.max(0, batchPnlKrw - newHighProfit);
      const compound = newHighProfit * RULE_PACK_PILOT_PROFILE.profitCompoundShare;
      const reserve = newHighProfit - compound;
      operatingCapitalKrw += recoveryProfit + compound;
      reserveKrw += reserve;
      compoundedProfitKrw += compound;
      highWaterMarkKrw += newHighProfit;
    }
    // An indistinguishably simultaneous win does not cancel evidence of a
    // loss streak; this is intentionally conservative without fill sequence.
    if (batchLosses > 0) consecutiveLosses += batchLosses;
    else if (batchWins > 0) consecutiveLosses = 0;
    batchTimestamp = null;
    batchPnlKrw = 0;
    batchLosses = 0;
    batchWins = 0;
  };

  for (const trade of sorted) {
    const closedAtMs = Date.parse(trade.closedAt);
    if (!trade.id?.trim() || !trade.symbol?.trim() || !trade.signalId?.trim()
      || !finite(trade.netPnlKrw) || !Number.isFinite(closedAtMs)
      || !Number.isFinite(nowMs) || closedAtMs > nowMs + 5_000) {
      blockers.push('PILOT_CAPITAL_TRADE_EVIDENCE_INVALID');
      continue;
    }
    if (seenTradeIds.has(trade.id)) {
      blockers.push('PILOT_CAPITAL_DUPLICATE_SETTLEMENT');
      continue;
    }
    if (batchTimestamp != null && batchTimestamp !== closedAtMs) settleBatch();
    if (batchTimestamp == null) batchTimestamp = closedAtMs;

    seenTradeIds.add(trade.id);
    settledTradeCount += 1;
    const pnl = trade.netPnlKrw;
    realizedNetPnlKrw += pnl;
    batchPnlKrw += pnl;
    if (pnl < 0) {
      batchLosses += 1;
      latestLossBySymbol[normalizedSymbol(trade.symbol)] = Object.freeze({
        closedAt: trade.closedAt, signalId: trade.signalId,
      });
    } else if (pnl > 0) batchWins += 1;
    if (kstDay(trade.closedAt) === today) {
      dailyRealizedPnlKrw += pnl;
      if (pnl < 0) dailyLosingTrades += 1;
    }
  }
  settleBatch();
  if (![operatingCapitalKrw, reserveKrw, highWaterMarkKrw,
    realizedNetPnlKrw, compoundedProfitKrw, dailyRealizedPnlKrw].every(finite)) {
    blockers.push('PILOT_CAPITAL_SETTLEMENT_OVERFLOW');
  }

  return Object.freeze({
    initialOperatingCapitalKrw: RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw,
    operatingCapitalKrw: roundKrw(operatingCapitalKrw),
    reserveKrw: roundKrw(reserveKrw),
    highWaterMarkKrw: roundKrw(highWaterMarkKrw),
    maxEntryKrw: roundKrw(operatingCapitalKrw),
    realizedNetPnlKrw: roundKrw(realizedNetPnlKrw),
    compoundedProfitKrw: roundKrw(compoundedProfitKrw),
    settledTradeCount,
    dailyRealizedPnlKrw: roundKrw(dailyRealizedPnlKrw),
    dailyLosingTrades,
    consecutiveLosses,
    latestLossBySymbol: Object.freeze({ ...latestLossBySymbol }),
    settlementReady: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    reserveWithdrawalAutomatic: false,
  });
}

export type RulePackPilotEntryGuardInput = Readonly<{
  pilot: RulePackPilotCapitalState;
  strategyId: string;
  symbol: string;
  signalId: string;
  estimatedKrw: number;
  policyMaxOrderKrw: number;
  policyTotalCapitalKrw: number;
  openLivePositions: number;
  nowMs: number;
}>;

export type RulePackPilotEntryGuardDecision = Readonly<{
  allowed: boolean;
  blockers: readonly string[];
  effectiveOperatingCapitalKrw: number;
  effectiveMaxEntryKrw: number;
}>;

export function evaluateRulePackPilotEntryGuard(
  input: RulePackPilotEntryGuardInput,
): RulePackPilotEntryGuardDecision {
  const blockers: string[] = [];
  const add = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };
  const operatingCapital = finite(input.pilot.operatingCapitalKrw)
    ? Math.max(0, input.pilot.operatingCapitalKrw)
    : 0;
  const pilotMaxEntry = finite(input.pilot.maxEntryKrw)
    ? Math.max(0, input.pilot.maxEntryKrw)
    : 0;
  const policyMaxOrder = finite(input.policyMaxOrderKrw)
    ? Math.max(0, input.policyMaxOrderKrw)
    : 0;
  // The original 500k ceiling tracks verified profit: 500k -> 525k after
  // 50k net profit (25k compound / 25k reserve). A deliberately stricter
  // policy (e.g. 30k) must NOT be silently elevated to 500k.
  const initial = RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw;
  const growth = Math.max(0, operatingCapital - initial);
  const dynamicPolicyCap = policyMaxOrder >= initial ? policyMaxOrder + growth : policyMaxOrder;
  const effectiveMaxEntryKrw = Math.min(operatingCapital, pilotMaxEntry, dynamicPolicyCap);

  if (!finite(input.policyTotalCapitalKrw) || input.policyTotalCapitalKrw < initial) {
    add('BACKGROUND_PILOT_BASE_POLICY_CAPITAL_REQUIRED');
  }
  // 500k is a risk floor, NOT a fabricated deposit or an instruction to
  // draw from the separately earmarked reserve after a loss.
  if (operatingCapital < initial) add('BACKGROUND_PILOT_BASE_CAPITAL_UNDERFUNDED');

  if (!isEvidenceBackedAutoStrategyId(input.strategyId)) add('BACKGROUND_FORMULA_AI_PILOT_STRATEGY_REQUIRED');
  if (!input.pilot.settlementReady || input.pilot.blockers.length > 0) add('BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED');
  if (!(operatingCapital > 0) || !(effectiveMaxEntryKrw > 0)) add('BACKGROUND_PILOT_CAPITAL_UNAVAILABLE');
  if (!(finite(input.estimatedKrw) && input.estimatedKrw > 0)
    || input.estimatedKrw > effectiveMaxEntryKrw) add('BACKGROUND_PILOT_ENTRY_LIMIT');
  if (input.pilot.dailyLosingTrades >= RULE_PACK_PILOT_PROFILE.maxDailyLosingTrades) {
    add('BACKGROUND_PILOT_DAILY_LOSS_COUNT_LIMIT');
  }
  if (input.pilot.dailyRealizedPnlKrw <= -RULE_PACK_PILOT_PROFILE.dailyLossStopKrw) {
    add('BACKGROUND_PILOT_DAILY_LOSS_KRW_LIMIT');
  }
  if (input.pilot.consecutiveLosses >= RULE_PACK_PILOT_PROFILE.maxConsecutiveLosses) {
    add('BACKGROUND_PILOT_CONSECUTIVE_LOSS_LIMIT');
  }
  if (input.openLivePositions >= RULE_PACK_PILOT_PROFILE.maxConcurrentLivePositions) {
    add('BACKGROUND_PILOT_CONCURRENT_POSITION_LIMIT');
  }

  const lastLoss = input.pilot.latestLossBySymbol[normalizedSymbol(input.symbol)];
  if (lastLoss) {
    if (lastLoss.signalId === input.signalId) add('BACKGROUND_PILOT_FRESH_SIGNAL_REQUIRED');
    const closedAt = Date.parse(lastLoss.closedAt);
    if (!Number.isFinite(closedAt)
      || input.nowMs - closedAt < RULE_PACK_PILOT_PROFILE.lossCooldownMinutes * 60_000) {
      add('BACKGROUND_PILOT_LOSS_COOLDOWN_ACTIVE');
    }
  }

  return Object.freeze({
    allowed: blockers.length === 0,
    blockers: Object.freeze(blockers.sort()),
    effectiveOperatingCapitalKrw: operatingCapital,
    effectiveMaxEntryKrw,
  });
}


/**
 * A verified, settlement-backed capital snapshot is the only source allowed
 * to grow the 500k risk ceiling. This is a POLICY PROJECTION ONLY: it does not
 * deposit/withdraw funds, change stored member policy or grant Live authority.
 */
export function deriveRulePackPilotExecutionPolicy(
  policy: TradingPolicy,
  pilot: RulePackPilotCapitalState,
): TradingPolicy {
  const initial = RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw;
  const operating = pilot.operatingCapitalKrw;
  if (!pilot.settlementReady || pilot.blockers.length > 0
    || !finite(operating) || operating < initial
    || !finite(policy.totalCapitalKrw) || policy.totalCapitalKrw < initial) {
    throw new Error('BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED');
  }
  const growth = Math.max(0, operating - initial);
  const capital = roundKrw(Math.min(operating, policy.totalCapitalKrw + growth));
  const growingCap = (original: number) => roundKrw(Math.min(
    capital,
    original >= initial ? original + growth : original,
  ));
  return {
    ...policy,
    totalCapitalKrw: capital,
    maxOrderKrw: growingCap(policy.maxOrderKrw),
    maxInstrumentKrw: growingCap(policy.maxInstrumentKrw),
    maxAssetClassKrw: {
      domestic_stock: growingCap(policy.maxAssetClassKrw.domestic_stock),
      us_stock: growingCap(policy.maxAssetClassKrw.us_stock),
      crypto_spot: growingCap(policy.maxAssetClassKrw.crypto_spot),
      crypto_futures: growingCap(policy.maxAssetClassKrw.crypto_futures),
    },
  };
}

/**
 * A compounding allowance must be backed by actually settled KRW net profit.
 * USD/USDT order-size estimates are NOT evidence of close-time conversion,
 * and Bitget needs an audited funding-fee statement not yet in this journal.
 */
export function verifiedRulePackKrwSettlement(input: Readonly<{
  market: string;
  currency: string;
  grossPnl: number;
  fees: number | null;
  tax: number | null;
}>):
  | Readonly<{ ok: true; netPnlKrw: number }>
  | Readonly<{ ok: false; code: string }> {
  const blocked = (code: string) => Object.freeze({ ok: false as const, code });
  if (input.fees == null || !finite(input.fees) || input.fees < 0
    || !finite(input.grossPnl)) return blocked('PILOT_CAPITAL_FEE_EVIDENCE_UNAVAILABLE');
  if (input.market === 'KR_STOCK' && (input.tax == null || !finite(input.tax))) {
    return blocked('PILOT_CAPITAL_KR_TAX_EVIDENCE_UNAVAILABLE');
  }
  if (input.market === 'CRYPTO_FUTURES') {
    return blocked('PILOT_CAPITAL_FUTURES_FUNDING_SETTLEMENT_REQUIRED');
  }
  if (input.currency !== 'KRW') return blocked('PILOT_CAPITAL_SETTLEMENT_KRW_FX_REQUIRED');
  const tax = input.tax == null ? 0 : input.tax;
  if (!finite(tax) || tax < 0) return blocked('PILOT_CAPITAL_TAX_EVIDENCE_INVALID');
  const netPnlKrw = input.grossPnl - input.fees - tax;
  if (!finite(netPnlKrw)) return blocked('PILOT_CAPITAL_REALIZED_NET_PNL_INVALID');
  return Object.freeze({ ok: true as const, netPnlKrw });
}


const PILOT_DYNAMIC_CAP_RECEIPT_PREFIX = 'PILOT_DYNAMIC_CAP_V1:';
const PILOT_DYNAMIC_CAP_RECEIPT_MAX_AGE_MS = 90_000;
const PILOT_DYNAMIC_CAP_CLOCK_SKEW_MS = 5_000;

function pilotCapSigningKey(): string | null {
  const key = process.env.RULE_PACK_PILOT_CAP_ATTESTATION_KEY ?? '';
  // A dedicated independent secret is mandatory. Never reuse broker keys,
  // app encryption keys, deploy SHAs or public Paper handoff digests.
  return Buffer.byteLength(key, 'utf8') >= 32 ? key : null;
}

function pilotCapReasons(plan: Pick<TradingPlanInput, 'signalReasons'>) {
  return plan.signalReasons.filter((value) => typeof value === 'string'
    && !value.startsWith(PILOT_DYNAMIC_CAP_RECEIPT_PREFIX));
}

function pilotCapIdentity(
  plan: TradingPlanInput,
  userId: string,
  issuedAtMs: number,
) {
  return JSON.stringify([
    'PILOT_DYNAMIC_CAP_V1', userId, issuedAtMs,
    plan.accountMode, plan.exchange, plan.stockBroker ?? null,
    plan.stockExchange ?? null, plan.market, plan.symbol.toUpperCase(),
    plan.side, plan.orderType, plan.quantity ?? null, plan.quoteAmount ?? null,
    plan.estimatedKrw, plan.stopPrice, plan.targetPrices,
    plan.splitRatios, plan.leverage ?? null, plan.marginMode ?? null,
    plan.reduceOnly === true, plan.strategyId, plan.signalId,
    pilotCapReasons(plan).slice().sort(),
  ]);
}

function authenticPilotCapHandoff(plan: TradingPlanInput): boolean {
  return plan.signalReasons.includes('CANONICAL_PAPER_HANDOFF')
    && plan.signalReasons.some((value) =>
      /^HANDOFF_ID:paper-auto-handoff:sha256:[0-9a-f]{64}$/u.test(value))
    && (plan.accountMode !== 'live'
      || plan.signalReasons.includes('CANONICAL_LIVE_AUTO_HANDOFF'));
}

/**
 * Issue only inside the server's validated Paper -> Live worker. The public
 * /plans route must never call this function with user-provided plan data.
 * This receipt grants NO Live authority by itself: current policy, profit
 * ledger, risk envelope, arm, broker position, and execution gates still run.
 */
export function issueRulePackPilotDynamicCapReceipt(
  userId: string,
  plan: TradingPlanInput,
  nowMs = Date.now(),
): TradingPlanInput {
  if (process.env.RULE_PACK_PILOT_DYNAMIC_CAP_ENABLED !== 'true') {
    throw new Error('BACKGROUND_PILOT_DYNAMIC_CAP_DISABLED');
  }
  const key = pilotCapSigningKey();
  if (!key) throw new Error('BACKGROUND_PILOT_DYNAMIC_CAP_SIGNING_KEY_REQUIRED');
  if (!authenticPilotCapHandoff(plan) || !Number.isSafeInteger(nowMs) || nowMs < 0
    || !Number.isFinite(plan.estimatedKrw) || plan.estimatedKrw <= 0) {
    throw new Error('BACKGROUND_PILOT_DYNAMIC_CAP_HANDOFF_INVALID');
  }
  const reasons = pilotCapReasons(plan);
  const unsigned = { ...plan, signalReasons: reasons };
  const signature = createHmac('sha256', key)
    .update(pilotCapIdentity(unsigned, userId, nowMs)).digest('hex');
  return {
    ...unsigned,
    signalReasons: [...reasons, PILOT_DYNAMIC_CAP_RECEIPT_PREFIX + nowMs + ':' + signature],
  };
}

/**
 * A member can supply arbitrary signalReasons, so a string/digest without
 * a server-held HMAC must NEVER expand a stored financial limit.
 */
export function verifyRulePackPilotDynamicCapReceipt(
  userId: string,
  plan: TradingPlanInput,
  nowMs = Date.now(),
): boolean {
  if (process.env.RULE_PACK_PILOT_DYNAMIC_CAP_ENABLED !== 'true'
    || !authenticPilotCapHandoff(plan)) return false;
  const key = pilotCapSigningKey();
  if (!key || !Number.isFinite(nowMs)) return false;
  const receipts = plan.signalReasons.filter((value) =>
    typeof value === 'string' && value.startsWith(PILOT_DYNAMIC_CAP_RECEIPT_PREFIX));
  if (receipts.length !== 1) return false;
  const m = /^PILOT_DYNAMIC_CAP_V1:(\d{13}):([0-9a-f]{64})$/u.exec(receipts[0]!);
  if (!m) return false;
  const issuedAtMs = Number(m[1]);
  if (!Number.isSafeInteger(issuedAtMs)
    || issuedAtMs - nowMs > PILOT_DYNAMIC_CAP_CLOCK_SKEW_MS
    || nowMs - issuedAtMs > PILOT_DYNAMIC_CAP_RECEIPT_MAX_AGE_MS) return false;
  const expected = createHmac('sha256', key)
    .update(pilotCapIdentity(plan, userId, issuedAtMs)).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex'));
}

/**
 * Re-evaluate the immutable worker receipt against CURRENT stored policy and
 * CURRENT settled profit on both approval and provider pre-submission paths.
 * A missing/expired/forged token never falls back to manual order authority.
 */
export async function resolveRulePackPilotDynamicCapPolicy(
  repository: TradingRepository,
  userId: string,
  plan: TradingPlan,
  policy: TradingPolicy,
  now = new Date(),
  openLivePositions = plan.marketSnapshot.openPositionCount,
): Promise<TradingPolicy> {
  if (plan.reduceOnly === true || (plan.accountMode !== 'paper' && plan.accountMode !== 'live')) {
    return policy;
  }
  const hasReceipt = plan.signalReasons.some((reason) =>
    typeof reason === 'string' && reason.startsWith(PILOT_DYNAMIC_CAP_RECEIPT_PREFIX));
  const requiresExtension = plan.estimatedKrw > policy.maxOrderKrw;
  if (!hasReceipt && !requiresExtension) return policy;
  if (plan.executionMode !== 'automatic' || policy.mode !== 'automatic'
    || !policy.automaticEnabled || policy.emergencyStopped || policy.newEntriesStopped
    || policy.pilotStage !== 'formula-ai-exception'
    || !isEvidenceBackedAutoStrategyId(plan.strategyId)) {
    throw new Error('BACKGROUND_PILOT_DYNAMIC_CAP_POLICY_REVOKED');
  }
  if (!verifyRulePackPilotDynamicCapReceipt(userId, plan, now.getTime())) {
    throw new Error('BACKGROUND_PILOT_DYNAMIC_CAP_ATTESTATION_REQUIRED');
  }
  const pilot = await readRulePackPilotCapitalState(repository, userId, now);
  const decision = evaluateRulePackPilotEntryGuard({
    pilot,
    strategyId: plan.strategyId,
    symbol: plan.symbol,
    signalId: plan.signalId,
    estimatedKrw: plan.estimatedKrw,
    policyMaxOrderKrw: policy.maxOrderKrw,
    policyTotalCapitalKrw: policy.totalCapitalKrw,
    openLivePositions: Number.isSafeInteger(openLivePositions) && openLivePositions >= 0
      ? openLivePositions : Number.POSITIVE_INFINITY,
    nowMs: now.getTime(),
  });
  if (!decision.allowed) {
    throw new Error(decision.blockers[0] ?? 'BACKGROUND_PILOT_DYNAMIC_CAP_RISK_BLOCKED');
  }
  return deriveRulePackPilotExecutionPolicy(policy, pilot);
}

function planForBrokerOrder(
  brokerOrderId: string,
  ordersByKey: Map<string, TradingOrder>,
  plansById: Map<string, TradingPlan>,
) {
  const order = ordersByKey.get(brokerOrderId) ?? null;
  return order ? plansById.get(order.planId) ?? null : null;
}

export async function readRulePackPilotCapitalState(
  repository: TradingRepository,
  userId: string,
  now = new Date(),
): Promise<RulePackPilotCapitalState> {
  const [payloads, orders, plans] = await Promise.all([
    readTradeAutomationJournalPayloads(repository, userId),
    repository.listOrders(userId),
    repository.listPlans(userId),
  ]);
  const journal = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, now);
  const ordersByKey = new Map<string, TradingOrder>();
  for (const order of orders) {
    ordersByKey.set(order.id, order);
    if (order.exchangeOrderId) ordersByKey.set(order.exchangeOrderId, order);
  }
  const plansById = new Map(plans.map((plan) => [plan.id, plan]));
  const trades: RulePackPilotRealizedTrade[] = [];
  const blockers: string[] = [];
  if (!rulePackPilotLedgerHistoryComplete(orders.length, plans.length)) {
    blockers.push('PILOT_CAPITAL_LEDGER_HISTORY_COMPLETENESS_REQUIRED');
  }
  // An unjoined fill is not "no profit"; its missing plan may hide a loss.
  // Protect shared 500k HWM accounting from incomplete ledger projections.
  for (const order of orders) {
    if (order.filledQuantity > 0 && !plansById.has(order.planId)) {
      blockers.push('PILOT_CAPITAL_ORDER_PLAN_LINEAGE_MISSING');
    }
  }

  for (const trade of journal.trades) {
    if (trade.source !== 'APP_AUTO' || trade.status !== 'CLOSED') continue;
    // Any other automatic Live strategy shares real broker capital and may
    // have losses. Silently excluding its closed trade would overstate HWM.
    if (!trade.closedAt || !trade.strategy
      || !isEvidenceBackedAutoStrategyId(trade.strategy)) {
      blockers.push('PILOT_CAPITAL_UNSUPPORTED_AUTO_LIVE_STRATEGY');
      continue;
    }
    const entryPlan = planForBrokerOrder(trade.initialEntry.orderId, ordersByKey, plansById);
    if (!entryPlan || entryPlan.accountMode !== 'live'
      || entryPlan.executionMode !== 'automatic'
      || !isEvidenceBackedAutoStrategyId(entryPlan.strategyId)) {
      blockers.push('PILOT_CAPITAL_ENTRY_LINEAGE_UNAVAILABLE');
      continue;
    }

    const entryNotionalNative = trade.entryPrice * trade.initialEntry.quantity;
    if (!(entryNotionalNative > 0) || !(entryPlan.estimatedKrw > 0)) {
      blockers.push('PILOT_CAPITAL_ENTRY_FX_BASIS_UNAVAILABLE');
      continue;
    }
    const settlement = verifiedRulePackKrwSettlement(trade);
    if (!settlement.ok) {
      blockers.push(settlement.code);
      continue;
    }
    trades.push(Object.freeze({
      id: trade.id, symbol: trade.symbol, signalId: entryPlan.signalId,
      closedAt: trade.closedAt, netPnlKrw: settlement.netPnlKrw,
    }));
  }

  const derived = deriveRulePackPilotCapitalFromTrades(trades, now);
  const uniqueBlockers = [...new Set([...blockers, ...derived.blockers])].sort();
  return Object.freeze({
    ...derived,
    settlementReady: uniqueBlockers.length === 0,
    blockers: Object.freeze(uniqueBlockers),
  });
}
