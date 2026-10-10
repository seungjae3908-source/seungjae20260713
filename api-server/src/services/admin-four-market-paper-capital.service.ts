import type { TradingAssetClass, TradingOrder, TradingPlan } from './trade-automation.types';
import type { PaperJournalSyncRecord, StoredPaperJournalRecord } from './paper-journal.types';

export const ADMIN_FOUR_PAPER_MARKETS = [
  'domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures',
] as const satisfies readonly TradingAssetClass[];
export type AdminPaperMarket = typeof ADMIN_FOUR_PAPER_MARKETS[number];
export const FOUR_MARKET_PAPER_MARKETS = ADMIN_FOUR_PAPER_MARKETS;
export type FourMarketPaperMarket = AdminPaperMarket;
export const ADMIN_MARKET_INITIAL_KRW = 1_000_000;
export const ADMIN_TOTAL_INITIAL_KRW = 4 * ADMIN_MARKET_INITIAL_KRW;
export const ADMIN_MARKET_WALLET_VERSION = 'admin-four-market-paper-v2' as const;
export const ADMIN_WALLET_CONFIRMATION = 'START_ADMIN_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY' as const;
export const MEMBER_MARKET_INITIAL_KRW = 1_000_000;
export const MEMBER_TOTAL_INITIAL_KRW = 4 * MEMBER_MARKET_INITIAL_KRW;
export const MEMBER_MARKET_WALLET_VERSION = 'member-four-market-paper-v2' as const;
export const MEMBER_WALLET_CONFIRMATION = 'START_MEMBER_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY' as const;
const INVALID_WALLET = 'ADMIN_PAPER_WALLET_INVALID';

export type FourMarketPaperWalletRole = 'admin' | 'member';
type FourMarketWalletConfig = Readonly<{
  role: FourMarketPaperWalletRole;
  idPrefix: string;
  schemaVersion: string;
  marketInitialKrw: number;
  blockerPrefix: 'ADMIN' | 'MEMBER';
}>;
const ADMIN_WALLET_CONFIG: FourMarketWalletConfig = Object.freeze({
  role: 'admin', idPrefix: 'automatic-paper-admin-v2:',
  schemaVersion: ADMIN_MARKET_WALLET_VERSION,
  marketInitialKrw: ADMIN_MARKET_INITIAL_KRW, blockerPrefix: 'ADMIN',
});
const MEMBER_WALLET_CONFIG: FourMarketWalletConfig = Object.freeze({
  role: 'member', idPrefix: 'automatic-paper-member-v2:',
  schemaVersion: MEMBER_MARKET_WALLET_VERSION,
  marketInitialKrw: MEMBER_MARKET_INITIAL_KRW, blockerPrefix: 'MEMBER',
});
function walletConfig(role: FourMarketPaperWalletRole) {
  return role === 'admin' ? ADMIN_WALLET_CONFIG : MEMBER_WALLET_CONFIG;
}

export function adminPaperMarketFromPlan(
  plan: Pick<TradingPlan, 'exchange' | 'market'>,
): AdminPaperMarket {
  if (plan.exchange === 'upbit') return 'crypto_spot';
  if (plan.exchange === 'bitget') return 'crypto_futures';
  return String(plan.market).toUpperCase() === 'US' ? 'us_stock' : 'domestic_stock';
}
export function adminPaperWalletId(market: AdminPaperMarket): string {
  return `automatic-paper-admin-v2:${market}`;
}
export function memberPaperWalletId(market: AdminPaperMarket): string {
  return `automatic-paper-member-v2:${market}`;
}
export function isAdminPaperWalletId(id: string): boolean {
  return ADMIN_FOUR_PAPER_MARKETS.some((market) => id === adminPaperWalletId(market));
}
export function isMemberPaperWalletId(id: string): boolean {
  return ADMIN_FOUR_PAPER_MARKETS.some((market) => id === memberPaperWalletId(market));
}
export function isProtectedFourMarketPaperWalletId(id: string): boolean {
  return isAdminPaperWalletId(id) || isMemberPaperWalletId(id);
}
function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return finiteNonnegative(value) && value > 0;
}
function validServerEpoch(row: StoredPaperJournalRecord, nowMs: number): number | null {
  const opened = Date.parse(row.createdAt);
  const updated = Date.parse(row.serverUpdatedAt);
  return Number.isFinite(opened) && Number.isFinite(updated) && Number.isFinite(nowMs)
    && opened >= 0 && opened <= nowMs + 5_000
    && updated <= nowMs + 5_000 && updated + 5_000 >= opened ? opened : null;
}
function buildFourMarketPaperBootstrap(
  role: FourMarketPaperWalletRole,
  now = new Date(),
): PaperJournalSyncRecord[] {
  const config = walletConfig(role);
  const at = now.toISOString();
  return ADMIN_FOUR_PAPER_MARKETS.map((market) => ({
    kind: 'account' as const, id: `${config.idPrefix}${market}`,
    version: 1, updatedAt: at, deletedAt: null,
    payload: {
      id: `${config.idPrefix}${market}`,
      schemaVersion: config.schemaVersion, role, market,
      initialBalance: config.marketInitialKrw, equity: config.marketInitialKrw,
      cashBalance: config.marketInitialKrw,
      availableMargin: config.marketInitialKrw, usedMargin: 0,
      realizedPnl: 0, unrealizedPnl: 0,
      reserveKrw: 0, compoundedProfitKrw: 0,
      compoundShare: 0.5, reserveShare: 0.5,
      reserveWithdrawalAutomatic: false,
      createdAt: at, updatedAt: at,
    },
  }));
}
export function buildAdminFourMarketPaperBootstrap(now = new Date()) {
  return buildFourMarketPaperBootstrap('admin', now);
}
export function buildMemberFourMarketPaperBootstrap(now = new Date()) {
  return buildFourMarketPaperBootstrap('member', now);
}
export type AdminWalletMarketState = Readonly<{
  market: AdminPaperMarket;
  walletId: string;
  ready: boolean;
  blockers: readonly string[];
  initialCapitalKrw: number;
  equityKrw: number | null;
  availableMarginKrw: number | null;
  cashKrw: number | null;
  reserveKrw: number | null;
  openedAtMs: number | null;
}>;
function inspectFourMarketPaperWallets(
  records: readonly StoredPaperJournalRecord[],
  role: FourMarketPaperWalletRole,
  nowMs = Date.now(),
) {
  const config = walletConfig(role);
  const code = (suffix: string) => `${config.blockerPrefix}_PAPER_${suffix}`;
  const blockers: string[] = [];
  const add = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };
  const legacy = records.filter((row) => row.kind === 'account'
    && ['automatic-paper-account-v1', 'automatic-paper-account-v2-1m'].includes(row.id));
  // A regular member's V1 wallet is preserved as immutable legacy history
  // while the V2 market wallets start a new server-owned epoch. Admin V2
  // retains its stricter historical blocker for backwards compatibility.
  if (legacy.length && role === 'admin') add(code('LEGACY_500K_WALLET_EXISTS'));
  const accounts = records.filter((row) => row.kind === 'account');
  const marketWallets = {} as Record<AdminPaperMarket, AdminWalletMarketState>;
  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    const id = `${config.idPrefix}${market}`;
    const matches = accounts.filter((row) => row.id === id);
    const reasons: string[] = [];
    if (matches.length !== 1) reasons.push(matches.length === 0
      ? code('MARKET_WALLET_MISSING') : code('DUPLICATE_MARKET_WALLET'));
    const row = matches[0] ?? null;
    const p = row?.payload ?? null;
    const epoch = row ? validServerEpoch(row, nowMs) : null;
    if (row && (
      row.deletedAt !== null || row.version < 1
      || p?.id !== id || p?.market !== market
      || p?.schemaVersion !== config.schemaVersion
      || (p?.role != null && p.role !== role)
      || p?.initialBalance !== config.marketInitialKrw
      || p?.compoundShare !== 0.5 || p?.reserveShare !== 0.5
      || p?.reserveWithdrawalAutomatic !== false
      || !positive(p?.equity) || !finiteNonnegative(p?.cashBalance)
      || !finiteNonnegative(p?.availableMargin) || !finiteNonnegative(p?.usedMargin)
      || !finiteNonnegative(p?.reserveKrw)
      || !finiteNonnegative(p?.compoundedProfitKrw)
      || epoch === null
    )) reasons.push(role === 'admin' ? INVALID_WALLET : code('WALLET_INVALID'));
    if (reasons.length) reasons.forEach(add);
    marketWallets[market] = Object.freeze({
      market, walletId: id, ready: reasons.length === 0,
      blockers: Object.freeze(reasons),
      initialCapitalKrw: config.marketInitialKrw,
      equityKrw: reasons.length ? null : Number(p?.equity),
      availableMarginKrw: reasons.length ? null : Number(p?.availableMargin),
      cashKrw: reasons.length ? null : Number(p?.cashBalance),
      reserveKrw: reasons.length ? null : Number(p?.reserveKrw),
      openedAtMs: reasons.length ? null : epoch,
    });
  }
  // An incomplete / substituted four-wallet campaign must never be treated
  // as a 4m portfolio. All four rows must originate from one insert batch.
  const epochs = ADMIN_FOUR_PAPER_MARKETS
    .map((m) => marketWallets[m].openedAtMs).filter((n): n is number => n !== null);
  if (epochs.length === 4 && Math.max(...epochs) - Math.min(...epochs) > 5_000) {
    add(code('EPOCH_BATCH_MISMATCH'));
  }
  const allReady = blockers.length === 0;
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    role,
    ready: allReady,
    blockers: Object.freeze(blockers),
    marketWallets: Object.freeze(marketWallets),
    initialCapitalKrw: 4 * config.marketInitialKrw,
    marketInitialCapitalKrw: config.marketInitialKrw,
    walletOpenedAtMs: allReady ? Math.min(...epochs) : null,
    realOrderAuthorityGranted: false as const,
    automaticWithdrawalEnabled: false as const,
  });
}
export function inspectAdminFourMarketPaperWallets(
  records: readonly StoredPaperJournalRecord[], nowMs = Date.now(),
) {
  return inspectFourMarketPaperWallets(records, 'admin', nowMs);
}
export function inspectMemberFourMarketPaperWallets(
  records: readonly StoredPaperJournalRecord[], nowMs = Date.now(),
) {
  return inspectFourMarketPaperWallets(records, 'member', nowMs);
}
/**
 * Settlement and reserve calculations must only see canonical orders from the
 * exact DB-owned market wallet epoch. This scope is NEVER a risk-history
 * deletion: the risk evidence function still sees complete, immutable orders.
 */
export function adminMarketCurrentEpochSettlementScope(input: {
  market: AdminPaperMarket;
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
  openedAtMs: number;
  nowMs: number;
}) {
  if (!Number.isFinite(input.openedAtMs) || !Number.isFinite(input.nowMs)
    || input.openedAtMs < 0 || input.openedAtMs > input.nowMs + 5_000) {
    return { plans: [] as TradingPlan[], orders: [] as TradingOrder[], valid: false as const };
  }
  const plans = input.plans.filter((plan) => {
    const created = Date.parse(plan.createdAt);
    return plan.accountMode === 'paper' && plan.executionMode === 'automatic'
      && adminPaperMarketFromPlan(plan) === input.market
      && Number.isFinite(created) && created >= input.openedAtMs
      && created <= input.nowMs + 5_000;
  });
  const byPlan = new Map(plans.map((plan) => [plan.id, plan]));
  const orders = input.orders.filter((order) => {
    const plan = byPlan.get(order.planId);
    const created = Date.parse(order.createdAt);
    return plan && order.userId === plan.userId
      && Number.isFinite(created) && created >= input.openedAtMs
      && created <= input.nowMs + 5_000;
  });
  return { plans, orders, valid: true as const };
}

/** Per-market Paper exposure is never collateral for another market. */
function fourMarketPaperRiskBudget(input: {
  market: AdminPaperMarket;
  records: readonly StoredPaperJournalRecord[];
  openPlans: readonly TradingPlan[];
  role: FourMarketPaperWalletRole;
  nowMs?: number;
  verifiedCapital?: ReturnType<typeof projectFourMarketPaperCapital>;
}) {
  const config = walletConfig(input.role);
  const summary = inspectFourMarketPaperWallets(input.records, input.role, input.nowMs);
  const code = (suffix: string) => `${config.blockerPrefix}_PAPER_${suffix}`;
  const wallet = summary.marketWallets[input.market];
  if (!summary.ready || !wallet.ready || wallet.openedAtMs == null) {
    return { ready: false as const, blockers: summary.blockers,
      availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  }
  const open = input.openPlans.filter((plan) => plan.accountMode === 'paper'
    && plan.executionMode === 'automatic'
    && adminPaperMarketFromPlan(plan) === input.market);
  if (open.some((plan) => {
    const created = Date.parse(plan.createdAt);
    return !Number.isFinite(created) || created < wallet.openedAtMs!;
  })) return { ready: false as const, blockers: [code('LEGACY_PLAN_UNISOLATED')],
    availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  const exposureKrw = open.reduce((sum, plan) => sum + Number(plan.estimatedKrw), 0);
  if (!finiteNonnegative(exposureKrw)) return { ready: false as const,
    blockers: [code('EXPOSURE_INVALID')],
    availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  // Wallet seed is not collateral proof: the full canonical execution ledger
  // must be reviewed, even when no filled trades are known yet.
  const capital = input.verifiedCapital;
  if (!capital || !capital.settlementReady || !capital.newEntriesAllowed
    || capital.market !== input.market) {
    return { ready: false as const,
      blockers: !capital ? [code('CANONICAL_SETTLEMENT_REQUIRED')]
        : capital.blockers.length ? capital.blockers
          : [code('VERIFIED_CAPITAL_UNDERFUNDED')],
      availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  }
  const equity = capital.operatingCapitalKrw;
  // Only settlement-verified growth may increase a frozen 1m seed wallet.
  // Any independently recorded loss or margin restriction remains binding.
  const verifiedGrowth = Math.max(0, equity - config.marketInitialKrw);
  const collateral = Math.min(equity,
    wallet.equityKrw! + verifiedGrowth,
    wallet.cashKrw! + verifiedGrowth,
    wallet.availableMarginKrw! + verifiedGrowth);
  return {
    ready: true as const, blockers: [] as string[],
    accountValueKrw: equity, exposureKrw,
    reserveKrw: capital.reserveKrw,
    availableToTradeKrw: Math.max(0, collateral - exposureKrw),
  };
}
export function adminMarketPaperRiskBudget(
  input: Omit<Parameters<typeof fourMarketPaperRiskBudget>[0], 'role'>,
) {
  return fourMarketPaperRiskBudget({ ...input, role: 'admin' });
}
export function memberMarketPaperRiskBudget(
  input: Omit<Parameters<typeof fourMarketPaperRiskBudget>[0], 'role'>,
) {
  return fourMarketPaperRiskBudget({ ...input, role: 'member' });
}
/**
 * Keep Paper cash on the verified per-market ledger: the original 1m
 * member-wide authorization ceiling is not a market cash balance.
 * A signed, settled 50% compound gain can increase cash without silently
 * raising per-order/risk or Live/Provider permissions.
 */
export function adminMarketPaperAvailableBalance(
  storedPolicyCapitalKrw: number,
  openMarketExposureKrw: number,
  certifiedMarketBudget?: Readonly<{
    ready: boolean;
    availableToTradeKrw: number;
  }> | null,
): number {
  if (certifiedMarketBudget) {
    return certifiedMarketBudget.ready === true
      && finiteNonnegative(certifiedMarketBudget.availableToTradeKrw)
      ? certifiedMarketBudget.availableToTradeKrw : 0;
  }
  if (!finiteNonnegative(storedPolicyCapitalKrw)
    || !finiteNonnegative(openMarketExposureKrw)) return 0;
  return Math.max(0, storedPolicyCapitalKrw - openMarketExposureKrw);
}

export type VerifiedMarketSettlement = Readonly<{
  id: string;
  market: AdminPaperMarket;
  closedAt: string;
  netPnlKrw: number;
  fullCostsVerified: boolean;
  closeTimeFxVerified: boolean;
}>;
/**
 * Read-only, deterministic 50/50 capital accounting. Deposits, bank
 * withdrawals and browser-supplied PnL are never performed or trusted here.
 * Only verified close-time KRW net settlement can earn additional capital.
 */
function projectFourMarketPaperCapital(
  market: AdminPaperMarket,
  closings: readonly VerifiedMarketSettlement[],
  role: FourMarketPaperWalletRole,
  nowMs = Date.now(),
) {
  const config = walletConfig(role);
  const errors: string[] = [];
  const seen = new Set<string>();
  let operatingCapitalKrw = config.marketInitialKrw;
  let reserveKrw = 0;
  let highWaterMarkKrw = config.marketInitialKrw;
  let totalNetPnlKrw = 0;
  let dailyNetPnlKrw = 0;
  let dailyLosingTrades = 0;
  const kstDay = (at: number) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
  const today = Number.isFinite(nowMs) ? kstDay(nowMs) : '';
  const sorted = [...closings].filter((row) => row.market === market)
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt)
      || a.id.localeCompare(b.id));
  // A win and loss with the same close-time millisecond have no reliable
  // ordering. Settle the whole timestamp batch at net PnL, never grant 50%
  // reserve from an arbitrary event ID order before an offsetting loss.
  let batchTime: number | null = null;
  let batchNet = 0;
  const settleBatch = () => {
    if (batchTime == null) return;
    if (batchNet <= 0) {
      operatingCapitalKrw = Math.max(0, operatingCapitalKrw + batchNet);
    } else {
      const newProfit = Math.max(0,
        operatingCapitalKrw + reserveKrw + batchNet - highWaterMarkKrw);
      const recovered = batchNet - newProfit;
      operatingCapitalKrw += recovered + newProfit * 0.5;
      reserveKrw += newProfit * 0.5;
      highWaterMarkKrw += newProfit;
    }
    batchTime = null;
    batchNet = 0;
  };
  for (const row of sorted) {
    const at = Date.parse(row.closedAt);
    if (!row.id || seen.has(row.id) || !Number.isFinite(at)
      || at > nowMs + 5_000 || !Number.isFinite(row.netPnlKrw)
      || row.fullCostsVerified !== true || row.closeTimeFxVerified !== true) {
      errors.push(`${config.blockerPrefix}_PAPER_SETTLEMENT_EVIDENCE_INVALID`);
      continue;
    }
    if (batchTime !== null && at !== batchTime) settleBatch();
    if (batchTime == null) batchTime = at;
    seen.add(row.id);
    totalNetPnlKrw += row.netPnlKrw;
    if (kstDay(at) === today) {
      dailyNetPnlKrw += row.netPnlKrw;
      if (row.netPnlKrw < 0) dailyLosingTrades += 1;
    }
    batchNet += row.netPnlKrw;
  }
  settleBatch();
  if (![operatingCapitalKrw,reserveKrw,highWaterMarkKrw,totalNetPnlKrw].every(Number.isFinite)) {
    errors.push(`${config.blockerPrefix}_PAPER_CAPITAL_OVERFLOW`);
  }
  const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.freeze({
    market, role, initialCapitalKrw: config.marketInitialKrw,
    operatingCapitalKrw: rounded(operatingCapitalKrw),
    reserveKrw: rounded(reserveKrw),
    highWaterMarkKrw: rounded(highWaterMarkKrw),
    settledNetPnlKrw: rounded(totalNetPnlKrw),
    dailyNetPnlKrw: rounded(dailyNetPnlKrw),
    dailyLosingTrades,
    settledTrades: seen.size, blockers: Object.freeze([...new Set(errors)]),
    settlementReady: errors.length === 0,
    // Ordinary losses draw down actual available Paper equity. Never
    // replenish the 1m seed or stop after a single small loss: five losing
    // trades or the independent daily realized-loss limit are the blockers.
    newEntriesAllowed: errors.length === 0
      && operatingCapitalKrw > 0
      && dailyLosingTrades < 5
      && dailyNetPnlKrw > -(config.marketInitialKrw * 0.05),
    reserveWithdrawalAutomatic: false as const,
  });
}
export function projectAdminMarketCapital(
  market: AdminPaperMarket,
  closings: readonly VerifiedMarketSettlement[],
  nowMs = Date.now(),
) {
  return projectFourMarketPaperCapital(market, closings, 'admin', nowMs);
}
export function projectMemberMarketCapital(
  market: AdminPaperMarket,
  closings: readonly VerifiedMarketSettlement[],
  nowMs = Date.now(),
) {
  return projectFourMarketPaperCapital(market, closings, 'member', nowMs);
}
