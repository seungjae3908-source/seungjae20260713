import test from 'node:test';
import assert from 'node:assert/strict';
import {includeProvisionalKrAlphanumericRoster,isKrAlphanumericPublicResearchCode} from '../src/public-kr-provisional-roster.mjs';
const base={
 entries:[{ticker:'005930',name:'Samsung',market:'KR',currency:'KRW',
  listingStatus:'LISTED',source:'krx-symbol-master',assetType:'STOCK',exchange:'KOSPI'}],
 totalCount:1,rawTotalCount:4,source:'krx-symbol-master',
 partial:true,stale:false,providerErrorCount:0,
 explainedExclusions:[
  {ticker:'0193W0',name:'ETF W',reason:'PUBLIC_PROVIDER_UNSUPPORTED_ALPHANUMERIC_KRX_SYMBOL',
   assetType:'ETF',exchange:'ETF·ETN'},
  {ticker:'0177N0',name:'ETF N',reason:'PUBLIC_PROVIDER_UNSUPPORTED_ALPHANUMERIC_KRX_SYMBOL',
   assetType:'ETF',exchange:'ETF·ETN'},
  {ticker:'****XX',name:'unsafe',reason:'PUBLIC_PROVIDER_UNSUPPORTED_ALPHANUMERIC_KRX_SYMBOL',
   assetType:'ETF',exchange:'ETF·ETN'},
 ],
};
test('only research pilot 0193W0 has separately sourced alpha bars; current member symbols and listing remain unchanged',()=>{
 const x=includeProvisionalKrAlphanumericRoster(base,'PILOT');
 assert.deepEqual(x.entries.map(r=>r.ticker),['005930','0193W0']);
 assert.equal(x.provisionalAlphanumericCount,1);
 assert.equal(x.entries[1].listingStatus,'UNKNOWN');
 assert.equal(x.entries[1].publicResearchProvisional,true);
 assert.equal(x.alphasNotVerifiedForSignals,true);
 assert.equal(x.partial,true);
 assert.equal(x.source,'krx-symbol-master');
 const none=includeProvisionalKrAlphanumericRoster(base);
 assert.equal(none.entries.length,1);
 assert.equal(none.provisionalAlphanumericCount,0);
 assert.equal(base.entries.length,1);
});
test('provisional all-roster is observation-only, malformed codes and unsafe sources fail closed',()=>{
 const s=includeProvisionalKrAlphanumericRoster(base,'OBSERVATION_ONLY');
 assert.deepEqual(s.entries.map(x=>x.ticker),['005930','0177N0','0193W0']);
 assert.equal(s.provisionalAlphanumericCount,2);
 assert.equal(s.partial,true);
 assert.equal(s.alphasNotVerifiedForSignals,true);
 assert.equal(isKrAlphanumericPublicResearchCode('0193W0'),true);
 assert.equal(isKrAlphanumericPublicResearchCode('005930'),false);
 assert.equal(isKrAlphanumericPublicResearchCode('AB-CD!'),false);
 const stale=includeProvisionalKrAlphanumericRoster({...base,stale:true},'OBSERVATION_ONLY');
 assert.equal(stale.provisionalAlphanumericCount,0);
 assert.equal(stale.rosterProvenanceBlocked,true);
 assert.throws(()=>includeProvisionalKrAlphanumericRoster(base,'LIVE'),/MODE_INVALID/);
});
