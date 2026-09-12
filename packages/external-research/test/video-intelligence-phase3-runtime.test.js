import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3,
  createPublicVideoDiscoveryRuntimeV3,
  runPublicVideoDiscoveryV3,
} from '../src/video-intelligence-phase3-runtime.js';

const NOW = '2026-09-12T12:30:00.000Z';
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

function successFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).includes('/search?')) {
      return response({
        items: [{
          id: { videoId: 'phase3-public-video' },
          snippet: {
            title: 'Public strategy research',
            channelId: 'public-channel',
            channelTitle: 'Public Research Channel',
            publishedAt: '2026-09-11T00:00:00Z',
          },
        }],
      });
    }
    return response({
      items: [{
        id: 'phase3-public-video',
        snippet: {
          title: 'Public strategy research',
          channelId: 'public-channel',
          channelTitle: 'Public Research Channel',
          publishedAt: '2026-09-11T00:00:00Z',
          description: 'Untrusted creator description',
          defaultAudioLanguage: 'en',
        },
        contentDetails: { duration: 'PT12M', caption: 'true' },
      }],
    });
  };
}

test('missing provider credential fails closed without outbound request', async () => {
  let fetchCount = 0;
  const runtime = createPublicVideoDiscoveryRuntimeV3({
    env: {},
    fetchImpl: async () => { fetchCount += 1; throw new Error('must not call'); },
  });
  const result = await runtime.discover({ query: 'bitcoin technical analysis strategy', discoveredAt: NOW });
  assert.equal(result.status, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(result.credentialConfigured, false);
  assert.equal(result.credentialEnvName, VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3);
  assert.equal(result.sourceCount, 0);
  assert.equal(fetchCount, 0);
  assert.equal(result.safety.paidProviderEnabled, false);
  assert.equal(result.safety.scheduleActive, false);
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.economicEvidenceCredit, 0);
  assert.equal(result.safety.profitabilityCredit, 0);
  assert.equal(result.safety.executionAuthority, 'NONE');
});

test('configured public runtime reuses official discovery and never exposes credential', async () => {
  const secret = 'phase3-secret-do-not-expose';
  const calls = [];
  const result = await runPublicVideoDiscoveryV3({
    env: { [VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3]: secret },
    fetchImpl: successFetch(calls),
    query: 'bitcoin technical analysis strategy',
    maxResults: 3,
    maxPages: 1,
    discoveredAt: NOW,
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provider, 'YOUTUBE_DATA_API_V3');
  assert.equal(result.providerAccess, 'OFFICIAL_PUBLIC_API');
  assert.equal(result.requestMode, 'READ_ONLY_GET');
  assert.equal(result.credentialConfigured, true);
  assert.equal(result.credentialValueExposed, false);
  assert.equal(result.sourceCount, 1);
  assert.equal(result.records[0].transcriptStatus, 'NOT_AUTHORIZED');
  assert.equal(result.records[0].economicEvidenceCredit, 0);
  assert.equal(result.records[0].profitabilityCredit, 0);
  assert.equal(result.records[0].executionAuthority, 'NONE');
  assert.deepEqual(calls.map((entry) => entry.method), ['GET', 'GET']);
  assert.ok(calls.every((entry) => entry.url.startsWith('https://www.googleapis.com/youtube/v3/')));
  assert.ok(calls.some((entry) => entry.url.includes(`key=${secret}`)));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('runtime authority locks reject activation or economic promotion attempts', async () => {
  const blocked = [
    ['paidProviderEnabled', true],
    ['scheduleActive', true],
    ['automaticDiscoveryEnabled', true],
    ['liveTrading', true],
    ['privateTradingApi', true],
    ['realOrderEnabled', true],
    ['credentialMutation', true],
    ['transcriptDownloadEnabled', true],
    ['economicEvidenceCredit', 1],
    ['profitabilityCredit', 1],
    ['executionAuthority', 'LIVE'],
  ];
  for (const [field, value] of blocked) {
    await assert.rejects(
      () => runPublicVideoDiscoveryV3({ query: 'x', env: {}, [field]: value }),
      (error) => error?.code === 'VIDEO_RESEARCH_PHASE3_AUTHORITY_LOCK_VIOLATION' && error?.details?.field === field,
    );
  }
});

test('runtime is bounded to one page and at most five public discovery records', async () => {
  await assert.rejects(
    () => runPublicVideoDiscoveryV3({ query: 'x', env: {}, maxPages: 2 }),
    (error) => error?.code === 'VIDEO_RESEARCH_PHASE3_MAX_PAGES_INVALID',
  );
  assert.throws(
    () => createPublicVideoDiscoveryRuntimeV3({ limits: { maxResultsPerQuery: 6 } }),
    (error) => error?.code === 'VIDEO_RESEARCH_PHASE3_MAX_RESULTS_INVALID',
  );
});
