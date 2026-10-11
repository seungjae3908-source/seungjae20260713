import test from 'node:test';
import assert from 'node:assert/strict';
import {krAlphaDailyCode,normalizePublicKrAlphaDaily,publicKrAlphaDailyQuote,
  createPublicKrAlphaDailyFeed} from '../src/public-kr-alpha-daily.mjs';
const day=(d,n)=>({localDateTime:d,openPrice:(n-1).toLocaleString('en-US'),
 highPrice:(n+2).toLocaleString('en-US'),lowPrice:(n-2).toLocaleString('en-US'),
 currentPrice:n.toLocaleString('en-US'),accumulatedTradingVolume:'1,000'});
const rows=()=>Array.from({length:40},(_,i)=>day('202608'+String(i+1).padStart(2,'0'),100+i));
const validRows=()=>{
 const start=Date.UTC(2026,6,1);
 return Array.from({length:40},(_,i)=>{
   const date=new Date(start+i*86400000).toISOString().slice(0,10).replace(/-/gu,'');
   return day(date,100+i);
 });
};
const clock=Date.parse('2026-10-11T05:00:00Z');
test('real Naver-compatible field names normalize into sorted, close-only daily candles and conservative quotes',()=>{
 const chart={code:'0193W0',priceInfos:validRows().reverse()};
 const candles=normalizePublicKrAlphaDaily(chart,'0193W0',clock);
 assert.equal(candles.length,40);
 assert.ok(Date.parse(candles.at(-1).time)>Date.parse(candles[0].time));
 assert.equal(candles[0].open,99);
 assert.equal(candles[0].high,102);
 assert.equal(candles[0].volume,1000);
 const quote=publicKrAlphaDailyQuote('0193W0',candles);
 assert.equal(quote.price,139);
 assert.equal(quote.previousClose,138);
 assert.equal(quote.updatedAt,candles.at(-1).time);
 assert.equal(quote.provenance,'naver-public-last-closed-session');
 assert.ok(Date.parse(quote.updatedAt)<clock);
});
test('invalid codes, malformed OHLC, insufficient history, unauthorized intraday and future daily bars fail closed',async()=>{
 for(const code of ['../../x','0193ß0','0193W0/','005930','0193w0','A005930','0000☃0']) {
   assert.throws(()=>krAlphaDailyCode(code),/CODE_UNSAFE/,code);
 }
 assert.throws(()=>normalizePublicKrAlphaDaily({code:'0193W0',priceInfos:validRows()},'0177N0',clock),/IDENTITY_MISMATCH/);
 assert.throws(()=>normalizePublicKrAlphaDaily({code:'0193W0',priceInfos:[day('20261010',100)]},'0193W0',clock),/INSUFFICIENT_VALID_ROWS/);
 const corrupt=validRows();corrupt[0].highPrice='-10';
 const parsed=normalizePublicKrAlphaDaily({priceInfos:corrupt},'0193W0',clock);
 assert.equal(parsed.length,39);
 const identical=validRows(),first={...identical[0]};
 const dedup=normalizePublicKrAlphaDaily({priceInfos:[...identical,first]},'0193W0',clock);
 assert.equal(dedup.length,40);
 assert.throws(()=>normalizePublicKrAlphaDaily({
   priceInfos:[...identical,{...first,currentPrice:101}],
 },'0193W0',clock),/CONFLICTING_BAR/);
 const feed=createPublicKrAlphaDailyFeed({fetchImpl:async()=>{throw Error('UNEXPECTED_FETCH')}});
 await assert.rejects(feed.getCandles('0193W0','5m'),/UNSUPPORTED_INTRADAY/);
});
test('two quote/candle readers coalesce the same public source and never request an order endpoint',async()=>{
 let calls=0;
 const data={code:'0193W0',priceInfos:validRows()};
 const feed=createPublicKrAlphaDailyFeed({fetchImpl:async(url)=>{
   calls++;assert.equal(url,'https://stock.naver.com/api/securityService/chart/domestic/item/0193W0?periodType=day');
   return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data};
 },now:()=>clock});
 const [cs,q]=await Promise.all([feed.getCandles('0193W0'),feed.getQuote('0193W0')]);
 assert.equal(calls,1);
 assert.equal(q.price,cs.at(-1).close);
 assert.equal(feed.executionAuthority,'NONE');
 assert.deepEqual(feed.permittedTimeframes,['1D']);
});
