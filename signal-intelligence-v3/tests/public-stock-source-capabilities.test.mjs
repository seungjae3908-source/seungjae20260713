import test from 'node:test';
import assert from 'node:assert/strict';
import {probePublicStockSources,summarizePublicProbePayload} from '../src/public-stock-source-capabilities.mjs';
const fake=json=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>json});
test('KR alphanumeric price/daily shapes and US chart are classified without granting bulk source authority',()=>{
 const price=summarizePublicProbePayload('KR_ALPHA_PRICE',{nowPrice:'11,240',itemcode:'0193W0',type:'EF'});
 assert.equal(price.hasRecognizableShape,true);
 assert.equal(price.licensedFullMarketAuthority,false);
 const chart=summarizePublicProbePayload('KR_ALPHA_DAILY',{priceInfos:[{price:11240}]});
 assert.equal(chart.discoveredCount,1);
 assert.deepEqual(chart.firstDailyRowKeys,['price']);
 const stock=summarizePublicProbePayload('US_AAPL_5M',{chart:{result:[{
   timestamp:[Date.now()/1000],indicators:{quote:[{close:[100,105]}]},
 }]}});
 assert.equal(stock.hasRecognizableShape,true);
 assert.equal(stock.discoveredCount,2);
 assert.throws(()=>summarizePublicProbePayload('KR_ALPHA_PRIVATE',{secret:'x'}),/TARGET_UNLISTED/);
});
test('malformed or HTTP-denied public samples remain blocked while trace never prints raw source payload',async()=>{
 let calls=0;
 const d=await probePublicStockSources({fetchImpl:async url=>{
  calls++;
  if(url.includes('priceInfos'))throw Error('should never pass source values into URL');
  if(url.includes('/0193W0/price'))return fake({nowPrice:'12,345',rawSecret:'should not emit'});
  if(url.includes('AAPL'))return {ok:false,status:429,headers:{get:()=> 'application/json'}};
  return fake({noActualRows:true});
 }});
 assert.equal(calls,9);
 assert.equal(d.samples.filter(x=>x.status==='READABLE_SAMPLE_ONLY').length,1);
 assert.equal(d.samples.filter(x=>x.status==='BLOCKED_HTTP').length,2);
 assert.equal(d.licensedForPublicRedistribution,false);
 assert.equal(JSON.stringify(d).includes('should not emit'),false);
 assert.equal(d.fullMarketCoverageProven,false);
});
