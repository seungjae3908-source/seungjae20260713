import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

const USER='22222222-2222-2222-2222-222222222222';
const NOW='2026-10-02T03:00:00.000Z';

function plan(id:string, accountMode:'live'|'paper', executionMode:'manual'|'automatic'): TradingPlan {
  return {
    id, userId:USER, idempotencyKey:'idem-'+id, state:'SUBMITTED', version:1,
    approvalExpiresAt:'2026-10-02T04:00:00.000Z', approvedAt:NOW, createdAt:NOW, updatedAt:NOW,
    executionMode,
    exchange:'upbit', accountMode, stockBroker:null, stockExchange:null,
    strategyId:'strategy-v1', signalId:'signal-'+id, symbol:'BTC', market:'KRW-BTC', side:'buy',
    orderType:'market', quantity:0.01, quoteAmount:null, limitPrice:null, estimatedKrw:1_000_000,
    stopPrice:95_000_000, targetPrices:[110_000_000], splitRatios:[1], leverage:null, marginMode:null,
    reduceOnly:false, invalidateAction:'hold', signalReasons:['test'],
    marketSnapshot:{
      observedAt:NOW, dataDelayMs:0, oneMinuteMovePercent:1, spreadPercent:0.1, orderbookGapPercent:0.1,
      halted:false, availableBalance:5_000_000, accountValueKrw:5_000_000, dailyPnlPercent:0,
      assetExposurePercent:0, openPositionCount:0, dailyOrderCount:0, consecutiveLosses:0,
      currentPrice:100_000_000, plannedPrice:100_000_000, marketStatus:'OPEN',
    },
    entryPrice:100_000_000, entryZoneLow:null, entryZoneHigh:null,
    estimatedSlippagePercent:null, averageSpreadPercent:null, economics:null,
  };
}

function order(id:string, planId:string): TradingOrder {
  return {
    id, userId:USER, planId, exchange:'upbit', stockBroker:null,
    clientOrderId:'client-'+id, exchangeOrderId:'exchange-'+id, state:'FILLED', version:3,
    requestedQuantity:0.01, remainingQuantity:0, currentLimitPrice:null, filledQuantity:0.01,
    averageFillPrice:100_000_000, fills:[{id:'fill-'+id,price:100_000_000,quantity:0.01,feeAmount:500,feeCurrency:'KRW',filledAt:NOW}],
    feeAmount:500, feeCurrency:'KRW', exchangeCreatedAt:NOW, exchangeUpdatedAt:NOW, cancelable:false,
    providerStatusCode:'done', retryCount:0, nextRetryAt:null, lastReconciledAt:NOW, lastErrorCode:null,
    manualReviewRequired:false, executionClaimId:'claim-'+id, submissionStartedAt:NOW, submissionAttemptId:'attempt-'+id,
    approvedPlanVersion:1, preSubmissionCheckedAt:NOW, preSubmissionDecision:null, preSubmissionSnapshot:null,
    cancelRequestedAt:null, cancelRequestClaimId:null, cancelSubmittedAt:null, cancelAcknowledgedAt:null,
    cancelOperationId:null, recoveryLeaseOwner:null, recoveryLeaseUntil:null, protectionStatus:'NOT_REQUIRED',
    protectionErrorCode:null, amendments:[], lastAmendRequestId:null, createdAt:NOW, updatedAt:NOW,
  };
}

test('canonical execution ledger separates manual live, automatic live, and automatic paper', async () => {
  const repository=new InMemoryTradingRepository();
  const fixtures=[
    [plan('manual-live','live','manual'), order('order-manual','manual-live')],
    [plan('auto-live','live','automatic'), order('order-auto','auto-live')],
    [plan('auto-paper','paper','automatic'), order('order-paper','auto-paper')],
  ] as const;
  for(const [p,o] of fixtures){ await repository.savePlan(p); await repository.saveOrder(o); }
  const rows=await readTradeAutomationJournalPayloads(repository,USER);
  const byOrder=new Map(rows.map((row)=>[row.brokerOrderId,row]));
  assert.equal(byOrder.get('exchange-order-manual')?.source,'APP_MANUAL');
  assert.equal(byOrder.get('exchange-order-auto')?.source,'APP_AUTO');
  assert.equal(byOrder.get('exchange-order-paper')?.source,'APP_PAPER');
  assert.equal(rows.every((row)=>String(row.accountIdMasked).includes('****')),true);
  const automatic = byOrder.get('exchange-order-auto');
  assert.deepEqual(automatic?.canonicalLineage, {
    signalIds: ['signal-auto-live'],
    planIds: ['auto-live'],
    orderIds: ['order-auto'],
    fillIds: ['fill-order-auto'],
  });
});


test('Bitget reduce-only exit keeps the original position side so entry and exit reconcile into one journal cycle', async () => {
  const repository=new InMemoryTradingRepository();
  const entry={...plan('future-entry','live','automatic'),
    exchange:'bitget' as const,market:'USDT-FUTURES',side:'long' as const,
    leverage:2,marginMode:'isolated' as const,quantity:1,quoteAmount:null,
    estimatedKrw:1_000_000,reduceOnly:false};
  const exit={...plan('future-exit','live','automatic'),
    exchange:'bitget' as const,market:'USDT-FUTURES',side:'short' as const,
    leverage:2,marginMode:'isolated' as const,quantity:1,quoteAmount:null,
    estimatedKrw:1_000_000,reduceOnly:true,
    signalReasons:['AUTO_EXIT_ENTRY_PLAN:future-entry','AUTO_EXIT_REASON:TAKE_PROFIT']};
  await repository.savePlan(entry);
  await repository.savePlan(exit);
  await repository.saveOrder({...order('future-entry-order','future-entry'),exchange:'bitget'});
  await repository.saveOrder({...order('future-exit-order','future-exit'),exchange:'bitget'});
  const rows=await readTradeAutomationJournalPayloads(repository,USER);
  const entryRow=rows.find((row)=>row.brokerOrderId==='exchange-future-entry-order');
  const exitRow=rows.find((row)=>row.brokerOrderId==='exchange-future-exit-order');
  assert.equal(entryRow?.positionSide,'LONG');
  assert.equal(entryRow?.positionEffect,'OPEN');
  assert.equal(exitRow?.positionSide,'LONG');
  assert.equal(exitRow?.positionEffect,'CLOSE');
  const journal=buildUnifiedTradeJournal(rows,{range:'ALL'},new Date(NOW));
  assert.equal(journal.trades.length,1);
  assert.deepEqual(journal.trades[0]?.canonicalLineage ? [...journal.trades[0].canonicalLineage.signalIds].sort() : undefined,[
    'signal-future-entry','signal-future-exit',
  ].sort());
  assert.deepEqual(journal.trades[0]?.canonicalLineage ? [...journal.trades[0].canonicalLineage.planIds].sort() : undefined,[
    'future-entry','future-exit',
  ].sort());
  assert.deepEqual(journal.trades[0]?.canonicalLineage ? [...journal.trades[0].canonicalLineage.orderIds].sort() : undefined,[
    'future-entry-order','future-exit-order',
  ].sort());
  assert.deepEqual(journal.trades[0]?.canonicalLineage ? [...journal.trades[0].canonicalLineage.fillIds].sort() : undefined,[
    'fill-future-entry-order','fill-future-exit-order',
  ].sort());
});
