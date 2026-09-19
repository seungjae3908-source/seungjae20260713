import test from 'node:test';
import assert from 'node:assert/strict';

import { auditStockUniverseBias } from '../../market-prediction-lab/src/stock-universe-bias-audit.js';
import {
  buildResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';
import {
  buildClosedCandleAdaptiveReceiptV1,
  buildStockCorporateActionAdaptiveReceiptV1,
  buildStockUniverseAdaptiveReceiptsV1,
  buildTransactionCostPolicyAdaptiveReceiptV1,
} from '../src/research-canonical-receipt-producers.mjs';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const AT='2026-09-20T00:00:00.000Z';

function stockEvidence(){
  return {
    benchmarkDatasetDigest:H('1'),
    foreignFlowHistoryDigest:H('2'),foreignFlowCoverage:0.95,foreignFlowTemporalParityConfirmed:true,
    institutionFlowHistoryDigest:H('3'),institutionFlowCoverage:0.96,institutionFlowTemporalParityConfirmed:true,
    sentimentHistoryDigest:H('4'),sentimentCoverage:0.94,sentimentTemporalParityConfirmed:true,
  };
}
function futuresEvidence(){
  return {
    benchmarkDatasetDigest:H('1'),
    fundingHistoryDigest:H('2'),fundingCoverage:0.95,
    longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
    openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
    sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
  };
}

function stockAuditInput(market='US_STOCK'){
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

function stockCorporateEvidence(market='US_STOCK'){
  const audit=stockAuditInput(market);
  const memberships=audit.memberships.map(row=>({
    listingId:`${market}-${row.symbol}-PRIMARY`,
    symbol:row.symbol,
    activeFrom:row.activeFrom,
    activeTo:row.activeTo,
    sourceId:row.sourceId,
    exchange:market==='US_STOCK'?'NYSE_NASDAQ':'KRX',
    exitReason:row.exitReason,
  }));
  const priceHistories=audit.histories.map((row,index)=>({
    listingId:`${market}-${row.symbol}-PRIMARY`,
    symbol:row.symbol,
    sourceId:row.source,
    adjustmentPolicy:'SPLIT_ADJUSTED',
    terminalEventPolicy:index===0?'LAST_TRADABLE_PRICE':null,
    observations:[
      {timestampMs:row.firstTimestamp,price:100+index},
      {timestampMs:audit.evaluationStartTime,price:101+index},
      {timestampMs:audit.evaluationEndTime,price:102+index},
      {timestampMs:row.lastTimestamp,price:103+index},
    ],
  }));
  const removed=memberships.find(row=>row.activeTo!=null);
  return {
    market,
    evaluationStartTime:audit.evaluationStartTime,
    evaluationEndTime:audit.evaluationEndTime,
    frozenAt:audit.frozenAt,
    toleranceMs:audit.toleranceMs,
    memberships,
    priceHistories,
    corporateActions:[{
      listingId:removed.listingId,
      symbol:removed.symbol,
      type:'DELISTING',
      effectiveAt:removed.activeTo,
      sourceId:'canonical-corporate-actions-v1',
    }],
    corporateActionCoverage:{
      startTime:audit.evaluationStartTime-86400000,
      endTime:audit.evaluationEndTime+86400000,
      sourceId:'canonical-corporate-actions-v1',
      complete:true,
    },
  };
}

function stockManifest(profileId='US_STOCK:POSITION',auditInput=stockAuditInput()){
  const audit=auditStockUniverseBias(auditInput);
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    profileId,
    evidence:stockEvidence(),
    scope:{
      timeframe:'1d',
      symbols:['S00','S01'],
      startTime:audit.evaluationStartTime,
      endTime:audit.evaluationEndTime,
      primaryDatasetDigest:H('6'),
      universeDigest:audit.manifestSha256,
      publicDataOnly:true,
    },
  });
}

const CANDLE_START=Date.UTC(2026,8,19,0,0,0);
const CANDLE_INTERVAL=15*60*1000;
const CANDLE_COUNT=60;
const CANDLE_END=CANDLE_START+CANDLE_COUNT*CANDLE_INTERVAL;

function futuresManifest(symbols=['BTCUSDT','ETHUSDT']){
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    profileId:'CRYPTO_FUTURES:SHORT',
    evidence:futuresEvidence(),
    scope:{
      timeframe:'15m',
      symbols,
      startTime:CANDLE_START,
      endTime:CANDLE_END,
      primaryDatasetDigest:H('7'),
      universeDigest:null,
      publicDataOnly:true,
    },
  });
}

function candles(symbol,overrides={}){
  return {
    schemaVersion:1,
    provider:'bitget-public-v2',
    collectedAt:CANDLE_END+1000,
    market:'CRYPTO_FUTURES',
    symbol,
    timeframe:'15m',
    productType:'usdt-futures',
    candles:Array.from({length:CANDLE_COUNT},(_,i)=>({
      timestamp:CANDLE_START+i*CANDLE_INTERVAL,
      open:100+i,
      high:102+i,
      low:99+i,
      close:101+i,
      volume:1000+i,
      quoteVolume:100000+i,
    })),
    ...overrides,
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
    ? {sourceType:'STATIC_POLICY',source:'canonical-funding-policy',valueBps:1,asOf:now,policyVersion:'funding-cost-v1'}
    : {sourceType:'NOT_APPLICABLE',notApplicableReason:'cash market has no perpetual funding'};
  return {market,evidenceSetVersion:'full-cost-set-v1',now,components};
}

test('passing stock audit emits only the exact profile PIT and delisted receipts',()=>{
  const input=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',input);
  const result=buildStockUniverseAdaptiveReceiptsV1({
    datasetManifest:dataset,
    auditInput:input,
    observedAt:'2026-09-20T00:10:00.000Z',
  });
  assert.equal(result.profileId,'US_STOCK:POSITION');
  assert.equal(result.receiptCount,2);
  assert.deepEqual(result.receipts.map(r=>r.profileId),['US_STOCK:POSITION','US_STOCK:POSITION']);
  assert.deepEqual([...new Set(result.receipts.map(r=>r.requirement))].sort(),[
    'DELISTED_UNIVERSE_INCLUDED','POINT_IN_TIME_UNIVERSE',
  ]);
});

test('stock audit must match snapshot range and universe digest',()=>{
  const input=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',input);
  assert.throws(()=>buildStockUniverseAdaptiveReceiptsV1({
    datasetManifest:dataset,
    auditInput:{...input,evaluationEndTime:input.evaluationEndTime-86400000},
    observedAt:'2026-09-20T00:10:00.000Z',
  }),/RANGE_MISMATCH|DIGEST_MISMATCH|NOT_READY/);

  const other=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,profileId:'US_STOCK:POSITION',evidence:stockEvidence(),
    scope:{...dataset.scope,universeDigest:H('f')},
  });
  assert.throws(()=>buildStockUniverseAdaptiveReceiptsV1({
    datasetManifest:other,auditInput:input,observedAt:'2026-09-20T00:10:00.000Z',
  }),/DIGEST_MISMATCH/);
});

test('current-list-only or missing removed-name history cannot produce stock receipts',()=>{
  const input=stockAuditInput('US_STOCK');
  input.memberships=input.memberships.map(row=>({...row,activeTo:null,exitReason:null}));
  const audit=auditStockUniverseBias(stockAuditInput('US_STOCK'));
  const dataset=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,profileId:'US_STOCK:POSITION',evidence:stockEvidence(),
    scope:{
      timeframe:'1d',symbols:['S00','S01'],
      startTime:input.evaluationStartTime,endTime:input.evaluationEndTime,
      primaryDatasetDigest:H('6'),universeDigest:audit.manifestSha256,publicDataOnly:true,
    },
  });
  assert.throws(()=>buildStockUniverseAdaptiveReceiptsV1({
    datasetManifest:dataset,auditInput:input,observedAt:'2026-09-20T00:10:00.000Z',
  }),/DIGEST_MISMATCH|NOT_READY/);
});

test('merged point-in-time owner emits CORPORATE_ACTIONS only for the exact stock profile snapshot',()=>{
  const auditInput=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',auditInput);
  const evidence=stockCorporateEvidence('US_STOCK');
  const result=buildStockCorporateActionAdaptiveReceiptV1({
    datasetManifest:dataset,
    pointInTimeEvidence:evidence,
    observedAt:'2026-09-20T00:15:00.000Z',
  });
  assert.equal(result.kind,'STOCK_POINT_IN_TIME_CORPORATE_ACTIONS');
  assert.equal(result.profileId,'US_STOCK:POSITION');
  assert.equal(result.receipt.profileId,'US_STOCK:POSITION');
  assert.equal(result.receipt.requirement,'CORPORATE_ACTIONS');
  assert.equal(result.receipt.datasetSnapshotHash,dataset.datasetSnapshotHash);
  assert.equal(result.receipt.sourceDigest,result.sourceDigest);
  assert.match(result.sourceDigest,/^[0-9a-f]{64}$/);
  assert.equal(result.executionAuthority,'NONE');
});

test('corporate-action receipt stays blocked for missing coverage or unsafe RAW-price action crossing',()=>{
  const auditInput=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',auditInput);
  const missing=stockCorporateEvidence('US_STOCK');
  missing.corporateActionCoverage=null;
  assert.throws(()=>buildStockCorporateActionAdaptiveReceiptV1({
    datasetManifest:dataset,
    pointInTimeEvidence:missing,
    observedAt:'2026-09-20T00:15:00.000Z',
  }),/EVIDENCE_NOT_READY/);

  const unsafe=stockCorporateEvidence('US_STOCK');
  const live=unsafe.memberships.find(row=>row.activeTo==null);
  unsafe.priceHistories=unsafe.priceHistories.map(row=>row.listingId===live.listingId
    ? {...row,adjustmentPolicy:'RAW'}
    : row);
  unsafe.corporateActions=[
    ...unsafe.corporateActions,
    {
      listingId:live.listingId,
      symbol:live.symbol,
      type:'SPLIT',
      effectiveAt:unsafe.evaluationStartTime+86400000,
      sourceId:'canonical-corporate-actions-v1',
      ratio:2,
    },
  ];
  assert.throws(()=>buildStockCorporateActionAdaptiveReceiptV1({
    datasetManifest:dataset,
    pointInTimeEvidence:unsafe,
    observedAt:'2026-09-20T00:15:00.000Z',
  }),/EVIDENCE_NOT_READY/);
});

test('corporate-action receipt cannot cross snapshot universe digest or evaluation range',()=>{
  const auditInput=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',auditInput);
  const evidence=stockCorporateEvidence('US_STOCK');
  assert.throws(()=>buildStockCorporateActionAdaptiveReceiptV1({
    datasetManifest:dataset,
    pointInTimeEvidence:{...evidence,evaluationEndTime:evidence.evaluationEndTime-86400000},
    observedAt:'2026-09-20T00:15:00.000Z',
  }),/EVIDENCE_NOT_READY/);

  const wrong=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,profileId:'US_STOCK:POSITION',evidence:stockEvidence(),
    scope:{...dataset.scope,universeDigest:H('f')},
  });
  assert.throws(()=>buildStockCorporateActionAdaptiveReceiptV1({
    datasetManifest:wrong,
    pointInTimeEvidence:evidence,
    observedAt:'2026-09-20T00:15:00.000Z',
  }),/EVIDENCE_NOT_READY/);
});

test('READY transaction-cost evidence emits one cost-policy receipt for the exact profile',()=>{
  const input=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',input);
  const result=buildTransactionCostPolicyAdaptiveReceiptV1({
    datasetManifest:dataset,
    costEvidenceInput:readyCostEvidence('US_STOCK'),
  });
  assert.equal(result.profileId,'US_STOCK:POSITION');
  assert.equal(result.receipt.profileId,'US_STOCK:POSITION');
  assert.equal(result.receipt.requirement,'COST_POLICY_IDENTITY');
  assert.equal(result.receipt.datasetSnapshotHash,dataset.datasetSnapshotHash);
});

test('incomplete or cross-market cost evidence cannot create cost-policy receipt',()=>{
  const input=stockAuditInput('US_STOCK');
  const dataset=stockManifest('US_STOCK:POSITION',input);
  const incomplete=readyCostEvidence('US_STOCK');
  delete incomplete.components.slippageBps;
  assert.throws(()=>buildTransactionCostPolicyAdaptiveReceiptV1({
    datasetManifest:dataset,costEvidenceInput:incomplete,
  }),/TRANSACTION_COST_EVIDENCE_NOT_READY/);
  assert.throws(()=>buildTransactionCostPolicyAdaptiveReceiptV1({
    datasetManifest:dataset,costEvidenceInput:readyCostEvidence('KR_STOCK'),
  }),/TRANSACTION_COST_DATASET_MARKET_MISMATCH/);
});

test('closed candle receipt requires every symbol in the profile snapshot with exact scope coverage',()=>{
  const dataset=futuresManifest();
  const result=buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,
    candleCollections:[candles('ETHUSDT'),candles('BTCUSDT')],
  });
  assert.equal(result.profileId,'CRYPTO_FUTURES:SHORT');
  assert.equal(result.symbolCount,2);
  assert.equal(result.receipt.requirement,'EXACT_TIMEFRAME_CLOSED_OHLCV');
  assert.equal(result.receipt.datasetSnapshotHash,dataset.datasetSnapshotHash);
});

test('missing symbol, timeframe mismatch, gap, or outside-snapshot candles are rejected',()=>{
  const dataset=futuresManifest();
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollections:[candles('BTCUSDT')],
  }),/SYMBOL_COVERAGE_INCOMPLETE/);
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollections:[candles('BTCUSDT',{timeframe:'1h'}),candles('ETHUSDT')],
  }),/COLLECTION_INVALID/);
  const gapped=candles('BTCUSDT');
  gapped.candles=gapped.candles.filter((_,i)=>i!==10);
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollections:[gapped,candles('ETHUSDT')],
  }),/SCOPE_COVERAGE_INCOMPLETE/);
  assert.throws(()=>buildClosedCandleAdaptiveReceiptV1({
    datasetManifest:dataset,candleCollections:[candles('BTCUSDT'),candles('ETHUSDT'),candles('SOLUSDT')],
  }),/SYMBOL_OUTSIDE_SNAPSHOT|SYMBOL_COVERAGE_INCOMPLETE/);
});
