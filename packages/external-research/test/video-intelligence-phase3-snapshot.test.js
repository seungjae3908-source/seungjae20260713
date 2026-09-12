import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1,
  createSanitizedVideoResearchSnapshotV1,
  publishSanitizedVideoResearchSnapshotV1,
} from '../src/video-intelligence-phase3-snapshot.js';

const HEAD = '7372877ed71aa7ef72b292600b749300f8d26c11';
const OBSERVED_AT = '2026-09-13T03:20:00+09:00';

function successfulRuntimeResult() {
  return {
    runtimeVersion: 'video-research-public-provider-runtime-v3',
    status: 'SUCCESS',
    provider: 'YOUTUBE_DATA_API_V3',
    providerAccess: 'OFFICIAL_PUBLIC_API',
    requestMode: 'READ_ONLY_GET',
    query: 'bitcoin technical analysis strategy',
    pagesUsed: 1,
    quotaState: 'BOUNDED_ESTIMATE_USED_100_UNITS',
    credentialEnvName: 'YOUTUBE_DATA_API_KEY',
    credentialConfigured: true,
    credentialValueExposed: false,
    sourceCount: 1,
    records: [{
      videoId: 'public-video-1',
      canonicalUrl: 'https://www.youtube.com/watch?v=public-video-1',
      title: 'Public strategy research',
      channelOrPublisher: 'Public Research Channel',
      publishedAt: '2026-09-11T00:00:00Z',
      discoveredAt: '2026-09-13T00:00:00Z',
      language: 'en',
      durationSec: 720,
      transcriptStatus: 'NOT_AUTHORIZED',
      captionsKnownPresent: true,
      sourceTrustTier: 'UNKNOWN',
      contentAuthority: 'UNTRUSTED_EXTERNAL_DATA',
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    }],
    safety: {
      researchOnly: true,
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
    },
  };
}

test('sanitized snapshot strips credential metadata and binds exact source provenance', () => {
  const snapshot = createSanitizedVideoResearchSnapshotV1(successfulRuntimeResult(), {
    sourceHeadSha: HEAD,
    observedAt: OBSERVED_AT,
  });
  assert.equal(snapshot.runtimeVersion, 'video-research-public-provider-runtime-v3');
  assert.equal(snapshot.provider, 'YOUTUBE_DATA_API_V3');
  assert.equal(snapshot.requestMode, 'READ_ONLY_GET');
  assert.equal(snapshot.sourceCount, 1);
  assert.equal(snapshot.credentialConfigured, true);
  assert.equal(snapshot.credentialValueExposed, false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'credentialEnvName'), false);
  assert.equal(snapshot.records[0]?.canonicalUrl, 'https://www.youtube.com/watch?v=public-video-1');
  assert.equal(snapshot.records[0]?.transcriptStatus, 'NOT_AUTHORIZED');
  assert.equal(snapshot.records[0]?.sourceTrustTier, 'UNKNOWN');
  assert.equal(snapshot.snapshotProvenance.sourceHeadSha, HEAD);
  assert.equal(snapshot.snapshotProvenance.observedAt, '2026-09-12T18:20:00.000Z');
  assert.equal(snapshot.snapshotProvenance.publisherMode, 'LOCAL_ATOMIC_FILE');
  assert.equal(snapshot.safety.economicEvidenceCredit, 0);
  assert.equal(snapshot.safety.profitabilityCredit, 0);
  assert.equal(snapshot.safety.executionAuthority, 'NONE');
});

test('publisher writes exactly one fixed-name atomic snapshot in a caller-selected local directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-research-snapshot-'));
  try {
    const published = await publishSanitizedVideoResearchSnapshotV1({
      result: successfulRuntimeResult(),
      outputDir: directory,
      sourceHeadSha: HEAD,
      observedAt: OBSERVED_AT,
    });
    assert.equal(published.path, join(directory, VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1));
    const files = await readdir(directory);
    assert.deepEqual(files, [VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1]);
    const raw = await readFile(published.path, 'utf8');
    const stored = JSON.parse(raw);
    assert.equal(stored.snapshotProvenance.sourceHeadSha, HEAD);
    assert.equal(stored.sourceCount, 1);
    assert.equal(raw.includes('YOUTUBE_DATA_API_KEY'), false);
    assert.equal(raw.includes('apiKey'), false);
    assert.equal(stored.safety.scheduleActive, false);
    assert.equal(stored.safety.automaticDiscoveryEnabled, false);
    assert.equal(stored.safety.executionAuthority, 'NONE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publisher fails closed on malformed record identity, transcript status, and trust tier', () => {
  const wrongHost = successfulRuntimeResult();
  wrongHost.records[0].canonicalUrl = 'https://example.invalid/watch?v=public-video-1';
  const mismatchedVideoId = successfulRuntimeResult();
  mismatchedVideoId.records[0].canonicalUrl = 'https://www.youtube.com/watch?v=another-video';
  const invalidTranscriptStatus = successfulRuntimeResult();
  invalidTranscriptStatus.records[0].transcriptStatus = 'AVAILABLE_BY_GUESS';
  const invalidTrustTier = successfulRuntimeResult();
  invalidTrustTier.records[0].sourceTrustTier = 'PUBLIC_PLATFORM_METADATA';

  for (const result of [wrongHost, mismatchedVideoId, invalidTranscriptStatus, invalidTrustTier]) {
    assert.throws(
      () => createSanitizedVideoResearchSnapshotV1(result, { sourceHeadSha: HEAD, observedAt: OBSERVED_AT }),
      (error) => error?.code === 'VIDEO_RESEARCH_SNAPSHOT_RECORD_INVALID',
    );
  }
});

test('publisher fails closed on non-success, secret-bearing, promoted, ambiguous, or unbound evidence', async () => {
  const cases = [
    [{ ...successfulRuntimeResult(), status: 'PROVIDER_NOT_CONFIGURED' }, 'VIDEO_RESEARCH_SNAPSHOT_STATUS_NOT_SUCCESS'],
    [{ ...successfulRuntimeResult(), apiKey: 'must-not-be-accepted' }, 'VIDEO_RESEARCH_SNAPSHOT_SECRET_BEARING_KEY'],
    [{ ...successfulRuntimeResult(), safety: { ...successfulRuntimeResult().safety, scheduleActive: true } }, 'VIDEO_RESEARCH_SNAPSHOT_AUTHORITY_LOCK_INVALID'],
    [{ ...successfulRuntimeResult(), sourceCount: 2 }, 'VIDEO_RESEARCH_SNAPSHOT_RECORD_COUNT_MISMATCH'],
  ];
  for (const [result, code] of cases) {
    assert.throws(
      () => createSanitizedVideoResearchSnapshotV1(result, { sourceHeadSha: HEAD, observedAt: OBSERVED_AT }),
      (error) => error?.code === code,
    );
  }
  assert.throws(
    () => createSanitizedVideoResearchSnapshotV1(successfulRuntimeResult(), { sourceHeadSha: 'not-a-sha', observedAt: OBSERVED_AT }),
    (error) => error?.code === 'VIDEO_RESEARCH_SNAPSHOT_SOURCE_SHA_INVALID',
  );
});
