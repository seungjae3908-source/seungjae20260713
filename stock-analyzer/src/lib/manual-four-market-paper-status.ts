/** Manual server wallet readiness is separate from the browser Futures-only
 * simulator and all Automatic Paper/LIVE account balances.
 */
export const MANUAL_FOUR_MARKETS=[
  {key:'domestic_stock',label:'국내주식'},
  {key:'us_stock',label:'미국주식'},
  {key:'crypto_spot',label:'코인현물'},
  {key:'crypto_futures',label:'코인선물'},
] as const;
export type ManualMarket=typeof MANUAL_FOUR_MARKETS[number]['key'];
export type ManualFourMarketStatus=Readonly<{
  ownerScope:'SELF';role:'admin'|'member';ready:boolean;
  rlsGuardReady:boolean;canCreate:boolean;manualExecutionReady:false;
  perMarketInitialKrw:1000000;totalInitialKrw:4000000;
  markets:Readonly<Record<ManualMarket,Readonly<{
    market:ManualMarket;id:string;seedExists:boolean;
    validated:boolean;initialCapitalKrw:1000000;blockers:readonly string[];
  }>>>;
  blockers:readonly string[];
  creationBlockers:readonly string[];
}>;
/**
 * A bootstrap confirmation belongs to the exact authenticated account that
 * opened it. Switching accounts, even with the same four-market readiness,
 * must invalidate a pending confirmation before issuing any request.
 */
export function manualPaperBootstrapAuthorized(
  ownerId:string, confirmedOwnerId:string|null,
  status:ManualFourMarketStatus|null,
):boolean {
  return typeof ownerId==='string' && ownerId.length>0
    && confirmedOwnerId===ownerId
    && status?.ownerScope==='SELF'
    && status.rlsGuardReady===true
    && status.ready===false
    && status.canCreate===true;
}

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const codes=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=16&&v.every(
  x=>typeof x==='string'&&x.length>0&&x.length<=128);
export function parseManualFourMarketStatus(raw:unknown):ManualFourMarketStatus{
  if(!record(raw)||raw.ok!==true
    ||raw.mode!=='MANUAL_PAPER_FOUR_MARKET_SEED_ONLY'
    ||raw.ownerScope!=='SELF'||raw.readOnlyProbe!==true
    ||(raw.role!=='admin'&&raw.role!=='member')
    ||typeof raw.ready!=='boolean'||typeof raw.rlsGuardReady!=='boolean'
    ||typeof raw.canCreate!=='boolean'||raw.manualExecutionReady!==false
    ||raw.perMarketInitialKrw!==1000000||raw.totalInitialKrw!==4000000
    ||raw.orderSubmitted!==false||raw.exchangeRequestSent!==false
    ||raw.privateProviderRequests!==0||raw.realOrders!==0
    ||raw.virtualSeedRowsInserted!==0
    ||!record(raw.markets)||!codes(raw.blockers)||!codes(raw.creationBlockers)){
    throw new Error('MANUAL_PAPER_STATUS_CONTRACT_INVALID');
  }
  if(raw.ready&&!raw.rlsGuardReady)throw new Error('MANUAL_PAPER_RLS_NOT_VERIFIED');
  for(const {key} of MANUAL_FOUR_MARKETS){
    const m=raw.markets[key];
    if(!record(m)||m.market!==key
      ||m.id!==`manual-paper-${raw.role}-v1:${key}`
      ||typeof m.seedExists!=='boolean'||typeof m.validated!=='boolean'
      ||m.initialCapitalKrw!==1000000||!codes(m.blockers)
      ||(m.validated&&(!m.seedExists||m.blockers.length>0))
      ||(raw.ready&&!m.validated)){
      throw new Error('MANUAL_PAPER_STATUS_MARKET_INVALID_'+key);
    }
  }
  if(raw.canCreate&&(!raw.rlsGuardReady||raw.ready
    ||Object.values(raw.markets as Record<string,Record<string,unknown>>)
      .some(lane=>lane.seedExists===true))){
    throw new Error('MANUAL_PAPER_CREATION_RIGHT_UNVERIFIED');
  }
  return raw as unknown as ManualFourMarketStatus;
}


/** Research-only immutable receipt view, never an executed Paper fill or
 * settled wallet. Missing/error response must not become a zero-PnL claim.
 */
export type ManualResearchHistoryReadback=Readonly<{
  ownerScope:'SELF';
  readOnlyProbe:true;
  hasMoreThan100:boolean;
  receipts:readonly Readonly<{
    cycleId:string;
    market:ManualMarket;
    receiptSha256:string;
    recordedAt:string;
    status:'RESEARCH_SIMULATED_CLOSED';
    hypotheticalNetPnlKrw:number;
    actualPaperLedgerWritten:false;
    profitabilityProven:false;
  }>[];
}>;
export function parseManualFourMarketResearchHistory(raw:unknown):ManualResearchHistoryReadback{
  if(!record(raw)||raw.ok!==true
    ||raw.mode!=='MANUAL_PAPER_RESEARCH_RECEIPT_READ_ONLY'
    ||raw.ownerScope!=='SELF'||raw.readOnlyProbe!==true
    ||raw.actualPaperLedgerWritten!==false
    ||raw.profitabilityProven!==false
    ||raw.financialMutationCount!==0
    ||raw.privateProviderRequests!==0
    ||raw.realOrders!==0
    ||raw.orderSubmitted!==false
    ||raw.exchangeRequestSent!==false
    ||raw.executionAuthority!=='NONE'
    ||typeof raw.hasMoreThan100!=='boolean'
    ||!Array.isArray(raw.receipts)||raw.receipts.length>100) {
    throw new Error('MANUAL_PAPER_RESEARCH_HISTORY_CONTRACT_INVALID');
  }
  const seen=new Set<string>();
  for(const entry of raw.receipts){
    if(!record(entry)
      ||typeof entry.cycleId!=='string'
      ||!/^paper-manual-cycle-v1:[a-f0-9]{64}$/u.test(entry.cycleId)
      ||seen.has(entry.cycleId)
      ||!MANUAL_FOUR_MARKETS.some(m=>m.key===entry.market)
      ||typeof entry.receiptSha256!=='string'
      ||!/^[a-f0-9]{64}$/u.test(entry.receiptSha256)
      ||typeof entry.recordedAt!=='string'
      ||!Number.isFinite(Date.parse(entry.recordedAt))
      ||entry.status!=='RESEARCH_SIMULATED_CLOSED'
      ||typeof entry.hypotheticalNetPnlKrw!=='number'
      ||!Number.isFinite(entry.hypotheticalNetPnlKrw)
      ||entry.actualPaperLedgerWritten!==false
      ||entry.profitabilityProven!==false) {
      throw new Error('MANUAL_PAPER_RESEARCH_HISTORY_ENTRY_INVALID');
    }
    seen.add(entry.cycleId);
  }
  return raw as unknown as ManualResearchHistoryReadback;
}
