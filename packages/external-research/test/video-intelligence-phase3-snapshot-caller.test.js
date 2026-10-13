import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAndPublishSanitizedVideoResearchSnapshotV1 } from '../src/video-intelligence-phase3-snapshot-caller.js';

const HEAD = '7372877ed71aa7ef72b292600b749300f8d26c11';
const OBSERVED_AT = '2026-09-13T03:20:00+09:00';

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
          id: { videoId: 'snapshot-public-video' },
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
        id: 'snapshot-public-video',
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

test('caller publishes only successful official public discovery into the sanitized snapshot contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-research-caller-'));
  const calls = [];
  const secret = 'test-only-provider-secret';
  try {
    const result = await runAndPublishSanitizedVideoResearchSnapshotV1({
      query: 'bitcoin technical analysis strategy',
      outputDir: directory,
      sourceHeadSha: HEAD,
      observedAt: OBSERVED_AT,
      env: { YOUTUBE_DATA_API_KEY: secret },
      fetchImpl: successFetch(calls),
    });
    assert.equal(result.published, true);
    assert.equal(result.result.status, 'SUCCESS');
    assert.equal(result.snapshot.sourceCount, 1);
    assert.equal(result.snapshot.snapshotProvenance.sourceHeadSha, HEAD);
    assert.equal(result.economicEvidenceCredit, 0);
    assert.equal(result.profitabilityCredit, 0);
    assert.equal(result.executionAuthority, 'NONE');
    assert.deepEqual(calls.map((entry) => entry.method), ['GET', 'GET']);
    assert.ok(calls.every((entry) => entry.url.startsWith('https://www.googleapis.com/youtube/v3/')));
    const stored = await readFile(result.snapshotPath, 'utf8');
    assert.equal(stored.includes(secret), false);
    assert.equal(stored.includes('YOUTUBE_DATA_API_KEY'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('caller does not publish when provider runtime is not configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-research-caller-missing-'));
  let fetchCount = 0;
  try {
    const result = await runAndPublishSanitizedVideoResearchSnapshotV1({
      query: 'bitcoin technical analysis strategy',
      outputDir: directory,
      sourceHeadSha: HEAD,
      observedAt: OBSERVED_AT,
      env: {},
      fetchImpl: async () => { fetchCount += 1; throw new Error('must not call'); },
    });
    assert.equal(result.published, false);
    assert.equal(result.reason, 'VIDEO_RESEARCH_RUNTIME_NOT_SUCCESS');
    assert.equal(result.result.status, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(fetchCount, 0);
    assert.equal(result.economicEvidenceCredit, 0);
    assert.equal(result.profitabilityCredit, 0);
    assert.equal(result.executionAuthority, 'NONE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
