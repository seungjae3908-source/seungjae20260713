import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateManualFourMarketPaperClosedCycle,
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
