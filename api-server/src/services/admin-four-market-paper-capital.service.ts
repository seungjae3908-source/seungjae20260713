import type { TradingAssetClass, TradingPlan } from './trade-automation.types';
import type { PaperJournalSyncRecord, StoredPaperJournalRecord } from './paper-journal.types';

export const ADMIN_FOUR_PAPER_MARKETS = [
  'domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures',
] as const satisfies readonly TradingAssetClass[];
export type AdminPaperMarket = typeof ADMIN_FOUR_PAPER_MARKETS[number];
export const ADMIN_MARKET_INITIAL_KRW = 1_000_000;
export const ADMIN_TOTAL_INITIAL_KRW = 4 * ADMIN_MARKET_INITIAL_KRW;
export const ADMIN_MARKET_WALLET_VERSION = 'admin-four-market-paper-v2' as const;
export const ADMIN_WALLET_CONFIRMATION = 'START_ADMIN_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY' as const;
const INVALID_WALLET = 'ADMIN_PAPER_WALLET_INVALID';

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
export function isAdminPaperWalletId(id: string): boolean {
  return ADMIN_FOUR_PAPER_MARKETS.some((market) => id === adminPaperWalletId(market));
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
export function buildAdminFourMarketPaperBootstrap(now = new Date()): PaperJournalSyncRecord[] {
  const at = now.toISOString();
  return ADMIN_FOUR_PAPER_MARKETS.map((market) => ({
    kind: 'account' as const, id: adminPaperWalletId(market),
    version: 1, updatedAt: at, deletedAt: null,
    payload: {
      id: adminPaperWalletId(market),
      schemaVersion: ADMIN_MARKET_WALLET_VERSION, market,
      initialBalance: ADMIN_MARKET_INITIAL_KRW, equity: ADMIN_MARKET_INITIAL_KRW,
      cashBalance: ADMIN_MARKET_INITIAL_KRW,
      availableMargin: ADMIN_MARKET_INITIAL_KRW, usedMargin: 0,
      realizedPnl: 0, unrealizedPnl: 0,
      reserveKrw: 0, compoundedProfitKrw: 0,
      compoundShare: 0.5, reserveShare: 0.5,
      reserveWithdrawalAutomatic: false,
      createdAt: at, updatedAt: at,
    },
  }));
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
export function inspectAdminFourMarketPaperWallets(
  records: readonly StoredPaperJournalRecord[],
  nowMs = Date.now(),
) {
  const blockers: string[] = [];
  const add = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };
  const legacy = records.filter((row) => row.kind === 'account'
    && row.id === 'automatic-paper-account-v1');
  if (legacy.length) add('ADMIN_PAPER_LEGACY_500K_WALLET_EXISTS');
  const accounts = records.filter((row) => row.kind === 'account');
  const marketWallets = {} as Record<AdminPaperMarket, AdminWalletMarketState>;
  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    const id = adminPaperWalletId(market);
    const matches = accounts.filter((row) => row.id === id);
    const reasons: string[] = [];
    if (matches.length !== 1) reasons.push(matches.length === 0
      ? 'ADMIN_PAPER_MARKET_WALLET_MISSING' : 'ADMIN_PAPER_DUPLICATE_MARKET_WALLET');
    const row = matches[0] ?? null;
    const p = row?.payload ?? null;
    const epoch = row ? validServerEpoch(row, nowMs) : null;
    if (row && (
      row.deletedAt !== null || row.version < 1
      || p?.id !== id || p?.market !== market
      || p?.schemaVersion !== ADMIN_MARKET_WALLET_VERSION
      || p?.initialBalance !== ADMIN_MARKET_INITIAL_KRW
      || p?.compoundShare !== 0.5 || p?.reserveShare !== 0.5
      || p?.reserveWithdrawalAutomatic !== false
      || !positive(p?.equity) || !finiteNonnegative(p?.cashBalance)
      || !finiteNonnegative(p?.availableMargin) || !finiteNonnegative(p?.usedMargin)
      || !finiteNonnegative(p?.reserveKrw)
      || !finiteNonnegative(p?.compoundedProfitKrw)
      || epoch === null
    )) reasons.push(INVALID_WALLET);
    if (reasons.length) reasons.forEach(add);
    marketWallets[market] = Object.freeze({
      market, walletId: id, ready: reasons.length === 0,
      blockers: Object.freeze(reasons),
      initialCapitalKrw: ADMIN_MARKET_INITIAL_KRW,
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
    add('ADMIN_PAPER_EPOCH_BATCH_MISMATCH');
  }
  const allReady = blockers.length === 0;
  return Object.freeze({
    schemaVersion: ADMIN_MARKET_WALLET_VERSION,
    ready: allReady,
    blockers: Object.freeze(blockers),
    marketWallets: Object.freeze(marketWallets),
    initialCapitalKrw: ADMIN_TOTAL_INITIAL_KRW,
    marketInitialCapitalKrw: ADMIN_MARKET_INITIAL_KRW,
    walletOpenedAtMs: allReady ? Math.min(...epochs) : null,
    realOrderAuthorityGranted: false as const,
    automaticWithdrawalEnabled: false as const,
  });
}
/** Per-market Paper exposure is never collateral for another market. */
export function adminMarketPaperRiskBudget(input: {
  market: AdminPaperMarket;
  records: readonly StoredPaperJournalRecord[];
  openPlans: readonly TradingPlan[];
  nowMs?: number;
  verifiedCapital?: ReturnType<typeof projectAdminMarketCapital>;
}) {
  const summary = inspectAdminFourMarketPaperWallets(input.records, input.nowMs);
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
  })) return { ready: false as const, blockers: ['ADMIN_PAPER_LEGACY_PLAN_UNISOLATED'],
    availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  const exposureKrw = open.reduce((sum, plan) => sum + Number(plan.estimatedKrw), 0);
  if (!finiteNonnegative(exposureKrw)) return { ready: false as const,
    blockers: ['ADMIN_PAPER_EXPOSURE_INVALID'],
    availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  const capital = input.verifiedCapital;
  if (capital && (!capital.settlementReady || !capital.newEntriesAllowed
    || capital.market !== input.market)) {
    return { ready: false as const,
      blockers: capital.blockers.length ? capital.blockers
        : ['ADMIN_PAPER_VERIFIED_CAPITAL_UNDERFUNDED'],
      availableToTradeKrw: 0, exposureKrw: 0, accountValueKrw: 0 };
  }
  const equity = capital?.operatingCapitalKrw ?? wallet.equityKrw!;
  // Only settlement-verified growth may increase a frozen 1m seed wallet.
  // Any independently recorded loss or margin restriction remains binding.
  const verifiedGrowth = capital
    ? Math.max(0, capital.operatingCapitalKrw - ADMIN_MARKET_INITIAL_KRW) : 0;
  const collateral = Math.min(equity,
    wallet.equityKrw! + verifiedGrowth,
    wallet.cashKrw! + verifiedGrowth,
    wallet.availableMarginKrw! + verifiedGrowth);
  return {
    ready: true as const, blockers: [] as string[],
    accountValueKrw: equity, exposureKrw,
    reserveKrw: capital?.reserveKrw ?? wallet.reserveKrw ?? 0,
    availableToTradeKrw: Math.max(0, collateral - exposureKrw),
  };
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
export function projectAdminMarketCapital(
  market: AdminPaperMarket,
  closings: readonly VerifiedMarketSettlement[],
  nowMs = Date.now(),
) {
  const errors: string[] = [];
  const seen = new Set<string>();
  let operatingCapitalKrw = ADMIN_MARKET_INITIAL_KRW;
  let reserveKrw = 0;
  let highWaterMarkKrw = ADMIN_MARKET_INITIAL_KRW;
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
      errors.push('ADMIN_PAPER_SETTLEMENT_EVIDENCE_INVALID');
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
    errors.push('ADMIN_PAPER_CAPITAL_OVERFLOW');
  }
  const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.freeze({
    market, initialCapitalKrw: ADMIN_MARKET_INITIAL_KRW,
    operatingCapitalKrw: rounded(operatingCapitalKrw),
    reserveKrw: rounded(reserveKrw),
    highWaterMarkKrw: rounded(highWaterMarkKrw),
    settledNetPnlKrw: rounded(totalNetPnlKrw),
    dailyNetPnlKrw: rounded(dailyNetPnlKrw),
    dailyLosingTrades,
    settledTrades: seen.size, blockers: Object.freeze([...new Set(errors)]),
    settlementReady: errors.length === 0,
    newEntriesAllowed: errors.length === 0
      && operatingCapitalKrw >= ADMIN_MARKET_INITIAL_KRW
      && dailyLosingTrades < 5
      && dailyNetPnlKrw > -50_000,
    reserveWithdrawalAutomatic: false as const,
  });
}
