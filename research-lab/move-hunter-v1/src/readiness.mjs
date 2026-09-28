import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  buildAdaptiveEvidenceCatalogFromDataFactoryV1,
} from '../../../research-production/src/research-adaptive-evidence-catalog.mjs';

export const MOVE_HUNTER_AUDIT_START_MS = Date.parse('2023-09-27T00:00:00.000Z');
export const MOVE_HUNTER_AUDIT_END_MS = Date.parse('2026-09-27T00:00:00.000Z');
export const MOVE_HUNTER_MARKETS = Object.freeze([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
]);

function freeze(value){ return Object.freeze(value); }

export function summarizeThreeYearProfileReadiness({
  readiness,
  datasetManifestsByProfile = {},
  startTime = MOVE_HUNTER_AUDIT_START_MS,
  endTime = MOVE_HUNTER_AUDIT_END_MS,
} = {}) {
  if (!readiness || !Array.isArray(readiness.profiles)) throw new TypeError('canonical readiness is required');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new TypeError('audit range invalid');

  const canonicalById = new Map(readiness.profiles.map((row) => [row.profileId, row]));
  const profiles = ADAPTIVE_MULTI_MARKET_PROFILES_V1.map((profile) => {
    const canonical = canonicalById.get(profile.profileId) ?? null;
    const manifest = datasetManifestsByProfile[profile.profileId] ?? null;
    const blockers = [];

    if (!canonical || canonical.status !== 'READY') {
      blockers.push(...(canonical?.missingRequirements?.length
        ? canonical.missingRequirements.map((requirement) => `MISSING:${requirement}`)
        : ['CANONICAL_PROFILE_NOT_READY']));
    }
    if (!manifest) {
      blockers.push('DATASET_MANIFEST_MISSING');
    } else {
      const scope = manifest.scope ?? {};
      if (!Number.isFinite(scope.startTime) || scope.startTime > startTime) blockers.push('DATASET_START_RANGE_GAP');
      if (!Number.isFinite(scope.endTime) || scope.endTime < endTime) blockers.push('DATASET_END_RANGE_GAP');
      if (scope.timeframe !== profile.timeframe) blockers.push('DATASET_TIMEFRAME_MISMATCH');
      if (manifest.market !== profile.market) blockers.push('DATASET_MARKET_MISMATCH');
      if (manifest.profileId !== profile.profileId) blockers.push('DATASET_PROFILE_MISMATCH');
    }

    return freeze({
      profileId: profile.profileId,
      market: profile.market,
      horizon: profile.horizon,
      timeframe: profile.timeframe,
      status: blockers.length === 0 ? 'READY' : 'BLOCKED',
      blockers: freeze([...new Set(blockers)]),
      datasetSnapshotHash: manifest?.datasetSnapshotHash ?? null,
      exactAuditStartMs: startTime,
      exactAuditEndMs: endTime,
    });
  });

  const markets = Object.fromEntries(MOVE_HUNTER_MARKETS.map((market) => {
    const marketProfiles = profiles.filter((row) => row.market === market);
    const blockers = [...new Set(marketProfiles.flatMap((row) => row.blockers))];
    return [market, freeze({
      market,
      status: marketProfiles.every((row) => row.status === 'READY') ? 'READY' : 'BLOCKED',
      readyProfileCount: marketProfiles.filter((row) => row.status === 'READY').length,
      profileCount: marketProfiles.length,
      blockers: freeze(blockers),
      profiles: freeze(marketProfiles),
    })];
  }));

  return freeze({
    schemaVersion: 'move-hunter-three-year-readiness/v1',
    startTime,
    endTime,
    markets: freeze(markets),
    readyMarketCount: Object.values(markets).filter((row) => row.status === 'READY').length,
    blockedMarketCount: Object.values(markets).filter((row) => row.status !== 'READY').length,
    fourMarketReady: Object.values(markets).every((row) => row.status === 'READY'),
    historicalReplayOnly: true,
    genuineForwardEvidence: false,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function assessMoveHunterThreeYearReadiness({
  datasetManifestsByProfile = {},
  receipts = [],
  startTime = MOVE_HUNTER_AUDIT_START_MS,
  endTime = MOVE_HUNTER_AUDIT_END_MS,
} = {}) {
  const catalog = buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile,
    receipts,
  });
  return freeze({
    ...summarizeThreeYearProfileReadiness({
      readiness: catalog.readiness,
      datasetManifestsByProfile,
      startTime,
      endTime,
    }),
    evidenceCatalogContract: catalog.contract,
  });
}
