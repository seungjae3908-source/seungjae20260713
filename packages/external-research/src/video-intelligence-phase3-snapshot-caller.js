import { runPublicVideoDiscoveryV3 } from './video-intelligence-phase3-runtime.js';
import { publishSanitizedVideoResearchSnapshotV1 } from './video-intelligence-phase3-snapshot.js';

export async function runAndPublishSanitizedVideoResearchSnapshotV1({
  query,
  outputDir,
  sourceHeadSha,
  observedAt,
  env = {},
  fetchImpl = globalThis.fetch,
  maxResults = 3,
  relevanceLanguage = null,
  regionCode = null,
  order = 'relevance',
  publishedAfter = null,
} = {}) {
  let providerNetworkCalls = 0;
  const countedFetch = async (...args) => {
    providerNetworkCalls += 1;
    return fetchImpl(...args);
  };
  const result = await runPublicVideoDiscoveryV3({
    env,
    fetchImpl: countedFetch,
    query,
    maxResults,
    maxPages: 1,
    relevanceLanguage,
    regionCode,
    order,
    publishedAfter,
    discoveredAt: observedAt,
    discoveryReason: 'PHASE3_SANITIZED_SNAPSHOT_READ_ONLY',
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
    paidProviderEnabled: false,
    scheduleActive: false,
    automaticDiscoveryEnabled: false,
    liveTrading: false,
    privateTradingApi: false,
    realOrderEnabled: false,
    credentialMutation: false,
    transcriptDownloadEnabled: false,
  });

  if (result.status !== 'SUCCESS') {
    return Object.freeze({
      published: false,
      reason: 'VIDEO_RESEARCH_RUNTIME_NOT_SUCCESS',
      result,
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
      providerNetworkCalls,
    });
  }

  const published = await publishSanitizedVideoResearchSnapshotV1({
    result,
    outputDir,
    sourceHeadSha,
    observedAt,
  });
  return Object.freeze({
    published: true,
    reason: null,
    result,
    snapshotPath: published.path,
    snapshot: published.snapshot,
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
    providerNetworkCalls,
  });
}
