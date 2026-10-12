import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_FOUR_MARKET_KEYS, parseFourPaperReadOnlyStatus, summarizeFourPaperReadOnlyStatus } from './four-market-paper-status';

const fixture = () => ({
  ok:true, mode:'four-market-paper-readiness-only',
  readOnlyProbe:true, ownerScope:'SELF', role:'member',
  ready:false, canCreate:false, rlsGuardReady:false,
  perMarketInitialKrw:1_000_000,totalInitialKrw:4_000_000,
  creationBlockers:['PAPER_FOUR_MARKET_DATABASE_GUARD_REQUIRED'],
  financialMutationCount:0, privateProviderRequests:0,
  orderSubmitted:false, exchangeRequestSent:false,
  liveTradingAuthorityGranted:false, autoTradingAuthorityGranted:false,
  transferAuthorityGranted:false, withdrawalAuthorityGranted:false,
  marketCapital:Object.fromEntries(PAPER_FOUR_MARKET_KEYS.map(({key}) => [key, {
    settlementReady:false, newEntriesAllowed:false,
    operatingCapitalKrw:null,reserveKrw:null,dailyLosingTrades:null,settledTrades:null,
    blockers:['MEMBER_PAPER_WALLET_NOT_READY'],
  }])),
});
test('missing member RLS means four wallets have unverified, never zero-valued financial balances', () => {
  const state=parseFourPaperReadOnlyStatus(fixture());
  assert.equal(state.rlsGuardReady,false);
  for(const {key} of PAPER_FOUR_MARKET_KEYS) {
    assert.equal(state.marketCapital[key].operatingCapitalKrw,null);
    assert.equal(state.marketCapital[key].reserveKrw,null);
  }
});
test('a verified 4-market immutable Paper readback can render without order authority', () => {
  const state=fixture();
  state.ready=true;state.rlsGuardReady=true;
  for(const {key} of PAPER_FOUR_MARKET_KEYS) {
    state.marketCapital[key]={
      settlementReady:true, newEntriesAllowed:key!=='crypto_futures',
      operatingCapitalKrw:1_000_000,reserveKrw:0,
      dailyLosingTrades:0,settledTrades:0,blockers:[],
    };
  }
  const value=parseFourPaperReadOnlyStatus(state);
  assert.equal(value.marketCapital.us_stock.operatingCapitalKrw,1000000);
  assert.equal(value.marketCapital.crypto_futures.newEntriesAllowed,false);
  assert.equal(summarizeFourPaperReadOnlyStatus(value), '정산 확인 · 일부 시장 신규진입 차단');
});
test('an invalid balance, missing protected RLS or impersonated mutation rights cannot be shown', () => {
  for(const change of [
    {ready:true},{ownerScope:'OTHER'},{orderSubmitted:true},
    {exchangeRequestSent:true},{liveTradingAuthorityGranted:true},
    {autoTradingAuthorityGranted:true},{financialMutationCount:1},
    {privateProviderRequests:1},{transferAuthorityGranted:true},
    {withdrawalAuthorityGranted:true},{totalInitialKrw:2000000},
  ]) assert.throws(() => parseFourPaperReadOnlyStatus({...fixture(),...change}));
  for(const name of ['reserveKrw','operatingCapitalKrw','dailyLosingTrades']) {
    const f=fixture();f.marketCapital.crypto_futures={
      ...f.marketCapital.crypto_futures, [name]:5000,
    };
    assert.throws(() => parseFourPaperReadOnlyStatus(f));
  }
});

test('wallet existence alone never claims four-market settlement or entry readiness', () => {
  const pending = fixture();
  pending.ready = true;
  pending.rlsGuardReady = true;
  const verified = parseFourPaperReadOnlyStatus(pending);
  assert.equal(summarizeFourPaperReadOnlyStatus(verified), '계좌 확인 · 일부 시장 정산 미확인');
  assert.equal(summarizeFourPaperReadOnlyStatus(parseFourPaperReadOnlyStatus(fixture())), '회원 DB 보호 미적용');
});
test('malformed Paper admission is rejected even if individual fields look valid', () => {
  const ready = fixture();
  ready.ready = true;
  ready.rlsGuardReady = true;
  const settled = {
    settlementReady: true, newEntriesAllowed: true,
    operatingCapitalKrw: 1_000_000, reserveKrw: 0,
    dailyLosingTrades: 0, settledTrades: 0, blockers: [],
  };
  for (const {key} of PAPER_FOUR_MARKET_KEYS) ready.marketCapital[key] = {...settled};
  assert.equal(summarizeFourPaperReadOnlyStatus(parseFourPaperReadOnlyStatus(ready)), '4시장 계좌·정산·진입 검증됨');

  const missingWallet = {...ready, ready:false, marketCapital:{...ready.marketCapital}};
  assert.throws(() => parseFourPaperReadOnlyStatus(missingWallet));
  const fifthLoss = {...ready, marketCapital:{
    ...ready.marketCapital,
    crypto_futures: {...settled, dailyLosingTrades:5},
  }};
  const observed=parseFourPaperReadOnlyStatus(fifthLoss);
  assert.equal(observed.marketCapital.crypto_futures.dailyLosingTrades,5);
  assert.equal(observed.marketCapital.crypto_futures.newEntriesAllowed,true);
  assert.equal(summarizeFourPaperReadOnlyStatus(observed),'4시장 계좌·정산·진입 검증됨');
  const unverifiedCount = {...ready, marketCapital:{
    ...ready.marketCapital,
    us_stock: {...settled, settledTrades:undefined},
  }};
  assert.throws(() => parseFourPaperReadOnlyStatus(unverifiedCount));
  const misleadingBlocker = {...ready, marketCapital:{
    ...ready.marketCapital,
    domestic_stock: {...settled, blockers:['COST_UNKNOWN']},
  }};
  assert.throws(() => parseFourPaperReadOnlyStatus(misleadingBlocker));
});


test('historical Paper audit renders bounded 17/15/2 status without inventing realized profit',()=>{
  const zero=()=>({
    paperOrders:0,filledOrders:0,partialOrders:0,
    invalidFilledOrders:0,aggregateOnlyFilledOrders:0,
    confirmedJournalMirrors:0,missingJournalMirrors:0,
    conflictingJournalMirrors:0,missingFullCostEvidence:0,
  });
  const lanes=Object.fromEntries(PAPER_FOUR_MARKET_KEYS.map(({key})=>[key,zero()]));
  const spot={
    ...zero(),paperOrders:17,filledOrders:17,invalidFilledOrders:2,
    aggregateOnlyFilledOrders:15,confirmedJournalMirrors:15,
    missingFullCostEvidence:15,
  };
  lanes.crypto_spot=spot;
  const a={
    version:'automatic-paper-history-audit-v1',
    readOnlyProbe:true,ownerScope:'SELF',
    status:'INCOMPLETE_EXECUTION_EVIDENCE',
    totals:{...spot},markets:lanes,
    actualSettlementProven:false,profitabilityProven:false,
    financialMutationCount:0,privateProviderRequests:0,executionAuthority:'NONE',
  };
  const parsed=parseFourPaperReadOnlyStatus({...fixture(),automaticPaperExecutionAudit:a});
  assert.equal(parsed.automaticPaperExecutionAudit?.totals.invalidFilledOrders,2);
  assert.equal(parsed.automaticPaperExecutionAudit?.totals.confirmedJournalMirrors,15);
  assert.equal(parsed.automaticPaperExecutionAudit?.actualSettlementProven,false);
  const tamper=[
    {...a,profitabilityProven:true},
    {...a,executionAuthority:'LIVE'},
    {...a,privateProviderRequests:1},
    {...a,ownerScope:'OTHER'},
    {...a,totals:{...spot,invalidFilledOrders:0}},
    {...a,markets:{...lanes,us_stock:{...zero(),paperOrders:1}}},
    {...a,status:'NO_HISTORY'},
  ];
  for(const candidate of tamper){
    assert.throws(()=>parseFourPaperReadOnlyStatus({
      ...fixture(),automaticPaperExecutionAudit:candidate,
    }),/PAPER_EXECUTION_HISTORY/);
  }
  // Older Production Paper-only status JSON remains readable during a safe,
  // source-controlled rollout; absent audit never implies zero anomalies.
  assert.equal(parseFourPaperReadOnlyStatus(fixture()).automaticPaperExecutionAudit,undefined);
});
