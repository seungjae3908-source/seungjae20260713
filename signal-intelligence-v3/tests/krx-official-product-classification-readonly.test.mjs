import test from 'node:test';
import assert from 'node:assert/strict';
import {readApprovedKrxEtpSubtypes,
  reconcileExcludedKrxProducts} from '../src/krx-official-product-classification-readonly.mjs';
const DAY='20261009',TOKEN='A'.repeat(40);
const batches=[
  [{BAS_DD:DAY,ISU_CD:'Q12345',ISU_NM:'UNSAFE_PRIVATE_ETF_NAME'}],
  [{BAS_DD:DAY,ISU_CD:'R12345',ISU_NM:'UNSAFE_PRIVATE_ETN_NAME'}],
  [{BAS_DD:DAY,ISU_CD:'S12345',ISU_NM:'UNSAFE_PRIVATE_ELW_NAME'}],
];
test('disabled or missing authorization never issues any network request',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('NETWORK_MUST_NOT_RUN');};
  for(const opts of [{enabled:false,date:DAY,authKey:TOKEN},
    {enabled:true,date:DAY},{enabled:true,date:'20260231',authKey:TOKEN}]){
    const r=await readApprovedKrxEtpSubtypes({...opts,fetchImpl});
    assert.notEqual(r.status,'DATE_EVIDENCE_READY');
    assert.equal(r.economicAuthority,'NONE');
  }
  assert.equal(calls,0);
});
test('three official KRX categories reconcile date-only evidence without exposing codes',async()=>{
  const urls=[],fetchImpl=async(url,opts)=>{
    urls.push(url);
    assert.equal(opts.method,'GET');
    assert.equal(opts.headers.AUTH_KEY,TOKEN);
    assert.equal(opts.redirect,'error');
    assert.ok(url.startsWith('https://data-dbg.krx.co.kr/svc/apis/etp/'));
    const idx=urls.length-1;
    return {ok:true,headers:{get:()=>null},
      text:async()=>JSON.stringify({OutBlock_1:batches[idx]})};
  };
  const r=await readApprovedKrxEtpSubtypes({enabled:true,date:DAY,authKey:TOKEN,fetchImpl});
  assert.equal(r.status,'DATE_EVIDENCE_READY');
  assert.deepEqual(r.counts,{ETF:1,ETN:1,ELW:1,CONFLICT:0,UNSUPPORTED_CODE:0});
  assert.equal(r.classify('Q12345'),'ETF');
  assert.equal(r.classify('R12345'),'ETN');
  assert.equal(r.classify('S12345'),'ELW');
  assert.equal(r.classify('A00000'),'UNKNOWN');
  const tally=reconcileExcludedKrxProducts([
    {ticker:'Q12345',exchange:'ETF·ETN'},
    {ticker:'R12345',exchange:'ETF·ETN'},
    {ticker:'S12345',exchange:'ETF·ETN'},
    {ticker:'X00000',exchange:'ETF·ETN'},
    {ticker:'Y00000',exchange:'코스닥'},
  ],r);
  assert.equal(tally.counts.ETF,1);
  assert.equal(tally.counts.ETN,1);
  assert.equal(tally.counts.ELW,1);
  assert.equal(tally.counts.UNKNOWN,1);
  assert.equal(tally.counts.STOCK_FINDER,1);
  assert.equal(tally.rosterComplete,false);
  assert.equal(tally.sourceAuthorityForOrders,'NONE');
  for(const secret of ['UNSAFE_PRIVATE','Q12345','R12345','S12345',TOKEN])
    assert.equal(JSON.stringify([r,tally]).includes(secret),false);
  assert.equal(urls.length,3);
});
test('conflicting and invalid dates, content or source data stay blocked',async()=>{
  const bad=await readApprovedKrxEtpSubtypes({enabled:true,date:DAY,authKey:TOKEN,
    fetchImpl:async()=>({ok:true,headers:{get:()=>null},
      text:async()=>JSON.stringify({OutBlock_1:[{BAS_DD:'20261008',
        ISU_CD:'Q12345'}]})})});
  assert.equal(bad.status,'PROVIDER_DATA_INVALID');
  let count=0;
  const conflict=await readApprovedKrxEtpSubtypes({enabled:true,date:DAY,authKey:TOKEN,
    fetchImpl:async()=>{
      count++;
      return {ok:true,headers:{get:()=>null},
        text:async()=>JSON.stringify({OutBlock_1:[{
          BAS_DD:DAY,ISU_CD:'Q12345'}]})};
    }});
  assert.equal(count,3);
  assert.equal(conflict.classify('Q12345'),'CONFLICT');
  assert.equal(conflict.counts.CONFLICT,2);
  assert.equal(conflict.status,'DATE_EVIDENCE_PARTIAL');
});

test('KRX holiday or empty official response never proves a full daily ETP list',async()=>{
  const result=await readApprovedKrxEtpSubtypes({
    enabled:true,date:DAY,authKey:TOKEN,
    fetchImpl:async()=>({ok:true,headers:{get:()=>null},
      text:async()=>JSON.stringify({OutBlock_1:[]})}),
  });
  assert.equal(result.status,'PROVIDER_DATA_INCOMPLETE');
  assert.equal(result.classify('Q12345'),'UNKNOWN');
  assert.equal(result.fullKrxRosterVerified,false);
  assert.equal(result.economicAuthority,'NONE');
});
