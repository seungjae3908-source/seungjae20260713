import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  createStockCorporateActionsEvidenceV1,
} from '../../market-prediction-lab/src/stock-corporate-actions-evidence-v1.js';
import {
  createAdaptiveEvidenceReceiptV1,
} from './research-adaptive-evidence-catalog.mjs';
import {
  assertResearchDatasetSnapshotManifestV1,
} from './research-dataset-snapshot-store.mjs';

export function buildStockCorporateActionsAdaptiveReceiptV1({
  datasetManifest,
  corporateActionsEvidence,
}={}){
  assertResearchDatasetSnapshotManifestV1(datasetManifest);
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(row=>row.profileId===datasetManifest.profileId);
  if(!profile||!['KR_STOCK','US_STOCK'].includes(profile.market)
    ||profile.market!==datasetManifest.market
    ||!profile.requiredEvidence.includes('CORPORATE_ACTIONS')){
    throw new Error('STOCK_CORPORATE_ACTIONS_PROFILE_INVALID');
  }
  const evidence=createStockCorporateActionsEvidenceV1({
    ...(corporateActionsEvidence??{}),
    market:profile.market,
  });
  if(evidence.coverageStartTime>datasetManifest.scope.startTime
    ||evidence.coverageEndTime<datasetManifest.scope.endTime){
    throw new Error('STOCK_CORPORATE_ACTIONS_SNAPSHOT_COVERAGE_INCOMPLETE');
  }
  const evidenceSymbols=evidence.symbols.map(row=>row.symbol);
  if(evidenceSymbols.length!==datasetManifest.scope.symbols.length
    ||evidenceSymbols.some((symbol,index)=>symbol!==datasetManifest.scope.symbols[index])){
    throw new Error('STOCK_CORPORATE_ACTIONS_SYMBOL_COVERAGE_MISMATCH');
  }
  const receipt=createAdaptiveEvidenceReceiptV1({
    profileId:profile.profileId,
    requirement:'CORPORATE_ACTIONS',
    evidenceId:`stock-corporate-actions:${evidence.evidenceDigest}`,
    observedAt:evidence.observedAt,
    datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
    sourceDigest:evidence.evidenceDigest,
  });
  return Object.freeze({
    schemaVersion:1,
    contract:'research-stock-corporate-actions-receipt/v1',
    profileId:profile.profileId,
    market:profile.market,
    corporateActionsEvidenceDigest:evidence.evidenceDigest,
    symbolCount:evidence.symbols.length,
    eventCount:evidence.symbols.reduce((sum,row)=>sum+row.events.length,0),
    receipt,
    executionAuthority:'NONE',
  });
}
