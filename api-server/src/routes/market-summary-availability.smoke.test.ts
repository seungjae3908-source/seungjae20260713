import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import marketSummaryAvailabilityRouter from './market-summary-availability';
import { createVideoResearchEvidenceRouter } from './video-research-evidence';

type Fixture = {
  status: number;
  body: Record<string, unknown>;
};

function summaryItem(key: string, price: number, ok: boolean) {
  return {
    key,
    label: key.toUpperCase(),
    price,
    changePercent: ok ? 1.25 : 0,
    spark: ok ? [price - 1, price] : [],
    unit: 'index',
    ok,
  };
}

async function start(fixture: Fixture) {
  const app = express();
  app.use('/api/market/summary', marketSummaryAvailabilityRouter);
  app.get('/api/market/summary', (_req, res) => {
    res.status(fixture.status).json(fixture.body);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function request(fixture: Fixture) {
  const server = await start(fixture);
  try {
    const response = await fetch(`${server.baseUrl}/api/market/summary`);
    const body = await response.json() as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await server.close();
  }
}

test('market summary exposes complete public-provider outage without browser-visible 503 or fake prices', async () => {
  const { status, body } = await request({
    status: 503,
    body: {
      ok: false,
      items: [summaryItem('kospi', 0, false), summaryItem('nasdaq', 0, false)],
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.available, false);
  assert.equal(body.partial, false);
  assert.equal(body.dataState, 'provider_error');
  assert.equal(body.errorCode, 'SUMMARY_PROVIDER_UNAVAILABLE');
  assert.equal(body.retryable, true);
  assert.equal(body.availableCount, 0);
  assert.equal(body.totalCount, 2);
  assert.deepEqual(body.missingKeys, ['kospi', 'nasdaq']);
  assert.deepEqual(body.items, []);
});

test('market summary keeps only verified live rows and marks partial provider availability', async () => {
  const { status, body } = await request({
    status: 200,
    body: {
      ok: true,
      items: [summaryItem('kospi', 3200.25, true), summaryItem('nasdaq', 0, false)],
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.available, true);
  assert.equal(body.partial, true);
  assert.equal(body.dataState, 'partial');
  assert.equal(body.errorCode, 'SUMMARY_PROVIDER_PARTIAL');
  assert.equal(body.retryable, true);
  assert.equal(body.availableCount, 1);
  assert.equal(body.totalCount, 2);
  assert.deepEqual(body.missingKeys, ['nasdaq']);
  const items = body.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.key, 'kospi');
  assert.equal(items[0]?.price, 3200.25);
  assert.equal(items[0]?.ok, true);
});

test('market summary reports ready only when every returned row has a verified positive price', async () => {
  const { status, body } = await request({
    status: 200,
    body: {
      ok: true,
      items: [summaryItem('kospi', 3200.25, true), summaryItem('nasdaq', 17000.5, true)],
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.available, true);
  assert.equal(body.partial, false);
  assert.equal(body.dataState, 'ready');
  assert.equal(body.errorCode, null);
  assert.equal(body.retryable, false);
  assert.equal(body.availableCount, 2);
  assert.deepEqual(body.missingKeys, []);
});

test('market summary does not downgrade unexpected backend failures', async () => {
  const { status, body } = await request({
    status: 502,
    body: {
      ok: false,
      items: [],
      error: 'SUMMARY_PROVIDER_ERROR',
    },
  });

  assert.equal(status, 502);
  assert.equal(body.error, 'SUMMARY_PROVIDER_ERROR');
  assert.equal(body.dataState, undefined);
});

const VIDEO_SAFETY = {
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
} as const;

function videoEvidenceSnapshot() {
  return {
    runtimeVersion: 'video-research-public-provider-runtime-v3',
    status: 'SUCCESS',
    provider: 'YOUTUBE_DATA_API_V3',
    providerAccess: 'OFFICIAL_PUBLIC_API',
    requestMode: 'READ_ONLY_GET',
    query: 'TEST_ONLY video strategy',
    pagesUsed: 1,
    quotaState: 'BOUNDED_ESTIMATE_USED_100_UNITS',
    credentialConfigured: true,
    credentialValueExposed: false,
    sourceCount: 1,
    records: [{
      videoId: 'TEST_ONLY_VIDEO',
      canonicalUrl: 'https://www.youtube.com/watch?v=TEST_ONLY_VIDEO',
      title: 'TEST_ONLY sanitized research source',
      channelOrPublisher: 'TEST_ONLY channel',
      publishedAt: '2026-09-12T00:00:00.000Z',
      discoveredAt: '2026-09-13T00:00:00.000Z',
      language: 'ko',
      durationSec: 321,
      transcriptStatus: 'NOT_PROVIDED',
      captionsKnownPresent: false,
      sourceTrustTier: 'UNKNOWN',
      contentAuthority: 'UNTRUSTED_EXTERNAL_DATA',
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    }],
    safety: VIDEO_SAFETY,
    snapshotProvenance: {
      schemaVersion: 'video-research-sanitized-snapshot-v1',
      sourceHeadSha: 'a'.repeat(40),
      observedAt: '2026-09-13T00:00:00.000Z',
      publisherMode: 'LOCAL_ATOMIC_FILE',
      providerRuntimeVersion: 'video-research-public-provider-runtime-v3',
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    },
  };
}

async function requestVideoEvidence(loadSnapshot: () => Promise<unknown>) {
  const app = express();
  app.use('/api/research/video/evidence', createVideoResearchEvidenceRouter(loadSnapshot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/research/video/evidence`);
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json() as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('video research evidence reader keeps missing snapshot UNKNOWN without inventing measured zero', async () => {
  const result = await requestVideoEvidence(async () => null);
  assert.equal(result.status, 200);
  assert.match(result.cacheControl ?? '', /no-store/u);
  assert.equal(result.body.available, false);
  assert.equal(result.body.dataState, 'UNKNOWN');
  assert.equal(result.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_MISSING');
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'sourceCount'), false);
  assert.equal(result.body.economicEvidenceCredit, 0);
  assert.equal(result.body.profitabilityCredit, 0);
  assert.equal(result.body.executionAuthority, 'NONE');
});

test('video research evidence reader projects only sanitized official public runtime evidence', async () => {
  const result = await requestVideoEvidence(async () => videoEvidenceSnapshot());
  assert.equal(result.status, 200);
  assert.equal(result.body.available, true);
  assert.equal(result.body.dataState, 'MEASURED');
  assert.equal(result.body.provider, 'YOUTUBE_DATA_API_V3');
  assert.equal(result.body.providerAccess, 'OFFICIAL_PUBLIC_API');
  assert.equal(result.body.requestMode, 'READ_ONLY_GET');
  assert.equal(result.body.sourceCount, 1);
  assert.equal(result.body.credentialValueExposed, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'credentialEnvName'), false);
  const records = result.body.records as Array<Record<string, unknown>>;
  assert.equal(records[0]?.contentAuthority, 'UNTRUSTED_EXTERNAL_DATA');
  assert.equal(records[0]?.economicEvidenceCredit, 0);
  assert.equal(records[0]?.profitabilityCredit, 0);
  assert.equal(records[0]?.executionAuthority, 'NONE');
  const provenance = result.body.snapshotProvenance as Record<string, unknown>;
  assert.equal(provenance.schemaVersion, 'video-research-sanitized-snapshot-v1');
  assert.equal(provenance.sourceHeadSha, 'a'.repeat(40));
  assert.equal(provenance.observedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(provenance.publisherMode, 'LOCAL_ATOMIC_FILE');
  assert.equal(provenance.executionAuthority, 'NONE');
});

test('video research evidence reader requires exact sanitized snapshot provenance before MEASURED', async () => {
  const missingProvenance: Record<string, unknown> = { ...videoEvidenceSnapshot() };
  delete missingProvenance.snapshotProvenance;
  const missingResult = await requestVideoEvidence(async () => missingProvenance);
  assert.equal(missingResult.body.available, false);
  assert.equal(missingResult.body.dataState, 'UNKNOWN');
  assert.equal(missingResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');
  assert.equal(Object.prototype.hasOwnProperty.call(missingResult.body, 'sourceCount'), false);

  const invalidSha = {
    ...videoEvidenceSnapshot(),
    snapshotProvenance: {
      ...videoEvidenceSnapshot().snapshotProvenance,
      sourceHeadSha: 'not-an-exact-sha',
    },
  };
  const invalidShaResult = await requestVideoEvidence(async () => invalidSha);
  assert.equal(invalidShaResult.body.available, false);
  assert.equal(invalidShaResult.body.dataState, 'UNKNOWN');
  assert.equal(invalidShaResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');

  const nonCanonicalTimestamp = {
    ...videoEvidenceSnapshot(),
    snapshotProvenance: {
      ...videoEvidenceSnapshot().snapshotProvenance,
      observedAt: '2026-09-13T00:00:00Z',
    },
  };
  const timestampResult = await requestVideoEvidence(async () => nonCanonicalTimestamp);
  assert.equal(timestampResult.body.available, false);
  assert.equal(timestampResult.body.dataState, 'UNKNOWN');
  assert.equal(timestampResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');
});

test('video research evidence reader independently rejects malformed record provenance', async () => {
  const wrongUrl = videoEvidenceSnapshot();
  wrongUrl.records = [{ ...wrongUrl.records[0], canonicalUrl: 'https://example.com/watch?v=TEST_ONLY_VIDEO' }];
  const wrongUrlResult = await requestVideoEvidence(async () => wrongUrl);
  assert.equal(wrongUrlResult.body.available, false);
  assert.equal(wrongUrlResult.body.dataState, 'UNKNOWN');
  assert.equal(wrongUrlResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');

  const inventedTranscriptStatus = videoEvidenceSnapshot();
  inventedTranscriptStatus.records = [{ ...inventedTranscriptStatus.records[0], transcriptStatus: 'AVAILABLE_BY_GUESS' }];
  const transcriptResult = await requestVideoEvidence(async () => inventedTranscriptStatus);
  assert.equal(transcriptResult.body.available, false);
  assert.equal(transcriptResult.body.dataState, 'UNKNOWN');
  assert.equal(transcriptResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');

  const inventedTrustTier = videoEvidenceSnapshot();
  inventedTrustTier.records = [{ ...inventedTrustTier.records[0], sourceTrustTier: 'PUBLIC_PLATFORM_METADATA' }];
  const trustResult = await requestVideoEvidence(async () => inventedTrustTier);
  assert.equal(trustResult.body.available, false);
  assert.equal(trustResult.body.dataState, 'UNKNOWN');
  assert.equal(trustResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');
});

test('video research evidence reader fails closed on secret-bearing or authority-violating snapshots', async () => {
  const secretBearing = { ...videoEvidenceSnapshot(), apiKey: 'TEST_ONLY_MUST_NOT_LEAK' };
  const secretResult = await requestVideoEvidence(async () => secretBearing);
  assert.equal(secretResult.body.available, false);
  assert.equal(secretResult.body.dataState, 'UNKNOWN');
  assert.equal(secretResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');
  assert.equal(JSON.stringify(secretResult.body).includes('TEST_ONLY_MUST_NOT_LEAK'), false);

  const authorityViolation: unknown = {
    ...videoEvidenceSnapshot(),
    safety: { ...VIDEO_SAFETY, scheduleActive: true },
  };
  const authorityResult = await requestVideoEvidence(async () => authorityViolation);
  assert.equal(authorityResult.body.available, false);
  assert.equal(authorityResult.body.dataState, 'UNKNOWN');
  assert.equal(authorityResult.body.reason, 'SANITIZED_RUNTIME_EVIDENCE_INVALID');
  assert.equal(Object.prototype.hasOwnProperty.call(authorityResult.body, 'sourceCount'), false);
});
