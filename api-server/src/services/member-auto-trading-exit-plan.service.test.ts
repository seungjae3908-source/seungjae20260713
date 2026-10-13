import test from 'node:test';
import assert from 'node:assert/strict';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import {
  automaticExitDecision,
  automaticExitReason,
  buildAutomaticExitPlanInput as buildAtRuntime,
} from './member-auto-trading-exit-plan.service';

const NOW='2026-10-02T03:00:00.000Z';
// Historical fixtures use a fixed run-clock, never current wall-clock time.
function buildAutomaticExitPlanInput(input: Parameters<typeof buildAtRuntime>[0]) {
  return buildAtRuntime({nowMs: Date.parse(NOW), ...input});
}
function plan(side:'buy'|'long'|'short'='buy',exchange:'upbit'|'bitget'='upbit'):TradingPlan{
  return {
    id:'11111111-1111-1111-1111-111111111111',userId:'u',idempotencyKey:'entry',state:'SUBMITTED',version:1,
    approvalExpiresAt:'2026-10-02T04:00:00.000Z',approvedAt:NOW,createdAt:NOW,updatedAt:NOW,executionMode:'automatic',
    exchange,accountMode:'paper',stockBroker:null,stockExchange:null,strategyId:'s',signalId:'sig',symbol:'BTC',
    market:exchange==='upbit'?'KRW':'USDT-FUTURES',side,orderType:'market',quantity:1,quoteAmount:null,limitPrice:100,
    estimatedKrw:100,stopPrice:95,targetPrices:[105,110],splitRatios:[100],leverage:exchange==='bitget'?2:null,
    marginMode:exchange==='bitget'?'isolated':null,reduceOnly:false,invalidateAction:'hold',signalReasons:[],
    marketSnapshot:{observedAt:NOW,riskObservedAt:NOW,dataDelayMs:0,oneMinuteMovePercent:0,spreadPercent:0.1,orderbookGapPercent:0.1,
      halted:false,availableBalance:1000,accountValueKrw:1000,dailyPnlPercent:0,weeklyPnlPercent:0,assetExposurePercent:0,
      accountExposureKrw:0,instrumentExposureKrw:0,strategyExposureKrw:0,assetClassExposureKrw:0,openRiskKrw:0,
      openPositionCount:0,dailyOrderCount:0,consecutiveLosses:0,existingPositionSide:null,liquidationDistancePercent:null,
      openOrderExposureKrw:0,currentPrice:100,plannedPrice:100,marketStatus:'OPEN',providerTimeOffsetMs:0,source:'test',
      availableLiquidityKrw:1000,estimatedSlippagePercent:0.1,estimatedFeePercent:0.05,correlatedExposurePercent:0,
      signalState:'entry_ready',signalObservedAt:NOW},
    entryPrice:null,entryZoneLow:null,entryZoneHigh:null,estimatedSlippagePercent:0.1,averageSpreadPercent:0.1,economics:null,
  };
}
function order(p:TradingPlan):TradingOrder{
  return {id:'22222222-2222-2222-2222-222222222222',userId:'u',planId:p.id,exchange:p.exchange,stockBroker:null,
    clientOrderId:'c',exchangeOrderId:'e',state:'FILLED',version:1,requestedQuantity:1,remainingQuantity:0,currentLimitPrice:null,
    filledQuantity:1,averageFillPrice:100,fills:[],feeAmount:0.1,feeCurrency:'KRW',exchangeCreatedAt:NOW,exchangeUpdatedAt:NOW,
    cancelable:false,providerStatusCode:'done',retryCount:0,nextRetryAt:null,lastReconciledAt:NOW,lastErrorCode:null,
    manualReviewRequired:false,executionClaimId:'x',submissionStartedAt:NOW,submissionAttemptId:'a',approvedPlanVersion:1,
    preSubmissionCheckedAt:NOW,preSubmissionDecision:null,preSubmissionSnapshot:null,cancelRequestedAt:null,cancelRequestClaimId:null,
    cancelSubmittedAt:null,cancelAcknowledgedAt:null,cancelOperationId:null,recoveryLeaseOwner:null,recoveryLeaseUntil:null,
    protectionStatus:'NOT_REQUIRED',protectionErrorCode:null,amendments:[],lastAmendRequestId:null,createdAt:NOW,updatedAt:NOW};
}

test('long and short automatic exits use stop-first price direction',()=>{
  assert.equal(automaticExitReason(plan('buy','upbit'),94),'STOP_LOSS');
  assert.equal(automaticExitReason(plan('buy','upbit'),106),'TAKE_PROFIT');
  assert.equal(automaticExitReason(plan('short','bitget'),106),'STOP_LOSS');
  assert.equal(automaticExitReason(plan('short','bitget'),94),'TAKE_PROFIT');
});

test('multiple targets take a venue-valid partial profit and leave the final target for the remainder',()=>{
  const entry=plan('buy','upbit');
  const first=automaticExitDecision({
    plan:entry,currentPrice:106,entryFilledQuantity:1,remainingQuantity:1,
    entryAveragePrice:100,quantityStep:0.01,minimumQuantity:0.01,
  });
  assert.deepEqual(first,{reason:'TAKE_PROFIT',quantity:0.5,targetIndex:0,triggerPrice:105});
  const hold=automaticExitDecision({
    plan:entry,currentPrice:108,entryFilledQuantity:1,remainingQuantity:0.5,
    completedTargetIndexes:[0],entryAveragePrice:100,quantityStep:0.01,minimumQuantity:0.01,
  });
  assert.equal(hold,null);
  const final=automaticExitDecision({
    plan:entry,currentPrice:111,entryFilledQuantity:1,remainingQuantity:0.5,
    completedTargetIndexes:[0],entryAveragePrice:100,quantityStep:0.01,minimumQuantity:0.01,
  });
  assert.deepEqual(final,{reason:'TAKE_PROFIT',quantity:0.5,targetIndex:1,triggerPrice:110});
});

test('completed target progress ratchets a restart-safe trailing exit for long and short remainders',()=>{
  const long=automaticExitDecision({
    plan:plan('buy','upbit'),currentPrice:99,entryFilledQuantity:1,remainingQuantity:0.5,
    completedTargetIndexes:[0],entryAveragePrice:100,quantityStep:0.01,
  });
  assert.deepEqual(long,{reason:'TRAILING_TAKE_PROFIT',quantity:0.5,targetIndex:null,triggerPrice:100});
  const shortPlan=plan('short','bitget');
  shortPlan.stopPrice=105;
  shortPlan.targetPrices=[95,90];
  const short=automaticExitDecision({
    plan:shortPlan,currentPrice:101,entryFilledQuantity:1,remainingQuantity:0.5,
    completedTargetIndexes:[0],entryAveragePrice:100,quantityStep:0.01,
  });
  assert.deepEqual(short,{reason:'TRAILING_TAKE_PROFIT',quantity:0.5,targetIndex:null,triggerPrice:100});
});

test('a persisted later target cumulatively completes earlier rungs after restart',()=>{
  const entry={...plan('buy','upbit'),targetPrices:[105,110,115]};
  const decision=automaticExitDecision({
    plan:entry,currentPrice:104,entryFilledQuantity:3,remainingQuantity:1,
    completedTargetIndexes:[1],entryAveragePrice:100,quantityStep:0.01,
  });
  assert.deepEqual(decision,{
    reason:'TRAILING_TAKE_PROFIT',quantity:1,targetIndex:null,triggerPrice:105,
  });
});

test('stop remains first and non-divisible or below-minimum partial exits close safely at the reached target',()=>{
  const entry=plan('buy','upbit');
  const stop=automaticExitDecision({
    plan:entry,currentPrice:94,entryFilledQuantity:1,remainingQuantity:1,
    completedTargetIndexes:[0],entryAveragePrice:100,quantityStep:0.01,
  });
  assert.deepEqual(stop,{reason:'STOP_LOSS',quantity:1,targetIndex:null,triggerPrice:95});
  const indivisible=automaticExitDecision({
    plan:{...entry,exchange:'kiwoom',market:'KR',stockExchange:'KRX'},
    currentPrice:106,entryFilledQuantity:1,remainingQuantity:1,
    entryAveragePrice:100,quantityStep:1,minimumQuantity:1,
  });
  assert.equal(indivisible?.quantity,1);
  const belowMinimumNotional=automaticExitDecision({
    plan:entry,currentPrice:106,entryFilledQuantity:0.1,remainingQuantity:0.1,
    entryAveragePrice:100,quantityStep:0.01,minimumQuantity:0.01,minimumNotionalQuote:10,
  });
  assert.equal(belowMinimumNotional?.quantity,0.1);
});

test('exit plan is reduce-only and bound to entry identity',()=>{
  const entry=plan('long','bitget');
  const input=buildAutomaticExitPlanInput({
    entryPlan:entry,entryOrder:order(entry),
    mark:{market:'CRYPTO_FUTURES',symbol:'BTC',price:94,observedAt:NOW,source:'public'},
    fx:{market:'CRYPTO_FUTURES',krwPerQuoteCurrency:1400,source:'UPBIT:KRW-USDT',observedAt:NOW,stale:false as const},
    reason:'TAKE_PROFIT',
  });
  assert.equal(input.reduceOnly,true);
  // A LONG futures entry is closed with reduce-only SHORT; do not reverse the position.
  assert.equal(input.side,'short');
  assert.equal(input.accountMode,'paper');
  assert.ok(input.signalReasons.includes(`AUTO_EXIT_ENTRY_PLAN:${entry.id}`));
  assert.equal(input.targetPrices.length,0);
  assert.equal(input.stopPrice,94);
});


test('exit plan can close only the remaining tracked quantity and reason is part of idempotency identity',()=>{
  const entry=plan('buy','upbit');
  const base={entryPlan:entry,entryOrder:order(entry),mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:94,observedAt:NOW,source:'public'},fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'NATIVE_KRW',observedAt:NOW,stale:false as const}};
  const stop=buildAutomaticExitPlanInput({...base,reason:'STOP_LOSS',remainingQuantity:0.4});
  const take=buildAutomaticExitPlanInput({...base,reason:'TAKE_PROFIT',remainingQuantity:0.4});
  assert.equal(stop.quantity,0.4);
  assert.ok(stop.signalId.includes(':STOP_LOSS:'));
  assert.ok(take.signalId.includes(':TAKE_PROFIT:'));
  assert.notEqual(stop.signalId,take.signalId);
});

test('target stage is persisted in exit identity and rejects malformed stage metadata',()=>{
  const entry=plan('buy','upbit');
  const base={entryPlan:entry,entryOrder:order(entry),mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:106,observedAt:NOW,source:'public'},fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'NATIVE_KRW',observedAt:NOW,stale:false as const},reason:'TAKE_PROFIT' as const,remainingQuantity:0.5};
  const target=buildAutomaticExitPlanInput({...base,targetIndex:0});
  assert.ok(target.signalId.includes(':TAKE_PROFIT:TARGET_0:'));
  assert.ok(target.signalReasons.includes('AUTO_EXIT_TARGET_INDEX:0'));
  assert.throws(()=>buildAutomaticExitPlanInput({...base,targetIndex:2}),/BACKGROUND_EXIT_TARGET_INDEX_INVALID/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,reason:'STOP_LOSS',targetIndex:0}),/BACKGROUND_EXIT_TARGET_INDEX_INVALID/);
});


test('fresh mark identity allows a safe retry only after a prior automatic exit is terminal',()=>{
  const entry=plan('buy','upbit');
  const base={entryPlan:entry,entryOrder:order(entry),fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'NATIVE_KRW',observedAt:NOW,stale:false as const},reason:'STOP_LOSS' as const,remainingQuantity:1};
  const first=buildAutomaticExitPlanInput({...base,mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:94,observedAt:NOW,source:'public'}});
  const nextAt='2026-10-02T03:00:30.000Z';
  const retry=buildAutomaticExitPlanInput({...base,nowMs:Date.parse(nextAt),mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:93,observedAt:nextAt,source:'public'}});
  assert.notEqual(first.signalId,retry.signalId);
  assert.ok(first.signalReasons.includes('AUTO_EXIT_ENTRY_PLAN:'+entry.id));
  assert.ok(retry.signalReasons.includes('AUTO_EXIT_REASON:STOP_LOSS'));
});

test('automatic exit cannot use another symbol, market, or unrelated FX market',()=>{
  const entry=plan('buy','upbit');
  const ord=order(entry);
  const base={
    entryPlan:entry,entryOrder:ord,
    mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:94,observedAt:NOW,source:'public'},
    fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'NATIVE_KRW',observedAt:NOW,stale:false as const},
    reason:'STOP_LOSS' as const,
  };
  assert.throws(()=>buildAutomaticExitPlanInput({...base,mark:{...base.mark,symbol:'ETH'}}),
    /BACKGROUND_EXIT_MARK_SYMBOL_MISMATCH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,mark:{...base.mark,market:'US_STOCK' as const}}),
    /BACKGROUND_EXIT_MARK_IDENTITY_MISMATCH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,market:'US_STOCK' as const}}),
    /BACKGROUND_EXIT_FX_IDENTITY_MISMATCH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,stale:true as false}}),
    /BACKGROUND_EXIT_FX_IDENTITY_MISMATCH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,mark:{...base.mark,source:''}}),
    /BACKGROUND_EXIT_MARK_SOURCE_REQUIRED/);
  assert.equal(buildAutomaticExitPlanInput({...base,mark:{...base.mark,symbol:'KRW-BTC'}}).side,'sell');
});

test('automatic exit cannot exceed existing fill or cross owner/entry identity',()=>{
  const entry=plan('short','bitget');
  const ord=order(entry);
  const base={
    entryPlan:entry,entryOrder:ord,
    mark:{market:'CRYPTO_FUTURES' as const,symbol:'BTC',price:94,observedAt:NOW,source:'public'},
    fx:{market:'CRYPTO_FUTURES' as const,krwPerQuoteCurrency:1400,source:'UPBIT:KRW-USDT',observedAt:NOW,stale:false as const},
    reason:'TAKE_PROFIT' as const,
  };
  assert.throws(()=>buildAutomaticExitPlanInput({...base,remainingQuantity:1.5}),
    /BACKGROUND_EXIT_OVERFILLED_QUANTITY_FORBIDDEN/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,entryOrder:{...ord,userId:'other'}}),
    /BACKGROUND_EXIT_CANONICAL_ENTRY_IDENTITY_REQUIRED/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,entryOrder:{...ord,planId:'another'}}),
    /BACKGROUND_EXIT_CANONICAL_ENTRY_IDENTITY_REQUIRED/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,entryOrder:{...ord,state:'REJECTED'}}),
    /BACKGROUND_EXIT_CANONICAL_ENTRY_IDENTITY_REQUIRED/);
  const reducingShort = buildAutomaticExitPlanInput({...base,remainingQuantity:0.25});
  assert.equal(reducingShort.quantity,0.25);
  assert.equal(reducingShort.side,'long');
  assert.equal(reducingShort.reduceOnly,true);
});

test('automatic exit rejects stale or future market marks and FX quotes at order-plan time',()=>{
  const entry=plan('buy','upbit');
  const base={
    entryPlan:entry,entryOrder:order(entry),
    mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:94,observedAt:NOW,source:'upbit-public-ticker'},
    fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'NATIVE_KRW',observedAt:NOW,stale:false as const},
    reason:'STOP_LOSS' as const,
  };
  assert.throws(()=>buildAutomaticExitPlanInput({...base,nowMs:Date.parse(NOW)+30_001}),
    /BACKGROUND_EXIT_MARK_NOT_FRESH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,nowMs:Date.parse(NOW)-5_001}),
    /BACKGROUND_EXIT_MARK_NOT_FRESH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,observedAt:'2026-10-01T23:59:00.000Z'}}),
    /BACKGROUND_EXIT_FX_NOT_FRESH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,observedAt:'2026-10-02T03:00:06.000Z'}}),
    /BACKGROUND_EXIT_FX_NOT_FRESH/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,source:'YAHOO:USDKRW=X'}}),
    /BACKGROUND_EXIT_FX_SOURCE_UNVERIFIED/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,krwPerQuoteCurrency:1.05}}),
    /BACKGROUND_EXIT_FX_SOURCE_UNVERIFIED/);
});

test('US equity exit recognizes exchange market and requires USD/KRW source',()=>{
  const original=plan('buy','upbit');
  const entry:TradingPlan={...original,exchange:'kiwoom',stockExchange:'NASDAQ',
    market:'NASDAQ',symbol:'AAPL'};
  const ord=order(entry);
  const base={
    entryPlan:entry,entryOrder:ord,
    mark:{market:'US_STOCK' as const,symbol:'AAPL',price:94,observedAt:NOW,source:'kiwoom-market-data'},
    fx:{market:'US_STOCK' as const,krwPerQuoteCurrency:1330,source:'YAHOO:USDKRW=X',observedAt:NOW,stale:false as const},
    reason:'STOP_LOSS' as const,
  };
  const ready=buildAutomaticExitPlanInput(base);
  assert.equal(ready.side,'sell');
  assert.equal(ready.reduceOnly,true);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,fx:{...base.fx,source:'UPBIT:KRW-USDT'}}),
    /BACKGROUND_EXIT_FX_SOURCE_UNVERIFIED/);
  assert.throws(()=>buildAutomaticExitPlanInput({...base,nowMs:Date.parse(NOW)+60_001}),
    /BACKGROUND_EXIT_MARK_NOT_FRESH/);
});

test('four-market reducing exits preserve broker, market, and LONG/SHORT direction without an order transport',()=>{
  const base=plan('buy','upbit');
  const cases=[
    {entry:{...base,exchange:'toss' as const,stockBroker:'toss' as const,market:'KR',symbol:'005930'},
      market:'KR_STOCK' as const,source:'kr-public',fx:1,fxSource:'NATIVE_KRW',side:'sell'},
    {entry:{...base,exchange:'kiwoom' as const,stockBroker:'kiwoom' as const,market:'KR',symbol:'000660'},
      market:'KR_STOCK' as const,source:'kr-public',fx:1,fxSource:'NATIVE_KRW',side:'sell'},
    {entry:{...base,exchange:'kiwoom' as const,stockBroker:'kiwoom' as const,stockExchange:'NASDAQ' as const,market:'US',symbol:'AAPL'},
      market:'US_STOCK' as const,source:'us-public',fx:1330,fxSource:'YAHOO:USDKRW=X',side:'sell'},
    {entry:{...base,exchange:'upbit' as const,stockBroker:null,market:'KRW',symbol:'BTC'},
      market:'CRYPTO_SPOT' as const,source:'upbit-public',fx:1,fxSource:'NATIVE_KRW',side:'sell'},
    {entry:{...base,exchange:'bitget' as const,stockBroker:null,market:'USDT-FUTURES',symbol:'BTCUSDT',side:'long' as const,leverage:2,marginMode:'isolated' as const},
      market:'CRYPTO_FUTURES' as const,source:'bitget-public',fx:1400,fxSource:'UPBIT:KRW-USDT',side:'short'},
    {entry:{...base,exchange:'bitget' as const,stockBroker:null,market:'USDT-FUTURES',symbol:'ETHUSDT',side:'short' as const,leverage:2,marginMode:'isolated' as const},
      market:'CRYPTO_FUTURES' as const,source:'bitget-public',fx:1400,fxSource:'UPBIT:KRW-USDT',side:'long'},
  ];
  for(const fixture of cases){
    const entry=fixture.entry as TradingPlan;
    const reducing=buildAutomaticExitPlanInput({
      entryPlan:entry,entryOrder:order(entry),reason:'STOP_LOSS',remainingQuantity:1,
      mark:{market:fixture.market,symbol:entry.symbol,price:94,observedAt:NOW,source:fixture.source},
      fx:{market:fixture.market,krwPerQuoteCurrency:fixture.fx,source:fixture.fxSource,observedAt:NOW,stale:false},
    });
    assert.equal(reducing.exchange,entry.exchange);
    assert.equal(reducing.side,fixture.side);
    assert.equal(reducing.reduceOnly,true);
    assert.equal(reducing.quantity,1);
  }
});
