import { runHistoricalMarketReplay } from '../../../market-prediction-lab/src/historical-market-replay-v1.js';
import { settleHistoricalDiscoveryReplay } from '../../../market-prediction-lab/src/historical-discovery-settlement-v1.js';
import { assertResearchDatasetSnapshotManifestV1 } from '../../../research-production/src/research-dataset-snapshot-store.mjs';
import { simulateRunner, summarizeRunnerTrials } from './engine.mjs';

const FUTURES='CRYPTO_FUTURES';
function frozen(value){ return Object.freeze(value); }
function symbolOf(candidate){ return String(candidate?.symbol??candidate?.ticker??'').trim().toUpperCase(); }
function directionOf(candidate,market){
  const raw=String(candidate?.direction??candidate?.action??'').trim().toUpperCase();
  if(raw==='LONG'||raw==='BUY') return 'LONG';
  if(raw==='SHORT'||raw==='SELL') return market===FUTURES?'SHORT':null;
  return market===FUTURES?null:'LONG';
}
function blocked(reason,details={}){
  return frozen({schemaVersion:'move-hunter-canonical-adapter-v1',status:'BLOCKED',reason,details:frozen(details),
    historicalReplayOnly:true,genuineForwardEvidence:false,profitabilityClaimAllowed:false,executionAuthority:'NONE'});
}

export async function runMoveHunterHistoricalAudit({
  datasetManifest,
  replayInput,
  settlementInput,
  loadExecutionCandles,
  runnerConfig={},
}={}){
  try { assertResearchDatasetSnapshotManifestV1(datasetManifest); }
  catch(error){ return blocked('DATASET_SNAPSHOT_NOT_CANONICAL',{message:error instanceof Error?error.message:String(error)}); }
  if(typeof loadExecutionCandles!=='function') throw new TypeError('loadExecutionCandles is required');
  if(datasetManifest.market!==replayInput?.market) return blocked('DATASET_MARKET_MISMATCH');

  const replay=await runHistoricalMarketReplay(replayInput);
  if(replay.status!=='READY') return blocked(`CANONICAL_REPLAY_${replay.reason??'NOT_READY'}`,{replay});
  const settlement=await settleHistoricalDiscoveryReplay({replayResult:replay,...settlementInput});
  if(settlement.status!=='READY') return blocked(`CANONICAL_SETTLEMENT_${settlement.reason??'NOT_READY'}`,{settlement});

  const runnerTrials=[];
  for(const row of replay.replayRows){
    for(const candidate of row.discoveryCandidates??[]){
      const symbol=symbolOf(candidate), direction=directionOf(candidate,replay.market);
      if(!symbol||!direction) return blocked('DISCOVERY_IDENTITY_INVALID',{asOfMs:row.asOfMs,symbol:symbol||null});
      const payload=await loadExecutionCandles({
        datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
        market:replay.market,strategyMode:replay.strategyMode,symbol,direction,asOfMs:row.asOfMs,
      });
      if(!payload||payload.datasetSnapshotHash!==datasetManifest.datasetSnapshotHash){
        return blocked('RUNNER_DATASET_IDENTITY_MISMATCH',{asOfMs:row.asOfMs,symbol});
      }
      if(payload.syntheticHistoricalData===true||payload.fakeHistoricalData===true){
        return blocked('SYNTHETIC_RUNNER_DATA_FORBIDDEN',{asOfMs:row.asOfMs,symbol});
      }
      try{
        runnerTrials.push(frozen({market:replay.market,strategyMode:replay.strategyMode,symbol,
          sourceSignalId:candidate?.signalId??null,rank:candidate?.rank??null,
          ...simulateRunner({candles:payload.candles,signalAtMs:row.asOfMs,direction,...runnerConfig})}));
      }catch(error){
        return blocked('RUNNER_EVALUATION_FAILED',{asOfMs:row.asOfMs,symbol,message:error instanceof Error?error.message:String(error)});
      }
    }
  }

  return frozen({
    schemaVersion:'move-hunter-canonical-adapter-v1',status:'READY',market:replay.market,strategyMode:replay.strategyMode,
    datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
    canonicalReplay:replay,canonicalSettlement:settlement,
    runnerTrials:frozen(runnerTrials),runnerSummary:frozen(summarizeRunnerTrials(runnerTrials)),
    canonicalOwnersReused:frozen(['historical-market-replay-v1','historical-discovery-settlement-v1','research-dataset-snapshot-store-v1']),
    historicalReplayOnly:true,genuineForwardEvidence:false,searchQualityIsNotProfitabilityProof:true,
    profitabilityClaimAllowed:false,executionAuthority:'NONE',liveTrading:false,realOrder:false,privateApi:false,
  });
}
