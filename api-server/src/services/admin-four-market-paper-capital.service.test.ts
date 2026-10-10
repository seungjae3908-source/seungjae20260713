import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredPaperJournalRecord, PaperJournalSyncRecord } from './paper-journal.types';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import {
  ADMIN_FOUR_PAPER_MARKETS, ADMIN_MARKET_INITIAL_KRW, ADMIN_TOTAL_INITIAL_KRW,
  adminPaperWalletId, adminPaperMarketFromPlan, adminMarketPaperRiskBudget,
  buildAdminFourMarketPaperBootstrap, inspectAdminFourMarketPaperWallets,
  buildMemberFourMarketPaperBootstrap, inspectMemberFourMarketPaperWallets,
  memberPaperWalletId, memberMarketPaperRiskBudget, projectMemberMarketCapital,
  MEMBER_MARKET_INITIAL_KRW, MEMBER_TOTAL_INITIAL_KRW,
  projectAdminMarketCapital,
  adminMarketCurrentEpochSettlementScope,
  adminMarketPaperAvailableBalance,
} from './admin-four-market-paper-capital.service';

const AT = new Date('2026-10-09T09:00:00Z');
function wallets(records = buildAdminFourMarketPaperBootstrap(AT)): StoredPaperJournalRecord[] {
  return records.map((row) => ({
    ...row, createdAt: AT.toISOString(), serverUpdatedAt: AT.toISOString(),
  }));
}
test('admin receives exactly four independent 1m Paper wallets in one epoch', () => {
  const initial = buildAdminFourMarketPaperBootstrap(AT);
  assert.equal(initial.length, 4);
  assert.deepEqual(initial.map((r) => r.id), ADMIN_FOUR_PAPER_MARKETS.map(adminPaperWalletId));
  assert.equal(initial.reduce((sum, r) => sum + Number(r.payload.initialBalance), 0), 4_000_000);
  assert.ok(initial.every((r) => r.version === 1 && r.deletedAt === null
    && r.payload.reserveWithdrawalAutomatic === false
    && r.payload.compoundShare === 0.5 && r.payload.reserveShare === 0.5));
  const result = inspectAdminFourMarketPaperWallets(wallets(), AT.getTime());
  assert.equal(result.ready, true);
  assert.equal(result.initialCapitalKrw, ADMIN_TOTAL_INITIAL_KRW);
  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    assert.equal(result.marketWallets[market].equityKrw, ADMIN_MARKET_INITIAL_KRW);
    assert.equal(result.marketWallets[market].openedAtMs, AT.getTime());
  }
});
test('member receives four independent 1m Paper wallets with the same 50/50 compound policy', () => {
  const initial = buildMemberFourMarketPaperBootstrap(AT);
  assert.equal(initial.length, 4);
  assert.deepEqual(initial.map((row) => row.id),
    ADMIN_FOUR_PAPER_MARKETS.map(memberPaperWalletId));
  assert.equal(initial.reduce((sum, row) => sum + Number(row.payload.initialBalance), 0),
    MEMBER_TOTAL_INITIAL_KRW);
  const stored = initial.map((row) => ({
    ...row, createdAt: AT.toISOString(), serverUpdatedAt: AT.toISOString(),
  }));
  const inspection = inspectMemberFourMarketPaperWallets(stored, AT.getTime());
  assert.equal(inspection.ready, true);
  assert.equal(inspection.role, 'member');
  assert.equal(inspection.initialCapitalKrw, 4_000_000);
  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    assert.equal(inspection.marketWallets[market].equityKrw, MEMBER_MARKET_INITIAL_KRW);
  }

  const settled = projectMemberMarketCapital('crypto_spot', [{
    id: 'member-spot-profit', market: 'crypto_spot',
    closedAt: new Date(AT.getTime() + 1_000).toISOString(),
    netPnlKrw: 100_000, fullCostsVerified: true, closeTimeFxVerified: true,
  }], AT.getTime() + 5_000);
  assert.equal(settled.operatingCapitalKrw, 1_050_000);
  assert.equal(settled.reserveKrw, 50_000);
  assert.equal(settled.reserveWithdrawalAutomatic, false);
  const budget = memberMarketPaperRiskBudget({
    market: 'crypto_spot', records: stored, openPlans: [],
    verifiedCapital: settled, nowMs: AT.getTime() + 5_000,
  });
  assert.equal(budget.ready, true);
  assert.equal(budget.availableToTradeKrw, 1_050_000);
  assert.equal(budget.reserveKrw, 50_000);
});
test('tampered, missing, tombstoned, staggered and legacy Paper wallets fail closed', () => {
  const w = wallets();
  const missing = inspectAdminFourMarketPaperWallets(w.slice(1), AT.getTime());
  assert.equal(missing.ready, false);
  assert.ok(missing.blockers.includes('ADMIN_PAPER_MARKET_WALLET_MISSING'));
  const changed = w.map((row, i) => i ? row : {
    ...row, payload: { ...row.payload, initialBalance: 500_000 },
  });
  assert.ok(inspectAdminFourMarketPaperWallets(changed, AT.getTime()).blockers
    .includes('ADMIN_PAPER_WALLET_INVALID'));
  const tombstone = w.map((row, i) => i ? row : { ...row, deletedAt: AT.toISOString() });
  assert.equal(inspectAdminFourMarketPaperWallets(tombstone, AT.getTime()).ready, false);
  const future = w.map((row, i) => i ? row : {
    ...row, createdAt: new Date(AT.getTime() + 10_000).toISOString(),
    serverUpdatedAt: new Date(AT.getTime() + 10_000).toISOString(),
  });
  assert.equal(inspectAdminFourMarketPaperWallets(future, AT.getTime()).ready, false);
  const old = [...w, { ...w[0], id: 'automatic-paper-account-v1' }];
  assert.ok(inspectAdminFourMarketPaperWallets(old, AT.getTime()).blockers
    .includes('ADMIN_PAPER_LEGACY_500K_WALLET_EXISTS'));
});
test('all four markets have separate, non-cross-subsidizing trading budgets', () => {
  const w = wallets();
  const evaluationMs = AT.getTime() + 24 * 60 * 60_000;
  const us = {
    exchange: 'kiwoom', market: 'US', accountMode: 'paper',
    executionMode: 'automatic', estimatedKrw: 700_000,
    createdAt: new Date(AT.getTime() + 1_000).toISOString(),
  } as TradingPlan;
  const spot = {
    exchange: 'upbit', market: 'KRW', accountMode: 'paper',
    executionMode: 'automatic', estimatedKrw: 100_000,
    createdAt: new Date(AT.getTime() + 1_000).toISOString(),
  } as TradingPlan;
  // Seed wallets are immutable. A loss is represented only by canonical,
  // fully-costed settlement evidence for the exact market lane.
  const usCapital = projectAdminMarketCapital('us_stock', [{
    id: 'us-loss', market: 'us_stock',
    closedAt: new Date(AT.getTime() + 2_000).toISOString(),
    netPnlKrw: -100_000, fullCostsVerified: true, closeTimeFxVerified: true,
  }], evaluationMs);
  const usBudget = adminMarketPaperRiskBudget({
    market: 'us_stock', records: w, openPlans: [us, spot], nowMs: evaluationMs,
    verifiedCapital: usCapital,
  });
  const krBudget = adminMarketPaperRiskBudget({
    market: 'domestic_stock', records: w, openPlans: [us, spot], nowMs: evaluationMs,
    verifiedCapital: projectAdminMarketCapital('domestic_stock', [], evaluationMs),
  });
  const spotBudget = adminMarketPaperRiskBudget({
    market: 'crypto_spot', records: w, openPlans: [us, spot], nowMs: evaluationMs,
    verifiedCapital: projectAdminMarketCapital('crypto_spot', [], evaluationMs),
  });
  assert.equal(usBudget.availableToTradeKrw, 200_000);
  assert.equal(krBudget.availableToTradeKrw, 1_000_000);
  assert.equal(spotBudget.availableToTradeKrw, 900_000);
  assert.equal(usBudget.accountValueKrw, 900_000);
  assert.equal(adminPaperMarketFromPlan(spot), 'crypto_spot');
});
test('old epoch entries, impossible exposure and missing wallet never count as free balance', () => {
  const oldPlan = {
    exchange: 'upbit', market: 'KRW', accountMode: 'paper',
    executionMode: 'automatic', estimatedKrw: 200_000,
    createdAt: new Date(AT.getTime() - 60_000).toISOString(),
  } as TradingPlan;
  const blocked = adminMarketPaperRiskBudget({
    market: 'crypto_spot', records: wallets(), openPlans: [oldPlan], nowMs: AT.getTime()+1_000,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.availableToTradeKrw, 0);
  const missing = adminMarketPaperRiskBudget({
    market: 'domestic_stock', records: [], openPlans: [],
  });
  assert.equal(missing.ready, false);
});
test('market-specific high-water mark produces half compound/half reserve without transfers', () => {
  const t = (i: number) => new Date(AT.getTime() + i * 1_000).toISOString();
  const trade = (id: string, amount: number, market: 'domestic_stock' | 'us_stock', i: number) => ({
    id,market,closedAt:t(i),netPnlKrw:amount,fullCostsVerified:true,closeTimeFxVerified:true,
  });
  const events = [trade('us-win',100_000,'us_stock',1),trade('us-loss',-25_000,'us_stock',2)];
  const us = projectAdminMarketCapital('us_stock', events, AT.getTime()+5_000);
  assert.equal(us.settlementReady,true);
  assert.equal(us.operatingCapitalKrw,1_025_000);
  assert.equal(us.reserveKrw,50_000);
  assert.equal(us.reserveWithdrawalAutomatic,false);
  const kr = projectAdminMarketCapital('domestic_stock',events, AT.getTime()+5_000);
  assert.equal(kr.operatingCapitalKrw,1_000_000);
  assert.equal(kr.reserveKrw,0);
  const noEvidence = projectAdminMarketCapital('crypto_spot', [{
    ...trade('invalid',100_000,'us_stock',1), market:'crypto_spot',
    fullCostsVerified:false,
  }], AT.getTime()+5_000);
  assert.equal(noEvidence.settlementReady,false);
  assert.equal(noEvidence.newEntriesAllowed,false);
  const loss = projectAdminMarketCapital('us_stock',[trade('loss',-100_000,'us_stock',1)],
    AT.getTime()+5_000);
  assert.equal(loss.operatingCapitalKrw,900_000);
  assert.equal(loss.newEntriesAllowed,false);
  const duplicate = projectAdminMarketCapital('us_stock',[
    trade('same',10_000,'us_stock',1),trade('same',10_000,'us_stock',1),
  ], AT.getTime()+5_000);
  assert.equal(duplicate.settlementReady,false);
});

test('simultaneous net loss never mints a false 50% reserve from ordering', () => {
  const at = new Date(AT.getTime()+1_000).toISOString();
  const projected = projectAdminMarketCapital('us_stock', [
    {id:'A',market:'us_stock',closedAt:at,netPnlKrw:100_000,fullCostsVerified:true,closeTimeFxVerified:true},
    {id:'B',market:'us_stock',closedAt:at,netPnlKrw:-150_000,fullCostsVerified:true,closeTimeFxVerified:true},
  ],AT.getTime()+5_000);
  assert.equal(projected.operatingCapitalKrw,950_000);
  assert.equal(projected.reserveKrw,0);
  assert.equal(projected.newEntriesAllowed,false);
});

test('market budget admits only canonical settlement-backed compounding and never borrows from another market', () => {
  const ready = wallets();
  const result = projectAdminMarketCapital('us_stock', [{
    id:'settled-us',market:'us_stock',closedAt:new Date(AT.getTime()+1_000).toISOString(),
    netPnlKrw:100_000,fullCostsVerified:true,closeTimeFxVerified:true,
  }],AT.getTime()+5_000);
  const us = adminMarketPaperRiskBudget({
    market:'us_stock',records:ready,openPlans:[],
    verifiedCapital:result,nowMs:AT.getTime()+5_000,
  });
  const kr = adminMarketPaperRiskBudget({
    market:'domestic_stock',records:ready,openPlans:[],
    verifiedCapital:projectAdminMarketCapital('domestic_stock',[],AT.getTime()+5_000),
    nowMs:AT.getTime()+5_000,
  });
  assert.equal(us.ready,true);
  assert.equal(us.availableToTradeKrw,1_050_000);
  assert.equal(us.reserveKrw,50_000);
  assert.equal(kr.availableToTradeKrw,1_000_000);
  const invalid = adminMarketPaperRiskBudget({
    market:'us_stock',records:ready,openPlans:[],
    verifiedCapital:projectAdminMarketCapital('us_stock',[{
      id:'no-fx',market:'us_stock',
      closedAt:new Date(AT.getTime()+1_000).toISOString(),
      netPnlKrw:100_000,fullCostsVerified:true,closeTimeFxVerified:false,
    }],AT.getTime()+5_000),nowMs:AT.getTime()+5_000,
  });
  assert.equal(invalid.ready,false);
  assert.equal(invalid.availableToTradeKrw,0);
});

test('admin market daily loss count and 50k net loss guard stay market-specific', () => {
  const now=AT.getTime()+10_000;
  const losses=Array.from({length:5},(_,i)=>({
    id:'losing-'+i,market:'crypto_spot' as const,
    closedAt:new Date(AT.getTime()+i*1000).toISOString(),
    netPnlKrw:-5_000,fullCostsVerified:true,closeTimeFxVerified:true,
  }));
  const projected=projectAdminMarketCapital('crypto_spot',losses,now);
  assert.equal(projected.dailyLosingTrades,5);
  assert.equal(projected.newEntriesAllowed,false);
  const untouched=projectAdminMarketCapital('domestic_stock',losses,now);
  assert.equal(untouched.dailyLosingTrades,0);
  assert.equal(untouched.newEntriesAllowed,true);
});

test('legacy and other-market Paper fills cannot be replayed into a new 1m admin campaign', () => {
  const epochMs = AT.getTime();
  const oldDate = new Date(epochMs - 60_000).toISOString();
  const currentDate = new Date(epochMs + 1_000).toISOString();
  const oldPlan = {
    id:'old-paper',userId:'owner-a',accountMode:'paper',executionMode:'automatic',
    exchange:'upbit',market:'KRW',createdAt:oldDate,
  } as TradingPlan;
  const newPlan = {...oldPlan,id:'new-paper',createdAt:currentDate};
  const otherMarket = {
    ...oldPlan,id:'us-paper',exchange:'kiwoom',market:'US',createdAt:currentDate,
  } as TradingPlan;
  const oldFill = {
    id:'old-fill',planId:oldPlan.id,userId:'owner-a',createdAt:oldDate,
    state:'FILLED',filledQuantity:2,
  } as TradingOrder;
  const newFill = {
    ...oldFill,id:'new-fill',planId:newPlan.id,createdAt:currentDate,
  };
  const otherFill = {
    ...oldFill,id:'us-fill',planId:otherMarket.id,createdAt:currentDate,
  };
  const scoped = adminMarketCurrentEpochSettlementScope({
    market:'crypto_spot',openedAtMs:epochMs,nowMs:epochMs+5_000,
    plans:[oldPlan,newPlan,otherMarket],orders:[oldFill,newFill,otherFill],
  });
  assert.equal(scoped.valid,true);
  assert.deepEqual(scoped.plans.map(p=>p.id),['new-paper']);
  assert.deepEqual(scoped.orders.map(o=>o.id),['new-fill']);
  const invalid = adminMarketCurrentEpochSettlementScope({
    market:'crypto_spot',openedAtMs:epochMs+20_000,nowMs:epochMs,
    plans:[newPlan],orders:[newFill],
  });
  assert.equal(invalid.valid,false);
  assert.deepEqual(invalid.orders,[]);
});

test('one verified small loss reduces actual collateral but does not falsely trigger five-loss stop', () => {
  const now = AT.getTime() + 10_000;
  const loss = [{
    id: 'first-loss', market: 'crypto_spot' as const,
    closedAt: new Date(AT.getTime() + 1_000).toISOString(),
    netPnlKrw: -5_000, fullCostsVerified: true, closeTimeFxVerified: true,
  }];
  const capital = projectAdminMarketCapital('crypto_spot', loss, now);
  assert.equal(capital.operatingCapitalKrw, 995_000);
  assert.equal(capital.reserveKrw, 0);
  assert.equal(capital.dailyLosingTrades, 1);
  assert.equal(capital.newEntriesAllowed, true);
  const budget = adminMarketPaperRiskBudget({
    market: 'crypto_spot', records: wallets(), openPlans: [],
    verifiedCapital: capital, nowMs: now,
  });
  assert.equal(budget.ready, true);
  assert.equal(budget.accountValueKrw, 995_000);
  assert.equal(budget.availableToTradeKrw, 995_000);
  const stopped = projectAdminMarketCapital('crypto_spot',
    Array.from({ length: 5 }, (_, i) => ({
      id: 'loss-'+i, market: 'crypto_spot' as const,
      closedAt: new Date(AT.getTime() + (i+1)*1_000).toISOString(),
      netPnlKrw: -5_000, fullCostsVerified: true, closeTimeFxVerified: true,
    })), now);
  assert.equal(stopped.dailyLosingTrades, 5);
  assert.equal(stopped.newEntriesAllowed, false);
});

test('verified 50/50 compound cash is market-local and cannot expand Live order policy', () => {
  assert.equal(adminMarketPaperAvailableBalance(1_000_000, 0, {
    ready: true, availableToTradeKrw: 1_050_000,
  }), 1_050_000);
  assert.equal(adminMarketPaperAvailableBalance(1_000_000, 100_000, {
    ready: true, availableToTradeKrw: 950_000,
  }), 950_000);
  assert.equal(adminMarketPaperAvailableBalance(1_000_000, 0, {
    ready: false, availableToTradeKrw: 1_050_000,
  }), 0);
  assert.equal(adminMarketPaperAvailableBalance(1_000_000, 0, {
    ready: true, availableToTradeKrw: Number.NaN,
  }), 0);
  assert.equal(adminMarketPaperAvailableBalance(1_000_000, 200_000), 800_000);
});

test('wallet seed alone cannot authorize Paper trading without canonical closing-ledger verification', () => {
  const missing=adminMarketPaperRiskBudget({
    market:'crypto_spot',records:wallets(),openPlans:[],nowMs:AT.getTime()+5_000,
  });
  assert.equal(missing.ready,false);
  assert.equal(missing.availableToTradeKrw,0);
  assert.ok(missing.blockers.includes('ADMIN_PAPER_CANONICAL_SETTLEMENT_REQUIRED'));
  const reviewed=adminMarketPaperRiskBudget({
    market:'crypto_spot',records:wallets(),openPlans:[],nowMs:AT.getTime()+5_000,
    verifiedCapital:projectAdminMarketCapital('crypto_spot',[],AT.getTime()+5_000),
  });
  assert.equal(reviewed.ready,true);
  assert.equal(reviewed.availableToTradeKrw,1_000_000);
});
