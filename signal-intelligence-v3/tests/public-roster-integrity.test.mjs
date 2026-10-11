import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {decidePublicRosterContinuity,hashPublicStockSourceRoster} from '../src/public-roster-integrity.mjs';

test('same count with different listed symbols resets research cursor rather than pretending index completeness',()=>{
 const first=hashPublicStockSourceRoster('US_STOCK','nasdaq-trader-public-directory',[{ticker:'A'},{ticker:'B'}],createHash);
 const changed=hashPublicStockSourceRoster('US_STOCK','nasdaq-trader-public-directory',[{ticker:'A'},{ticker:'C'}],createHash);
 assert.match(first,/^[a-f0-9]{64}$/);
 assert.notEqual(first,changed);
 assert.deepEqual(decidePublicRosterContinuity({previousDigest:first,observedDigest:changed,stale:false,providerErrors:0}),{
  trusted:false,changed:true,nextDigest:changed,reason:'ROSTER_DIGEST_CHANGED_RESET',
 });
 assert.equal(decidePublicRosterContinuity({previousDigest:first,observedDigest:first,stale:false,providerErrors:0}).trusted,true);
});

test('source reorder is immaterial, duplicate/missing/failed provider input is not trusted',()=>{
 const a=hashPublicStockSourceRoster('KR_STOCK','krx-symbol-master',[{ticker:'005930'},{ticker:'000660'}],createHash);
 const b=hashPublicStockSourceRoster('KR_STOCK','krx-symbol-master',[{ticker:'000660'},{ticker:'005930'}],createHash);
 assert.equal(a,b);
 assert.equal(hashPublicStockSourceRoster('KR_STOCK','krx-symbol-master',[{ticker:'000660'},{ticker:'000660'}],createHash),null);
 for(const input of [
  {previousDigest:a,observedDigest:null,stale:false,providerErrors:0},
  {previousDigest:a,observedDigest:b,stale:true,providerErrors:0},
  {previousDigest:a,observedDigest:b,stale:false,providerErrors:1},
 ]) {
  const d=decidePublicRosterContinuity(input);
  assert.equal(d.trusted,false);
  assert.equal(d.changed,false);
  assert.equal(d.nextDigest,a);
 }
});
