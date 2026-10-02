import test from 'node:test';
import assert from 'node:assert/strict';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import { automaticExitReason, buildAutomaticExitPlanInput } from './member-auto-trading-exit-plan.service';

const NOW='2026-10-02T03:00:00.000Z';
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

test('exit plan is reduce-only and bound to entry identity',()=>{
  const entry=plan('long','bitget');
  const input=buildAutomaticExitPlanInput({
    entryPlan:entry,entryOrder:order(entry),
    mark:{market:'CRYPTO_FUTURES',symbol:'BTC',price:94,observedAt:NOW,source:'public'},
    fx:{market:'CRYPTO_FUTURES',krwPerQuoteCurrency:1400,source:'USDT_KRW',observedAt:NOW,stale:false as const},
    reason:'TAKE_PROFIT',
  });
  assert.equal(input.reduceOnly,true);
  assert.equal(input.side,'long');
  assert.equal(input.accountMode,'paper');
  assert.ok(input.signalReasons.includes(`AUTO_EXIT_ENTRY_PLAN:${entry.id}`));
  assert.equal(input.targetPrices.length,0);
  assert.equal(input.stopPrice,94);
});


test('exit plan can close only the remaining tracked quantity and reason is part of idempotency identity',()=>{
  const entry=plan('buy','upbit');
  const base={entryPlan:entry,entryOrder:order(entry),mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:94,observedAt:NOW,source:'public'},fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'KRW_NATIVE',observedAt:NOW,stale:false as const}};
  const stop=buildAutomaticExitPlanInput({...base,reason:'STOP_LOSS',remainingQuantity:0.4});
  const take=buildAutomaticExitPlanInput({...base,reason:'TAKE_PROFIT',remainingQuantity:0.4});
  assert.equal(stop.quantity,0.4);
  assert.ok(stop.signalId.includes(':STOP_LOSS:'));
  assert.ok(take.signalId.includes(':TAKE_PROFIT:'));
  assert.notEqual(stop.signalId,take.signalId);
});


test('fresh mark identity allows a safe retry only after a prior automatic exit is terminal',()=>{
  const entry=plan('buy','upbit');
  const base={entryPlan:entry,entryOrder:order(entry),fx:{market:'CRYPTO_SPOT' as const,krwPerQuoteCurrency:1,source:'KRW_NATIVE',observedAt:NOW,stale:false as const},reason:'STOP_LOSS' as const,remainingQuantity:1};
  const first=buildAutomaticExitPlanInput({...base,mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:94,observedAt:NOW,source:'public'}});
  const nextAt='2026-10-02T03:00:30.000Z';
  const retry=buildAutomaticExitPlanInput({...base,mark:{market:'CRYPTO_SPOT' as const,symbol:'BTC',price:93,observedAt:nextAt,source:'public'}});
  assert.notEqual(first.signalId,retry.signalId);
  assert.ok(first.signalReasons.includes('AUTO_EXIT_ENTRY_PLAN:'+entry.id));
  assert.ok(retry.signalReasons.includes('AUTO_EXIT_REASON:STOP_LOSS'));
});
