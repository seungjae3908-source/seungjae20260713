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
  strategyId:string;
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
  updatedHighWaterMarkKrw:number|null;
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
    newCompoundedProfitKrw:null,newReserveProfitKrw:null,
    updatedHighWaterMarkKrw:null,journal:null,
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
    ||o.strategyCandidateId!==s.candidateId||o.strategyId!==s.strategyId
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
    &&(o.priorCloseEventIds.some(id=>typeof id!=='string'
      || !/^paper-manual-cycle-v1:[0-9a-f]{64}$/u.test(id))
      ||new Set(o.priorCloseEventIds).size!==o.priorCloseEventIds.length))
    add('PAPER_CYCLE_LEDGER_DUPLICATE');
  // Entry collateral includes known commission and full conservative
  // quoted slippage budget. A highly leveraged order cannot ignore fees
  // and overuse the remaining virtual capital before its Paper fill.
  if(Number.isFinite(margin)&&riskAllowed(o.operatingCapitalKrw)
    &&riskAllowed(s.requestedNotionalKrw)
    &&riskAllowed(c.entryCommissionRate)
    &&riskAllowed(c.spreadAndSlippageKrw)
    &&margin+s.requestedNotionalKrw*c.entryCommissionRate
      +c.spreadAndSlippageKrw>o.operatingCapitalKrw+0.01)
    add('PAPER_CYCLE_ENTRY_COSTS_EXCEED_AVAILABLE_CAPITAL');
  if(blockers.length)return blocked(input,blockers);
  const entryPrice=s.side==='SHORT'?e.bid:e.ask;
  const exitPrice=s.side==='SHORT'?x.ask:x.bid;
  const qty=s.requestedNotionalKrw/(entryPrice*c.entryFxKrwPerQuote);
  const entryValueKrw=qty*entryPrice*c.entryFxKrwPerQuote;
  const closeValueKrw=qty*exitPrice*c.exitFxKrwPerQuote;
  // A cash USD stock owns FX exposure on the whole principal. Isolated
  // USDT-margined futures own only the native price-difference PnL: applying
  // changed FX to the full futures notional manufactures a profit on flat price.
  const direction=s.side==='SHORT'?-1:1;
  const grossKrw=s.market==='crypto_futures'
    ? direction*qty*(exitPrice-entryPrice)*c.exitFxKrwPerQuote
    : direction*(closeValueKrw-entryValueKrw);
  // Both contributions must reconcile to the same verified gross KRW PnL.
  const priceMovementKrw=direction*qty*(exitPrice-entryPrice)*c.entryFxKrwPerQuote;
  const fxTranslationKrw=s.market==='crypto_futures'
    ? direction*qty*(exitPrice-entryPrice)*(c.exitFxKrwPerQuote-c.entryFxKrwPerQuote)
    : direction*qty*exitPrice*(c.exitFxKrwPerQuote-c.entryFxKrwPerQuote);
  const commissionKrw=entryValueKrw*c.entryCommissionRate
    +closeValueKrw*c.exitCommissionRate;
  const costKrw=commissionKrw+c.spreadAndSlippageKrw+c.taxKrw+c.signedFundingKrw;
  const netKrw=grossKrw-costKrw;
  if(![qty,entryValueKrw,closeValueKrw,grossKrw,
    priceMovementKrw,fxTranslationKrw,costKrw,netKrw].every(Number.isFinite)
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
  // Store this receipt in the next protected snapshot: otherwise a later
  // losing trade can accidentally earn another 50% reserve distribution.
  const nextHighWaterKrw=Math.max(highWater,previousTotal+netKrw);
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
    grossPnlKrw:cents(grossKrw),
    priceMovementKrw:cents(priceMovementKrw),
    fxTranslationKrw:cents(fxTranslationKrw),
    pnlAttributionBasis:'PRICE_FX_COST_ARITHMETIC_ONLY',
    commissionKrw:cents(commissionKrw),
    slippageKrw:cents(c.spreadAndSlippageKrw),
    taxKrw:cents(c.taxKrw),fundingCostKrw:cents(c.signedFundingKrw),
    netPnlKrw:cents(netKrw),
    nextHighWaterMarkKrw:cents(nextHighWaterKrw),
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
    updatedHighWaterMarkKrw:cents(nextHighWaterKrw),
    journal,executionAuthority:'NONE',liveOrderSubmitted:false,
    exchangeRequestSent:false,dataSource:'SERVER_READBACK_ONLY',
    oosProfitabilityProven:false,actualPaperLedgerWritten:false,
  });
}


/**
 * Immutable research-only receipt for a separately authenticated server source.
 * Never promote this into a canonical filled order, settled capital, a real
 * broker trade, a backtest PASS, or an automatic 50/50 reserve credit.
 */
export const MANUAL_PAPER_RESEARCH_RECEIPT_VERSION =
  'manual-four-market-research-receipt-v1' as const;
export type ManualPaperResearchReceipt = Readonly<{
  schemaVersion:typeof MANUAL_PAPER_RESEARCH_RECEIPT_VERSION;
  cycleId:string;
  ownerId:string;
  role:ManualWalletRole;
  market:AdminPaperMarket;
  walletId:string;
  epochId:string;
  roundNumber:number;
  candidateId:string;
  strategyId:string;
  status:'RESEARCH_SIMULATED_CLOSED';
  sourceEvidenceSha256:string;
  journal:Readonly<Record<string,unknown>>;
  hypotheticalNetPnlKrw:number;
  hypotheticalOperatingCapitalKrw:number;
  hypotheticalReserveKrw:number;
  hypotheticalHighWaterMarkKrw:number;
  executionAuthority:'NONE';
  actualPaperLedgerWritten:false;
  realOrderSubmitted:false;
  profitabilityProven:false;
  financialMutationCount:0;
}>;
export type ManualPaperResearchReceiptRow = Readonly<{
  user_id:string;
  cycle_id:string;
  wallet_id:string;
  owner_role:ManualWalletRole;
  market:AdminPaperMarket;
  epoch_id:string;
  round_number:number;
  receipt_sha256:string;
  receipt:ManualPaperResearchReceipt;
}>;
export function buildManualPaperResearchReceipt(
  input:ManualPaperFourMarketCycleInput,
  calculation:ManualPaperFourMarketCycle,
):ManualPaperResearchReceiptRow {
  const s=input?.selected, o=input?.verifiedOwner;
  if(!s || !o || calculation?.status!=='RESEARCH_SIMULATED_CLOSED'
    || calculation.actualPaperLedgerWritten!==false
    || calculation.executionAuthority!=='NONE'
    || calculation.liveOrderSubmitted!==false
    || calculation.exchangeRequestSent!==false
    || calculation.oosProfitabilityProven!==false
    || !calculation.journal
    || !/^[a-zA-Z0-9:._-]{1,150}$/u.test(o.currentEpochId)
    || !Number.isInteger(o.currentRoundNumber)||o.currentRoundNumber<1
    || !/^[a-zA-Z0-9:._-]{1,150}$/u.test(s.candidateId)
    || !/^[a-zA-Z0-9:._-]{1,150}$/u.test(s.strategyId)
    || !/^paper-manual-cycle-v1:[0-9a-f]{64}$/u.test(calculation.closedCycleId??'')
    || !ADMIN_FOUR_PAPER_MARKETS.includes(s.market)
    || !['admin','member'].includes(s.role)
    || s.ownerId!==o.ownerId
    || s.accountId!==manualPaperWalletId(s.role,s.market)
    || o.accountId!==s.accountId || o.market!==s.market
    || o.walletReadbackReady!==true || o.ownerRlsReady!==true
    || calculation.market!==s.market || calculation.mode!=='manual'
    || calculation.journal.id!==calculation.closedCycleId
    || calculation.journal.accountId!==s.accountId
    || calculation.journal.ownerId!==s.ownerId
    || calculation.journal.roundNumber!==o.currentRoundNumber
    || calculation.journal.epochId!==o.currentEpochId
    || !Number.isFinite(calculation.netPnlKrw)
    || !Number.isFinite(calculation.updatedOperatingCapitalKrw)
    || !Number.isFinite(calculation.updatedLockedReserveKrw)
    || !Number.isFinite(calculation.updatedHighWaterMarkKrw)) {
    throw new Error('MANUAL_PAPER_RESEARCH_RECEIPT_INVALID_EVIDENCE');
  }
  // Hash the complete server-owned research input, not just the symbol/date.
  // A repeat of the same cycle ID with a revised price/fee/FX must conflict,
  // never silently count as a second gain or overwrite immutable research.
  const sourceEvidenceSha256=sha(JSON.stringify({
    selected:s, verifiedOwner:o, entryQuote:input.entryQuote,
    exitQuote:input.exitQuote, costs:input.costs,
  }));
  const receipt:ManualPaperResearchReceipt=Object.freeze({
    schemaVersion:MANUAL_PAPER_RESEARCH_RECEIPT_VERSION,
    cycleId:calculation.closedCycleId!,
    ownerId:s.ownerId,role:s.role,market:s.market,walletId:s.accountId,
    epochId:o.currentEpochId,roundNumber:o.currentRoundNumber,
    candidateId:s.candidateId,strategyId:s.strategyId,
    status:'RESEARCH_SIMULATED_CLOSED',
    sourceEvidenceSha256,
    journal:Object.freeze(structuredClone(calculation.journal)),
    hypotheticalNetPnlKrw:calculation.netPnlKrw!,
    hypotheticalOperatingCapitalKrw:calculation.updatedOperatingCapitalKrw!,
    hypotheticalReserveKrw:calculation.updatedLockedReserveKrw!,
    hypotheticalHighWaterMarkKrw:calculation.updatedHighWaterMarkKrw!,
    executionAuthority:'NONE',actualPaperLedgerWritten:false,
    realOrderSubmitted:false,profitabilityProven:false,
    financialMutationCount:0,
  });
  return Object.freeze({
    user_id:s.ownerId,cycle_id:receipt.cycleId,
    wallet_id:s.accountId,owner_role:s.role,market:s.market,
    epoch_id:o.currentEpochId,round_number:o.currentRoundNumber,
    receipt_sha256:sha(JSON.stringify(receipt)),receipt,
  });
}
export function sameManualPaperResearchReceipt(
  expected:ManualPaperResearchReceiptRow,
  actual:Record<string,unknown>,
):boolean {
  return Boolean(actual&&typeof actual==='object'
    && actual.user_id===expected.user_id
    && actual.cycle_id===expected.cycle_id
    && actual.wallet_id===expected.wallet_id
    && actual.owner_role===expected.owner_role
    && actual.market===expected.market
    && actual.epoch_id===expected.epoch_id
    && actual.round_number===expected.round_number
    && actual.receipt_sha256===expected.receipt_sha256
    && actual.receipt!==null
    && typeof actual.receipt==='object'
    && (actual.receipt as Record<string,unknown>).cycleId===expected.cycle_id
    && (actual.receipt as Record<string,unknown>).sourceEvidenceSha256
      ===expected.receipt.sourceEvidenceSha256
    && (actual.receipt as Record<string,unknown>).executionAuthority==='NONE'
    && (actual.receipt as Record<string,unknown>).actualPaperLedgerWritten===false
  );
}


/**
 * Deterministic, server-evidence-only manual four-market PAPER simulation
 * lifecycle. This is deliberately NOT a broker order/fill. A quote-simulation
 * match does not constitute an actual exchange print or a durable trading fill.
 * Nothing here writes financial tables, transfers funds or sends Telegram.
 *
 * A fresh authenticated server adapter must separately attest the strategy,
 * source quotes and match model. Do not accept match[] from a browser request.
 */
export const MANUAL_PAPER_ORDER_PATH_VERSION =
  'manual-four-market-paper-order-path-v1' as const;
export type ManualPaperSimulatedMatch = Readonly<{
  eventId:string;
  phase:'ENTRY'|'EXIT';
  action:'BUY'|'SELL';
  quoteSourceId:string;
  observedAtMs:number;
  quantity:number;
  provenance:'SERVER_PUBLIC_QUOTE_SIMULATION';
}>;
export type ManualPaperOrderPathInput = Readonly<{
  cycle:ManualPaperFourMarketCycleInput;
  events:readonly ManualPaperSimulatedMatch[];
  /** Attested in-process simulated cancellation of the unfilled entry part. */
  entryRemainderCanceled:boolean;
}>;
export type ManualPaperOrderPathStatus =
  'BLOCKED'|'UNMATCHED'|'CANCELED_NO_FILL'|
  'OPEN_UNSETTLED'|'PARTIALLY_CLOSED_UNSETTLED'|'SIMULATED_CLOSED';
export type ManualPaperOrderPathResult = Readonly<{
  schemaVersion:typeof MANUAL_PAPER_ORDER_PATH_VERSION;
  status:ManualPaperOrderPathStatus;
  blockers:readonly string[];
  market:AdminPaperMarket|null;
  simulatedOrderId:string|null;
  requestedQuantity:number|null;
  simulatedEntryQuantity:number;
  simulatedExitQuantity:number;
  openQuantity:number;
  entryRemainderCanceled:boolean;
  entryMatchCount:number;
  exitMatchCount:number;
  hypotheticalNetPnlKrw:number|null;
  hypotheticalNewOperatingCapitalKrw:number|null;
  hypotheticalNewReserveKrw:number|null;
  hypotheticalHighWaterKrw:number|null;
  journal:Readonly<Record<string,unknown>>|null;
  ownerScope:'SERVER_EVIDENCE_ONLY';
  simulationOnly:true;
  actualPaperOrderCreated:false;
  actualPaperFillsRecorded:false;
  actualPaperLedgerWritten:false;
  realOrderSubmitted:false;
  executionAuthority:'NONE';
  profitabilityProven:false;
  transferAuthority:false;
}>;
export function evaluateManualFourMarketPaperOrderPath(
  input:ManualPaperOrderPathInput,
):ManualPaperOrderPathResult {
  const selected=input?.cycle?.selected;
  const market=selected?.market??null;
  const base={
    schemaVersion:MANUAL_PAPER_ORDER_PATH_VERSION,
    market,
    ownerScope:'SERVER_EVIDENCE_ONLY' as const,
    simulationOnly:true as const,
    actualPaperOrderCreated:false as const,
    actualPaperFillsRecorded:false as const,
    actualPaperLedgerWritten:false as const,
    realOrderSubmitted:false as const,
    executionAuthority:'NONE' as const,
    profitabilityProven:false as const,
    transferAuthority:false as const,
  };
  const blocked=(errors:readonly string[]):ManualPaperOrderPathResult=>Object.freeze({
    ...base,status:'BLOCKED' as const,blockers:Object.freeze([...new Set(errors)]),
    simulatedOrderId:null,requestedQuantity:null,
    simulatedEntryQuantity:0,simulatedExitQuantity:0,openQuantity:0,
    entryRemainderCanceled:false,entryMatchCount:0,exitMatchCount:0,
    hypotheticalNetPnlKrw:null,hypotheticalNewOperatingCapitalKrw:null,
    hypotheticalNewReserveKrw:null,hypotheticalHighWaterKrw:null,journal:null,
  });
  if(!input||!input.cycle||!Array.isArray(input.events)
    ||input.events.length>64
    ||typeof input.entryRemainderCanceled!=='boolean') {
    return blocked(['MANUAL_PAPER_ORDER_PATH_INPUT_INVALID']);
  }
  // The existing fail-closed checker is canonical for the owner, wallet,
  // verified prospective strategy, public as-of quotes and complete costs.
  const cycle=evaluateManualFourMarketPaperClosedCycle(input.cycle);
  if(cycle.status!=='RESEARCH_SIMULATED_CLOSED') {
    return blocked(cycle.blockers);
  }
  const {selected:s,verifiedOwner:o,entryQuote:e,exitQuote:x,costs:c}=input.cycle;
  const entryPrice=s.side==='SHORT'?e.bid:e.ask;
  const exitPrice=s.side==='SHORT'?x.ask:x.bid;
  const entryAction=s.side==='SHORT'?'SELL':'BUY';
  const exitAction=s.side==='SHORT'?'BUY':'SELL';
  const requestedQty=s.requestedNotionalKrw/(entryPrice*c.entryFxKrwPerQuote);
  if(!positive(requestedQty)||!Number.isFinite(requestedQty)
    ||requestedQty>Number.MAX_SAFE_INTEGER) {
    return blocked(['MANUAL_PAPER_ORDER_PATH_QUANTITY_INVALID']);
  }
  const orderId='manual-paper-order-sim-v1:'+sha([
    s.ownerId,s.accountId,o.currentEpochId,o.currentRoundNumber,s.candidateId,
    s.market,s.symbol,s.side,s.leverage,s.signalObservedAtMs,
  ].join('|'));
  const tolerance=Math.max(1e-9,requestedQty*1e-9);
  let entryQty=0;
  let exitQty=0;
  let exitStarted=false;
  let entryCount=0;
  let exitCount=0;
  let lastTs=0;
  const seen=new Set<string>();
  for(const event of input.events){
    if(!event||typeof event!=='object'
      ||!idPattern.test(event.eventId)
      ||seen.has(event.eventId)
      ||event.provenance!=='SERVER_PUBLIC_QUOTE_SIMULATION'
      ||(event.phase!=='ENTRY'&&event.phase!=='EXIT')
      ||!positive(event.quantity)
      ||event.quantity>Number.MAX_SAFE_INTEGER) {
      return blocked(['MANUAL_PAPER_ORDER_PATH_MATCH_INVALID_OR_DUPLICATE']);
    }
    seen.add(event.eventId);
    const isEntry=event.phase==='ENTRY';
    const quote=isEntry?e:x;
    if(event.action!==(isEntry?entryAction:exitAction)
      ||event.quoteSourceId!==quote.sourceId
      ||event.observedAtMs!==quote.observedAtMs
      ||event.observedAtMs<lastTs
      ||(isEntry&&exitStarted)
      ||(!isEntry&&entryQty<=0)) {
      return blocked(['MANUAL_PAPER_ORDER_PATH_SOURCE_SIDE_OR_TIME_MISMATCH']);
    }
    lastTs=event.observedAtMs;
    if(isEntry){
      entryQty+=event.quantity;
      entryCount++;
    }else{
      exitStarted=true;
      exitQty+=event.quantity;
      exitCount++;
    }
    if(!Number.isFinite(entryQty)||!Number.isFinite(exitQty)
      ||entryQty>requestedQty+tolerance||exitQty>entryQty+tolerance) {
      return blocked(['MANUAL_PAPER_ORDER_PATH_OVERFILL_OR_REDUCE_ONLY']);
    }
  }
  // No matched order can ever be reported as a real fill. Not even a
  // hypothetical realized profit is credited when an entry can still fill
  // later or a position remains open: wait for cancellation and flatness.
  const openQty=Math.max(0,entryQty-exitQty);
  const pendingEntry=requestedQty-entryQty>tolerance
    &&!input.entryRemainderCanceled;
  let status:Exclude<ManualPaperOrderPathStatus,'BLOCKED'>;
  if(entryQty===0){
    status=input.entryRemainderCanceled?'CANCELED_NO_FILL':'UNMATCHED';
  }else if(exitQty===0 || openQty>tolerance || pendingEntry){
    status=exitQty>0?'PARTIALLY_CLOSED_UNSETTLED':'OPEN_UNSETTLED';
  }else{
    status='SIMULATED_CLOSED';
  }
  const baseResult={
    ...base,status,blockers:Object.freeze([] as string[]),
    simulatedOrderId:orderId,requestedQuantity:requestedQty,
    simulatedEntryQuantity:entryQty,simulatedExitQuantity:exitQty,
    openQuantity:openQty,entryRemainderCanceled:input.entryRemainderCanceled,
    entryMatchCount:entryCount,exitMatchCount:exitCount,
  };
  const pending=()=>Object.freeze({
    ...baseResult,hypotheticalNetPnlKrw:null,
    hypotheticalNewOperatingCapitalKrw:null,
    hypotheticalNewReserveKrw:null,hypotheticalHighWaterKrw:null,journal:null,
  });
  if(status!=='SIMULATED_CLOSED')return pending();
  const matchedNotionalKrw=entryQty*entryPrice*c.entryFxKrwPerQuote;
  const exitNotionalKrw=exitQty*exitPrice*c.exitFxKrwPerQuote;
  const marginKrw=matchedNotionalKrw/s.leverage;
  const commissionKrw=matchedNotionalKrw*c.entryCommissionRate
    +exitNotionalKrw*c.exitCommissionRate;
  const allCostsKrw=commissionKrw+c.spreadAndSlippageKrw+c.taxKrw
    +c.signedFundingKrw;
  const direction=s.side==='SHORT'?-1:1;
  const grossKrw=s.market==='crypto_futures'
    ?direction*exitQty*(exitPrice-entryPrice)*c.exitFxKrwPerQuote
    :direction*(exitNotionalKrw-matchedNotionalKrw);
  const netKrw=grossKrw-allCostsKrw;
  const totalBefore=o.operatingCapitalKrw+o.lockedReserveKrw;
  const newProfit=Math.max(0,totalBefore+netKrw-o.highWaterMarkKrw);
  const newCompound=newProfit*0.5;
  const newReserve=newProfit*0.5;
  const nextOperating=o.operatingCapitalKrw+netKrw-newProfit+newCompound;
  const nextReserve=o.lockedReserveKrw+newReserve;
  const highWater=Math.max(o.highWaterMarkKrw,totalBefore+netKrw);
  if(![marginKrw,commissionKrw,allCostsKrw,grossKrw,netKrw,
    nextOperating,nextReserve,highWater].every(Number.isFinite)
    ||marginKrw+matchedNotionalKrw*c.entryCommissionRate
       +c.spreadAndSlippageKrw>o.operatingCapitalKrw+0.01
    ||nextOperating< -0.01
    ||(s.market==='crypto_futures'&&netKrw< -marginKrw-0.01)
    ||Math.abs(netKrw)>Number.MAX_SAFE_INTEGER) {
    return blocked(['MANUAL_PAPER_ORDER_PATH_SETTLEMENT_OR_LIQUIDATION_UNMODELLED']);
  }
  const journal=Object.freeze({
    schemaVersion:MANUAL_PAPER_ORDER_PATH_VERSION,
    id:orderId,ownerId:s.ownerId,role:s.role,mode:'manual' as const,
    accountId:s.accountId,market:s.market,epochId:o.currentEpochId,
    roundNumber:o.currentRoundNumber,candidateId:s.candidateId,
    strategyId:s.strategyId,symbol:s.symbol,side:s.side,leverage:s.leverage,
    entryAction,exitAction,
    entryQuoteSourceId:e.sourceId,exitQuoteSourceId:x.sourceId,
    matchEventIds:Object.freeze(input.events.map(event=>event.eventId)),
    simulatedEntryQuantity:entryQty,simulatedExitQuantity:exitQty,
    entryRemainderCanceled:input.entryRemainderCanceled,
    entryObservedAtMs:e.observedAtMs,exitObservedAtMs:x.observedAtMs,
    entryPrice,exitPrice,quoteCurrency:e.currency,
    costsSourceId:c.sourceId,entryFxSourceId:c.entryFxSourceId,
    exitFxSourceId:c.exitFxSourceId,
    priceMovementKrw:cents(direction*exitQty*(exitPrice-entryPrice)
      *c.entryFxKrwPerQuote),
    fxTranslationKrw:cents(s.market==='crypto_futures'
      ?direction*exitQty*(exitPrice-entryPrice)
        *(c.exitFxKrwPerQuote-c.entryFxKrwPerQuote)
      :direction*exitQty*exitPrice*(c.exitFxKrwPerQuote-c.entryFxKrwPerQuote)),
    grossPnlKrw:cents(grossKrw),commissionKrw:cents(commissionKrw),
    slippageKrw:cents(c.spreadAndSlippageKrw),taxKrw:cents(c.taxKrw),
    fundingCostKrw:cents(c.signedFundingKrw),
    netPnlKrw:cents(netKrw),
    newCompoundedProfitKrw:cents(newCompound),
    newReserveProfitKrw:cents(newReserve),
    nextHighWaterMarkKrw:cents(highWater),
    simulatedOnly:true,causalImpactProven:false,
    actualPaperOrderCreated:false,actualPaperFillsRecorded:false,
    actualPaperLedgerWritten:false,realOrderSubmitted:false,
    profitabilityProven:false,executionAuthority:'NONE' as const,
  });
  return Object.freeze({
    ...baseResult,hypotheticalNetPnlKrw:cents(netKrw),
    hypotheticalNewOperatingCapitalKrw:cents(Math.max(0,nextOperating)),
    hypotheticalNewReserveKrw:cents(nextReserve),
    hypotheticalHighWaterKrw:cents(highWater),journal,
  });
}


/**
 * Sequential, event-sourced four-market MANUAL PAPER simulation.
 *
 * Unlike the retrospective research-cycle preview, this is a one-event-at-a-
 * time order/partial-fill/exit projection. No future exit quote is needed when
 * opening. A saved public-quote simulation is NEVER a real broker fill, cannot
 * alter a protected wallet, and by itself is not an OOS/profitability PASS.
 *
 * All events must come from a trusted server adapter. An HTTP client is only
 * permitted to select an operation and an idempotency key.
 */
export const MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION =
  'manual-paper-sequential-events-v1' as const;
export type ManualPaperSequentialKind =
  'OPEN_ORDER'|'ENTRY_MATCH'|'CANCEL_ENTRY'|
  'REQUEST_EXIT'|'EXIT_MATCH'|'CANCEL_EXIT';
export type ManualPaperSequentialSession = Readonly<{
  ownerId:string;
  role:ManualWalletRole;
  market:AdminPaperMarket;
  walletId:string;
  epochId:string;
  roundNumber:number;
  symbol:string;
  strategyId:string;
  candidateId:string;
  strategyReceiptSha256:string;
  strategyValidatedAtMs:number;
  signalObservedAtMs:number;
  side:'BUY'|'LONG'|'SHORT';
  leverage:number;
  requestedNotionalKrw:number;
  operatingCapitalKrw:number;
  lockedReserveKrw:number;
  highWaterMarkKrw:number;
  initialWalletReadbackVerified:true;
  independentStrategyEvidenceVerified:true;
}>;
export type ManualPaperSequentialQuote = Readonly<{
  provenance:'SERVER_PUBLIC_QUOTE_SIMULATION';
  quoteSourceId:string;
  observedAtMs:number;
  currency:ManualPaperFourQuoteCurrency;
  bid:number;
  ask:number;
  fxKrwPerUnit:number;
  fxSourceId:string;
  fxObservedAtMs:number;
  feeKrw:number;
  taxKrw:number;
  slippageKrw:number;
  /** Funding is a signed KRW cost. Missing is never an assumed zero. */
  signedFundingKrw:number;
  /** For perpetuals this must be issued by a complete server funding source. */
  fundingCoverageVerified:boolean;
}>;
export type ManualPaperSequentialEvent=Readonly<{
  schemaVersion:typeof MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION;
  orderId:string;
  eventId:string;
  requestKey:string;
  sequence:number;
  ownerId:string;
  walletId:string;
  role:ManualWalletRole;
  market:AdminPaperMarket;
  kind:ManualPaperSequentialKind;
  observedAtMs:number;
  source:'SERVER_ISSUED_PAPER_EVENT';
  session?:ManualPaperSequentialSession;
  quantity?:number;
  quote?:ManualPaperSequentialQuote;
  executionAuthority:'NONE';
  actualBrokerFill:false;
  walletMutation:false;
  actualPaperLedgerWritten:false;
}>;
export type ManualPaperSequentialEventRow=Readonly<{
  user_id:string;
  wallet_id:string;
  order_id:string;
  event_id:string;
  request_key:string;
  sequence_number:number;
  market:AdminPaperMarket;
  owner_role:ManualWalletRole;
  event_sha256:string;
  event:ManualPaperSequentialEvent;
}>;
export type ManualPaperSequentialProjection=Readonly<{
  schemaVersion:typeof MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION;
  status:'EMPTY'|'ENTRY_PENDING'|'ENTRY_PARTIAL'|'OPEN'|
    'EXIT_PENDING'|'PARTIALLY_CLOSED'|'ENTRY_CANCELLED'|
    'CLOSED_PROJECTION'|'BLOCKED';
  blockers:readonly string[];
  orderId:string|null;
  market:AdminPaperMarket|null;
  processedEvents:number;
  entryQuantity:number;
  exitQuantity:number;
  openQuantity:number;
  entryRemainderCancelled:boolean;
  hypotheticalGrossPnlKrw:number|null;
  hypotheticalNetPnlKrw:number|null;
  hypotheticalOperatingCapitalKrw:number|null;
  hypotheticalLockedReserveKrw:number|null;
  hypotheticalHighWaterMarkKrw:number|null;
  journalProjection:Readonly<Record<string,unknown>>|null;
  dataProvenance:'SERVER_EVENTS_ONLY';
  executionAuthority:'NONE';
  actualBrokerFill:false;
  actualPaperLedgerWritten:false;
  actualWalletMutation:false;
  realOrderSubmitted:false;
  profitabilityProven:false;
}>;
const seqOrderPattern=/^manual-paper-seq-order-v1:[a-f0-9]{64}$/u;
const seqEventPattern=/^manual-paper-seq-event-v1:[a-f0-9]{64}$/u;
/** Stable across JS insertion order and PostgreSQL JSONB key normalization. */
function paperCanonicalJson(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(paperCanonicalJson).join(',')+']';
  if(value!==null&&typeof value==='object'){
    const v=value as Record<string,unknown>;
    return '{'+Object.keys(v).filter(key=>v[key]!==undefined).sort()
      .map(key=>JSON.stringify(key)+':'+paperCanonicalJson(v[key])).join(',')+'}';
  }
  return JSON.stringify(value)??'null';
}
function paperWithoutEventId(event:ManualPaperSequentialEvent) {
  const {eventId:_unused,...without}=event;
  return without;
}
const sha64=/^[a-f0-9]{64}$/u;
const validPositive=(v:unknown):v is number=>
  typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=Number.MAX_SAFE_INTEGER;
const validNonnegative=(v:unknown):v is number=>
  typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;
const validString=(v:unknown):v is string=>
  typeof v==='string'&&idPattern.test(v);
const seqTolerance=(qty:number)=>Math.max(1e-9,Math.abs(qty)*1e-9);
const currencyForManualMarket=(m:AdminPaperMarket)=>
  MARKET_CURRENCY[m];
export function manualPaperSequentialOrderId(session:ManualPaperSequentialSession):string {
  return 'manual-paper-seq-order-v1:'+sha([
    session.ownerId,session.walletId,session.epochId,session.roundNumber,
    session.market,session.symbol,session.strategyId,session.candidateId,
    session.side,session.leverage,session.requestedNotionalKrw,
    session.signalObservedAtMs,
  ].join('|'));
}
export function manualPaperSequentialEventId(
  input:Omit<ManualPaperSequentialEvent,'eventId'>,
):string {
  return 'manual-paper-seq-event-v1:'+sha(paperCanonicalJson(input));
}
export function manualPaperSequentialRow(event:ManualPaperSequentialEvent):
  ManualPaperSequentialEventRow {
  if(!seqOrderPattern.test(event.orderId)||!seqEventPattern.test(event.eventId)
    ||event.eventId!==manualPaperSequentialEventId(paperWithoutEventId(event))
    ||!Number.isSafeInteger(event.sequence)||event.sequence<1
    ||event.executionAuthority!=='NONE'||event.actualBrokerFill!==false
    ||event.walletMutation!==false||event.actualPaperLedgerWritten!==false) {
    throw new Error('MANUAL_PAPER_SEQUENTIAL_EVENT_IDENTITY_INVALID');
  }
  return Object.freeze({
    user_id:event.ownerId,wallet_id:event.walletId,
    order_id:event.orderId,event_id:event.eventId,
    request_key:event.requestKey,sequence_number:event.sequence,
    market:event.market,owner_role:event.role,
    event_sha256:sha(paperCanonicalJson(event)),event,
  });
}
export function sameManualPaperSequentialRow(
  expected:ManualPaperSequentialEventRow,existing:Record<string,unknown>,
):boolean {
  if(!existing||typeof existing!=='object')return false;
  for(const k of [
    'user_id','wallet_id','order_id','event_id','request_key',
    'sequence_number','market','owner_role','event_sha256',
  ] as const)if(existing[k]!==expected[k])return false;
  const actual=existing.event;
  return actual!==null&&typeof actual==='object'
    &&paperCanonicalJson(actual)===paperCanonicalJson(expected.event)
    &&sha(paperCanonicalJson(actual))===expected.event_sha256;
}
export function projectManualPaperSequentialEvents(
  events:readonly ManualPaperSequentialEvent[],nowMs:number,
):ManualPaperSequentialProjection {
  const base={
    schemaVersion:MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION,
    dataProvenance:'SERVER_EVENTS_ONLY' as const,
    executionAuthority:'NONE' as const,
    actualBrokerFill:false as const,
    actualPaperLedgerWritten:false as const,
    actualWalletMutation:false as const,
    realOrderSubmitted:false as const,
    profitabilityProven:false as const,
  };
  const blocked=(blockers:string[]):ManualPaperSequentialProjection=>Object.freeze({
    ...base,status:'BLOCKED' as const,blockers:Object.freeze([...new Set(blockers)]),
    orderId:null,market:null,processedEvents:0,entryQuantity:0,
    exitQuantity:0,openQuantity:0,entryRemainderCancelled:false,
    hypotheticalGrossPnlKrw:null,hypotheticalNetPnlKrw:null,
    hypotheticalOperatingCapitalKrw:null,hypotheticalLockedReserveKrw:null,
    hypotheticalHighWaterMarkKrw:null,journalProjection:null,
  });
  if(!Array.isArray(events)||events.length>1000||!Number.isSafeInteger(nowMs)
    ||nowMs<=0)return blocked(['MANUAL_PAPER_SEQ_INPUT_OR_CLOCK_INVALID']);
  if(events.length===0)return Object.freeze({
    ...base,status:'EMPTY' as const,blockers:Object.freeze([] as string[]),
    orderId:null,market:null,processedEvents:0,entryQuantity:0,
    exitQuantity:0,openQuantity:0,entryRemainderCancelled:false,
    hypotheticalGrossPnlKrw:null,hypotheticalNetPnlKrw:null,
    hypotheticalOperatingCapitalKrw:null,hypotheticalLockedReserveKrw:null,
    hypotheticalHighWaterMarkKrw:null,journalProjection:null,
  });
  const start=events[0],s=start?.session;
  if(!start||start.kind!=='OPEN_ORDER'||!s
    ||!validString(s.ownerId)||!validString(s.walletId)
    ||!validString(s.epochId)||!validString(s.symbol)
    ||!validString(s.strategyId)||!validString(s.candidateId)
    ||!ADMIN_FOUR_PAPER_MARKETS.includes(s.market)
    ||!['admin','member'].includes(s.role)
    ||s.walletId!==manualPaperWalletId(s.role,s.market)
    ||!Number.isSafeInteger(s.roundNumber)||s.roundNumber<1
    ||!sha64.test(s.strategyReceiptSha256)
    ||s.initialWalletReadbackVerified!==true
    ||s.independentStrategyEvidenceVerified!==true
    ||!Number.isSafeInteger(s.strategyValidatedAtMs)
    ||!Number.isSafeInteger(s.signalObservedAtMs)
    ||s.strategyValidatedAtMs>s.signalObservedAtMs
    ||s.signalObservedAtMs<=0||s.signalObservedAtMs>start.observedAtMs
    ||!validPositive(s.requestedNotionalKrw)
    ||s.requestedNotionalKrw<1_000
    ||!validPositive(s.operatingCapitalKrw)
    ||!validNonnegative(s.lockedReserveKrw)
    ||!validPositive(s.highWaterMarkKrw)
    ||s.highWaterMarkKrw+0.01<s.operatingCapitalKrw+s.lockedReserveKrw
    ||s.highWaterMarkKrw<1_000_000
    ||(s.market==='crypto_futures'
      ?(!['LONG','SHORT'].includes(s.side)
        ||!validateManualPaperFuturesLeverage(s.leverage))
      :(s.side!=='BUY'||s.leverage!==1))
    ||s.requestedNotionalKrw/s.leverage>s.operatingCapitalKrw+0.01
    ||start.orderId!==manualPaperSequentialOrderId(s)) {
    return blocked(['MANUAL_PAPER_SEQ_OWNER_STRATEGY_OR_CAPITAL_NOT_VERIFIED']);
  }
  const requestedNotional=s.requestedNotionalKrw;
  const toleranceKrw=Math.max(0.01,requestedNotional*1e-8);
  let entryQty=0,exitQty=0,entryKrw=0,entryNative=0,exitGrossKrw=0;
  let costsKrw=0,cancelEntry=false,exitStarted=false;
  let outstandingExit=0,exitRequestActive=false;
  let priorAt=0,finished=false,exitMatchCount=0;
  const knownEvents=new Set<string>();
  const knownRequests=new Set<string>();
  const matchIds:string[]=[];
  const expectedOrderId=start.orderId;
  const entryAction=s.side==='SHORT'?'SELL':'BUY';
  const exitAction=s.side==='SHORT'?'BUY':'SELL';
  const expectedCurrency=currencyForManualMarket(s.market);
  for(let i=0;i<events.length;i++){
    const e=events[i];
    if(!e||e.schemaVersion!==MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION
      ||e.source!=='SERVER_ISSUED_PAPER_EVENT'
      ||e.executionAuthority!=='NONE'||e.actualBrokerFill!==false
      ||e.walletMutation!==false||e.actualPaperLedgerWritten!==false
      ||e.ownerId!==s.ownerId||e.walletId!==s.walletId
      ||e.role!==s.role||e.market!==s.market
      ||e.orderId!==expectedOrderId
      ||!seqEventPattern.test(e.eventId)
      ||e.eventId!==manualPaperSequentialEventId(paperWithoutEventId(e))
      ||!validString(e.requestKey)
      ||knownRequests.has(e.requestKey)
      ||knownEvents.has(e.eventId)
      ||e.sequence!==i+1
      ||!Number.isSafeInteger(e.observedAtMs)||e.observedAtMs<=0
      ||e.observedAtMs>nowMs+5_000||e.observedAtMs<priorAt
      ||finished
      ||(i===0&&e.kind!=='OPEN_ORDER')
      ||(i>0&&e.kind==='OPEN_ORDER')) {
      return blocked(['MANUAL_PAPER_SEQ_EVENT_ORDER_OR_OWNER_INVALID']);
    }
    priorAt=e.observedAtMs;
    knownEvents.add(e.eventId);
    knownRequests.add(e.requestKey);
    if(i===0)continue;
    if(e.session!==undefined) return blocked(['MANUAL_PAPER_SEQ_REPLACEMENT_SESSION_FORBIDDEN']);
    const kind=e.kind;
    if(kind==='ENTRY_MATCH'||kind==='EXIT_MATCH'){
      const q=e.quote;
      if(!q||q.provenance!=='SERVER_PUBLIC_QUOTE_SIMULATION'
        ||!validString(q.quoteSourceId)||!validString(q.fxSourceId)
        ||q.currency!==expectedCurrency
        ||!validPositive(q.bid)||!validPositive(q.ask)||q.ask<q.bid
        ||!Number.isSafeInteger(q.observedAtMs)
        ||q.observedAtMs>e.observedAtMs
        ||e.observedAtMs-q.observedAtMs>60_000
        ||!Number.isSafeInteger(q.fxObservedAtMs)
        ||q.fxObservedAtMs>q.observedAtMs
        ||q.observedAtMs-q.fxObservedAtMs>(q.currency==='USD'?86_400_000:600_000)
        ||!validPositive(q.fxKrwPerUnit)
        ||(q.currency==='KRW'&&q.fxKrwPerUnit!==1)
        ||!validNonnegative(q.feeKrw)||!validNonnegative(q.taxKrw)
        ||!validNonnegative(q.slippageKrw)
        ||typeof q.signedFundingKrw!=='number'
        ||!Number.isFinite(q.signedFundingKrw)
        ||Math.abs(q.signedFundingKrw)>Number.MAX_SAFE_INTEGER
        ||!validPositive(e.quantity)
        ||(kind==='ENTRY_MATCH'&&q.signedFundingKrw!==0)
        ||(s.market!=='crypto_futures'&&q.signedFundingKrw!==0)
        ||(s.market==='crypto_futures'&&kind==='EXIT_MATCH'
          &&q.fundingCoverageVerified!==true)) {
        return blocked(['MANUAL_PAPER_SEQ_PUBLIC_COST_FX_OR_FILL_INVALID']);
      }
      if(kind==='ENTRY_MATCH'&&(cancelEntry||exitStarted)) {
        return blocked(['MANUAL_PAPER_SEQ_ENTRY_AFTER_CANCEL_OR_EXIT']);
      }
      if(kind==='EXIT_MATCH'&&(!exitRequestActive||entryQty<=0)) {
        return blocked(['MANUAL_PAPER_SEQ_EXIT_REQUIRES_REDUCE_ONLY_ORDER']);
      }
      const price=kind==='ENTRY_MATCH'
        ?(entryAction==='BUY'?q.ask:q.bid)
        :(exitAction==='BUY'?q.ask:q.bid);
      const notionalKrw=price*e.quantity*q.fxKrwPerUnit;
      const feeAndSlippage=q.feeKrw+q.taxKrw+q.slippageKrw;
      if(!Number.isFinite(notionalKrw)||!Number.isFinite(feeAndSlippage)
        ||notionalKrw>Number.MAX_SAFE_INTEGER
        ||feeAndSlippage>Number.MAX_SAFE_INTEGER)
        return blocked(['MANUAL_PAPER_SEQ_AMOUNT_OVERFLOW']);
      if(kind==='ENTRY_MATCH'){
        entryQty+=e.quantity;
        entryKrw+=notionalKrw;
        entryNative+=price*e.quantity;
        const pledged=entryKrw/s.leverage;
        if(![entryQty,entryKrw,entryNative,pledged].every(Number.isFinite)
          ||entryKrw>requestedNotional+toleranceKrw
          ||pledged+costsKrw+feeAndSlippage>s.operatingCapitalKrw+0.01){
          return blocked(['MANUAL_PAPER_SEQ_ENTRY_NOTIONAL_OR_MARGIN_EXCEEDED']);
        }
      }else{
        if(e.quantity>outstandingExit+seqTolerance(outstandingExit)
          ||e.quantity>entryQty-exitQty+seqTolerance(entryQty)) {
          return blocked(['MANUAL_PAPER_SEQ_REDUCE_ONLY_OVERFILL']);
        }
        const avgNative=entryNative/entryQty;
        const avgKrw=entryKrw/entryQty;
        exitGrossKrw+=s.market==='crypto_futures'
          ?(s.side==='SHORT'?-1:1)*e.quantity
            *(price-avgNative)*q.fxKrwPerUnit
          :e.quantity*(price*q.fxKrwPerUnit-avgKrw);
        exitQty+=e.quantity;
        outstandingExit=Math.max(0,outstandingExit-e.quantity);
        if(outstandingExit<=seqTolerance(entryQty)){
          outstandingExit=0;
          exitRequestActive=false;
        }
        exitMatchCount++;
      }
      costsKrw+=feeAndSlippage+q.signedFundingKrw;
      if(!Number.isFinite(costsKrw)||!Number.isFinite(exitGrossKrw))
        return blocked(['MANUAL_PAPER_SEQ_PROJECTION_OVERFLOW']);
      matchIds.push(e.eventId);
    }else if(kind==='CANCEL_ENTRY'){
      if(cancelEntry||exitStarted||entryKrw>=requestedNotional-toleranceKrw)
        return blocked(['MANUAL_PAPER_SEQ_ENTRY_CANCEL_NOT_PENDING']);
      cancelEntry=true;
    }else if(kind==='REQUEST_EXIT'){
      if(!validPositive(e.quantity)
        ||entryQty<=exitQty+seqTolerance(entryQty)
        ||exitRequestActive
        ||e.quantity>entryQty-exitQty+seqTolerance(entryQty))
        return blocked(['MANUAL_PAPER_SEQ_EXIT_REQUEST_EXCEEDS_POSITION']);
      outstandingExit=e.quantity;
      exitRequestActive=true;
      exitStarted=true;
    }else if(kind==='CANCEL_EXIT'){
      if(!exitRequestActive||outstandingExit<=0)
        return blocked(['MANUAL_PAPER_SEQ_EXIT_CANCEL_NOT_PENDING']);
      exitRequestActive=false;
      outstandingExit=0;
    }else{
      return blocked(['MANUAL_PAPER_SEQ_UNKNOWN_EVENT']);
    }
    const positionRemaining=entryQty-exitQty;
    if(positionRemaining< -seqTolerance(entryQty))
      return blocked(['MANUAL_PAPER_SEQ_NEGATIVE_POSITION']);
    const remainingEntry=entryKrw<requestedNotional-toleranceKrw&&!cancelEntry;
    if(entryQty>0&&positionRemaining<=seqTolerance(entryQty)
      &&!remainingEntry&&!exitRequestActive)finished=true;
  }
  const openQty=Math.max(0,entryQty-exitQty);
  const stillEntryPending=entryKrw<requestedNotional-toleranceKrw&&!cancelEntry;
  let status:ManualPaperSequentialProjection['status'];
  if(entryQty===0)status=cancelEntry?'ENTRY_CANCELLED':'ENTRY_PENDING';
  else if(finished)status='CLOSED_PROJECTION';
  else if(exitStarted)status=exitQty>0?'PARTIALLY_CLOSED':'EXIT_PENDING';
  else status=stillEntryPending?'ENTRY_PARTIAL':'OPEN';
  const safeProjection={
    ...base,status,blockers:Object.freeze([] as string[]),
    orderId:expectedOrderId,market:s.market,processedEvents:events.length,
    entryQuantity:entryQty,exitQuantity:exitQty,openQuantity:openQty,
    entryRemainderCancelled:cancelEntry,
  };
  if(status!=='CLOSED_PROJECTION')return Object.freeze({
    ...safeProjection,hypotheticalGrossPnlKrw:null,
    hypotheticalNetPnlKrw:null,hypotheticalOperatingCapitalKrw:null,
    hypotheticalLockedReserveKrw:null,hypotheticalHighWaterMarkKrw:null,
    journalProjection:null,
  });
  const netKrw=exitGrossKrw-costsKrw;
  const previousTotal=s.operatingCapitalKrw+s.lockedReserveKrw;
  const newAboveHigh=Math.max(0,previousTotal+netKrw-s.highWaterMarkKrw);
  const operating=s.operatingCapitalKrw+netKrw-newAboveHigh*0.5;
  const reserve=s.lockedReserveKrw+newAboveHigh*0.5;
  const highWater=Math.max(s.highWaterMarkKrw,previousTotal+netKrw);
  const pledgedEntryMargin=entryKrw/s.leverage;
  if(![netKrw,previousTotal,newAboveHigh,operating,reserve,highWater].every(Number.isFinite)
    ||Math.abs(netKrw)>Number.MAX_SAFE_INTEGER
    ||operating< -0.01
    ||(s.market==='crypto_futures'&&netKrw< -pledgedEntryMargin-0.01))
    return blocked(['MANUAL_PAPER_SEQ_SETTLEMENT_OR_LIQUIDATION_UNPROVEN']);
  const journalProjection=Object.freeze({
    schemaVersion:MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION,
    orderId:expectedOrderId,market:s.market,symbol:s.symbol,side:s.side,
    strategyId:s.strategyId,candidateId:s.candidateId,
    epochId:s.epochId,roundNumber:s.roundNumber,leverage:s.leverage,
    simulatedMatchIds:Object.freeze(matchIds),
    entryQuantity:entryQty,exitQuantity:exitQty,
    grossPnlKrw:cents(exitGrossKrw),knownCostsKrw:cents(costsKrw),
    netPnlKrw:cents(netKrw),
    hypotheticalOperatingCapitalKrw:cents(Math.max(0,operating)),
    hypotheticalLockedReserveKrw:cents(reserve),
    hypotheticalHighWaterMarkKrw:cents(highWater),
    source:'SERVER_PUBLIC_QUOTE_SIMULATION',
    actualBrokerFill:false,actualPaperLedgerWritten:false,
    realOrderSubmitted:false,profitabilityProven:false,
    executionAuthority:'NONE',
  });
  return Object.freeze({
    ...safeProjection,hypotheticalGrossPnlKrw:cents(exitGrossKrw),
    hypotheticalNetPnlKrw:cents(netKrw),
    hypotheticalOperatingCapitalKrw:cents(Math.max(0,operating)),
    hypotheticalLockedReserveKrw:cents(reserve),
    hypotheticalHighWaterMarkKrw:cents(highWater),
    journalProjection,
  });
}
