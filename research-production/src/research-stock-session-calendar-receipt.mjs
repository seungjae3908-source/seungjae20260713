import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  createStockSessionCalendarEvidenceV1,
} from '../../market-prediction-lab/src/stock-session-calendar-evidence-v1.js';
import {
  createAdaptiveEvidenceReceiptV1,
} from './research-adaptive-evidence-catalog.mjs';
import {
  assertResearchDatasetSnapshotManifestV1,
} from './research-dataset-snapshot-store.mjs';

export function buildStockSessionCalendarAdaptiveReceiptV1({
  datasetManifest,
  calendarEvidence,
}={}){
  assertResearchDatasetSnapshotManifestV1(datasetManifest);
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(row=>row.profileId===datasetManifest.profileId);
  if(!profile||!['KR_STOCK','US_STOCK'].includes(profile.market)
    ||profile.market!==datasetManifest.market
    ||!profile.requiredEvidence.includes('SESSION_CALENDAR')){
    throw new Error('STOCK_SESSION_CALENDAR_PROFILE_INVALID');
  }
  const evidence=createStockSessionCalendarEvidenceV1({
    ...(calendarEvidence??{}),
    market:profile.market,
  });
  if(evidence.coverageStartTime>datasetManifest.scope.startTime
    ||evidence.coverageEndTime<datasetManifest.scope.endTime){
    throw new Error('STOCK_SESSION_CALENDAR_SNAPSHOT_COVERAGE_INCOMPLETE');
  }
  const receipt=createAdaptiveEvidenceReceiptV1({
    profileId:profile.profileId,
    requirement:'SESSION_CALENDAR',
    evidenceId:`stock-session-calendar:${evidence.evidenceDigest}`,
    observedAt:evidence.observedAt,
    datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
    sourceDigest:evidence.evidenceDigest,
  });
  return Object.freeze({
    schemaVersion:1,
    contract:'research-stock-session-calendar-receipt/v1',
    profileId:profile.profileId,
    market:profile.market,
    calendarEvidenceDigest:evidence.evidenceDigest,
    receipt,
    executionAuthority:'NONE',
  });
}
