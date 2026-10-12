import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicStockSourceAudit,attachPublicStockSourceAuditToError,
 readPublicStockSourceAuditFromError,classifyPublicStockSourceBlocker} from '../src/public-stock-source-audit.mjs';
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

test('thrown bounded provider failure retains only allowlisted audit counts for diagnostics',()=>{
 const audit=createPublicStockSourceAudit({now:()=>NOW});
 audit.candleError('15m',new Error('YAHOO_HEDGED_PAIR_FAILED:HTTP_429:https://private.example/key=DO_NOT_LEAK'));
 audit.recordCandles('1D',[{
   time:new Date(NOW-86400000).toISOString(),open:100,high:90,low:91,close:99,volume:100,
 }]);
 const thrown=new Error('SCAN_PROVIDER_ERROR: completed=0, providerErrors=20, workerErrors=0, timeouts=0, started=20');
 assert.equal(attachPublicStockSourceAuditToError(thrown,audit.snapshot()),thrown);
 const stats=readPublicStockSourceAuditFromError(thrown);
 assert.equal(stats.sanitizedProviderFailures.HTTP_429,1);
 assert.equal(stats.candles['15m'].errors,1);
 assert.equal(stats.candles['1D'].invalidOhlc,1);
 assert.equal(stats.symbolsRedacted,true);
 assert.equal(stats.executionAuthority,'NONE');
 assert.equal(JSON.stringify(stats).includes('DO_NOT_LEAK'),false);
 assert.equal(JSON.stringify(thrown).includes('DO_NOT_LEAK'),false);
 assert.equal(Object.isFrozen(stats.candles['1D']),true);
});
test('untrusted attachment, non-Error failures and extra fields cannot expose raw data',()=>{
 const audit=createPublicStockSourceAudit().snapshot();
 assert.equal(readPublicStockSourceAuditFromError(new Error('untagged')),null);
 assert.equal(attachPublicStockSourceAuditToError('strange',audit),'strange');
 const untrusted={...audit,symbolsRedacted:false};
 const error=new Error('bounded');
 attachPublicStockSourceAuditToError(error,untrusted);
 assert.equal(readPublicStockSourceAuditFromError(error),null);
 const sanitized=new Error('bounded');
 attachPublicStockSourceAuditToError(sanitized,{...audit,
   sourceUrl:'https://secret.example/api?token=NEVER_EMIT',
   rawSymbol:'1234XY'});
 const result=readPublicStockSourceAuditFromError(sanitized);
 assert.ok(result);
 assert.equal(JSON.stringify(result).includes('NEVER_EMIT'),false);
 assert.equal(JSON.stringify(result).includes('1234XY'),false);
});

test('weekend stale quote, missing and future timestamps never masquerade as HTTP outage',()=>{
 const audit=createPublicStockSourceAudit({now:()=>NOW});
 audit.recordQuote({price:100,updatedAt:new Date(NOW-3*3600000).toISOString()},'15m');
 audit.recordQuote({price:100,updatedAt:new Date(NOW-3*3600000).toISOString()},'1D');
 audit.recordQuote({price:100},'15m');
 audit.recordQuote({price:100,updatedAt:new Date(NOW+10*60000).toISOString()},'15m');
 audit.recordQuote({price:100,updatedAt:new Date(NOW-6*86400000).toISOString()},'1D');
 const x=audit.snapshot();
 assert.equal(x.quote.fetched,5);
 assert.equal(x.quote.expiredTimestamp,2);
 assert.equal(x.quote.missingTimestamp,1);
 assert.equal(x.quote.futureTimestamp,1);
 assert.equal(x.quote.errors,0);
 assert.equal(x.sanitizedProviderFailures.HTTP_429,0);
 assert.equal(x.executionAuthority,'NONE');
});


test('stale quote observations are not mistaken for HTTP faults or permission to create signals',()=>{
 const audit=createPublicStockSourceAudit({now:()=>NOW});
 for(let i=0;i<4;i++)audit.recordQuote({
   price:100,updatedAt:new Date(NOW-3*3600000).toISOString()},'15m');
 const stats=audit.snapshot();
 const diagnosis=classifyPublicStockSourceBlocker(stats,'15m');
 assert.equal(diagnosis.category,'ALL_OBSERVED_QUOTES_EXPIRED');
 assert.equal(diagnosis.observedQuoteReads,4);
 assert.equal(diagnosis.expiredQuoteReads,4);
 assert.equal(diagnosis.http429Reads,0);
 assert.equal(diagnosis.candidatePromotionAllowed,false);
 assert.equal(diagnosis.fullMarketDataReady,false);
 audit.quoteError(new Error('YAHOO_CHART_HTTP_429'));
 assert.equal(classifyPublicStockSourceBlocker(audit.snapshot(),'15m').category,'HTTP_429_OBSERVED');
 const tampered={...stats,executionAuthority:'LIVE'};
 assert.equal(classifyPublicStockSourceBlocker(tampered,'15m').category,'SOURCE_CAUSE_UNVERIFIED');
});
