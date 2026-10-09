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
