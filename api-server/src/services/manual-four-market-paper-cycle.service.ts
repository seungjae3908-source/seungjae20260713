import {createHash} from 'node:crypto';
import {
  ADMIN_FOUR_PAPER_MARKETS, type AdminPaperMarket,
} from './admin-four-market-paper-capital.service';
import {
  manualPaperWalletId, type ManualWalletRole,
} from './manual-four-market-paper-wallets.service';
import {validateManualPaperFuturesLeverage} from './paper-futures-mode-policy.service';

/**
 * A *pure* Paper-only 4-market closed-cycle calculation, currently for
 * independently supplied, timestamped SERVER source evidence and QA.
 *
 * No route, provider/private API, database writes, wallet credits or actual
 * fills are authorized by this service. Synthetic test receipts MUST NOT be
 * interpreted as an actual historical trade, realized gain or OOS PASS.
 */
export type ManualPaperMarketSide='BUY'|'LONG'|'SHORT';
export type ManualPaperFourQuoteCurrency='KRW'|'USD'|'USDT';
export type ManualPaperFourMarketQuote=Readonly<{
  sourceId:string;
  market:AdminPaperMarket;
  symbol:string;
  currency:ManualPaperFourQuoteCurrency;
  observedAtMs:number;
  bid:number;
  ask:number;
  provenance:'SERVER_PUBLIC_MARKET_READBACK';
  closedCandleConfirmed:true;
}>;
export type ManualPaperFourCostEvidence=Readonly<{
  sourceId:string;
  status:'SERVER_COST_EVIDENCE_READY';
  observedAtMs:number;
  entryCommissionRate:number;
  exitCommissionRate:number;
  spreadAndSlippageKrw:number;
  taxKrw:number;
  signedFundingKrw:number;
  entryFxKrwPerQuote:number;
  exitFxKrwPerQuote:number;
  entryFxSourceId:string;
  entryFxObservedAtMs:number;
  exitFxSourceId:string;
  exitFxObservedAtMs:number;
}>;
export type ManualPaperFourMarketSelection=Readonly<{
  ownerId:string;
  role:ManualWalletRole;
  mode:'manual';
  accountId:string;
  market:AdminPaperMarket;
  symbol:string;
  strategyId:string;
  candidateId:string;
  signalObservedAtMs:number;
  side:ManualPaperMarketSide;
  leverage:number;
  requestedNotionalKrw:number;
}>;
export type ManualPaperFourMarketOwnerEvidence=Readonly<{
  ownerId:string;
  accountId:string;
  market:AdminPaperMarket;
  strategyCandidateId:string;
  strategyValidatedAtMs:number;
  strategySourceId:string;
  walletReadbackReady:boolean;
  ownerRlsReady:boolean;
  initialCapitalKrw:1000000;
  currentRoundNumber:number;
  currentEpochId:string;
  operatingCapitalKrw:number;
  lockedReserveKrw:number;
  highWaterMarkKrw:number;
  fullyReconciledFlatPosition:boolean;
  priorCloseEventIds:readonly string[];
}>;
export type ManualPaperFourMarketCycleInput=Readonly<{
  selected:ManualPaperFourMarketSelection;
  verifiedOwner:ManualPaperFourMarketOwnerEvidence;
  entryQuote:ManualPaperFourMarketQuote;
  exitQuote:ManualPaperFourMarketQuote;
  costs:ManualPaperFourCostEvidence;
  nowMs:number;
}>;
export type ManualPaperFourMarketCycle=Readonly<{
  status:'RESEARCH_SIMULATED_CLOSED'|'BLOCKED';
  blockers:readonly string[];
  market:AdminPaperMarket|null;
  side:ManualPaperMarketSide|null;
  mode:'manual';
  closedCycleId:string|null;
  grossPnlKrw:number|null;
  netPnlKrw:number|null;
  verifiedCostsKrw:number|null;
  entryPrice:number|null;
  exitPrice:number|null;
  quantity:number|null;
  updatedOperatingCapitalKrw:number|null;
  updatedLockedReserveKrw:number|null;
  newCompoundedProfitKrw:number|null;
  newReserveProfitKrw:number|null;
  journal:Readonly<Record<string,unknown>>|null;
  executionAuthority:'NONE';
  liveOrderSubmitted:false;
  exchangeRequestSent:false;
  dataSource:'SERVER_READBACK_ONLY';
  oosProfitabilityProven:false;
  actualPaperLedgerWritten:false;
}>;

const MARKET_CURRENCY:Readonly<Record<AdminPaperMarket,ManualPaperFourQuoteCurrency>>={
  domestic_stock:'KRW',us_stock:'USD',crypto_spot:'KRW',crypto_futures:'USDT',
};
const FRESH=60_000;
const riskAllowed=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const positive=(v:unknown):v is number=>riskAllowed(v)&&v>0;
const cents=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const idPattern=/^[a-zA-Z0-9:._-]{1,150}$/u;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function blocked(input:ManualPaperFourMarketCycleInput,blockers:string[]):ManualPaperFourMarketCycle{
  return Object.freeze({
    status:'BLOCKED',blockers:Object.freeze([...new Set(blockers)]),
    market:input?.selected?.market??null,side:input?.selected?.side??null,
    mode:'manual' as const,closedCycleId:null,grossPnlKrw:null,netPnlKrw:null,
    verifiedCostsKrw:null,entryPrice:null,exitPrice:null,quantity:null,
    updatedOperatingCapitalKrw:null,updatedLockedReserveKrw:null,
    newCompoundedProfitKrw:null,newReserveProfitKrw:null,journal:null,
    executionAuthority:'NONE' as const,liveOrderSubmitted:false as const,
    exchangeRequestSent:false as const,dataSource:'SERVER_READBACK_ONLY' as const,
    oosProfitabilityProven:false as const,actualPaperLedgerWritten:false as const,
  });
}

/** Used only after an authenticated server adapter has separately read the
 * real owner/strategy/quote/fee snapshots. A caller-provided boolean does
 * NOT serve as a substitute for that trusted adapter; the public route must
 * not accept this structure as a request body.
 */
export function evaluateManualFourMarketPaperClosedCycle(
  input:ManualPaperFourMarketCycleInput,
):ManualPaperFourMarketCycle {
  const blockers:string[]=[];
  const add=(code:string)=>{if(!blockers.includes(code))blockers.push(code);};
  if(!input||typeof input!=='object')
    return blocked(input,['PAPER_CYCLE_EVIDENCE_MISSING']);
  const {selected:s,verifiedOwner:o,entryQuote:e,exitQuote:x,costs:c,nowMs}=input;
  if(!Number.isSafeInteger(nowMs)||nowMs<=0)add('PAPER_CYCLE_CLOCK_INVALID');
  if(!s||!o||!e||!x||!c)return blocked(input,['PAPER_CYCLE_EVIDENCE_MISSING']);
  if(s.mode!=='manual'||!ADMIN_FOUR_PAPER_MARKETS.includes(s.market)
    ||!['admin','member'].includes(s.role)
    ||!idPattern.test(s.ownerId)||!idPattern.test(s.accountId)
    ||!idPattern.test(s.strategyId)||!idPattern.test(s.candidateId)
    ||!idPattern.test(s.symbol))add('PAPER_CYCLE_IDENTITY_INVALID');
  const accountId=ADMIN_FOUR_PAPER_MARKETS.includes(s.market)
    && ['admin','member'].includes(s.role)
    ?manualPaperWalletId(s.role,s.market):null;
  if(accountId!==s.accountId||o.ownerId!==s.ownerId
    ||o.accountId!==s.accountId||o.market!==s.market
    ||o.strategyCandidateId!==s.candidateId
    ||!idPattern.test(o.strategySourceId)||o.walletReadbackReady!==true
    ||o.ownerRlsReady!==true||o.initialCapitalKrw!==1000000
    ||!Number.isSafeInteger(o.currentRoundNumber)||o.currentRoundNumber<1
    ||!idPattern.test(o.currentEpochId))add('PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  if(s.market==='crypto_futures'){
    if(!['LONG','SHORT'].includes(s.side)
      ||!validateManualPaperFuturesLeverage(s.leverage))add('PAPER_CYCLE_FUTURES_POLICY_INVALID');
  }else if(s.side!=='BUY'||s.leverage!==1)add('PAPER_CYCLE_NONFUTURES_LONG_ONLY');
  if(!positive(s.requestedNotionalKrw)
    ||!riskAllowed(o.operatingCapitalKrw)||!riskAllowed(o.lockedReserveKrw)
    ||!positive(o.highWaterMarkKrw)||!o.fullyReconciledFlatPosition
    ||!Array.isArray(o.priorCloseEventIds)
    ||o.priorCloseEventIds.length>10000)add('PAPER_CYCLE_CAPITAL_OR_SETTLEMENT_UNKNOWN');
  const margin=positive(s.leverage)?s.requestedNotionalKrw/s.leverage:NaN;
  if(!Number.isFinite(margin)
    ||!(positive(o.operatingCapitalKrw)&&margin<=o.operatingCapitalKrw))
    add('PAPER_CYCLE_INSUFFICIENT_OPERATING_CAPITAL');
  if(positive(o.highWaterMarkKrw)&&riskAllowed(o.operatingCapitalKrw)
    &&riskAllowed(o.lockedReserveKrw)
    &&(o.highWaterMarkKrw<1_000_000
      ||o.highWaterMarkKrw+0.01<o.operatingCapitalKrw+o.lockedReserveKrw))
    add('PAPER_CYCLE_INVALID_HIGH_WATER_PROOF');
  if(!Number.isSafeInteger(s.signalObservedAtMs)||!Number.isSafeInteger(o.strategyValidatedAtMs)
    ||s.signalObservedAtMs<=0||o.strategyValidatedAtMs<=0
    ||o.strategyValidatedAtMs>s.signalObservedAtMs
    ||s.signalObservedAtMs>nowMs)add('PAPER_CYCLE_LOOKAHEAD_OR_STRATEGY_NOT_VALIDATED');
  const correctQuote=(q:ManualPaperFourMarketQuote):boolean=>
    q.provenance==='SERVER_PUBLIC_MARKET_READBACK'
    &&q.closedCandleConfirmed===true
    &&q.market===s.market&&q.symbol===s.symbol
    &&q.currency===MARKET_CURRENCY[s.market]
    &&idPattern.test(q.sourceId)
    &&positive(q.ask)&&positive(q.bid)&&q.ask>=q.bid
    &&Number.isSafeInteger(q.observedAtMs)&&q.observedAtMs>0
    &&q.observedAtMs<=nowMs;
  if(!correctQuote(e)||!correctQuote(x))add('PAPER_CYCLE_PUBLIC_QUOTE_INVALID');
  if(correctQuote(e)&&correctQuote(x)&&(
    e.observedAtMs<s.signalObservedAtMs
    ||e.observedAtMs-s.signalObservedAtMs>FRESH
    ||x.observedAtMs<=e.observedAtMs
    ||nowMs-x.observedAtMs>FRESH
    ||x.sourceId===e.sourceId
  ))add('PAPER_CYCLE_UNVERIFIED_OR_FUTURE_TIMELINE');
  if(c.status!=='SERVER_COST_EVIDENCE_READY'||!idPattern.test(c.sourceId)
    ||!idPattern.test(c.entryFxSourceId)||!idPattern.test(c.exitFxSourceId)
    ||!Number.isSafeInteger(c.observedAtMs)||c.observedAtMs<x.observedAtMs
    ||c.observedAtMs>nowMs
    // Entry FX must have been known *before* entry, and close-time FX before
    // exit. Future observations cannot backfill a winning simulation.
    ||!Number.isSafeInteger(c.entryFxObservedAtMs)
    ||!Number.isSafeInteger(c.exitFxObservedAtMs)
    ||c.entryFxObservedAtMs>e.observedAtMs
    ||c.exitFxObservedAtMs>x.observedAtMs
    ||e.observedAtMs-c.entryFxObservedAtMs>FRESH
    ||x.observedAtMs-c.exitFxObservedAtMs>FRESH
    ||c.entryFxObservedAtMs<=0||c.exitFxObservedAtMs<=0
    ||![c.entryCommissionRate,c.exitCommissionRate].every(
      n=>riskAllowed(n)&&n<=0.05)
    ||!riskAllowed(c.spreadAndSlippageKrw)||!riskAllowed(c.taxKrw)
    ||!Number.isFinite(c.signedFundingKrw)
    ||!positive(c.entryFxKrwPerQuote)||!positive(c.exitFxKrwPerQuote)
  )add('PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  if(s.market==='domestic_stock'||s.market==='crypto_spot'){
    if(c.entryFxKrwPerQuote!==1||c.exitFxKrwPerQuote!==1)
      add('PAPER_CYCLE_KRW_FX_MUST_EQUAL_ONE');
  }
  if(s.market!=='crypto_futures'&&c.signedFundingKrw!==0)
    add('PAPER_CYCLE_NONFUTURES_FUNDING_FORBIDDEN');
  if(Array.isArray(o.priorCloseEventIds)
    &&new Set(o.priorCloseEventIds).size!==o.priorCloseEventIds.length)
    add('PAPER_CYCLE_LEDGER_DUPLICATE');
  if(blockers.length)return blocked(input,blockers);
  const entryPrice=s.side==='SHORT'?e.bid:e.ask;
  const exitPrice=s.side==='SHORT'?x.ask:x.bid;
  const qty=s.requestedNotionalKrw/(entryPrice*c.entryFxKrwPerQuote);
  const entryValueKrw=qty*entryPrice*c.entryFxKrwPerQuote;
  const closeValueKrw=qty*exitPrice*c.exitFxKrwPerQuote;
  const grossKrw=s.side==='SHORT'?entryValueKrw-closeValueKrw:closeValueKrw-entryValueKrw;
  const commissionKrw=entryValueKrw*c.entryCommissionRate
    +closeValueKrw*c.exitCommissionRate;
  const costKrw=commissionKrw+c.spreadAndSlippageKrw+c.taxKrw+c.signedFundingKrw;
  const netKrw=grossKrw-costKrw;
  if(![qty,entryValueKrw,closeValueKrw,grossKrw,costKrw,netKrw].every(Number.isFinite)
    ||qty<=0||entryValueKrw>Number.MAX_SAFE_INTEGER
    ||Math.abs(netKrw)>Number.MAX_SAFE_INTEGER)
    return blocked(input,['PAPER_CYCLE_CALCULATION_OVERFLOW']);
  // Isolated futures liquidation needs an independently verified liquidation
  // model. A mock price move beyond pledged margin must never fabricate a fill.
  if(s.market==='crypto_futures' &&netKrw< -margin-0.01)
    return blocked(input,['PAPER_CYCLE_UNMODELLED_ISOLATED_LIQUIDATION']);
  // Identity anchors to the decision, not to a later price/cost revision.
  // Otherwise the same order can be replayed with a new feed ID and credited
  // twice. Evidence IDs remain in the journal for actual audit.
  const dedupId='paper-manual-cycle-v1:'+sha([
    s.ownerId,s.accountId,o.currentEpochId,o.currentRoundNumber,s.candidateId,
    s.market,s.symbol,s.side,s.leverage,s.signalObservedAtMs,
  ].join('|'));
  if(o.priorCloseEventIds.includes(dedupId))
    return blocked(input,['PAPER_CYCLE_ALREADY_CLOSED']);
  const previousTotal=o.operatingCapitalKrw+o.lockedReserveKrw;
  const highWater= o.highWaterMarkKrw;
  const newlyAboveHighWater=Math.max(0,previousTotal+netKrw-highWater);
  const recovered=netKrw-newlyAboveHighWater;
  const newReserve=newlyAboveHighWater*0.5;
  const newCompound=newlyAboveHighWater*0.5;
  const operatingKrw=o.operatingCapitalKrw+recovered+newCompound;
  if(!Number.isFinite(operatingKrw)||operatingKrw< -0.01)
    return blocked(input,['PAPER_CYCLE_CAPITAL_EXHAUSTED_UNMODELLED']);
  const journal=Object.freeze({
    schemaVersion:'manual-four-market-paper-research-cycle-v1',
    id:dedupId,mode:'manual',ownerId:s.ownerId,
    market:s.market,accountId:s.accountId,epochId:o.currentEpochId,
    roundNumber:o.currentRoundNumber,candidateId:s.candidateId,
    strategyId:s.strategyId,symbol:s.symbol,side:s.side,leverage:s.leverage,
    entryObservedAtMs:e.observedAtMs,exitObservedAtMs:x.observedAtMs,
    entryPrice,exitPrice,quantity:qty,
    quoteCurrency:e.currency,entrySourceId:e.sourceId,exitSourceId:x.sourceId,
    costsSourceId:c.sourceId,
    entryFxSourceId:c.entryFxSourceId,exitFxSourceId:c.exitFxSourceId,
    entryFxObservedAtMs:c.entryFxObservedAtMs,
    exitFxObservedAtMs:c.exitFxObservedAtMs,
    grossPnlKrw:cents(grossKrw),commissionKrw:cents(commissionKrw),
    slippageKrw:cents(c.spreadAndSlippageKrw),
    taxKrw:cents(c.taxKrw),fundingCostKrw:cents(c.signedFundingKrw),
    netPnlKrw:cents(netKrw),
    exitReason:'PRICE_BASED_RESEARCH_SIMULATION_ONLY',
    causalImpactProven:false,actualPaperLedgerWritten:false,
    externalAiCalled:false,realOrderSubmitted:false,
  });
  return Object.freeze({
    status:'RESEARCH_SIMULATED_CLOSED',blockers:Object.freeze([]),
    market:s.market,side:s.side,mode:'manual',closedCycleId:dedupId,
    grossPnlKrw:cents(grossKrw),netPnlKrw:cents(netKrw),
    verifiedCostsKrw:cents(costKrw),entryPrice,exitPrice,quantity:qty,
    updatedOperatingCapitalKrw:cents(Math.max(0,operatingKrw)),
    updatedLockedReserveKrw:cents(o.lockedReserveKrw+newReserve),
    newCompoundedProfitKrw:cents(newCompound),newReserveProfitKrw:cents(newReserve),
    journal,executionAuthority:'NONE',liveOrderSubmitted:false,
    exchangeRequestSent:false,dataSource:'SERVER_READBACK_ONLY',
    oosProfitabilityProven:false,actualPaperLedgerWritten:false,
  });
}
