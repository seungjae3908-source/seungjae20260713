import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_FOUR_MARKET_KEYS, parseFourPaperReadOnlyStatus } from './four-market-paper-status';

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
    operatingCapitalKrw:null,reserveKrw:null,dailyLosingTrades:null,
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
      dailyLosingTrades:0,blockers:[],
    };
  }
  const value=parseFourPaperReadOnlyStatus(state);
  assert.equal(value.marketCapital.us_stock.operatingCapitalKrw,1000000);
  assert.equal(value.marketCapital.crypto_futures.newEntriesAllowed,false);
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
