import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicStockSessionGapAudit,
  summarizePublicKrExclusions} from '../src/public-stock-session-diagnostics.mjs';

const bar=time=>({time,open:100,high:101,low:99,close:100,volume:5,
  ticker:'PRIVATE_SYMBOL',credential:'DO_NOT_OUTPUT'});
test('U.S. regular-session gaps across DST are candidates, not trusted repaired candles',()=>{
  for(const [a,b] of [
    ['2026-01-12T15:00:00Z','2026-01-12T16:00:00Z'], // 10-11 EST
    ['2026-07-13T14:00:00Z','2026-07-13T15:00:00Z'], // 10-11 EDT
  ]){
    const audit=createPublicStockSessionGapAudit('US_STOCK','15m');
    audit.observe([bar(a),bar(b)]);
    const summary=audit.snapshot();
    assert.equal(summary.inRegularSessionGapCandidateCount,1);
    assert.equal(summary.outsideRegularOrBoundaryGapCount,0);
    assert.equal(summary.scanQualityGateModified,false);
    assert.equal(summary.economicAuthority,'NONE');
    assert.equal(JSON.stringify(summary).includes('PRIVATE_SYMBOL'),false);
  }
});
test('premarket gaps and overnight/weekend intervals are separately observed, never automatically waived',()=>{
  const audit=createPublicStockSessionGapAudit('US_STOCK','15m');
  audit.observe([bar('2026-07-13T11:00:00Z'),
    bar('2026-07-13T13:00:00Z')]); // 07-09 EDT: extended hours
  audit.observe([bar('2026-07-10T19:45:00Z'),
    bar('2026-07-13T13:30:00Z')]); // Friday close to Monday open
  const result=audit.snapshot();
  assert.equal(result.inRegularSessionGapCandidateCount,0);
  assert.equal(result.outsideRegularOrBoundaryGapCount,2);
  assert.equal(result.symbolsWithBoundaryOrExtendedHoursGapCount,2);
  assert.equal(result.needsExchangeCalendarVerification,true);
});
test('KR regular intraday gap remains flagged, not invented; daily gap diagnosis is not applicable',()=>{
  const audit=createPublicStockSessionGapAudit('KR_STOCK','15m');
  audit.observe([bar('2026-10-12T01:00:00Z'),bar('2026-10-12T02:00:00Z')]);
  assert.equal(audit.snapshot().inRegularSessionGapCandidateCount,1);
  const daily=createPublicStockSessionGapAudit('KR_STOCK','1D');
  daily.observe([bar('2026-10-09T00:00:00Z'),bar('2026-10-12T00:00:00Z')]);
  assert.equal(daily.snapshot().classification,'NOT_APPLICABLE');
  assert.equal(daily.snapshot().largeGapCount,0);
});
test('invalid timestamps and failed public reads cannot create green candle evidence',()=>{
  const audit=createPublicStockSessionGapAudit('US_STOCK','60m');
  audit.observe([{time:'INVALID',symbol:'PRIVATE'}]);
  audit.observeFetchFailure();
  const summary=audit.snapshot();
  assert.equal(summary.invalidTimestampCount,1);
  assert.equal(summary.fetchFailureCount,1);
  assert.equal(summary.providerRequestsAdded,0);
  assert.equal(summary.symbolOrCandleSamplesCaptured,false);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'),false);
});
test('KR public exclusions are aggregates, not proof of universal vendor support',()=>{
  const summary=summarizePublicKrExclusions({
    explainedExcludedCount:4,
    explainedExclusions:[
      {ticker:'A12345',assetType:'STOCK',name:'CONFIDENTIAL_A'},
      {ticker:'Q12345',assetType:'ETF',name:'CONFIDENTIAL_B'},
      {ticker:'005930',assetType:'STOCK'},
      {ticker:'LONGPRIVATECODE',assetType:'LEVERAGED_ETN'},
    ],
  });
  assert.equal(summary.alphanumericSixCodeCount,2);
  assert.equal(summary.numericSixCodeCount,1);
  assert.equal(summary.otherCodeCount,1);
  assert.equal(summary.byAssetType.ETF,1);
  assert.equal(summary.byAssetType.LEVERAGED_ETN,1);
  assert.equal(summary.fullUniverseCovered,false);
  assert.equal(summary.countEvidenceMatches,true);
  assert.equal(summary.vendorSupportVerified,false);
  for(const value of ['CONFIDENTIAL_A','CONFIDENTIAL_B','LONGPRIVATECODE'])
    assert.equal(JSON.stringify(summary).includes(value),false);
  assert.equal(summarizePublicKrExclusions({
    explainedExcludedCount:2837,explainedExclusions:[],
  }).countEvidenceMatches,false);
});
