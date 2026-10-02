import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';
import { normalizeTradingPolicy, evaluateTradingPlan } from './trade-automation-risk.service';
import { buildRiskEnvelope, evaluateRiskEnvelope, withRiskEnvelope } from './trade-risk-envelope.service';

function exitInput(): TradingPlanInput {
  const now=new Date().toISOString();
  return {
    exchange:'upbit', accountMode:'live', stockBroker:null, stockExchange:null,
    strategyId:'auto-exit', signalId:'auto-exit:entry-1', symbol:'BTC', market:'KRW',
    side:'sell', orderType:'market', quantity:0.01, quoteAmount:null, limitPrice:null,
    estimatedKrw:2_000_000, stopPrice:null, targetPrices:[], splitRatios:[100],
    leverage:null, marginMode:null, reduceOnly:true, invalidateAction:'hold',
    signalReasons:['AUTO_EXIT','ENTRY_PLAN_ID:entry-1'],
    marketSnapshot:{
      observedAt:now,riskObservedAt:now,dataDelayMs:0,oneMinuteMovePercent:12,
      spreadPercent:3,orderbookGapPercent:3,halted:false,availableBalance:0,
      accountValueKrw:1_000_000,dailyPnlPercent:-99,weeklyPnlPercent:-99,
      assetExposurePercent:100,accountExposureKrw:2_000_000,instrumentExposureKrw:2_000_000,
      strategyExposureKrw:2_000_000,assetClassExposureKrw:2_000_000,openRiskKrw:2_000_000,
      openPositionCount:99,dailyOrderCount:99,consecutiveLosses:99,existingPositionSide:'buy',
      liquidationDistancePercent:null,openOrderExposureKrw:0,currentPrice:100_000_000,
      plannedPrice:100_000_000,marketStatus:'OPEN',providerTimeOffsetMs:0,
      source:'provider-live-exit',availableLiquidityKrw:1,estimatedSlippagePercent:0.1,
      estimatedFeePercent:0.05,correlatedExposurePercent:100,signalState:'approved',signalObservedAt:now,
    },
    entryPrice:null,entryZoneLow:null,entryZoneHigh:null,estimatedSlippagePercent:0.1,
    averageSpreadPercent:3,economics:null,
  };
}

test('reduce-only live automatic exit bypasses entry-only loss, exposure and profitability gates', () => {
  const policy=normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,mode:'automatic',automaticEnabled:true,
    newEntriesStopped:true,marketEnabled:{domestic_stock:false,us_stock:false,crypto_spot:false,crypto_futures:false},
    exchangeEnabled:{bitget:false,upbit:false,kiwoom:false,toss:false},
  });
  const decision=evaluateTradingPlan(exitInput(),policy,{emergencyStopped:true,serverLiveEnabled:true});
  for(const code of [
    'EMERGENCY_STOP_ACTIVE','NEW_ENTRIES_STOPPED','DAILY_LOSS_LIMIT','WEEKLY_LOSS_LIMIT',
    'ASSET_EXPOSURE_LIMIT','PROJECTED_ASSET_EXPOSURE_LIMIT','ACCOUNT_EXPOSURE_LIMIT',
    'INSTRUMENT_AMOUNT_LIMIT','STRATEGY_EXPOSURE_LIMIT','ASSET_CLASS_AMOUNT_LIMIT',
    'OPEN_RISK_LIMIT','OPEN_POSITION_LIMIT','DAILY_ORDER_LIMIT','CONSECUTIVE_LOSS_LIMIT',
    'FAST_MOVE_DETECTED','SPREAD_TOO_WIDE','ORDERBOOK_GAP','ESTIMATED_SLIPPAGE_LIMIT',
    'AVERAGE_SPREAD_LIMIT','CORRELATED_EXPOSURE_LIMIT','LIQUIDITY_LIMIT','MARKET_NOT_ENABLED',
    'EXCHANGE_NOT_ENABLED','ASSET_NOT_ENABLED','STRATEGY_NOT_ENABLED','AUTOMATIC_ECONOMICS_REQUIRED',
    'INSUFFICIENT_BALANCE','EXIT_PLAN_REQUIRED','SERVER_PROFITABILITY_ATTESTATION_REQUIRED',
  ]) assert.equal(decision.blockCodes.includes(code),false,code);
  assert.equal(decision.allowed,true,decision.blockCodes.join(','));
});

test('reduce-only risk envelope does not require or re-trigger an entry stop', () => {
  const input=exitInput();
  const now=new Date();
  const plan={...input,id:'11111111-1111-1111-1111-111111111111',userId:'22222222-2222-2222-2222-222222222222',
    idempotencyKey:'reduce-only-envelope',state:'SUBMITTED' as const,version:1,
    approvalExpiresAt:new Date(now.getTime()+60_000).toISOString(),approvedAt:now.toISOString(),
    createdAt:now.toISOString(),updatedAt:now.toISOString()};
  const envelope=buildRiskEnvelope(plan,DEFAULT_TRADING_POLICY,plan.approvedAt!);
  const approved=withRiskEnvelope(plan,envelope);
  const result=evaluateRiskEnvelope({plan:approved,snapshot:approved.marketSnapshot,now});
  assert.equal(result.allowed,true,result.blockCodes.join(','));
  assert.ok(envelope.maxLossKrw>0);
});
