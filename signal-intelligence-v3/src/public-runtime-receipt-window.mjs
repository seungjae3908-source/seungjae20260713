// Research-only sanitized runtime receipt and offline 24-hour gap auditor.
// These receipts are locally writable, unsigned observations. Even a clean
// 24-hour receipt chain cannot establish licensed whole-market quotes,
// independent infrastructure uptime attestation, PIT, OOS or profitability.
import {summarizePublicCycleHealth} from './public-cycle-supervisor.mjs';

export const PUBLIC_RUNTIME_RECEIPT_SCHEMA='public-readonly-runtime-receipt-v1';
const SHA=/^[a-f0-9]{40}$/u;
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const HOUR=3600000,DAY=24*HOUR;
const integer=x=>Number.isSafeInteger(x)&&x>=0;

export function createPublicReadOnlyRuntimeReceipt({
  serviceSha,startedAtMs,finishedAtMs,producerSucceeded=false,snapshot=null,
}={}){
  if(!SHA.test(serviceSha??'')||!integer(startedAtMs)||startedAtMs===0
    ||!integer(finishedAtMs)||finishedAtMs<startedAtMs
    ||finishedAtMs-startedAtMs>20*60000
    ||typeof producerSucceeded!=='boolean')
    throw Error('PUBLIC_RUNTIME_RECEIPT_INPUT_INVALID');
  let health=null;
  if(producerSucceeded){
    if(snapshot?.profile?.surface!=='RESEARCH_V3')
      throw Error('PUBLIC_RUNTIME_RECEIPT_RESEARCH_SURFACE_REQUIRED');
    const generatedAtMs=Date.parse(String(snapshot?.generatedAt??''));
    if(!Number.isFinite(generatedAtMs)||generatedAtMs<startedAtMs
      ||generatedAtMs>finishedAtMs)
      throw Error('PUBLIC_RUNTIME_RECEIPT_OUT_OF_CYCLE_SNAPSHOT');
    health=summarizePublicCycleHealth(snapshot,serviceSha,finishedAtMs);
  }
  const totals=health?.markets??{};
  const providerErrors=MARKETS.reduce((sum,key)=>sum+(totals[key]?.providerErrors??0),0);
  const timeouts=MARKETS.reduce((sum,key)=>sum+(totals[key]?.timeouts??0),0);
  const blocked=(health?.buckets?.blocked??0)+(health?.buckets?.failed??0);
  return Object.freeze({
    schemaVersion:PUBLIC_RUNTIME_RECEIPT_SCHEMA,
    serviceSha,startedAtMs,finishedAtMs,
    observedAt:new Date(finishedAtMs).toISOString(),
    status:!health?'PRODUCER_OR_SNAPSHOT_FAILED':
      blocked||providerErrors||timeouts?'SUCCEEDED_WITH_SOURCE_BLOCKERS':'SUCCEEDED_BATCHES_ONLY',
    producerSucceeded:Boolean(health),observedLanes:health?12:0,
    blockedOrFailedLanes:blocked,providerErrors,timeouts,
    publicReadOnly:true,sourcePayloadRedacted:true,
    rawSymbolsLogged:false,wholeMarketCoverageProven:false,
    licensedForRedistribution:false,independentUptimeAttested:false,
    executionAuthority:'NONE',paperOrdersAllowed:false,realOrdersAllowed:false,
  });
}

function validateReceipt(row,sha){
  if(!row||row.schemaVersion!==PUBLIC_RUNTIME_RECEIPT_SCHEMA
    ||row.serviceSha!==sha||!integer(row.startedAtMs)
    ||!integer(row.finishedAtMs)||row.startedAtMs===0
    ||row.finishedAtMs<row.startedAtMs
    ||row.finishedAtMs-row.startedAtMs>20*60000
    ||row.observedAt!==new Date(row.finishedAtMs).toISOString()
    ||!['PRODUCER_OR_SNAPSHOT_FAILED','SUCCEEDED_WITH_SOURCE_BLOCKERS',
      'SUCCEEDED_BATCHES_ONLY'].includes(row.status)
    ||typeof row.producerSucceeded!=='boolean'
    ||!integer(row.observedLanes)||!integer(row.blockedOrFailedLanes)
    ||!integer(row.providerErrors)||!integer(row.timeouts)
    ||row.observedLanes!==(row.producerSucceeded?12:0)
    ||row.status==='SUCCEEDED_BATCHES_ONLY'&&
      (!row.producerSucceeded||row.blockedOrFailedLanes>0||row.providerErrors>0||row.timeouts>0)
    ||row.status==='SUCCEEDED_WITH_SOURCE_BLOCKERS'&&
      (!row.producerSucceeded||row.blockedOrFailedLanes+row.providerErrors+row.timeouts===0)
    ||row.status==='PRODUCER_OR_SNAPSHOT_FAILED'&&row.producerSucceeded
    ||row.publicReadOnly!==true||row.sourcePayloadRedacted!==true
    ||row.rawSymbolsLogged!==false||row.wholeMarketCoverageProven!==false
    ||row.licensedForRedistribution!==false||row.independentUptimeAttested!==false
    ||row.executionAuthority!=='NONE'
    ||row.paperOrdersAllowed!==false||row.realOrdersAllowed!==false)
    throw Error('PUBLIC_RUNTIME_RECEIPT_UNTRUSTED');
}

export function auditPublicReadOnly24hReceiptWindow({
  observations,serviceSha,asOfMs=Date.now(),maxSilenceMs=6*60000,
}={}){
  if(!Array.isArray(observations)||observations.length>1500
    ||!SHA.test(serviceSha??'')||!integer(asOfMs)||asOfMs<DAY
    ||!integer(maxSilenceMs)||maxSilenceMs<60000||maxSilenceMs>20*60000)
    throw Error('PUBLIC_RUNTIME_WINDOW_INPUT_INVALID');
  let last=-1;
  for(const row of observations){
    validateReceipt(row,serviceSha);
    if(row.finishedAtMs<=last||row.finishedAtMs>asOfMs+5000)
      throw Error('PUBLIC_RUNTIME_WINDOW_ORDER_OR_FUTURE_INVALID');
    last=row.finishedAtMs;
  }
  const start=asOfMs-DAY;
  const relevant=observations.filter(r=>r.finishedAtMs>=start-maxSilenceMs);
  let longestSilenceMs=0;
  for(let i=1;i<relevant.length;i++)
    longestSilenceMs=Math.max(longestSilenceMs,
      relevant[i].finishedAtMs-relevant[i-1].finishedAtMs);
  const firstAt=relevant[0]?.finishedAtMs??null;
  const lastAt=relevant.at(-1)?.finishedAtMs??null;
  const receiptsInWindow=relevant.filter(r=>r.finishedAtMs>=start);
  const failed=receiptsInWindow.filter(r=>!r.producerSucceeded).length;
  const blocked=receiptsInWindow.reduce((sum,r)=>sum+r.blockedOrFailedLanes,0);
  const providerErrors=receiptsInWindow.reduce((sum,r)=>sum+r.providerErrors,0);
  const timeouts=receiptsInWindow.reduce((sum,r)=>sum+r.timeouts,0);
  const hasStart=firstAt!==null&&firstAt<=start+maxSilenceMs;
  const hasEnd=lastAt!==null&&asOfMs-lastAt<=maxSilenceMs;
  const noLargeGap=longestSilenceMs<=maxSilenceMs;
  const structurallyContinuous=hasStart&&hasEnd&&noLargeGap
    &&failed===0&&relevant.length>=2;
  return Object.freeze({
    schemaVersion:'public-readonly-24h-receipt-audit-v1',
    serviceSha,asOf:new Date(asOfMs).toISOString(),
    windowStart:new Date(start).toISOString(),
    receiptsInWindow:receiptsInWindow.length,
    firstReceiptAt:firstAt===null?null:new Date(firstAt).toISOString(),
    lastReceiptAt:lastAt===null?null:new Date(lastAt).toISOString(),
    maxObservedSilenceMs:longestSilenceMs,
    missingWindowStart:!hasStart,missingWindowEnd:!hasEnd,
    oversizedObservationGap:!noLargeGap,failedProducerCycles:failed,
    blockedOrFailedSourceLanes:blocked,providerErrors,timeouts,
    receiptWindowStructurallyContinuous:structurallyContinuous,
    observedBatchesWithoutProviderErrors:structurallyContinuous
      &&blocked===0&&providerErrors===0&&timeouts===0,
    // Unsigned local process logs or synthetic fixtures are not a genuine
    // externally attested 24h production runtime acceptance report.
    real24hInfrastructureAttested:false,wholeMarketConstituentCoverageProven:false,
    historicOneMinutePITProven:false,licensedForPublicRedistribution:false,
    profitabilityProven:false,executionAuthority:'NONE',
  });
}
