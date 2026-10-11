import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeV3EconomicReadiness} from '../src/public-v3-readiness-diagnostics.mjs';
const row=(values={})=>({
  market:'CRYPTO_SPOT',symbol:'HIDDEN_SECRET_TICKER',
  state:'NO_TRADE',dataStatus:'READY',
  quantEligible:true,profitEligible:false,riskReady:true,utilityR:null,
  provenance:{profitBlockers:[
    'PAPER_IDENTITY_REQUIRED','CANONICAL_PROFIT_EVIDENCE_REQUIRED',
    'EXPLICIT_COST_POLICY_REQUIRED',
    'confidential_user_id=NO_EXPORT',
  ]},...values,
});
test('canonical profit input omissions are counted, never invented as PASS',()=>{
  const report=summarizeV3EconomicReadiness([row(),row({
    market:'US_STOCK',state:'BLOCKED_DATA',dataStatus:'BLOCKED',
    riskReady:false,
  })]);
  assert.equal(report.totalRows,2);
  assert.equal(report.byMarket.CRYPTO_SPOT.profitNotEligible,1);
  assert.equal(report.byMarket.CRYPTO_SPOT.canonicalProofAbsent,1);
  assert.equal(report.byMarket.CRYPTO_SPOT.identityMissing,1);
  assert.equal(report.byMarket.CRYPTO_SPOT.costPolicyMissing,1);
  assert.equal(report.byMarket.CRYPTO_SPOT.candidate,0);
  assert.equal(report.byMarket.US_STOCK.dataBlocked,1);
  assert.equal(report.byMarket.US_STOCK.riskNotReady,1);
  assert.equal(report.oosPassProven,false);
  const serialized=JSON.stringify(report);
  assert.ok(!serialized.includes('HIDDEN_SECRET_TICKER'));
  assert.ok(!serialized.includes('NO_EXPORT'));
});
test('isolated healthy research row is not relabeled as profitable OOS evidence',()=>{
  const out=summarizeV3EconomicReadiness([row({
    market:'CRYPTO_FUTURES',state:'CANDIDATE',profitEligible:true,
    utilityR:1.25,provenance:{profitBlockers:[]},
  })]);
  assert.equal(out.byMarket.CRYPTO_FUTURES.candidate,1);
  assert.equal(out.byMarket.CRYPTO_FUTURES.profitNotEligible,0);
  assert.equal(out.oosPassProven,false,'no economic proof elevation from snapshot counts');
  assert.equal(out.economicAuthority,'NONE');
});
test('invalid market and unknown state cannot masquerade as complete diagnostic',()=>{
  assert.throws(()=>summarizeV3EconomicReadiness({}),/INPUT_INVALID/);
  assert.throws(()=>summarizeV3EconomicReadiness([row({market:'FAKE_MARKET'})]),/ROW_INVALID/);
  assert.throws(()=>summarizeV3EconomicReadiness([row({state:'EXECUTE'})]),/ROW_INVALID/);
  assert.equal(summarizeV3EconomicReadiness([]).totalRows,0);
});
