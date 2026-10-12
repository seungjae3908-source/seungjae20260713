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


/** Only an authenticated owner can inspect a stored Paper-SIMULATION order.
 * The display never upgrades simulated public-quote matches to real fills.
 */
const seqOrderPattern=/^manual-paper-seq-order-v1:[a-f0-9]{64}$/u;
const seqEventPattern=/^manual-paper-seq-event-v1:[a-f0-9]{64}$/u;
const sequentialStatuses=['ENTRY_PENDING','ENTRY_PARTIAL','OPEN',
  'EXIT_PENDING','PARTIALLY_CLOSED','ENTRY_CANCELLED','CLOSED_PROJECTION'] as const;
const sequentialKinds=['OPEN_ORDER','ENTRY_MATCH','CANCEL_ENTRY',
  'REQUEST_EXIT','EXIT_MATCH','CANCEL_EXIT'] as const;
export type ManualSequentialOrderStatus=typeof sequentialStatuses[number];
export type ManualSequentialOrderReadback=Readonly<{
  ownerScope:'SELF';
  readOnlyProbe:true;
  projection:Readonly<{
    schemaVersion:'manual-paper-sequential-events-v1';
    status:ManualSequentialOrderStatus;
    market:ManualMarket;
    orderId:string;
    processedEvents:number;
    entryQuantity:number;
    exitQuantity:number;
    openQuantity:number;
    entryRemainderCancelled:boolean;
    hypotheticalNetPnlKrw:number|null;
    hypotheticalOperatingCapitalKrw:number|null;
    hypotheticalLockedReserveKrw:number|null;
    hypotheticalHighWaterMarkKrw:number|null;
    journalProjection:Readonly<Record<string,unknown>>|null;
    actualBrokerFill:false;
    actualPaperLedgerWritten:false;
    actualWalletMutation:false;
    realOrderSubmitted:false;
    profitabilityProven:false;
    executionAuthority:'NONE';
  }>;
  eventHistory:readonly Readonly<{
    eventId:string;
    sequence:number;
    kind:typeof sequentialKinds[number];
    observedAtMs:number;
  }>[];
}>;
const finiteNonnegative=(v:unknown):v is number=>
  typeof v==='number'&&Number.isFinite(v)&&v>=0
  &&v<=Number.MAX_SAFE_INTEGER;
export function parseManualSequentialOrderReadback(
  raw:unknown,expectedOrderId:string,
):ManualSequentialOrderReadback {
  if(!seqOrderPattern.test(expectedOrderId)||!record(raw)
    ||raw.ok!==true||raw.mode!=='PAPER_SEQUENTIAL_SIMULATION_READ_ONLY'
    ||raw.ownerScope!=='SELF'||raw.readOnlyProbe!==true
    ||raw.executionAuthority!=='NONE'
    ||raw.orderSubmitted!==false||raw.exchangeRequestSent!==false
    ||raw.privateProviderRequests!==0||raw.realOrders!==0
    ||raw.actualBrokerFill!==false||raw.actualPaperLedgerWritten!==false
    ||raw.actualWalletMutation!==false||raw.financialMutationCount!==0
    ||raw.profitabilityProven!==false||!record(raw.projection)
    ||!Array.isArray(raw.eventHistory)
    ||raw.eventHistory.length<1||raw.eventHistory.length>1000) {
    throw new Error('MANUAL_SEQ_ORDER_READBACK_UNVERIFIED');
  }
  const p=raw.projection;
  if(p.schemaVersion!=='manual-paper-sequential-events-v1'
    ||p.orderId!==expectedOrderId
    ||!MANUAL_FOUR_MARKETS.some(m=>m.key===p.market)
    ||!sequentialStatuses.some(status=>status===p.status)
    ||p.executionAuthority!=='NONE'
    ||p.actualBrokerFill!==false||p.actualPaperLedgerWritten!==false
    ||p.actualWalletMutation!==false||p.realOrderSubmitted!==false
    ||p.profitabilityProven!==false
    ||p.dataProvenance!=='SERVER_EVENTS_ONLY'
    ||!Array.isArray(p.blockers)||p.blockers.length!==0
    ||p.processedEvents!==raw.eventHistory.length
    ||!finiteNonnegative(p.entryQuantity)
    ||!finiteNonnegative(p.exitQuantity)
    ||!finiteNonnegative(p.openQuantity)
    ||p.exitQuantity>p.entryQuantity+1e-8
    ||Math.abs(p.openQuantity-(p.entryQuantity-p.exitQuantity))>1e-6
    ||typeof p.entryRemainderCancelled!=='boolean') {
    throw new Error('MANUAL_SEQ_ORDER_PROJECTION_INVALID');
  }
  const closed=p.status==='CLOSED_PROJECTION';
  const values=[p.hypotheticalNetPnlKrw,p.hypotheticalOperatingCapitalKrw,
    p.hypotheticalLockedReserveKrw,p.hypotheticalHighWaterMarkKrw];
  if(closed
    ?(p.openQuantity>1e-8||values.some(v=>typeof v!=='number'
      ||!Number.isFinite(v))||!record(p.journalProjection)
      ||p.journalProjection.actualBrokerFill!==false
      ||p.journalProjection.actualPaperLedgerWritten!==false
      ||p.journalProjection.executionAuthority!=='NONE')
    :(values.some(v=>v!==null)||p.journalProjection!==null)) {
    throw new Error('MANUAL_SEQ_ORDER_FALSE_SETTLEMENT');
  }
  let prevTime=0;
  const eventIds=new Set<string>();
  for(let i=0;i<raw.eventHistory.length;i++){
    const e=raw.eventHistory[i];
    if(!record(e)||!seqEventPattern.test(String(e.eventId))
      ||eventIds.has(e.eventId as string)||e.sequence!==i+1
      ||!sequentialKinds.some(kind=>kind===e.kind)
      ||(i===0&&e.kind!=='OPEN_ORDER')
      ||!Number.isSafeInteger(e.observedAtMs)
      ||(e.observedAtMs as number)<=0
      ||(e.observedAtMs as number)<prevTime) {
      throw new Error('MANUAL_SEQ_ORDER_EVENT_HISTORY_INVALID');
    }
    prevTime=e.observedAtMs as number;
    eventIds.add(e.eventId as string);
  }
  // Stored event metadata must remain consistent with the projected state.
  // Metadata cannot prove economic fills, but impossible order transitions
  // should still be rejected before the browser displays "closed".
  let entered=false,requestedExit=false,everExited=false,entryCancelled=false;
  for(const event of raw.eventHistory){
    if(event.kind==='ENTRY_MATCH'){
      if(entryCancelled||requestedExit)throw new Error('MANUAL_SEQ_ORDER_EVENT_TRANSITION_INVALID');
      entered=true;
    }else if(event.kind==='CANCEL_ENTRY'){
      if(requestedExit||entryCancelled)throw new Error('MANUAL_SEQ_ORDER_EVENT_TRANSITION_INVALID');
      entryCancelled=true;
    }else if(event.kind==='REQUEST_EXIT'){
      if(!entered||requestedExit)throw new Error('MANUAL_SEQ_ORDER_EVENT_TRANSITION_INVALID');
      requestedExit=true;
    }else if(event.kind==='EXIT_MATCH'){
      if(!requestedExit)throw new Error('MANUAL_SEQ_ORDER_EVENT_TRANSITION_INVALID');
      everExited=true;
    }else if(event.kind==='CANCEL_EXIT'){
      if(!requestedExit)throw new Error('MANUAL_SEQ_ORDER_EVENT_TRANSITION_INVALID');
      requestedExit=false;
    }
  }
  if((closed&&(!entered||!everExited))
    ||(p.status==='ENTRY_CANCELLED'&&(!entryCancelled||entered))
    ||(p.status==='ENTRY_PENDING'&&entered)
    ||(p.entryQuantity>0&&!entered)
    ||(p.exitQuantity>0&&!everExited)) {
    throw new Error('MANUAL_SEQ_ORDER_STATUS_HISTORY_MISMATCH');
  }
  return raw as unknown as ManualSequentialOrderReadback;
}
