import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveResearchVideoDiscoveryPolicy,
  runResearchVideoDiscoveryScan,
} from '../src/research-video-discovery-worker.mjs';

const SHA = 'a'.repeat(40);
const SECRET = 'TEST_ONLY_YOUTUBE_KEY_123456';

function fakePreflight(root) {
  return async ({ researchSha }) => ({ stateRoot: resolve(root), researchSha: String(researchSha).toLowerCase() });
}

function snapshot(query, observedAt) {
  return {
    runtimeVersion: 'video-research-public-provider-runtime-v3',
    status: 'SUCCESS',
    provider: 'YOUTUBE_DATA_API_V3',
    providerAccess: 'OFFICIAL_PUBLIC_API',
    requestMode: 'READ_ONLY_GET',
    query,
    pagesUsed: 1,
    quotaState: 'UNKNOWN',
    credentialConfigured: true,
    credentialValueExposed: false,
    sourceCount: 1,
    records: [{
      videoId: 'abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'Public research video',
      channelOrPublisher: 'Research Channel',
      publishedAt: observedAt,
      discoveredAt: observedAt,
      language: null,
      durationSec: null,
      transcriptStatus: 'NOT_PROVIDED',
      captionsKnownPresent: null,
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
    snapshotProvenance: {
      schemaVersion: 'video-research-sanitized-snapshot-v1',
      sourceHeadSha: SHA,
      observedAt,
      publisherMode: 'LOCAL_ATOMIC_FILE',
      providerRuntimeVersion: 'video-research-public-provider-runtime-v3',
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    },
  };
}

test('discovery waits fail-closed until explicitly approved and configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-video-wait-'));
  try {
    let calls = 0;
    const result = await runResearchVideoDiscoveryScan({
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA,
      env: { YOUTUBE_DATA_API_KEY: SECRET },
      verifyGitHead: false, preflight: fakePreflight(root),
      discover: async () => { calls += 1; throw new Error('must not call'); },
      clock: () => '2026-10-02T03:00:00.000Z',
    });
    assert.equal(result.status, 'WAITING_CONFIGURATION');
    assert.equal(result.providerNetworkCalls, 0);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduled discovery rotates bounded queries and persists sanitized history plus review inbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-video-rotate-'));
  const queries = ['kr strategy research', 'us strategy research'];
  const seen = [];
  try {
    const env = {
      RESEARCH_VIDEO_DISCOVERY_APPROVED: 'true',
      RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON: JSON.stringify(queries),
      RESEARCH_VIDEO_INVOCATION_MODE: 'SYSTEMD_TIMER',
      YOUTUBE_DATA_API_KEY: SECRET,
    };
    let tick = 0;
    const discover = async ({ query, observedAt }) => {
      seen.push(query);
      return { published: true, snapshot: snapshot(query, observedAt) };
    };
    const input = {
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root), discover,
      clock: () => tick++ === 0 ? '2026-10-02T03:00:00.000Z' : '2026-10-02T06:00:00.000Z',
    };
    const first = await runResearchVideoDiscoveryScan(input);
    const second = await runResearchVideoDiscoveryScan(input);
    assert.deepEqual(seen, queries);
    assert.equal(first.status, 'COMPLETE');
    assert.equal(first.scheduledInvocationObserved, true);
    assert.equal(second.nextQueryIndex, 0);
    assert.equal(second.safety.automaticGeminiExecution, false);
    assert.equal(second.safety.automaticGroqExecution, false);
    assert.equal(second.safety.executionAuthority, 'NONE');
    const history = await readdir(join(root, 'video-research', 'history'));
    const inbox = await readdir(join(root, 'video-research', 'inbox'));
    assert.equal(history.length, 2);
    assert.equal(inbox.length, 2);
    const latest = await readFile(join(root, 'video-research', 'latest.json'), 'utf8');
    assert.equal(latest.includes(SECRET), false);
    assert.match(latest, /SOURCE_REVIEW_THEN_EXISTING_GEMINI_GROQ_ORCHESTRATOR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider failure does not advance the query cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-video-fail-'));
  const env = {
    RESEARCH_VIDEO_DISCOVERY_APPROVED: 'true',
    RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON: JSON.stringify(['first query', 'second query']),
    YOUTUBE_DATA_API_KEY: SECRET,
  };
  let attempt = 0;
  const seen = [];
  try {
    const discover = async ({ query, observedAt }) => {
      seen.push(query);
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('quota');
        error.code = 'VIDEO_RESEARCH_PHASE3_PROVIDER_ERROR';
        throw error;
      }
      return { published: true, snapshot: snapshot(query, observedAt) };
    };
    const input = {
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root), discover,
      clock: () => attempt === 0 ? '2026-10-02T03:00:00.000Z' : '2026-10-02T06:00:00.000Z',
    };
    const failed = await runResearchVideoDiscoveryScan(input);
    const recovered = await runResearchVideoDiscoveryScan(input);
    assert.equal(failed.status, 'BLOCKED');
    assert.equal(recovered.status, 'COMPLETE');
    assert.deepEqual(seen, ['first query', 'first query']);
    assert.equal(recovered.nextQueryIndex, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('policy rejects malformed query configuration without provider access', () => {
  assert.throws(() => resolveResearchVideoDiscoveryPolicy({
    RESEARCH_VIDEO_DISCOVERY_APPROVED: 'true',
    YOUTUBE_DATA_API_KEY: SECRET,
    RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON: JSON.stringify(['ok', 'bad\nquery']),
  }), /VIDEO_DISCOVERY_QUERIES_INVALID/);
});
