import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONE_DAY_MS,
  ONE_YEAR_FULL_STACK_GATE_V1,
  aggregateFourHourCandlesToUtcDaily,
  buildCanonicalFeatureAt,
  normalizeResearchCandles,
} from '../src/one-year-public-benchmark.mjs';

function candles(count=140){
  const start=Date.parse('2025-01-01T00:00:00.000Z');
  let price=100;
  return Array.from({length:count},(_,i)=>{
    const drift=(i%17===0?-1.2:0.45);
    const open=price;
    const close=Math.max(10,open+drift);
    const high=Math.max(open,close)+1;
    const low=Math.min(open,close)-1;
    price=close;
    return {ts:start+i*ONE_DAY_MS,open,high,low,close,volume:1000+i*7+(i%9===0?800:0)};
  });
}
const source={sourceId:'TEST_PUBLIC',originalSourceId:'TEST_PUBLIC',sourceType:'PUBLIC_MARKET_OHLCV',sourceUrl:'https://example.com/data'};

test('canonical feature snapshot is causal: future candle mutation cannot alter an earlier digest',()=>{
  const rows=candles();
  const index=100;
  const first=buildCanonicalFeatureAt({market:'US_STOCK',symbol:'TEST',side:'LONG',candles:rows,index,source});
  const changed=rows.map((row,i)=>i>index?{...row,close:row.close*5,high:row.high*5}:row);
  const second=buildCanonicalFeatureAt({market:'US_STOCK',symbol:'TEST',side:'LONG',candles:changed,index,source});
  assert.ok(['READY_FOR_SPECIALIST_RESEARCH_ONLY','PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(first.status));
  assert.equal(second.contentDigest,first.contentDigest);
  assert.equal(first.executionAuthority,'NONE');
});

test('one-year full stack stays fail-closed without PIT news/disclosure/AI history',()=>{
  assert.equal(ONE_YEAR_FULL_STACK_GATE_V1.status,'BLOCKED_DATA');
  assert.equal(ONE_YEAR_FULL_STACK_GATE_V1.newsScoreImpact,0);
  assert.equal(ONE_YEAR_FULL_STACK_GATE_V1.aiScoreImpact,0);
  assert.equal(ONE_YEAR_FULL_STACK_GATE_V1.economicSampleCredit,0);
});

test('4h aggregation accepts only complete six-bar UTC days',()=>{
  const start=Date.parse('2026-01-01T00:00:00.000Z');
  const rows=[];
  for(let d=0;d<2;d+=1) for(let i=0;i<6;i+=1){
    const ts=start+(d*6+i)*4*60*60*1000;
    rows.push({ts,open:100,high:102,low:99,close:101,volume:10});
  }
  rows.pop();
  const daily=aggregateFourHourCandlesToUtcDaily(rows);
  assert.equal(daily.length,1);
  assert.equal(daily[0].volume,60);
});

test('normalizer rejects duplicate timestamps',()=>{
  const rows=candles(3);
  assert.throws(()=>normalizeResearchCandles([rows[0],rows[0]],{intervalMs:ONE_DAY_MS}),/unique ascending/);
});
