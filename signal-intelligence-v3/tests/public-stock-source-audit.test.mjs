import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicStockSourceAudit} from '../src/public-stock-source-audit.mjs';
const NOW=Date.parse('2026-10-11T00:00:00Z');
test('stock public source audit distinguishes short, stale, invalid and timeout evidence without exposing symbols',()=>{
 const audit=createPublicStockSourceAudit({now:()=>NOW});
 const data=Array.from({length:18},(_,i)=>({
  time:new Date(NOW-(3*86400000)+i*60000).toISOString(),
  open:100,high:102,low:99,close:101,volume:1000,
 }));
 audit.recordCandles('5m',data);
 audit.recordCandles('5m',[]);
 audit.recordCandles('60m',[{...data[0],high:90}]);
 audit.candleError('5m',new Error('YAHOO_CHART_HTTP_429:https://masked.private/?token=sensitive'));
 audit.quoteError(new Error('YAHOO_CHART_BUDGET_EXCEEDED'));
 audit.recordQuote({price:100});
 const x=audit.snapshot();
 assert.equal(x.candles['5m'].fetched,2);
 assert.equal(x.candles['5m'].shortLt20,1);
 assert.equal(x.candles['5m'].empty,1);
 assert.equal(x.candles['5m'].lastBarLagGteOneDay,1);
 assert.equal(x.candles['60m'].invalidOhlc,1);
 assert.equal(x.sanitizedProviderFailures.HTTP_429,1);
 assert.equal(x.sanitizedProviderFailures.TIMEOUT,1);
 assert.equal(x.quote.errors,1);
 assert.equal(x.executionAuthority,'NONE');
 assert.equal(x.fullMarketVerified,false);
 assert.equal(JSON.stringify(x).includes('sensitive'),false);
 assert.equal(JSON.stringify(x).includes('private'),false);
});
test('unknown timeframes and invalid providers never invent verified results',()=>{
 const audit=createPublicStockSourceAudit();
 audit.recordCandles('2H',[]);
 audit.candleError('2H',new Error('sensitive'));
 const x=audit.snapshot();
 assert.equal(x.sanitizedProviderFailures.OTHER,0);
 assert.equal(x.candles['5m'].empty,0);
 assert.equal(x.symbolsRedacted,true);
});
