import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_CYCLE_COVERAGE_POLICY_VERSION,
  PUBLIC_V3_SPOT_STAGE_TWO_LIMIT,
  classifyPublicCycleLaneStatus,
  decidePublicCycleCursor,
} from '../src/public-cycle-coverage.mjs';

function result(changes={}) {
  return {
    outcome: null, dataState: 'untrusted', cards: [],
    universe: {
      totalCount: 4010, cursor: 0, nextCursor: 20,
      source: 'krx-symbol-master', partial: true, stale: false,
    },
    execution: {
      requestedCount: 20, startedCount: 20, completedCount: 20,
      providerErrorCount: 0, timeoutCount: 0, partial: false,
    },
    ...changes,
  };
}
test('partial current KRX eligible roster stays BLOCKED_DATA but advances attempted-only cursor', () => {
  const evidence = result();
  const status = classifyPublicCycleLaneStatus(evidence);
  assert.equal(status, 'BLOCKED_DATA');
  const decision = decidePublicCycleCursor({response:evidence,status,cursor:0});
  assert.equal(decision.nextCursor, 20);
  assert.equal(decision.blockedObservationOnly, true);
  assert.equal(decision.reason, 'BLOCKED_RESEARCH_ROTATION_ONLY');
  assert.equal(evidence.cards.length, 0);
  assert.equal(PUBLIC_CYCLE_COVERAGE_POLICY_VERSION, 'public-cycle-coverage-v1');
  assert.equal(PUBLIC_V3_SPOT_STAGE_TWO_LIMIT, 5, 'V3 must not request twenty deep Upbit symbols per strategy');
});
test('partial but provider errors, timeouts, stale or incomplete batch cannot advance', () => {
  const variants = [
    result({execution:{...result().execution,providerErrorCount:1}}),
    result({execution:{...result().execution,timeoutCount:1}}),
    result({execution:{...result().execution,completedCount:19}}),
    result({universe:{...result().universe,stale:true,source:'last-good-cache'}}),
    result({universe:{...result().universe,source:'curated-fallback'}}),
    result({outcome:'PROVIDER_FAILURE'}),
    result({universe:{...result().universe,nextCursor:10}}),
  ];
  for(const data of variants) {
    const status=classifyPublicCycleLaneStatus(data);
    const decision=decidePublicCycleCursor({response:data,status,cursor:0});
    assert.equal(decision.nextCursor,0,JSON.stringify(data));
    assert.equal(decision.blockedObservationOnly,false);
    assert.ok(status==='BLOCKED_DATA'||status==='SEARCH_FAILURE');
  }
});
test('valid full batch rotates, while missing evidence never becomes zero-trade', () => {
  const complete=result({
    dataState:'complete',
    cards:[{symbol:'BTC',direction:'LONG'}],
    universe:{...result().universe,partial:false},
  });
  assert.equal(classifyPublicCycleLaneStatus(complete),'CANDIDATES_AVAILABLE');
  const rotated=decidePublicCycleCursor({
    response:complete,status:'CANDIDATES_AVAILABLE',cursor:0,
  });
  assert.equal(rotated.nextCursor,20);
  assert.equal(rotated.blockedObservationOnly,false);
  const zero={...complete,cards:[]};
  assert.equal(classifyPublicCycleLaneStatus(zero),'VALID_NO_TRADE');
  const unavailable={...complete,execution:{...complete.execution,providerErrorCount:1},cards:[]};
  assert.equal(classifyPublicCycleLaneStatus(unavailable),'SEARCH_FAILURE');
  assert.equal(decidePublicCycleCursor({
    response:unavailable,status:'SEARCH_FAILURE',cursor:0,
  }).nextCursor,0);
  assert.equal(classifyPublicCycleLaneStatus(null),'SEARCH_FAILURE');
});
test('missing completed symbols cannot masquerade as valid no-trade or advance cursor', () => {
  const full=result({
    dataState:'complete',cards:[],
    universe:{...result().universe,partial:false},
  });
  for (const broken of [
    {...full, execution:{...full.execution,startedCount:19}},
    {...full, execution:{...full.execution,completedCount:19}},
    {...full, execution:{...full.execution,partial:true}},
    {...full, universe:{...full.universe,nextCursor:19}},
    {...full, universe:{...full.universe,nextCursor:null}},
    {...full, universe:{...full.universe,cursor:20}},
    {...full, universe:{...full.universe,totalCount:10}},
    {...full, execution:{...full.execution,requestedCount:0}},
  ]) {
    const status=classifyPublicCycleLaneStatus(broken);
    assert.equal(status,'SEARCH_FAILURE',JSON.stringify(broken));
    const cursor=decidePublicCycleCursor({response:broken,status,cursor:0});
    assert.equal(cursor.nextCursor,0);
    assert.equal(cursor.blockedObservationOnly,false);
  }
  const mismatched=decidePublicCycleCursor({
    response:full,status:'BLOCKED_DATA',cursor:0,
  });
  assert.equal(mismatched.nextCursor,0);
  assert.equal(mismatched.reason,'STATUS_EVIDENCE_MISMATCH');
});

test('a complete last page wraps, without pretending first-page or all-universe coverage', () => {
  const evidence=result({
    dataState:'complete',cards:[],
    universe:{totalCount:41,cursor:40,nextCursor:null,source:'bitget-public',partial:false,stale:false},
    execution:{requestedCount:1,startedCount:1,completedCount:1,providerErrorCount:0,timeoutCount:0,partial:false},
  });
  assert.equal(decidePublicCycleCursor({
    response:evidence,status:classifyPublicCycleLaneStatus(evidence),cursor:40,
  }).nextCursor,0);
  assert.throws(()=>decidePublicCycleCursor({response:evidence,status:'VALID_NO_TRADE',cursor:-1}),/CURSOR_INVALID/);
});
