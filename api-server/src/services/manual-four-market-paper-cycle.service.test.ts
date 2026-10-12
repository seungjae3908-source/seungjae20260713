import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateManualFourMarketPaperClosedCycle,
  evaluateManualFourMarketPaperOrderPath,
  MANUAL_PAPER_ORDER_PATH_VERSION,
  MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION,
  manualPaperSequentialOrderId,
  manualPaperSequentialEventId,
  manualPaperSequentialRow,
  sameManualPaperSequentialRow,
  projectManualPaperSequentialEvents,
  type ManualPaperSequentialEvent,
  type ManualPaperSequentialSession,
  type ManualPaperSequentialQuote,
  type ManualPaperOrderPathInput,
  type ManualPaperSimulatedMatch,
  buildManualPaperResearchReceipt,
  sameManualPaperResearchReceipt,
  MANUAL_PAPER_RESEARCH_RECEIPT_VERSION,
  type ManualPaperFourMarketCycleInput,
} from './manual-four-market-paper-cycle.service';
import type {AdminPaperMarket} from './admin-four-market-paper-capital.service';
import {manualPaperWalletId} from './manual-four-market-paper-wallets.service';

const NOW=Date.parse('2026-10-11T04:00:00.000Z');
const OWNER='11111111-1111-1111-1111-111111111111';
const symbols:Record<AdminPaperMarket,string>={
  domestic_stock:'005930',us_stock:'AAPL',crypto_spot:'KRW-BTC',
  crypto_futures:'BTCUSDT',
};
const currency:Record<AdminPaperMarket,'KRW'|'USD'|'USDT'>={
  domestic_stock:'KRW',us_stock:'USD',crypto_spot:'KRW',crypto_futures:'USDT',
};
function fixture(market:AdminPaperMarket='crypto_futures',
  changes:Partial<ManualPaperFourMarketCycleInput>={}):ManualPaperFourMarketCycleInput {
  const acc=manualPaperWalletId('member',market);
  return {
    selected:{
      ownerId:OWNER,role:'member',mode:'manual',accountId:acc,market,
      symbol:symbols[market],strategyId:'user-selected-strategy',
      candidateId:'validated-research-candidate-01',
      signalObservedAtMs:NOW-45_000,
      side:market==='crypto_futures'?'LONG':'BUY',
      leverage:market==='crypto_futures'?7:1,
      requestedNotionalKrw:200_000,
    },
    verifiedOwner:{
      ownerId:OWNER,accountId:acc,market,
      strategyId:'user-selected-strategy',
      strategyCandidateId:'validated-research-candidate-01',
      strategyValidatedAtMs:NOW-120_000,
      strategySourceId:'canonical-owner-evidence',
      walletReadbackReady:true,ownerRlsReady:true,
      initialCapitalKrw:1_000_000,currentRoundNumber:1,
      currentEpochId:'manual-v1-epoch-one',
      operatingCapitalKrw:1_000_000,lockedReserveKrw:0,
      highWaterMarkKrw:1_000_000,
      fullyReconciledFlatPosition:true,priorCloseEventIds:[],
    },
    entryQuote:{
      sourceId:'public-entry-snapshot-1',market,symbol:symbols[market],
      currency:currency[market],observedAtMs:NOW-40_000,bid:99,ask:100,
      provenance:'SERVER_PUBLIC_MARKET_READBACK',closedCandleConfirmed:true,
    },
    exitQuote:{
      sourceId:'public-exit-snapshot-2',market,symbol:symbols[market],
      currency:currency[market],observedAtMs:NOW-20_000,bid:108,ask:109,
      provenance:'SERVER_PUBLIC_MARKET_READBACK',closedCandleConfirmed:true,
    },
    costs:{
      sourceId:'public-cost-snapshot-1',status:'SERVER_COST_EVIDENCE_READY',
      observedAtMs:NOW-15_000,
      entryCommissionRate:0.001,exitCommissionRate:0.001,
      spreadAndSlippageKrw:100,taxKrw:0,signedFundingKrw:0,
      entryFxKrwPerQuote:market==='domestic_stock'||market==='crypto_spot'?1:1400,
      exitFxKrwPerQuote:market==='domestic_stock'||market==='crypto_spot'?1:1400,
      entryFxSourceId:'public-fx-entry-1',entryFxObservedAtMs:NOW-40_000,
      exitFxSourceId:'public-fx-exit-2',exitFxObservedAtMs:NOW-20_000,
    },nowMs:NOW,
    ...changes,
  };
}
const change=(input:ManualPaperFourMarketCycleInput,
  section:'selected'|'verifiedOwner'|'entryQuote'|'exitQuote'|'costs',
  patch:Record<string,unknown>):ManualPaperFourMarketCycleInput=>({
    ...input,[section]:{...input[section],...patch},
  });
const blocks=(input:ManualPaperFourMarketCycleInput,code:string)=>{
  const r=evaluateManualFourMarketPaperClosedCycle(input);
  assert.equal(r.status,'BLOCKED',JSON.stringify(r));
  assert.ok(r.blockers.includes(code),JSON.stringify(r.blockers));
  assert.equal(r.liveOrderSubmitted,false);
  assert.equal(r.exchangeRequestSent,false);
  assert.equal(r.actualPaperLedgerWritten,false);
};
test('all four manual Paper markets calculate price and costs separately without real order authority',()=>{
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const){
    const a=evaluateManualFourMarketPaperClosedCycle(fixture(market));
    assert.equal(a.status,'RESEARCH_SIMULATED_CLOSED',JSON.stringify(a.blockers));
    assert.equal(a.netPnlKrw!>0,true);
    assert.equal(a.updatedLockedReserveKrw,a.newReserveProfitKrw);
    assert.equal(a.newCompoundedProfitKrw,a.newReserveProfitKrw);
    assert.equal(a.updatedOperatingCapitalKrw,1_000_000+a.newCompoundedProfitKrw!);
    assert.equal(a.executionAuthority,'NONE');
    assert.equal(a.actualPaperLedgerWritten,false);
    assert.equal(a.oosProfitabilityProven,false);
    assert.equal(a.journal?.market,market);
    assert.equal(a.journal?.symbol,symbols[market]);
  }
});
test('KR stocks, US stocks and spot cannot short or increase leverage',()=>{
  for(const market of ['domestic_stock','us_stock','crypto_spot'] as const){
    blocks(change(fixture(market),'selected',{side:'SHORT'}),'PAPER_CYCLE_NONFUTURES_LONG_ONLY');
    blocks(change(fixture(market),'selected',{leverage:3}),'PAPER_CYCLE_NONFUTURES_LONG_ONLY');
  }
});
test('manual crypto futures accepts 1 through 125 isolated hypothetical multipliers but rejects outside',()=>{
  for(const lev of [1,2,7,75,125]){
    const r=evaluateManualFourMarketPaperClosedCycle(change(fixture(),'selected',{
      leverage:lev,
    }));
    assert.equal(r.status,'RESEARCH_SIMULATED_CLOSED',`lev=${lev} ${r.blockers}`);
  }
  for(const lev of [0,126,0.5,7.7]){
    blocks(change(fixture(),'selected',{leverage:lev}),'PAPER_CYCLE_FUTURES_POLICY_INVALID');
  }
  assert.equal(evaluateManualFourMarketPaperClosedCycle(
    change(fixture(),'selected',{side:'SHORT'})
  ).status,'RESEARCH_SIMULATED_CLOSED');
});
test('quote source/owner/mode/candidate mismatches, forged wallet or absent RLS fail closed',()=>{
  blocks(change(fixture(),'selected',{accountId:'automatic-paper-member-v2:crypto_futures'}),
    'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'selected',{mode:'automatic'}),'PAPER_CYCLE_IDENTITY_INVALID');
  blocks(change(fixture(),'selected',{ownerId:'other-user'}),'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'verifiedOwner',{strategyCandidateId:'other'}),
    'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'selected',{strategyId:'forged-strategy'}),
    'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'verifiedOwner',{strategyId:'unrelated-strategy'}),
    'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'verifiedOwner',{walletReadbackReady:false}),
    'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'verifiedOwner',{ownerRlsReady:false}),
    'PAPER_CYCLE_OWNER_OR_STRATEGY_PROOF_REQUIRED');
  blocks(change(fixture(),'entryQuote',{symbol:'ETHUSDT'}),'PAPER_CYCLE_PUBLIC_QUOTE_INVALID');
  blocks(change(fixture(),'entryQuote',{provenance:'CLIENT_PRICE'}),
    'PAPER_CYCLE_PUBLIC_QUOTE_INVALID');
  blocks(change(fixture(),'entryQuote',{closedCandleConfirmed:false}),
    'PAPER_CYCLE_PUBLIC_QUOTE_INVALID');
});
test('entry must follow selected signal, exit after entry, and FX/cost cannot come from future',()=>{
  blocks(change(fixture(),'entryQuote',{observedAtMs:NOW-60_000}),
    'PAPER_CYCLE_UNVERIFIED_OR_FUTURE_TIMELINE');
  blocks(change(fixture(),'entryQuote',{observedAtMs:NOW-100_000}),
    'PAPER_CYCLE_UNVERIFIED_OR_FUTURE_TIMELINE');
  blocks(change(fixture(),'exitQuote',{observedAtMs:NOW-41_000}),
    'PAPER_CYCLE_UNVERIFIED_OR_FUTURE_TIMELINE');
  blocks(change(fixture(),'exitQuote',{observedAtMs:NOW+1}),
    'PAPER_CYCLE_PUBLIC_QUOTE_INVALID');
  blocks(change(fixture(),'exitQuote',{sourceId:'public-entry-snapshot-1'}),
    'PAPER_CYCLE_UNVERIFIED_OR_FUTURE_TIMELINE');
  blocks(change(fixture(),'costs',{observedAtMs:NOW-25_000}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture(),'costs',{entryFxObservedAtMs:NOW-15_000}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture(),'costs',{exitFxObservedAtMs:NOW+1}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture(),'costs',{entryFxObservedAtMs:NOW-150_000}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture(),'verifiedOwner',{strategyValidatedAtMs:NOW-30_000}),
    'PAPER_CYCLE_LOOKAHEAD_OR_STRATEGY_NOT_VALIDATED');
});
test('no unknown costs, fake KRW FX, unverified currency or nonfutures funding allowed',()=>{
  blocks(change(fixture(),'costs',{status:'UNVERIFIED'}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture(),'costs',{entryCommissionRate:NaN}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture(),'costs',{entryCommissionRate:-0.1}),
    'PAPER_CYCLE_COST_FX_EVIDENCE_UNVERIFIED');
  blocks(change(fixture('us_stock'),'entryQuote',{currency:'KRW'}),
    'PAPER_CYCLE_PUBLIC_QUOTE_INVALID');
  blocks(change(fixture('crypto_spot'),'costs',{entryFxKrwPerQuote:1400}),
    'PAPER_CYCLE_KRW_FX_MUST_EQUAL_ONE');
  blocks(change(fixture('domestic_stock'),'costs',{signedFundingKrw:100}),
    'PAPER_CYCLE_NONFUTURES_FUNDING_FORBIDDEN');
});
test('isolated margin insufficiency, leverage-fueled modeled liquidation and stale capital are not paper profits',()=>{
  blocks(change(fixture(),'verifiedOwner',{operatingCapitalKrw:1_000}),
    'PAPER_CYCLE_INSUFFICIENT_OPERATING_CAPITAL');
  blocks(change(fixture(),'verifiedOwner',{operatingCapitalKrw:0}),
    'PAPER_CYCLE_INSUFFICIENT_OPERATING_CAPITAL');
  blocks(change(fixture(),'verifiedOwner',{fullyReconciledFlatPosition:false}),
    'PAPER_CYCLE_CAPITAL_OR_SETTLEMENT_UNKNOWN');
  blocks(change(fixture(),'verifiedOwner',{highWaterMarkKrw:900_000}),
    'PAPER_CYCLE_INVALID_HIGH_WATER_PROOF');
  const liquidation=change(fixture(),'exitQuote',{bid:1,ask:2});
  blocks(liquidation,'PAPER_CYCLE_UNMODELLED_ISOLATED_LIQUIDATION');
});
test('entry fees and slippage require spendable margin even if leverage notional itself is in range',()=>{
  const s=fixture('crypto_spot');
  blocks(change(s,'selected',{requestedNotionalKrw:1_000_000}),
    'PAPER_CYCLE_ENTRY_COSTS_EXCEED_AVAILABLE_CAPITAL');
  const futures=fixture('crypto_futures');
  blocks(change(futures,'selected',{requestedNotionalKrw:7_000_000}),
    'PAPER_CYCLE_ENTRY_COSTS_EXCEED_AVAILABLE_CAPITAL');
});
test('unknown or duplicated journal identities cannot be used as verified prior trades',()=>{
  const s=fixture();
  blocks(change(s,'verifiedOwner',{priorCloseEventIds:[null]}),
    'PAPER_CYCLE_LEDGER_DUPLICATE');
  blocks(change(s,'verifiedOwner',{priorCloseEventIds:['fake-close-id']}),
    'PAPER_CYCLE_LEDGER_DUPLICATE');
  const good=evaluateManualFourMarketPaperClosedCycle(s);
  blocks(change(s,'verifiedOwner',{priorCloseEventIds:[good.closedCycleId,good.closedCycleId]}),
    'PAPER_CYCLE_LEDGER_DUPLICATE');
});

test('costs and FX can turn a gross profit into loss, without hallucinated news or CVD cause',()=>{
  const entry=fixture('us_stock');
  const costed=change(entry,'costs',{
    spreadAndSlippageKrw:30_000,
  });
  const r=evaluateManualFourMarketPaperClosedCycle(costed);
  assert.equal(r.status,'RESEARCH_SIMULATED_CLOSED',JSON.stringify(r.blockers));
  assert.ok(r.grossPnlKrw!>0);
  assert.ok(r.netPnlKrw!<0);
  assert.equal(r.newCompoundedProfitKrw,0);
  assert.equal(r.newReserveProfitKrw,0);
  assert.equal(r.actualPaperLedgerWritten,false);
  assert.equal(r.journal?.causalImpactProven,false);
});
test('repeat of same closed signal and epoch cannot mint a second paper event even with new quote IDs',()=>{
  const initial=fixture();
  const first=evaluateManualFourMarketPaperClosedCycle(initial);
  assert.equal(first.status,'RESEARCH_SIMULATED_CLOSED');
  const withPrior=change(initial,'verifiedOwner',{
    priorCloseEventIds:[first.closedCycleId],
  });
  blocks(withPrior,'PAPER_CYCLE_ALREADY_CLOSED');
  const withChangedPrice=change(withPrior,'exitQuote',{
    sourceId:'public-exit-snapshot-revision',bid:109,ask:110,
  });
  blocks(withChangedPrice,'PAPER_CYCLE_ALREADY_CLOSED');
});
test('loss recovered before 50/50 compounding; locked reserve never subsidizes fresh paper margin',()=>{
  const first=fixture();
  const prior=change(first,'verifiedOwner',{
    operatingCapitalKrw:900_000,lockedReserveKrw:20_000,
    highWaterMarkKrw:1_000_000,
  });
  const moderate=evaluateManualFourMarketPaperClosedCycle(prior);
  assert.equal(moderate.status,'RESEARCH_SIMULATED_CLOSED');
  assert.equal(moderate.newCompoundedProfitKrw,0);
  assert.equal(moderate.newReserveProfitKrw,0);
  assert.equal(moderate.updatedLockedReserveKrw,20_000);
  const overMargin=change(prior,'selected',{
    requestedNotionalKrw:6_400_000,leverage:7,
  });
  blocks(overMargin,'PAPER_CYCLE_INSUFFICIENT_OPERATING_CAPITAL');
});

test('manual Paper journal separates entry-price and as-of FX effects without claiming signal causality',()=>{
  const f=fixture('us_stock');
  const receipt=evaluateManualFourMarketPaperClosedCycle(change(f,'costs',{
    exitFxKrwPerQuote:1450,
  }));
  assert.equal(receipt.status,'RESEARCH_SIMULATED_CLOSED',String(receipt.blockers));
  const price=Number(receipt.journal?.priceMovementKrw);
  const fx=Number(receipt.journal?.fxTranslationKrw);
  assert.ok(price>0);
  assert.ok(fx>0);
  assert.ok(Math.abs(price+fx-receipt.grossPnlKrw!)<=0.02);
  assert.equal(receipt.journal?.pnlAttributionBasis,'PRICE_FX_COST_ARITHMETIC_ONLY');
  assert.equal(receipt.journal?.causalImpactProven,false);
  assert.equal(receipt.actualPaperLedgerWritten,false);
});

test('USDT-margined futures cannot earn KRW profit from FX alone at unchanged native price',()=>{
  for(const side of ['LONG','SHORT'] as const){
    const base=change(fixture('crypto_futures'),'selected',{side});
    const zeroPrice=side==='LONG'?100:99;
    const neutral=change(base,'exitQuote',{bid:zeroPrice,ask:zeroPrice});
    const fx=change(neutral,'costs',{
      entryCommissionRate:0,exitCommissionRate:0,
      spreadAndSlippageKrw:0,taxKrw:0,signedFundingKrw:0,
      exitFxKrwPerQuote:1500,
    });
    const result=evaluateManualFourMarketPaperClosedCycle(fx);
    assert.equal(result.status,'RESEARCH_SIMULATED_CLOSED',JSON.stringify(result.blockers));
    assert.equal(result.grossPnlKrw,0);
    assert.equal(result.netPnlKrw,0);
    assert.equal(result.journal?.priceMovementKrw,0);
    assert.equal(result.journal?.fxTranslationKrw,0);
    assert.equal(result.newReserveProfitKrw,0);
  }
});
test('futures translates only native variation while cash USD stock retains principal FX exposure',()=>{
  const f=change(fixture('crypto_futures'),'costs',{exitFxKrwPerQuote:1500});
  const result=evaluateManualFourMarketPaperClosedCycle(f);
  assert.equal(result.status,'RESEARCH_SIMULATED_CLOSED',JSON.stringify(result.blockers));
  const nativePnL=result.quantity!*(108-100);
  assert.ok(Math.abs(result.grossPnlKrw!-nativePnL*1500)<0.02);
  assert.ok(Math.abs(Number(result.journal?.priceMovementKrw)
    +Number(result.journal?.fxTranslationKrw)-result.grossPnlKrw!)<=0.02);
  const cash=change(fixture('us_stock'),'exitQuote',{bid:100,ask:100});
  const changed=change(cash,'costs',{exitFxKrwPerQuote:1500});
  const cashResult=evaluateManualFourMarketPaperClosedCycle(changed);
  assert.equal(cashResult.status,'RESEARCH_SIMULATED_CLOSED');
  assert.ok(cashResult.grossPnlKrw!>0,'USD cash principal retains genuine FX translation');
});
test('50/50 high-water advances only on wins and never credits reserve on later losses',()=>{
  const first=evaluateManualFourMarketPaperClosedCycle(fixture('domestic_stock'));
  assert.equal(first.status,'RESEARCH_SIMULATED_CLOSED',JSON.stringify(first.blockers));
  assert.ok(first.newReserveProfitKrw!>0);
  assert.equal(first.updatedHighWaterMarkKrw,
    Math.round((1_000_000+first.netPnlKrw!)*100)/100);
  const second=change(fixture('domestic_stock'),'verifiedOwner',{
    operatingCapitalKrw:first.updatedOperatingCapitalKrw,
    lockedReserveKrw:first.updatedLockedReserveKrw,
    highWaterMarkKrw:first.updatedHighWaterMarkKrw,
    currentRoundNumber:2,currentEpochId:'manual-v1-second',
  });
  const loss=evaluateManualFourMarketPaperClosedCycle(
    change(second,'exitQuote',{bid:95,ask:95}));
  assert.equal(loss.status,'RESEARCH_SIMULATED_CLOSED',JSON.stringify(loss.blockers));
  assert.ok(loss.netPnlKrw!<0);
  assert.equal(loss.newReserveProfitKrw,0);
  assert.equal(loss.newCompoundedProfitKrw,0);
  assert.equal(loss.updatedHighWaterMarkKrw,first.updatedHighWaterMarkKrw);
  assert.equal(loss.updatedLockedReserveKrw,first.updatedLockedReserveKrw);
});


test('four-market manual closed research receipts pin owner, strategy, epoch and source evidence',()=>{
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const){
    const input=fixture(market);
    const calculation=evaluateManualFourMarketPaperClosedCycle(input);
    assert.equal(calculation.status,'RESEARCH_SIMULATED_CLOSED');
    const receipt=buildManualPaperResearchReceipt(input,calculation);
    assert.equal(receipt.receipt.schemaVersion,MANUAL_PAPER_RESEARCH_RECEIPT_VERSION);
    assert.equal(receipt.receipt.executionAuthority,'NONE');
    assert.equal(receipt.receipt.actualPaperLedgerWritten,false);
    assert.equal(receipt.receipt.realOrderSubmitted,false);
    assert.equal(receipt.receipt.profitabilityProven,false);
    assert.equal(receipt.receipt.financialMutationCount,0);
    assert.equal(receipt.receipt.walletId,manualPaperWalletId('member',market));
    assert.equal(receipt.receipt.market,market);
    assert.equal(receipt.receipt.hypotheticalNetPnlKrw,calculation.netPnlKrw);
    assert.match(receipt.cycle_id,/^paper-manual-cycle-v1:[a-f0-9]{64}$/);
    assert.match(receipt.receipt_sha256,/^[a-f0-9]{64}$/);
    const stored=structuredClone(receipt) as unknown as Record<string,unknown>;
    assert.ok(sameManualPaperResearchReceipt(receipt,stored));
    assert.equal(calculation.actualPaperLedgerWritten,false);
  }
});
test('manual research receipt collision on revised quote or FX cannot produce another profit credit',()=>{
  const first=fixture('crypto_futures');
  const base=buildManualPaperResearchReceipt(first,evaluateManualFourMarketPaperClosedCycle(first));
  const revised=change(first,'exitQuote',{bid:109,ask:110,sourceId:'server-revision'});
  const different=buildManualPaperResearchReceipt(
    revised,evaluateManualFourMarketPaperClosedCycle(revised));
  assert.equal(base.cycle_id,different.cycle_id,'decision identity stays fixed');
  assert.notEqual(base.receipt_sha256,different.receipt_sha256,
    'economic evidence revisions must never be silently idempotent');
  assert.equal(sameManualPaperResearchReceipt(base,
    structuredClone(different) as unknown as Record<string,unknown>),false);
  const altered={...base,receipt_sha256:'0'.repeat(64)};
  assert.equal(sameManualPaperResearchReceipt(base,altered),false);
});
test('manual research receipt refuses blocker and foreign-owner calculations',()=>{
  const good=fixture();
  const blocked=evaluateManualFourMarketPaperClosedCycle(
    change(good,'verifiedOwner',{ownerRlsReady:false}));
  assert.equal(blocked.status,'BLOCKED');
  assert.throws(()=>buildManualPaperResearchReceipt(good,blocked),
    /MANUAL_PAPER_RESEARCH_RECEIPT_INVALID_EVIDENCE/);
  const other=change(good,'selected',{ownerId:'22222222-2222-2222-2222-222222222222'});
  const mismatched=evaluateManualFourMarketPaperClosedCycle(other);
  assert.equal(mismatched.status,'BLOCKED');
  assert.throws(()=>buildManualPaperResearchReceipt(other,mismatched),
    /MANUAL_PAPER_RESEARCH_RECEIPT_INVALID_EVIDENCE/);
});


function orderPath(market:AdminPaperMarket='crypto_futures',
  edits:Partial<ManualPaperOrderPathInput>={}):ManualPaperOrderPathInput {
  const cycle=fixture(market);
  const side=cycle.selected.side;
  const entryAction=side==='SHORT'?'SELL':'BUY';
  const exitAction=side==='SHORT'?'BUY':'SELL';
  const price=side==='SHORT'?cycle.entryQuote.bid:cycle.entryQuote.ask;
  const qty=cycle.selected.requestedNotionalKrw
    /(price*cycle.costs.entryFxKrwPerQuote);
  const events:ManualPaperSimulatedMatch[]=[
    {eventId:'entry-a',phase:'ENTRY',action:entryAction,
      quoteSourceId:cycle.entryQuote.sourceId,
      observedAtMs:cycle.entryQuote.observedAtMs,
      quantity:qty*0.6,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
    {eventId:'entry-b',phase:'ENTRY',action:entryAction,
      quoteSourceId:cycle.entryQuote.sourceId,
      observedAtMs:cycle.entryQuote.observedAtMs,
      quantity:qty*0.4,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
    {eventId:'exit-a',phase:'EXIT',action:exitAction,
      quoteSourceId:cycle.exitQuote.sourceId,
      observedAtMs:cycle.exitQuote.observedAtMs,
      quantity:qty*0.4,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
    {eventId:'exit-b',phase:'EXIT',action:exitAction,
      quoteSourceId:cycle.exitQuote.sourceId,
      observedAtMs:cycle.exitQuote.observedAtMs,
      quantity:qty*0.6,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
  ];
  return {cycle,events,entryRemainderCanceled:false,...edits};
}
test('all 4 markets replay staged simulated entry partial-match close with matching economic proof',()=>{
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const){
    const input=orderPath(market);
    const result=evaluateManualFourMarketPaperOrderPath(input);
    assert.equal(result.status,'SIMULATED_CLOSED',JSON.stringify(result.blockers));
    assert.equal(result.schemaVersion,MANUAL_PAPER_ORDER_PATH_VERSION);
    assert.equal(result.entryMatchCount,2);
    assert.equal(result.exitMatchCount,2);
    assert.ok(Math.abs(result.simulatedEntryQuantity-result.simulatedExitQuantity)<1e-8);
    assert.equal(result.openQuantity,0);
    const original=evaluateManualFourMarketPaperClosedCycle(input.cycle);
    assert.equal(original.status,'RESEARCH_SIMULATED_CLOSED');
    assert.ok(Math.abs(result.hypotheticalNetPnlKrw!-original.netPnlKrw!)<=0.02);
    assert.equal(result.hypotheticalNewReserveKrw,original.updatedLockedReserveKrw);
    assert.equal(result.hypotheticalHighWaterKrw,original.updatedHighWaterMarkKrw);
    assert.equal(result.actualPaperOrderCreated,false);
    assert.equal(result.actualPaperFillsRecorded,false);
    assert.equal(result.actualPaperLedgerWritten,false);
    assert.equal(result.realOrderSubmitted,false);
    assert.equal(result.profitabilityProven,false);
    assert.equal(result.executionAuthority,'NONE');
    assert.equal(result.journal?.simulatedOnly,true);
    assert.equal(result.journal?.market,market);
    assert.equal(result.journal?.causalImpactProven,false);
  }
});
test('SHORT isolated simulated futures use SELL entries and BUY reducing closes',()=>{
  const input=orderPath('crypto_futures');
  const cycle=change(input.cycle,'selected',{side:'SHORT'});
  // Short entry uses bid=99 rather than long ask=100. Re-size all
  // server-simulated matches to the short's exact selected notional.
  const shortRatio=input.cycle.entryQuote.ask/input.cycle.entryQuote.bid;
  const events=input.events.map(event=>({
    ...event,quantity:event.quantity*shortRatio,
    action:event.phase==='ENTRY'?'SELL' as const:'BUY' as const,
  }));
  const result=evaluateManualFourMarketPaperOrderPath({...input,cycle,events});
  assert.equal(result.status,'SIMULATED_CLOSED',JSON.stringify(result.blockers));
  assert.ok(result.hypotheticalNetPnlKrw!<0);
  assert.equal(result.journal?.entryAction,'SELL');
  assert.equal(result.journal?.exitAction,'BUY');
  assert.equal(result.hypotheticalNewReserveKrw,0);
  const stock=orderPath('domestic_stock');
  const bad=evaluateManualFourMarketPaperOrderPath({...stock,
    cycle:change(stock.cycle,'selected',{side:'SHORT'})});
  assert.equal(bad.status,'BLOCKED');
  assert.ok(bad.blockers.includes('PAPER_CYCLE_NONFUTURES_LONG_ONLY'));
});
test('simulated partial entry and partial close never claim settled profit or cash',()=>{
  const input=orderPath();
  for(const events of [
    [],input.events.slice(0,1),
    [input.events[0],input.events[2]],
  ]){
    const result=evaluateManualFourMarketPaperOrderPath({
      ...input,events,entryRemainderCanceled:false,
    });
    assert.ok(['UNMATCHED','OPEN_UNSETTLED','PARTIALLY_CLOSED_UNSETTLED']
      .includes(result.status));
    assert.equal(result.hypotheticalNetPnlKrw,null);
    assert.equal(result.hypotheticalNewReserveKrw,null);
    assert.equal(result.journal,null);
    assert.equal(result.actualPaperLedgerWritten,false);
  }
  const cancelled=evaluateManualFourMarketPaperOrderPath({
    ...input,events:[],entryRemainderCanceled:true,
  });
  assert.equal(cancelled.status,'CANCELED_NO_FILL');
  assert.equal(cancelled.simulatedEntryQuantity,0);
  assert.equal(cancelled.hypotheticalNetPnlKrw,null);
});
test('partial entry can close only after simulated cancellation of unmatched remainder',()=>{
  const input=orderPath('crypto_spot');
  const qty=input.events[0].quantity;
  const matchingClose={...input.events[2],quantity:qty};
  const open=evaluateManualFourMarketPaperOrderPath({
    ...input,events:[input.events[0],matchingClose],
    entryRemainderCanceled:false,
  });
  assert.equal(open.status,'PARTIALLY_CLOSED_UNSETTLED');
  assert.equal(open.hypotheticalNetPnlKrw,null);
  const settled=evaluateManualFourMarketPaperOrderPath({
    ...input,events:[input.events[0],matchingClose],
    entryRemainderCanceled:true,
  });
  assert.equal(settled.status,'SIMULATED_CLOSED',JSON.stringify(settled.blockers));
  assert.ok(settled.simulatedEntryQuantity<settled.requestedQuantity!);
  assert.equal(settled.entryRemainderCanceled,true);
  assert.ok(settled.hypotheticalNetPnlKrw!==null);
  assert.equal(settled.actualPaperFillsRecorded,false);
});
test('duplicate, excess entry and reduce-only overclose refuse simulation settlement',()=>{
  const input=orderPath();
  const corrupt=[
    [input.events[0],{...input.events[0]}],
    [{...input.events[0],quantity:input.events[0].quantity*100}],
    [input.events[0],{...input.events[2],quantity:input.events[0].quantity*2}],
  ];
  for(const events of corrupt){
    const result=evaluateManualFourMarketPaperOrderPath({...input,events});
    assert.equal(result.status,'BLOCKED',JSON.stringify(result.blockers));
    assert.equal(result.hypotheticalNetPnlKrw,null);
  }
  const duplicate=evaluateManualFourMarketPaperOrderPath({
    ...input,events:[input.events[0],{...input.events[0]}],
  });
  assert.ok(duplicate.blockers.includes('MANUAL_PAPER_ORDER_PATH_MATCH_INVALID_OR_DUPLICATE'));
});
test('source, side, time, provenance and out-of-order matches fail closed',()=>{
  const input=orderPath();
  const modifications=[
    {eventId:'entry-a',action:'SELL'},
    {eventId:'entry-a',quoteSourceId:'client-owned-quote'},
    {eventId:'entry-a',observedAtMs:input.cycle.entryQuote.observedAtMs+100},
    {eventId:'entry-a',provenance:'BROKER_FILL'},
    {eventId:'entry-a',quantity:Number.NaN},
    {eventId:'entry-a',quantity:-1},
  ];
  for(const patch of modifications){
    const first={...input.events[0],...patch} as ManualPaperSimulatedMatch;
    const outcome=evaluateManualFourMarketPaperOrderPath({
      ...input,events:[first,input.events[1],input.events[2],input.events[3]],
    });
    assert.equal(outcome.status,'BLOCKED',JSON.stringify(patch));
    assert.equal(outcome.journal,null);
  }
  const outOfOrder=evaluateManualFourMarketPaperOrderPath({
    ...input,events:[input.events[2],input.events[0]],
  });
  assert.equal(outOfOrder.status,'BLOCKED');
  const lateEntry=evaluateManualFourMarketPaperOrderPath({
    ...input,events:[input.events[0],input.events[2],input.events[1]],
  });
  assert.equal(lateEntry.status,'BLOCKED');
});
test('unknown verified owner, changed strategy and zero available capital forbid a simulated cycle',()=>{
  const input=orderPath();
  const variants=[
    change(input.cycle,'verifiedOwner',{ownerRlsReady:false}),
    change(input.cycle,'verifiedOwner',{walletReadbackReady:false}),
    change(input.cycle,'verifiedOwner',{operatingCapitalKrw:0}),
    change(input.cycle,'verifiedOwner',{strategyCandidateId:'client'}),
    change(input.cycle,'costs',{status:'UNKNOWN'}),
  ];
  for(const cycle of variants){
    const result=evaluateManualFourMarketPaperOrderPath({...input,cycle});
    assert.equal(result.status,'BLOCKED');
    assert.equal(result.actualPaperOrderCreated,false);
    assert.equal(result.hypotheticalNetPnlKrw,null);
  }
});
test('isolated future simulated loss beyond margin never fabricates an exit/settlement',()=>{
  const input=orderPath('crypto_futures');
  const lossExit=change(input.cycle,'exitQuote',{
    sourceId:'stop-like-public-quote',bid:1,ask:2,
  });
  const changedEvents=input.events.map(event=>event.phase==='EXIT'
    ?{...event,quoteSourceId:'stop-like-public-quote'}:event);
  const result=evaluateManualFourMarketPaperOrderPath({
    ...input,cycle:lossExit,events:changedEvents,
  });
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.hypotheticalNetPnlKrw,null);
  assert.ok(result.blockers.some(code=>code.includes('LIQUIDATION')));
  assert.equal(result.transferAuthority,false);
});


/** Sequential Paper events arrive over time, not from a future closed-cycle
 * payload. These are server-only fixtures; the browser cannot mint fills.
 */
const SEQ_AT=Date.parse('2026-10-12T08:00:00.000Z');
function seqSession(
  market:AdminPaperMarket='crypto_spot',
  side:ManualPaperSequentialSession['side']=market==='crypto_futures'?'LONG':'BUY',
):ManualPaperSequentialSession {
  return {
    ownerId:OWNER,role:'member',market,
    walletId:manualPaperWalletId('member',market),
    epochId:'manual-four-epoch-one',roundNumber:1,
    symbol:symbols[market],strategyId:'verified-manual-strategy',
    candidateId:'candidate-validated-1',
    strategyReceiptSha256:'a'.repeat(64),
    strategyValidatedAtMs:SEQ_AT-90_000,signalObservedAtMs:SEQ_AT-5_000,
    side,leverage:market==='crypto_futures'?7:1,
    requestedNotionalKrw:200_000,operatingCapitalKrw:1_000_000,
    lockedReserveKrw:0,highWaterMarkKrw:1_000_000,
    initialWalletReadbackVerified:true,
    independentStrategyEvidenceVerified:true,
  };
}
function seqQuote(s:ManualPaperSequentialSession,phase:'ENTRY'|'EXIT',
  extra:Partial<ManualPaperSequentialQuote>={}):ManualPaperSequentialQuote {
  const qcur=currency[s.market], fx=qcur==='KRW'?1:1400;
  return {
    provenance:'SERVER_PUBLIC_QUOTE_SIMULATION',
    quoteSourceId:phase==='ENTRY'?'verified-entry-quote':'verified-exit-quote',
    observedAtMs:SEQ_AT+(phase==='ENTRY'?1_000:4_000),
    currency:qcur,bid:phase==='ENTRY'?99:108,ask:phase==='ENTRY'?100:109,
    fxKrwPerUnit:fx,fxSourceId:phase==='ENTRY'?'entry-fx-proof':'exit-fx-proof',
    fxObservedAtMs:SEQ_AT+(phase==='ENTRY'?800:3_800),
    feeKrw:5,taxKrw:0,slippageKrw:10,signedFundingKrw:0,
    fundingCoverageVerified:true,
    ...extra,
  };
}
function seqEvent(
  s:ManualPaperSequentialSession,
  kind:ManualPaperSequentialEvent['kind'],
  sequence:number,
  observedAtMs:number,
  addition:Partial<ManualPaperSequentialEvent>={},
):ManualPaperSequentialEvent {
  const unsig:Omit<ManualPaperSequentialEvent,'eventId'>={
    schemaVersion:MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION,
    orderId:manualPaperSequentialOrderId(s),requestKey:'rq-seq-'+sequence,
    sequence,ownerId:s.ownerId,walletId:s.walletId,role:s.role,
    market:s.market,kind,observedAtMs,source:'SERVER_ISSUED_PAPER_EVENT',
    executionAuthority:'NONE',actualBrokerFill:false,walletMutation:false,
    actualPaperLedgerWritten:false,
    ...Object.fromEntries(Object.entries(addition).filter(([key])=>key!=='eventId')),
  } as Omit<ManualPaperSequentialEvent,'eventId'>;
  return {
    ...unsig,eventId:manualPaperSequentialEventId(unsig),
  };
}
function sequenceFor(
  market:AdminPaperMarket='crypto_spot',
  side:ManualPaperSequentialSession['side']=market==='crypto_futures'?'LONG':'BUY',
){
  const s=seqSession(market,side);
  const eq=seqQuote(s,'ENTRY'),xq=seqQuote(s,'EXIT');
  const entryPrice=side==='SHORT'?eq.bid:eq.ask;
  const qty=s.requestedNotionalKrw/(entryPrice*eq.fxKrwPerUnit);
  const events:ManualPaperSequentialEvent[]=[
    seqEvent(s,'OPEN_ORDER',1,SEQ_AT,{session:s}),
    seqEvent(s,'ENTRY_MATCH',2,SEQ_AT+1_200,{
      quantity:qty*0.6,quote:eq,
    }),
    seqEvent(s,'ENTRY_MATCH',3,SEQ_AT+1_600,{
      quantity:qty*0.4,quote:eq,
    }),
    seqEvent(s,'REQUEST_EXIT',4,SEQ_AT+3_000,{quantity:qty}),
    seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{
      quantity:qty*0.4,quote:xq,
    }),
    seqEvent(s,'EXIT_MATCH',6,SEQ_AT+4_600,{
      quantity:qty*0.6,quote:xq,
    }),
  ];
  return {s,events,qty,entry:eq,exit:xq};
}
const seqProject=(e:readonly ManualPaperSequentialEvent[])=>
  projectManualPaperSequentialEvents(e,SEQ_AT+12_000);

test('4-market prospective Paper orders unfold chronologically without knowing a future exit quote at OPEN',()=>{
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const){
    const {events}=sequenceFor(market);
    const opened=seqProject(events.slice(0,1));
    assert.equal(opened.status,'ENTRY_PENDING',market);
    assert.equal(opened.journalProjection,null);
    assert.equal(opened.hypotheticalNetPnlKrw,null);
    const partial=seqProject(events.slice(0,2));
    assert.equal(partial.status,'ENTRY_PARTIAL',market);
    assert.ok(partial.entryQuantity>0);
    assert.equal(partial.hypotheticalLockedReserveKrw,null);
    const open=seqProject(events.slice(0,3));
    assert.equal(open.status,'OPEN',market);
    const pending=seqProject(events.slice(0,4));
    assert.equal(pending.status,'EXIT_PENDING',market);
    const reducing=seqProject(events.slice(0,5));
    assert.equal(reducing.status,'PARTIALLY_CLOSED',market);
    assert.equal(reducing.hypotheticalNetPnlKrw,null);
    const closed=seqProject(events);
    assert.equal(closed.status,'CLOSED_PROJECTION',JSON.stringify(closed.blockers));
    assert.equal(closed.entryQuantity,closed.exitQuantity);
    assert.equal(closed.openQuantity,0);
    assert.ok(closed.hypotheticalNetPnlKrw!>0);
    assert.equal(closed.executionAuthority,'NONE');
    assert.equal(closed.actualPaperLedgerWritten,false);
    assert.equal(closed.actualBrokerFill,false);
    assert.equal(closed.realOrderSubmitted,false);
    assert.equal(closed.profitabilityProven,false);
    assert.equal(closed.journalProjection?.actualBrokerFill,false);
    assert.equal(closed.journalProjection?.simulatedMatchIds instanceof Array,true);
    assert.equal(closed.journalProjection?.market,market);
    assert.equal(closed.hypotheticalOperatingCapitalKrw!+
      closed.hypotheticalLockedReserveKrw!,
      Math.round((1_000_000+closed.hypotheticalNetPnlKrw!)*100)/100);
  }
});
test('sequential entry remainder cancellation and repeated reduce-only exit orders preserve flatness',()=>{
  const {s,events,qty,exit:exitQuote}=sequenceFor('crypto_spot');
  const extra:ManualPaperSequentialEvent[]=[
    events[0],events[1],
    seqEvent(s,'CANCEL_ENTRY',3,SEQ_AT+2_000),
    seqEvent(s,'REQUEST_EXIT',4,SEQ_AT+3_000,{quantity:qty*0.6}),
    seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{quantity:qty*0.25,quote:exitQuote}),
    seqEvent(s,'CANCEL_EXIT',6,SEQ_AT+4_300),
    seqEvent(s,'REQUEST_EXIT',7,SEQ_AT+4_400,{quantity:qty*0.35}),
    // A new exit request must use a new, as-of quote, not the prior
    // request's favorable quote (retroactive profit would be hindsight).
    seqEvent(s,'EXIT_MATCH',8,SEQ_AT+4_600,{
      quantity:qty*0.35,
      quote:seqQuote(s,'EXIT',{
        quoteSourceId:'verified-second-exit-quote',
        observedAtMs:SEQ_AT+4_500,fxObservedAtMs:SEQ_AT+4_480,
      }),
    }),
  ];
  const projected=seqProject(extra);
  assert.equal(projected.status,'CLOSED_PROJECTION',JSON.stringify(projected.blockers));
  assert.equal(projected.entryRemainderCancelled,true);
  assert.ok(projected.entryQuantity<qty);
  assert.equal(projected.openQuantity,0);
  assert.ok(projected.hypotheticalNetPnlKrw!>0);
  const withoutCancel=seqProject([
    events[0],events[1],
    seqEvent(s,'REQUEST_EXIT',3,SEQ_AT+3_000,{quantity:qty*0.6}),
    seqEvent(s,'EXIT_MATCH',4,SEQ_AT+4_600,{quantity:qty*0.6,quote:exitQuote}),
  ]);
  assert.equal(withoutCancel.status,'BLOCKED');
  assert.ok(withoutCancel.blockers.includes(
    'MANUAL_PAPER_SEQ_ENTRY_REMAINDER_CANCEL_REQUIRED_BEFORE_EXIT'));
  assert.equal(withoutCancel.hypotheticalNetPnlKrw,null);
});
test('sequential Paper LONG/SHORT PnL avoids USDT notional FX phantom gain',()=>{
  const {s,events}=sequenceFor('crypto_futures','LONG');
  const staticFx=events.map(e=>e.kind==='EXIT_MATCH'?seqEvent(s,e.kind,e.sequence,
    e.observedAtMs,{quantity:e.quantity,quote:seqQuote(s,'EXIT',{
      bid:100,ask:101,fxKrwPerUnit:1500,fxSourceId:'changed-fx',
    })}):e);
  const flat=seqProject(staticFx);
  assert.equal(flat.status,'CLOSED_PROJECTION',JSON.stringify(flat.blockers));
  assert.equal(flat.hypotheticalGrossPnlKrw,0);
});
test('sequential short reduces through BUY and never extends exposure',()=>{
  const a=sequenceFor('crypto_futures','SHORT');
  const result=seqProject(a.events);
  assert.equal(result.status,'CLOSED_PROJECTION',JSON.stringify(result.blockers));
  assert.ok(result.hypotheticalNetPnlKrw!<0);
  assert.equal(result.hypotheticalLockedReserveKrw,0);
  const nonFutures=sequenceFor('domestic_stock');
  const invalid=seqSession('domestic_stock','SHORT');
  const bad=seqEvent(invalid,'OPEN_ORDER',1,SEQ_AT,{session:invalid});
  assert.equal(seqProject([bad]).status,'BLOCKED');
  assert.equal(nonFutures.events[0].role,'member');
});
test('sequential owner, event sequence, request key and duplicate identity are fail-closed',()=>{
  const {events,s}=sequenceFor();
  const forged=[
    [events[0],{...events[1],ownerId:'other'}],
    [events[0],events[1],events[1]],
    [events[0],{...events[2]}],
    [events[0],{...events[1],sequence:6}],
    [events[0],{...events[1],requestKey:events[0].requestKey}],
  ];
  for(const set of forged) {
    assert.equal(seqProject(set).status,'BLOCKED');
    assert.equal(seqProject(set).hypotheticalNetPnlKrw,null);
  }
  const replayed=seqProject([...events,events[5]]);
  assert.equal(replayed.status,'BLOCKED');
  const empty=seqProject([]);
  assert.equal(empty.status,'EMPTY');
  const future=seqEvent(s,'OPEN_ORDER',1,SEQ_AT+20_000,{session:s});
  assert.equal(seqProject([future]).status,'BLOCKED');
});
test('sequential Paper underfunded entry and over-close cannot credit reserve',()=>{
  const {events,s,qty}=sequenceFor();
  const inflated=seqEvent(s,'ENTRY_MATCH',2,SEQ_AT+1_200,{
    quote:seqQuote(s,'ENTRY'),quantity:qty*5,
  });
  assert.equal(seqProject([events[0],inflated]).status,'BLOCKED');
  const excess=seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{
    quantity:qty*2,quote:seqQuote(s,'EXIT'),
  });
  assert.equal(seqProject([...events.slice(0,4),excess]).status,'BLOCKED');
  const unknownCost=seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{
    quantity:qty*0.4,quote:seqQuote(s,'EXIT',{taxKrw:Number.NaN}),
  });
  assert.equal(seqProject([...events.slice(0,4),unknownCost]).status,'BLOCKED');
  const falseFx=seqEvent(s,'ENTRY_MATCH',2,SEQ_AT+1_200,{
    quote:seqQuote(s,'ENTRY',{fxKrwPerUnit:0}),quantity:qty,
  });
  assert.equal(seqProject([events[0],falseFx]).status,'BLOCKED');
});
test('futures funding receipt is mandatory and entry funding cannot fake free margin',()=>{
  const {s,events,qty}=sequenceFor('crypto_futures');
  const missing=seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{
    quantity:qty*0.4,
    quote:seqQuote(s,'EXIT',{fundingCoverageVerified:false}),
  });
  assert.equal(seqProject([...events.slice(0,4),missing]).status,'BLOCKED');
  const injected=seqEvent(s,'ENTRY_MATCH',2,SEQ_AT+1_200,{
    quantity:qty,quote:seqQuote(s,'ENTRY',{signedFundingKrw:-50_000}),
  });
  assert.equal(seqProject([events[0],injected]).status,'BLOCKED');
});
test('sequential Paper event hash and JSONB-normalized duplicate readback agree by content',()=>{
  const {events}=sequenceFor('us_stock');
  const row=manualPaperSequentialRow(events[1]);
  assert.match(row.event_sha256,/^[a-f0-9]{64}$/);
  assert.ok(sameManualPaperSequentialRow(row,structuredClone(row) as unknown as Record<string,unknown>));
  // PostgreSQL JSONB reorders object properties. Hashing insertion order
  // would corrupt all legitimate duplicate acknowledgements.
  const sortKeys=(v:any):any=>Array.isArray(v)?v.map(sortKeys)
    :v!==null&&typeof v==='object'
      ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortKeys(v[k])]))
      :v;
  const fromJsonb=sortKeys(structuredClone(row));
  assert.equal(sameManualPaperSequentialRow(row,fromJsonb),true);
  assert.equal(sameManualPaperSequentialRow(row,{
    ...fromJsonb,event_sha256:'0'.repeat(64),
  }),false);
  assert.equal(sameManualPaperSequentialRow(row,{
    ...fromJsonb,event:{...fromJsonb.event,quantity:99999},
  }),false);
});


test('partial entry requires remainder cancellation before reducing exit or it deadlocks',()=>{
  const {s,events,qty,exit:exitQuote}=sequenceFor('crypto_spot');
  const impossible=[
    events[0],events[1],
    seqEvent(s,'REQUEST_EXIT',3,SEQ_AT+3_000,{quantity:qty*0.6}),
  ];
  const rejected=seqProject(impossible);
  assert.equal(rejected.status,'BLOCKED');
  assert.ok(rejected.blockers.includes(
    'MANUAL_PAPER_SEQ_ENTRY_REMAINDER_CANCEL_REQUIRED_BEFORE_EXIT'));
  assert.equal(rejected.hypotheticalNetPnlKrw,null);
  const viable=[
    events[0],events[1],
    seqEvent(s,'CANCEL_ENTRY',3,SEQ_AT+2_000),
    seqEvent(s,'REQUEST_EXIT',4,SEQ_AT+3_000,{quantity:qty*0.6}),
    seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{
      quantity:qty*0.6,quote:exitQuote,
    }),
  ];
  const valid=seqProject(viable);
  assert.equal(valid.status,'CLOSED_PROJECTION',JSON.stringify(valid.blockers));
  assert.ok(valid.hypotheticalNetPnlKrw!>0);
  assert.equal(valid.actualPaperLedgerWritten,false);
});

test('sequential simulated fills reject quotes predating order, exit request or prior price observation',()=>{
  const {s,events,qty}=sequenceFor();
  const beforeOpen=seqEvent(s,'ENTRY_MATCH',2,SEQ_AT+1_200,{
    quantity:qty*0.6,
    quote:seqQuote(s,'ENTRY',{
      observedAtMs:SEQ_AT-1,fxObservedAtMs:SEQ_AT-100,
      quoteSourceId:'pre-open-price',
    }),
  });
  const a=seqProject([events[0],beforeOpen]);
  assert.equal(a.status,'BLOCKED');
  assert.ok(a.blockers.includes('MANUAL_PAPER_SEQ_PUBLIC_COST_FX_OR_FILL_INVALID'));

  const priorPrice=seqEvent(s,'ENTRY_MATCH',3,SEQ_AT+1_600,{
    quantity:qty*0.4,
    quote:seqQuote(s,'ENTRY',{
      observedAtMs:SEQ_AT+900,fxObservedAtMs:SEQ_AT+800,
      quoteSourceId:'earlier-entry-quote',
    }),
  });
  const b=seqProject([events[0],events[1],priorPrice]);
  assert.equal(b.status,'BLOCKED');

  const retroExit=seqEvent(s,'EXIT_MATCH',5,SEQ_AT+4_200,{
    quantity:qty*0.4,
    quote:seqQuote(s,'EXIT',{
      observedAtMs:SEQ_AT+2_800,fxObservedAtMs:SEQ_AT+2_700,
      quoteSourceId:'favorable-before-exit-request',
    }),
  });
  const c=seqProject([...events.slice(0,4),retroExit]);
  assert.equal(c.status,'BLOCKED');
  assert.ok(c.blockers.includes('MANUAL_PAPER_SEQ_PUBLIC_COST_FX_OR_FILL_INVALID'));
  assert.equal(c.hypotheticalNetPnlKrw,null);

});

test('stale order signal and mismatched event kind payloads cannot mint a Paper settlement',()=>{
  const {s,events,qty}=sequenceFor();
  const staleS={...s,signalObservedAtMs:SEQ_AT-60_001};
  const staleOpen=seqEvent(staleS,'OPEN_ORDER',1,SEQ_AT,{session:staleS});
  const stale=seqProject([staleOpen]);
  assert.equal(stale.status,'BLOCKED');
  assert.equal(stale.hypotheticalNetPnlKrw,null);
  for(const candidate of [
    seqEvent(s,'OPEN_ORDER',1,SEQ_AT,{
      session:s,quantity:qty,quote:seqQuote(s,'ENTRY'),
    }),
    seqEvent(s,'CANCEL_ENTRY',3,SEQ_AT+2_000,{
      quantity:qty*0.5,
    }),
    seqEvent(s,'REQUEST_EXIT',4,SEQ_AT+3_000,{
      quantity:qty,quote:seqQuote(s,'EXIT'),
    }),
    seqEvent(s,'CANCEL_EXIT',6,SEQ_AT+4_300,{
      quote:seqQuote(s,'EXIT'),
    }),
  ]){
    const history=candidate.kind==='OPEN_ORDER'?[candidate]
      :candidate.kind==='CANCEL_ENTRY'
        ?[events[0],events[1],candidate]
        :candidate.kind==='REQUEST_EXIT'
          ?[...events.slice(0,3),candidate]
          :[...events.slice(0,5),candidate];
    const projection=seqProject(history);
    assert.equal(projection.status,'BLOCKED',candidate.kind);
    assert.equal(projection.journalProjection,null);
  }
});
