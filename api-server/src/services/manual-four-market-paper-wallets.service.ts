import {
  ADMIN_FOUR_PAPER_MARKETS, type AdminPaperMarket,
} from './admin-four-market-paper-capital.service';
import type {
  PaperJournalSyncRecord, StoredPaperJournalRecord,
} from './paper-journal.types';

export const MANUAL_FOUR_MARKET_INITIAL_KRW = 1_000_000 as const;
export const MANUAL_FOUR_MARKET_TOTAL_KRW = 4_000_000 as const;
export const MANUAL_FOUR_MARKET_VERSION = 'manual-four-market-paper-v1' as const;
export const MANUAL_FOUR_MARKET_CONFIRMATION =
  'START_MANUAL_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY' as const;

export type ManualWalletRole = 'admin' | 'member';
export type ManualMarketWalletStatus = Readonly<{
  market: AdminPaperMarket;
  id: string;
  seedExists: boolean;
  validated: boolean;
  initialCapitalKrw: number;
  blockers: readonly string[];
}>;
const roles: readonly ManualWalletRole[] = ['admin','member'];

export function manualPaperWalletId(role: ManualWalletRole, market: AdminPaperMarket): string {
  if (!roles.includes(role) || !ADMIN_FOUR_PAPER_MARKETS.includes(market)) {
    throw new Error('MANUAL_FOUR_MARKET_IDENTITY_INVALID');
  }
  return `manual-paper-${role}-v1:${market}`;
}
export function isManualPaperWalletId(id: unknown): id is string {
  return typeof id === 'string' && roles.some(role =>
    ADMIN_FOUR_PAPER_MARKETS.some(market => id === manualPaperWalletId(role, market)));
}

/** Immutable manual-only virtual seed; never an actual broker account or
 *  proof of settled/available trading cash. 4 markets are a separate mode
 *  and never share automatic Paper capital.
 */
export function buildManualFourMarketWalletSeeds(
  role: ManualWalletRole, now = new Date(),
): PaperJournalSyncRecord[] {
  if (!roles.includes(role) || !Number.isFinite(now.getTime())) {
    throw new Error('MANUAL_FOUR_MARKET_SEED_INPUT_INVALID');
  }
  const at = now.toISOString();
  return ADMIN_FOUR_PAPER_MARKETS.map(market => {
    const id = manualPaperWalletId(role,market);
    return {
      kind: 'account' as const, id, version: 1, updatedAt: at, deletedAt: null,
      payload: {
        id, schemaVersion: MANUAL_FOUR_MARKET_VERSION, role, mode: 'manual',
        market, initialBalance: MANUAL_FOUR_MARKET_INITIAL_KRW,
        equity: MANUAL_FOUR_MARKET_INITIAL_KRW,
        cashBalance: MANUAL_FOUR_MARKET_INITIAL_KRW,
        availableMargin: MANUAL_FOUR_MARKET_INITIAL_KRW,
        usedMargin: 0, realizedPnl: 0, unrealizedPnl: 0,
        reserveKrw: 0, compoundedProfitKrw: 0,
        compoundShare: 0.5, reserveShare: 0.5,
        reserveWithdrawalAutomatic: false,
        createdAt: at, updatedAt: at,
      },
    };
  });
}

const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;
function exactSeed(row: StoredPaperJournalRecord, role: ManualWalletRole,
  market: AdminPaperMarket, nowMs: number): boolean {
  const id = manualPaperWalletId(role,market);
  const p = row.payload;
  const created=Date.parse(row.createdAt), updated=Date.parse(row.serverUpdatedAt);
  return row.kind==='account' && row.id===id && row.version===1
    && row.deletedAt===null && row.payload?.id===id
    && p.schemaVersion===MANUAL_FOUR_MARKET_VERSION && p.role===role
    && p.mode==='manual' && p.market===market
    && p.initialBalance===MANUAL_FOUR_MARKET_INITIAL_KRW
    && p.equity===MANUAL_FOUR_MARKET_INITIAL_KRW
    && p.cashBalance===MANUAL_FOUR_MARKET_INITIAL_KRW
    && p.availableMargin===MANUAL_FOUR_MARKET_INITIAL_KRW
    && p.usedMargin===0 && p.realizedPnl===0 && p.unrealizedPnl===0
    && p.reserveKrw===0 && p.compoundedProfitKrw===0
    && p.compoundShare===0.5 && p.reserveShare===0.5
    && p.reserveWithdrawalAutomatic===false
    && Number.isFinite(created) && Number.isFinite(updated)
    && created>=0 && created<=nowMs+5_000
    && updated>=created-5_000 && updated<=nowMs+5_000
    && typeof p.createdAt==='string'
    && Number.isFinite(Date.parse(p.createdAt))
    && Math.abs(Date.parse(p.createdAt)-created)<=5_000;
}

/** Owner-scoped records must come from the authenticated DB reader. This
 * does not attest OOS/Paper fills, ability to buy, or server worker activation.
 */
export function inspectManualFourMarketWallets(
  role: ManualWalletRole, records: readonly StoredPaperJournalRecord[],
  nowMs=Date.now(),
) {
  if (!roles.includes(role) || !Number.isFinite(nowMs)) {
    throw new Error('MANUAL_FOUR_MARKET_READBACK_INPUT_INVALID');
  }
  const blockers: string[]=[];
  const add=(reason:string)=>{if(!blockers.includes(reason))blockers.push(reason);};
  const foreign=records.some(r=>r.kind==='account' && isManualPaperWalletId(r.id)
    && !r.id.startsWith(`manual-paper-${role}-v1:`));
  if (foreign) add('MANUAL_PAPER_ROLE_WALLET_CONFLICT');
  if (records.some(r=>r.kind==='account' && r.id.startsWith('manual-paper-')
    && !isManualPaperWalletId(r.id))) add('MANUAL_PAPER_RESERVED_UNKNOWN_WALLET');
  const lanes={} as Record<AdminPaperMarket,ManualMarketWalletStatus>;
  const timestamps:number[]=[];
  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    const id=manualPaperWalletId(role,market);
    const rows=records.filter(r=>r.kind==='account' && r.id===id);
    const local:string[]=[];
    if (rows.length!==1) local.push(rows.length===0
      ? 'MANUAL_PAPER_WALLET_MISSING' : 'MANUAL_PAPER_WALLET_DUPLICATED');
    else if (!exactSeed(rows[0],role,market,nowMs)) local.push('MANUAL_PAPER_WALLET_EVIDENCE_INVALID');
    else timestamps.push(Date.parse(rows[0].createdAt));
    local.forEach(add);
    lanes[market]=Object.freeze({
      market,id,seedExists:rows.length===1,validated:local.length===0,
      initialCapitalKrw:MANUAL_FOUR_MARKET_INITIAL_KRW,blockers:Object.freeze(local),
    });
  }
  if (timestamps.length===4 && Math.max(...timestamps)-Math.min(...timestamps)>5_000) {
    add('MANUAL_PAPER_SEEDS_NOT_SAME_EPOCH');
  }
  const ready=blockers.length===0;
  return Object.freeze({
    mode:'MANUAL_PAPER_FOUR_MARKET_SEED_ONLY' as const,
    role,ready,
    seedReadOnly:true as const,executionAuthority:'NONE' as const,
    financialMutationAllowed:false as const,
    privateProviderRequests:0 as const,realOrders:0 as const,
    // Real execution is blocked until the independent server-owned manual
    // formula selector, signed Paper execution and settlement are connected.
    manualExecutionReady:false as const,
    markets:Object.freeze(lanes),blockers:Object.freeze(blockers),
    perMarketInitialKrw:MANUAL_FOUR_MARKET_INITIAL_KRW,
    totalInitialKrw:MANUAL_FOUR_MARKET_TOTAL_KRW,
  });
}

export function manualWalletCreationReadiness(
  role:ManualWalletRole,records:readonly StoredPaperJournalRecord[],nowMs=Date.now(),
) {
  const found=records.filter(r=>r.kind==='account' && r.id.startsWith('manual-paper-'));
  const existing=inspectManualFourMarketWallets(role, records, nowMs);
  const blockers:string[]=[];
  if(found.length) blockers.push(
    existing.ready ? 'MANUAL_PAPER_SEEDS_ALREADY_CREATED' : 'MANUAL_PAPER_PARTIAL_OR_ROLE_CONFLICT',
  );
  return Object.freeze({
    canCreate: blockers.length===0,
    blockers:Object.freeze(blockers),
    priorManualJournalPreserved:true as const,
    liveAccountUnaffected:true as const,
    autoPaperWalletsUnaffected:true as const,
  });
}
