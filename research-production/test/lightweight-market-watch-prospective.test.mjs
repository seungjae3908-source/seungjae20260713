import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_PROSPECTIVE_CONTRACT, WATCH_PROSPECTIVE_POLICY,
  advancePublicWatchProspectiveEvidence,
} from '../src/lightweight-market-watch-prospective.mjs';

const START = Date.parse('2026-10-09T03:00:00Z');
const SHA = 'a'.repeat(64);
function source(price, offsetMin, market = 'CRYPTO_FUTURES', sourceName = 'BITGET_PUBLIC_TICKERS') {
  return {
    market, status: 'READY', source: sourceName, listedCount: 1,
    quotes: [{
      symbol: 'BTCUSDT', price, sourceAtMs: START + offsetMin * 60_000,
      turnover24h: 10_000_000, change24hPercent: 0,
    }],
  };
}
function candidate(direction = 'UP') {
  return {
    eventId: SHA, market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT',
    source: 'BITGET_PUBLIC_TICKERS', direction,
    sourceAtMs: START,
    executionAuthority: 'NONE', isTradingSignal: false,
  };
}
function step(pending, offsetMin, price, { market = 'CRYPTO_FUTURES', sourceName = 'BITGET_PUBLIC_TICKERS' } = {}) {
  const item = source(price, offsetMin, market, sourceName);
  return advancePublicWatchProspectiveEvidence({
    previousPending: pending, nowMs: START + offsetMin * 60_000,
    sources: { [market]: item }, discovered: [],
  });
}
test('first observation cannot settle or create Paper/Live/PnL evidence', () => {
  const started = advancePublicWatchProspectiveEvidence({
    nowMs: START, previousPending: [],
    sources: { CRYPTO_FUTURES: source(100, 0) },
    discovered: [candidate()],
  });
  assert.equal(started.contract, WATCH_PROSPECTIVE_CONTRACT);
  assert.equal(started.pendingCount, 1);
  assert.equal(started.outcomes.length, 0);
  assert.equal(started.safety.priceSamplesOnly, true);
  assert.equal(started.safety.feeAdjustedPnLProvided, false);
  assert.equal(started.safety.orderAuthority, 'NONE');
  assert.equal(started.safety.paperOrderAuthority, false);
  assert.equal(started.safety.profitabilityProven, false);
  assert.equal(started.pending[0].sampleCount, 0);
});
test('UP follow-up uses only future public 2-minute ticker samples', () => {
  const started = advancePublicWatchProspectiveEvidence({
    nowMs: START, sources: { CRYPTO_FUTURES: source(100, 0) },
    discovered: [candidate()],
  });
  let pending = started.pending;
  for (const [m,price] of [[3,101],[7,99],[11,102],[15,103],[19,101.5]]) {
    const result = step(pending,m,price);
    assert.equal(result.outcomes.length,0);
    pending = result.pending;
  }
  // Evaluate at 20m using the last independently observed 19m ticker.
  // No 20m quote is synthesized merely because the wall clock advanced.
  const finished = advancePublicWatchProspectiveEvidence({
    previousPending: pending, nowMs: START + 20 * 60_000,
    sources: { CRYPTO_FUTURES: source(101.5, 19) },
    discovered: [],
  });
  assert.equal(finished.pendingCount,0);
  assert.equal(finished.completedCoarse,1);
  assert.equal(finished.blockedData,0);
  const o = finished.outcomes[0];
  assert.equal(o.status,'OBSERVED_COARSE');
  assert.equal(o.kind,'PUBLIC_PRICE_OBSERVATION_ONLY');
  assert.equal(o.sampledFutureN,5);
  assert.equal(o.sampledElapsedMs,19*60_000);
  assert.equal(o.horizonTargetMs,WATCH_PROSPECTIVE_POLICY.targetMs);
  assert.equal(o.sampledFavorableExcursionPercent,3);
  assert.equal(o.sampledAdverseExcursionPercent,-1);
  assert.equal(o.paperCredit,0);
  assert.equal(o.oosCredit,0);
  assert.equal(o.economicEvidenceCredit,0);
  assert.equal(o.profitabilityProven,false);
  assert.equal(o.isTradingSignal,false);
  assert.equal(o.orderAllowed,false);
  assert.equal(o.executionAuthority,'NONE');
});
test('DOWN uses inverse movement only as a price observation, not a short order', () => {
  const started = advancePublicWatchProspectiveEvidence({
    nowMs: START, sources:{CRYPTO_FUTURES:source(100,0)},
    discovered:[candidate('DOWN')],
  });
  let pending=started.pending;
  for(const[m,v]of [[3,102],[7,97],[11,96],[15,97],[19,99]])pending=step(pending,m,v).pending;
  const out=step(pending,20,99).outcomes[0];
  assert.equal(out.status,'OBSERVED_COARSE');
  assert.equal(out.direction,'DOWN');
  assert.equal(out.sampledFavorableExcursionPercent,4);
  assert.equal(out.sampledAdverseExcursionPercent,-2);
  assert.equal(out.orderAllowed,false);
});
test('no future quotes blocks; one new quote cannot become economic evidence', () => {
  const newOne=advancePublicWatchProspectiveEvidence({
    nowMs:START,sources:{CRYPTO_FUTURES:source(100,0)},discovered:[candidate()],
  });
  const dead=advancePublicWatchProspectiveEvidence({
    nowMs:START+25*60_000,previousPending:newOne.pending,
    sources:{},discovered:[],
  });
  assert.equal(dead.blockedData,1);
  assert.equal(dead.outcomes[0].status,'BLOCKED_DATA');
  assert.equal(dead.outcomes[0].sampledFavorableExcursionPercent,null);
  assert.equal(dead.outcomes[0].profitabilityProven,false);
});
test('late quote beyond 20-minute horizon never enters excursion', () => {
  const start=advancePublicWatchProspectiveEvidence({
    nowMs:START,sources:{CRYPTO_FUTURES:source(100,0)},discovered:[candidate()],
  });
  let pending=start.pending;
  for(const m of [3,7,11,15,19]) pending=step(pending,m,100).pending;
  const out=step(pending,21,999).outcomes[0];
  assert.equal(out.status,'OBSERVED_COARSE');
  assert.equal(out.sampledFavorableExcursionPercent,0);
  assert.equal(out.sampledAdverseExcursionPercent,0);
  assert.equal(out.sampledElapsedMs,19*60_000);
});
test('temporary blocked public HTTP source does not fake a provider change',()=>{
  const start=advancePublicWatchProspectiveEvidence({
    nowMs:START,sources:{CRYPTO_FUTURES:source(100,0)},discovered:[candidate()],
  });
  const blocked=advancePublicWatchProspectiveEvidence({
    nowMs:START+2*60_000,previousPending:start.pending,
    sources:{CRYPTO_FUTURES:{
      market:'CRYPTO_FUTURES',source:'NONE',status:'BLOCKED_PUBLIC_HTTP_429',
      listedCount:0,quotes:[],
    }},
  });
  assert.equal(blocked.pendingCount,1);
  assert.equal(blocked.outcomes.length,0);
  const recovered=step(blocked.pending,3,101);
  assert.equal(recovered.pendingCount,1);
  assert.equal(recovered.pending[0].sampleCount,1);
});
test('changing quote provider cannot reuse a different source price history',()=>{
  const start=advancePublicWatchProspectiveEvidence({
    nowMs:START,sources:{CRYPTO_FUTURES:source(100,0)},discovered:[candidate()],
  });
  const changed=step(start.pending,2,1000,{sourceName:'CHANGED_PUBLIC_API'});
  assert.equal(changed.pendingCount,0);
  assert.equal(changed.outcomes[0].status,'BLOCKED_DATA');
  assert.equal(changed.outcomes[0].reason,'PUBLIC_SOURCE_CHANGED');
  assert.equal(changed.outcomes[0].sampledFavorableExcursionPercent,null);
});
test('outcome IDs are deterministic across crash replay; later duplicates have zero economic authority',()=>{
  const s=advancePublicWatchProspectiveEvidence({
    nowMs:START,sources:{CRYPTO_FUTURES:source(100,0)},discovered:[candidate()],
  });
  const a=step(s.pending,25,100);
  const b=step(s.pending,25,100);
  assert.equal(a.outcomes[0].outcomeId,b.outcomes[0].outcomeId);
  assert.equal(a.outcomes[0].paperCredit,0);
  assert.equal(a.outcomes[0].economicEvidenceCredit,0);
  assert.equal(a.outcomes[0].oosCredit,0);
});
test('exact source quote and bounded pending buffer required',()=>{
  const noMatch=advancePublicWatchProspectiveEvidence({
    nowMs:START,sources:{CRYPTO_FUTURES:source(100,0)},
    discovered:[{...candidate(),sourceAtMs:START-1}],
  });
  assert.equal(noMatch.pendingCount,0);
  assert.equal(noMatch.notTrackedCount,1);
  assert.throws(()=>advancePublicWatchProspectiveEvidence({
    nowMs:START, previousPending:[{eventId:SHA}],sources:{},
  }),/WATCH_PROSPECTIVE_PENDING_INVALID/);
  assert.throws(()=>advancePublicWatchProspectiveEvidence({
    nowMs:START, discovered:[{...candidate(),eventId:'not-sha'}],
  }),/WATCH_PROSPECTIVE_DISCOVERY_INVALID/);
  assert.throws(()=>advancePublicWatchProspectiveEvidence({
    nowMs:START,previousPending:Array(1025).fill({}),
  }),/WATCH_PROSPECTIVE_INPUT_INVALID/);
});
