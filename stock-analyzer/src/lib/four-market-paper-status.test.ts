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
  assert.throws(() => parseFourPaperReadOnlyStatus(fifthLoss));
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
