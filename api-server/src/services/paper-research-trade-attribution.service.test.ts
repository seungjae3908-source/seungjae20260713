import test from 'node:test';
import assert from 'node:assert/strict';
import { explainAutomaticPaperTrade } from './paper-research-trade-attribution.service';
import type { UnifiedTradeCycle } from './unified-trade-journal.service';

const entryAt='2026-10-11T02:15:00.000Z';
const closedAt='2026-10-11T02:20:00.000Z';
const fixture=(changes: Record<string,unknown> = {}): UnifiedTradeCycle => ({
  source:'APP_PAPER',status:'CLOSED',market:'CRYPTO_FUTURES',currency:'USDT',
  openedAt:entryAt,closedAt,entryPrice:100,exitPrice:104,
  positionSide:'LONG',grossPnl:40,fees:3,tax:1,netPnl:36,
  stopLossPrice:98,targetPrice:104,
  costEvidence:{status:'READY'},
  technicalSnapshot:{
    contextSource:'PRE_TRADE_SNAPSHOT',capturedAt:'2026-10-11T02:14:00Z',
    volumeRatio:2.4,rsi:58,macd:3,macdSignal:2,marketRegime:'bull',
  },
  ...changes,
} as unknown as UnifiedTradeCycle);

test('verified simulated paper win separates target, price contribution and recorded charges', () => {
  const r=explainAutomaticPaperTrade(fixture());
  assert.equal(r.outcome,'PROFIT');
  assert.equal(r.netPnlNative,36);
  assert.equal(r.exitPriceProximity,'NEAR_TARGET_PRICE');
  assert.equal(r.grossPriceEffect,40);
  assert.equal(r.fees,3);
  assert.equal(r.tax,1);
  assert.ok(r.observedAtEntry.some(t=>t.includes('거래량')));
  assert.equal(r.causalImpactProven,false);
  assert.equal(r.externalAiCalled,false);
  assert.equal(r.profitabilityProven,false);
});
test('profitable gross price movement can become net loss after expenses', () => {
  const r=explainAutomaticPaperTrade(fixture({
    grossPnl:4,fees:8,tax:2,netPnl:-6,exitPrice:101,targetPrice:105,
  }));
  assert.equal(r.outcome,'LOSS');
  assert.ok(r.factualAttribution.some(t=>t.includes('수익에도')));
});
test('unverified full cost and LIVE source cannot be presented as paper economic proof', () => {
  for(const changes of [
    {source:'APP_REAL'}, {status:'OPEN'}, {netPnl:null},
    {costEvidence:{status:'NOT_AVAILABLE'}},{tax:null},
  ]) {
    const r=explainAutomaticPaperTrade(fixture(changes));
    assert.equal(r.status,'BLOCKED_EVIDENCE',JSON.stringify(changes));
    assert.equal(r.netPnlNative,null);
  }
});
test('after-the-fact and older signal snapshots do not become invented causes', () => {
  for(const snapshot of [
    {contextSource:'POST_HOC_RECONSTRUCTION',capturedAt:entryAt},
    {contextSource:'PRE_TRADE_SNAPSHOT',capturedAt:closedAt},
    {contextSource:'PRE_TRADE_SNAPSHOT',capturedAt:'2026-10-11T01:30:00Z'},
  ]) {
    const x=fixture({technicalSnapshot:{
      ...fixture().technicalSnapshot,...snapshot,volumeRatio:12,marketRegime:'bull',
    }});
    assert.deepEqual(explainAutomaticPaperTrade(x).observedAtEntry,[]);
  }
});
test('USD and USDT outcomes never silently convert to KRW or assert missing funding equals zero', () => {
  for(const currency of ['USD','USDT'] as const) {
    const r=explainAutomaticPaperTrade(fixture({currency}));
    assert.equal(r.currency,currency);
    assert.equal(r.netPnlNative,36);
    assert.ok(r.unknownReasons.some(t=>t.includes('환율')));
  }
});
