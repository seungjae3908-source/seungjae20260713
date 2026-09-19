import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';
import {
  buildClosedCandleAdaptiveReceiptV1,
  buildStockUniverseAdaptiveReceiptsV1,
  buildTransactionCostPolicyAdaptiveReceiptsV1,
} from '../src/research-canonical-receipt-producers.mjs';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const AT='2026-09-20T00:00:00.000Z';

function manifest(market){
  if(market==='CRYPTO_FUTURES'){
    return buildResearchDatasetSnapshotManifestV1({
      researchSha:SHA,createdAt:AT,market,
      evidence:{
        benchmarkDatasetDigest:H('1'),
        fundingHistoryDigest:H('2'),fundingCoverage:0.95,
        longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
        openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
        sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
      },
    });
  }
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,market,
    evidence:{
      benchmarkDatasetDigest:H('1'),
      foreignFlowHistoryDigest:H('2'),foreignFlowCoverage:0.95,foreignFlowTemporalParityConfirmed:true,
      institutionFlowHistoryDigest:H('3'),institutionFlowCoverage:0.96,institutionFlowTemporalParityConfirmed:true,
      sentimentHistoryDigest:H('4'),sentimentCoverage:0.94,sentimentTemporalParityConfirmed:true,
    },
  });
}

function stockAuditInput(market){
  const start=Date.UTC(2025,0,1);
  const end=Date.UTC(2025,11,31);
  const memberships=[];
  const histories=[];
  for(let i=0;i<20;i++){
    const symbol=`S${String(i).padStart(2,'0')}`;
    memberships.push({
      symbol,
      activeFrom:start-10*86400000,
      activeTo:i===0?end-30*86400000:null,
      exitReason:i===0?'delisted':null,
      sourceId:`membership:${symbol}`,
    });
    histories.push({
      symbol,
      firstTimestamp:start-20*86400000,
      lastTimestamp:end+86400000,
      source:'canonical-history',
    });
  }
  return {
    market,
    evaluationStartTime:start,
    evaluationEndTime:end,
    frozenAt:start-86400000,
    toleranceMs:0,
    minMemberships:20,
    minExitedSymbols:1,
    minMembershipCoverage:0.9,
    minExitedCoverage:0.8,
    memberships,
    histories,
  };
}

function readyCostEvidence(market='US_STOCK'){
  const now=Date.UTC(2026,8,20,0,0,0);
  const components={};
  for(const component of [
    'commissionBps','taxBps','spreadBps','slippageBps','latencyBps','liquidityImpactBps','partialFillImpactBps',
  ]){
    components[component]={
      sourceType:'STATIC_POLICY',
      source:'canonical-cost-policy',
      valueBps:1,
      asOf:now,
      policyVersion:'broker-cost-v1',
    };
  }
  components.fundingBps=market==='CRYPTO_FUTURES'
    ? {
        sourceType:'STATIC_POLICY',
        source:'canonical-funding-policy',
        valueBps:1,
        asOf:now,
        policyVersion:'funding-cost-v1',
      }
    : {
        sourceType:'NOT_APPLICABLE',
        notApplicableReason:'cash market has no perpetual funding',
      };
  return {
    market,
    evidenceSetVersion:'full-cost-set-v1',
    now,
    components,
  };
}

function candles(){
  const interval=15*60*1000;
  const start=Date.UTC(2026,8,19,0,0,0);
  return {
    schemaVersion:1,
    provider:'bitget-public-v2',
    collectedAt:start+61*interval,
    market:'CRYPTO_FUTURES',
    symbol:'BTCUSDT',
    timeframe:'15m',
    productType:'usdt-futures',
    candles:Array.from({length:60},(_,i)=>({
      timestamp:start+i*interval,
      open:100+i,
      high:102+i,
      low:99+i,
      close:101+i,
      volume:1000+i,
      quoteVolume:100000+i,
    })),
  };
}

test('passing stock universe audit emits PIT and delisted-included receipts for all stock horizons',()=>{
  const dataset=manifest('US_STOCK');
  const result=buildStockUniverseAdaptiveReceiptsV1({
    datasetManifest:dataset,
    auditInput:stockAuditInput('US_STOCK'),
    observedAt:'2026-09-20T00:10:00.000Z',
  });
  assert.equal(result.receiptCount,6);
  assert.deepEqual([...new Set(result.receipts.map(r=>r.requirement))].sort(),[
    'DELISTED_UNIVERSE_INCLUDED','POINT_IN_TIME_UNIVERSE',
  ]);
  assert.equal(result.receipts.every(r=>r.datasetSnapshotHash===dataset.datasetSnapshotHash),true);
  assert.equal(result.receipts.every(r=>r.executionAuthority==='NONE'),true);
});

test('current-list-only or missing removed-name history cannot produce stock receipts',()=>{
  const input=stockAuditInput('US_STOCK');
  input.memberships=input.memberships.map(row=>({...row,activeTo:null,exitReason:null}));
  const dataset=manifest('US_STOCK');
  assert.throws(()=>buildStockUniverseAdaptiveReceiptsV1({
    datasetManifest:dataset,auditInput:input,observedAt:'2026-09-20T00:10:00.000Z',
  }),/STOCK_UNIVERSE_AUDIT_NOT_READY/);
});

test('READY transaction-cost evidence emits cost-policy identity receipts for every market horizon',()=>{
  const dataset=manifest('US_STOCK');
  const result=buildTransactionCostPolicyAdaptiveReceiptsV1({
    datasetManifest:dataset,
    costEvidenceInput:readyCostEvidence('US_STOCK'),
  });
  assert.equal(result.receiptCount,3);
  assert.equal(result.policyVersion,'MIS_TRANSACTION_COST_EVIDENCE_V1');
  assert.equal(result.receipts.every(r=>r.requirement==='COST_POLICY_IDENTITY'),true);
  assert.equal(result.receipts.every(r=>r.datasetSnapshotHash===dataset.datasetSnapshotHash),true);
  assert.equal(result.receipts.every(r=>r.executionAuthority==='NONE'),true);
});

test('incomplete or cross-market cost evidence cannot create cost-policy receipts',()=>{
  const dataset=manifest('US_STOCK');
  const incomplete=readyCostEvidence('US_STOCK');
  delete incomplete.components.slippageBps;
  assert.throws(()=>buildTransactionCostPolicyAdaptiveReceiptsV1({
    datasetManifest:dataset,
    costEvidenceInput:incomplete,
  }),/TRANSACTION_COST_EVIDENCE_NOT_READY/);

  assert.throws(()=>buildTransactionCostPolicyAdaptiveReceiptsV1({
    datasetManifest:dataset,
    costEvidenceInput:readyCostEvidence('KR_STOCK'),
  }),/TRANSACTION_COST_DATASET_MARKET_MISMATCH/);
});

test('closed Bitget candles produce exact-timeframe receipt for matching adaptive horizon',()=>{
  const dataset=manifest('CRYPTO_FUTURES');
  const result=buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,
    candleCollection:candles(),
  });
  assert.equal(result.receipt.profileId,'CRYPTO_FUTURES:SHORT');
  assert.equal(result.receipt.requirement,'EXACT_TIMEFRAME_CLOSED_OHLCV');
  assert.equal(result.receipt.datasetSnapshotHash,dataset.datasetSnapshotHash);
  assert.match(result.receipt.sourceDigest,/^[0-9a-f]{64}$/);
});

test('still-open or unordered candle evidence is rejected',()=>{
  const dataset=manifest('CRYPTO_FUTURES');
  const open=candles();
  open.collectedAt=open.candles.at(-1).timestamp+1;
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollection:open,
  }),/OPEN_CANDLE_EVIDENCE_FORBIDDEN/);

  const unordered=candles();
  [unordered.candles[1],unordered.candles[2]]=[unordered.candles[2],unordered.candles[1]];
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollection:unordered,
  }),/CLOSED_CANDLE_ORDER_INVALID/);
});

test('receipt producer refuses cross-market dataset binding',()=>{
  const dataset=manifest('CRYPTO_FUTURES');
  const collection=candles();
  collection.market='CRYPTO_SPOT';
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollection:collection,
  }),/CANDLE_DATASET_MARKET_MISMATCH/);
});
