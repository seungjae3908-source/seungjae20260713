import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdminFourMarketPaperBootstrap } from './admin-four-market-paper-capital.service';
import { adminFourMarketPaperCapitalReadback } from './admin-four-market-paper-readback.service';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

const NOW = Date.UTC(2026,9,9,3,0,0);
const opened = new Date(NOW - 120_000).toISOString();
function records(): StoredPaperJournalRecord[] {
  return buildAdminFourMarketPaperBootstrap(new Date(opened)).map(row => ({
    ...row,createdAt:opened,serverUpdatedAt:opened,
  }));
}
test('admin readback reports 1m virtual seed and zero reserve until a canonical settled close exists', () => {
  const response = adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),plans:[],orders:[],nowMs:NOW,
  });
  assert.equal(response.walletReady,true);
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const) {
    assert.equal(response.marketReadback[market].settlementReady,true);
    assert.equal(response.marketReadback[market].operatingCapitalKrw,1_000_000);
    assert.equal(response.marketReadback[market].reserveKrw,0);
    assert.equal(response.marketReadback[market].newEntriesAllowed,true);
  }
  assert.equal(response.realOrdersPlaced,false);
  assert.equal(response.reserveTransferred,false);
});
test('a malformed new-epoch FILLED order is blocked for its market and never reported as zero-loss equity', () => {
  const plan = {
    id:'post-wallet-spot',userId:'owner-only',accountMode:'paper',
    executionMode:'automatic',exchange:'upbit',market:'KRW',
    createdAt:new Date(NOW - 60_000).toISOString(),
  } as TradingPlan;
  const badOrder={
    id:'unverified-fill',userId:'owner-only',planId:plan.id,
    state:'FILLED',createdAt:new Date(NOW-40_000).toISOString(),
    filledQuantity:0,averageFillPrice:null,
  } as TradingOrder;
  const status=adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),plans:[plan],orders:[badOrder],nowMs:NOW,
  });
  const spot=status.marketReadback.crypto_spot;
  assert.equal(spot.settlementReady,false);
  assert.equal(spot.operatingCapitalKrw,null);
  assert.equal(spot.reserveKrw,null);
  assert.ok(spot.blockers.includes('ADMIN_PAPER_FILL_EXECUTION_EVIDENCE_INCOMPLETE'));
  assert.equal(status.marketReadback.us_stock.settlementReady,true);
});
test('old-epoch fills cannot affect a new 1m market cash or reserve display', () => {
  const oldPlan={
    id:'old-spot',userId:'owner-only',accountMode:'paper',
    executionMode:'automatic',exchange:'upbit',market:'KRW',
    createdAt:new Date(NOW - 900_000).toISOString(),
  } as TradingPlan;
  const oldOrder={
    id:'old-fill',userId:'owner-only',planId:oldPlan.id,
    state:'FILLED',filledQuantity:1,averageFillPrice:100,
    createdAt:new Date(NOW-850_000).toISOString(),
  } as TradingOrder;
  const result=adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),plans:[oldPlan],orders:[oldOrder],nowMs:NOW,
  });
  assert.equal(result.marketReadback.crypto_spot.operatingCapitalKrw,1_000_000);
  assert.equal(result.marketReadback.crypto_spot.reserveKrw,0);
});
test('a missing market wallet cannot be depicted as settled or available', () => {
  const result=adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records().slice(1),
    plans:[],orders:[],nowMs:NOW,
  });
  assert.equal(result.walletReady,false);
  assert.equal(result.marketReadback.us_stock.settlementReady,false);
  assert.equal(result.marketReadback.us_stock.operatingCapitalKrw,null);
});

test('a post-epoch retry of an old Paper plan is blocked for its market, not hidden as zero PnL', () => {
  const oldPlan={
    id:'old-late-spot',userId:'owner-only',accountMode:'paper',
    executionMode:'automatic',exchange:'upbit',market:'KRW',
    createdAt:new Date(NOW-900_000).toISOString(),
  } as TradingPlan;
  const lateFill={
    id:'old-late-fill',userId:'owner-only',planId:oldPlan.id,
    state:'FILLED',filledQuantity:1,averageFillPrice:100,
    createdAt:new Date(NOW-35_000).toISOString(),
  } as TradingOrder;
  const status=adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),
    plans:[oldPlan],orders:[lateFill],nowMs:NOW,
  });
  assert.equal(status.marketReadback.crypto_spot.settlementReady,false);
  assert.equal(status.marketReadback.crypto_spot.operatingCapitalKrw,null);
  assert.equal(status.marketReadback.crypto_spot.reserveKrw,null);
  assert.deepEqual(status.marketReadback.crypto_spot.blockers,['ADMIN_PAPER_LEGACY_RETRY_AFTER_NEW_EPOCH']);
  assert.equal(status.marketReadback.us_stock.settlementReady,true);
  assert.equal(status.marketReadback.domestic_stock.settlementReady,true);
});

test('cross-account canonical Paper rows never count as the current admin ledger', () => {
  const otherPlan={
    id:'other-owner',userId:'different-owner',accountMode:'paper',
    executionMode:'automatic',exchange:'upbit',market:'KRW',
    createdAt:new Date(NOW-25_000).toISOString(),
  } as TradingPlan;
  const status=adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),plans:[otherPlan],orders:[],nowMs:NOW,
  });
  assert.equal(status.marketReadback.crypto_spot.settlementReady,false);
  assert.ok(status.marketReadback.crypto_spot.blockers.includes('ADMIN_PAPER_OWNER_SCOPE_MISMATCH'));
  assert.equal(status.marketReadback.us_stock.settlementReady,false);
});


function certifiedAutoPaperPair(input: {
  id: string; exchange: 'kiwoom' | 'upbit' | 'bitget';
  market: string; symbol: string;
  entrySide: 'buy' | 'long'; exitSide: 'sell' | 'short';
  entryPrice: number; exitPrice: number;
  entryFx: number; exitFx: number;
  fxSource: string; tax?: number | null;
}) {
  const start = new Date(NOW - 90_000).toISOString();
  const close = new Date(NOW - 30_000).toISOString();
  // Build real contract-shaped fixtures rather than asserting sparse JSON as
  // TradingPlan/TradingOrder. This keeps settlement regression tests bound to
  // the same typed invariants as the Paper execution repository.
  const mkPlan = (exit: boolean): TradingPlan => {
    const stamp = exit ? close : start;
    const price = exit ? input.exitPrice : input.entryPrice;
    const id = input.id + (exit ? '-exit' : '-entry');
    return {
      id, userId: 'owner-only', idempotencyKey: 'idem-' + id,
      state: 'SUBMITTED', version: 1, approvalExpiresAt: null,
      approvedAt: stamp, createdAt: stamp, updatedAt: stamp,
      executionMode: 'automatic', accountMode: 'paper',
      exchange: input.exchange, market: input.market, symbol: input.symbol,
      stockBroker: input.exchange === 'kiwoom' ? 'kiwoom' : null,
      stockExchange: input.exchange === 'kiwoom' ? 'NASDAQ' : null,
      side: exit ? input.exitSide : input.entrySide,
      orderType: 'market', quantity: 1, quoteAmount: null, limitPrice: null,
      estimatedKrw: price * (exit ? input.exitFx : input.entryFx),
      reduceOnly: exit, signalId: input.id + '-signal',
      strategyId: 's-qualified-paper', stopPrice: 0, targetPrices: [],
      splitRatios: [100], leverage: input.exchange === 'bitget' ? 2 : null,
      marginMode: input.exchange === 'bitget' ? 'isolated' : null,
      invalidateAction: 'hold', signalReasons: [],
      marketSnapshot: {
        observedAt: stamp, currentPrice: price, dataDelayMs: 0,
        oneMinuteMovePercent: 0, spreadPercent: 0, orderbookGapPercent: 0,
        halted: false, availableBalance: 1_000_000, accountValueKrw: 1_000_000,
        dailyPnlPercent: 0, assetExposurePercent: 0, openPositionCount: 0,
        dailyOrderCount: 0, consecutiveLosses: 0,
      },
    };
  };
  const makeOrder = (plan: TradingPlan, exit: boolean): TradingOrder => {
    const stamp = exit ? close : start;
    const feeCurrency = input.exchange === 'kiwoom' ? 'USD'
      : input.exchange === 'bitget' ? 'USDT' : 'KRW';
    return {
      id: plan.id + '-fill', planId: plan.id, userId: 'owner-only',
      state: 'FILLED', version: 1, exchange: input.exchange,
      createdAt: stamp, updatedAt: stamp,
      clientOrderId: plan.id + '-client', exchangeOrderId: plan.id + '-exchange',
      filledQuantity: 1, requestedQuantity: 1, remainingQuantity: 0,
      currentLimitPrice: null,
      averageFillPrice: exit ? input.exitPrice : input.entryPrice,
      feeAmount: 0, feeCurrency,
      taxAmount: input.tax === null ? null : input.tax ?? 0,
      taxCurrency: input.tax === null ? null : feeCurrency,
      settlementFxEvidence: {
        krwPerQuoteCurrency: exit ? input.exitFx : input.entryFx,
        source: input.fxSource, observedAt: stamp,
      },
      fills: [], retryCount: 0, nextRetryAt: null, lastErrorCode: null,
    };
  };
  const first = mkPlan(false), last = mkPlan(true);
  return {
    plans: [first, last], orders: [makeOrder(first, false), makeOrder(last, true)],
  };
}

test('KRW, USD stock and USDT perpetual paper settlements use authenticated per-fill FX and separate 50/50 reserves', () => {
  const us = certifiedAutoPaperPair({
    id:'us-fx', exchange:'kiwoom', market:'US', symbol:'AAPL',
    entrySide:'buy', exitSide:'sell', entryPrice:100, exitPrice:110,
    entryFx:1300,exitFx:1350,fxSource:'YAHOO:USDKRW=X',
  });
  const spot = certifiedAutoPaperPair({
    id:'spot-native',exchange:'upbit',market:'KRW',symbol:'BTC',
    entrySide:'buy',exitSide:'sell',entryPrice:100_000,exitPrice:110_000,
    entryFx:1,exitFx:1,fxSource:'NATIVE_KRW',
  });
  const futures = certifiedAutoPaperPair({
    id:'futures-usdt',exchange:'bitget',market:'USDT-FUTURES',symbol:'BTCUSDT',
    entrySide:'long',exitSide:'short',entryPrice:100,exitPrice:110,
    entryFx:1300,exitFx:1350,fxSource:'UPBIT:KRW-USDT',
  });
  const state = adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only', records:records(),
    plans:[...us.plans,...spot.plans,...futures.plans],
    orders:[...us.orders,...spot.orders,...futures.orders],
    nowMs:NOW,
  });
  assert.equal(state.marketReadback.us_stock.settlementReady,true);
  assert.equal(state.marketReadback.us_stock.operatingCapitalKrw,1_009_250);
  assert.equal(state.marketReadback.us_stock.reserveKrw,9_250);
  assert.equal(state.marketReadback.crypto_spot.operatingCapitalKrw,1_005_000);
  assert.equal(state.marketReadback.crypto_spot.reserveKrw,5_000);
  // USDT-margined futures realize their native PnL at close-time FX, not
  // the fictitious FX gain on a leveraged notional cash purchase.
  assert.equal(state.marketReadback.crypto_futures.operatingCapitalKrw,1_006_750);
  assert.equal(state.marketReadback.crypto_futures.reserveKrw,6_750);
  assert.equal(state.marketReadback.domestic_stock.operatingCapitalKrw,1_000_000);
  assert.equal(state.reserveTransferred,false);
});

test('unknown tax and unbound or forged FX cannot mint 1m Paper capital or reserve', () => {
  const valid = certifiedAutoPaperPair({
    id:'unverified-us',exchange:'kiwoom',market:'US',symbol:'AAPL',
    entrySide:'buy',exitSide:'sell',entryPrice:100,exitPrice:120,
    entryFx:1400,exitFx:1400,fxSource:'YAHOO:USDKRW=X',
  });
  const missingTax=valid.orders.map((order,i) => i
    ? ({...order, taxAmount:null, taxCurrency:null}) as TradingOrder : order);
  const missingFx=valid.orders.map((order,i) => i
    ? ({...order, settlementFxEvidence:null}) as TradingOrder : order);
  const forgedRate=valid.orders.map((order,i) => i
    ? ({...order, settlementFxEvidence:{
      krwPerQuoteCurrency:50_000,source:'NATIVE_KRW',
      observedAt:new Date(NOW-30_000).toISOString(),
    }}) as TradingOrder : order);
  for(const orders of [missingTax,missingFx,forgedRate]) {
    const state=adminFourMarketPaperCapitalReadback({
      ownerId:'owner-only',records:records(),plans:valid.plans,orders,nowMs:NOW,
    });
    const us=state.marketReadback.us_stock;
    assert.equal(us.settlementReady,false);
    assert.equal(us.operatingCapitalKrw,null);
    assert.equal(us.reserveKrw,null);
    assert.equal(us.newEntriesAllowed,false);
  }
});

test('non-finite canonical Paper tax and fee receipts never mint compound capital', () => {
  const valid = certifiedAutoPaperPair({
    id:'invalid-amount',exchange:'kiwoom',market:'US',symbol:'AAPL',
    entrySide:'buy',exitSide:'sell',entryPrice:100,exitPrice:120,
    entryFx:1400,exitFx:1400,fxSource:'YAHOO:USDKRW=X',
  });
  for (const mutation of [
    {feeAmount:Number.NaN}, {feeAmount:Number.POSITIVE_INFINITY},
    {taxAmount:Number.NaN}, {taxAmount:Number.POSITIVE_INFINITY},
  ]) {
    const orders=valid.orders.map((order,i)=>i===1
      ? {...order,...mutation} as TradingOrder : order);
    const state=adminFourMarketPaperCapitalReadback({
      ownerId:'owner-only',records:records(),plans:valid.plans,orders,nowMs:NOW,
    });
    const market=state.marketReadback.us_stock;
    assert.equal(market.settlementReady,false);
    assert.equal(market.operatingCapitalKrw,null);
    assert.equal(market.reserveKrw,null);
    assert.equal(market.newEntriesAllowed,false);
  }
});

test('duplicate broker-facing Paper order identity cannot bind a second fill or mint reserves', () => {
  const valid = certifiedAutoPaperPair({
    id:'alias-collision',exchange:'kiwoom',market:'US',symbol:'AAPL',
    entrySide:'buy',exitSide:'sell',entryPrice:100,exitPrice:120,
    entryFx:1400,exitFx:1400,fxSource:'YAHOO:USDKRW=X',
  });
  const reusedBrokerAlias = valid.orders[0]!.exchangeOrderId;
  assert.ok(reusedBrokerAlias);
  const orders = valid.orders.map((order, index) => index === 1
    ? { ...order, exchangeOrderId: reusedBrokerAlias }
    : order);
  const state = adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),plans:valid.plans,orders,nowMs:NOW,
  });
  const us = state.marketReadback.us_stock;
  assert.equal(us.settlementReady,false);
  assert.deepEqual(us.blockers,['ADMIN_PAPER_CANONICAL_ORDER_IDENTITY_COLLISION']);
  assert.equal(us.operatingCapitalKrw,null);
  assert.equal(us.reserveKrw,null);
  assert.equal(us.newEntriesAllowed,false);
  assert.equal(state.reserveTransferred,false);
});

test('duplicate internal canonical order IDs with distinct broker aliases cannot create Paper reserves', () => {
  const valid = certifiedAutoPaperPair({
    id:'canonical-row-collision',exchange:'kiwoom',market:'US',symbol:'AAPL',
    entrySide:'buy',exitSide:'sell',entryPrice:100,exitPrice:120,
    entryFx:1400,exitFx:1400,fxSource:'YAHOO:USDKRW=X',
  });
  const repeatedRow = {
    ...valid.orders[0]!,
    // Broker ID is not duplicated: only the canonical repository ID is.
    // A distinct displayed alias must not make one fill count twice.
    exchangeOrderId:'second-exchange-alias',
    clientOrderId:'second-client-alias',
  };
  const state = adminFourMarketPaperCapitalReadback({
    ownerId:'owner-only',records:records(),plans:valid.plans,
    orders:[...valid.orders,repeatedRow],nowMs:NOW,
  });
  const us = state.marketReadback.us_stock;
  assert.equal(us.settlementReady,false);
  assert.deepEqual(us.blockers,['ADMIN_PAPER_CANONICAL_ORDER_IDENTITY_COLLISION']);
  assert.equal(us.operatingCapitalKrw,null);
  assert.equal(us.reserveKrw,null);
  assert.equal(us.newEntriesAllowed,false);
  assert.equal(state.reserveTransferred,false);
});
