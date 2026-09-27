import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseForwardAdmission, summarizeForwardAdmissionPreflight } from '../src/forward-admission-preflight.mjs';

function baseCard(){
  return {
    signalId:'sig-1',assetClass:'coin_futures',market:'BITGET_USDT_FUTURES',symbol:'BTCUSDT',
    action:'LONG',direction:'LONG',signalState:'WATCHING',signalGrade:'A',strongSignalEligible:true,
    strategyMode:'swing',dataState:'complete',dataSources:['bitget-public-ticker','bitget-public-candles'],
    dataQuality:{state:'TRUSTED',strongSignalAllowed:true},observedAt:'2026-09-27T00:00:00.000Z',
    expiresAt:'2026-09-27T03:00:00.000Z',price:100,pricePlan:{stopLoss:98,targets:[104]},
    paperCandidate:{
      executionAuthority:'NONE',liveOrderAllowed:false,privateTradingApiAllowed:false,orderSubmitted:false,exchangeRequestSent:false,
      signal:{signalId:'sig-1',market:'CRYPTO_FUTURES',symbol:'BTCUSDT',timeframe:'60m',horizon:6,direction:'LONG',style:'SWING',
        strategyIdentity:{strategyId:'s',strategyVersion:'v1',parameterHash:'p',researchCodeSha:'a'.repeat(40)}}
    }
  };
}

test('valid canonical scanner card is Forward-observable in diagnostic only',()=>{
  const r=diagnoseForwardAdmission(baseCard(),{expectedResearchSha:'a'.repeat(40)});
  assert.equal(r.forwardObservable,true);
  assert.equal(r.blockers.length,0);
  assert.equal(r.mutatesForward,false);
  assert.equal(r.executionAuthority,'NONE');
});

test('B-grade futures card exposes exact Forward grade blocker',()=>{
  const c=baseCard(); c.signalGrade='B'; c.backtestQuality={status:'missing'}; c.candidateRanking={watchReasons:['OOS/Walk-forward 검증 데이터 필요']};
  const r=diagnoseForwardAdmission(c);
  assert.equal(r.forwardObservable,false);
  assert.ok(r.blockers.some(x=>x.code==='SCANNER_GRADE_NOT_FORWARD_OBSERVABLE'));
  assert.deepEqual(r.diagnostics.backtestWatchReasons,['OOS/Walk-forward 검증 데이터 필요']);
});

test('spot card without canonical Paper candidate exposes exact blocker',()=>{
  const c=baseCard();
  c.assetClass='coin_spot'; c.market='UPBIT_KRW'; c.symbol='KRW-BTC'; c.action='BUY'; c.direction='LONG'; delete c.paperCandidate;
  const r=diagnoseForwardAdmission(c);
  assert.ok(r.blockers.some(x=>x.code==='CANONICAL_PAPER_CANDIDATE_REQUIRED'));
});

test('timeframe mismatch and unsafe candidate fail closed',()=>{
  const c=baseCard();
  c.paperCandidate.signal.timeframe='4H';
  c.paperCandidate.privateTradingApiAllowed=true;
  const r=diagnoseForwardAdmission(c);
  assert.ok(r.blockers.some(x=>x.code==='PAPER_TIMEFRAME_MISMATCH'));
  assert.ok(r.blockers.some(x=>x.code==='PAPER_CANDIDATE_PRIVATE_API_FORBIDDEN'));
});

test('summary preserves blocker counts without inventing readiness',()=>{
  const a=diagnoseForwardAdmission(baseCard());
  const b=baseCard(); b.signalGrade='B';
  const s=summarizeForwardAdmissionPreflight([a,diagnoseForwardAdmission(b)]);
  assert.equal(s.total,2); assert.equal(s.ready,1); assert.equal(s.blocked,1);
  assert.equal(s.blockerCounts.SCANNER_GRADE_NOT_FORWARD_OBSERVABLE,1);
  assert.equal(s.economicSampleCredit,0);
});
