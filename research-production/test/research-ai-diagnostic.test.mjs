import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = 'a'.repeat(40);
const cli = fileURLToPath(new URL('../bin/research-ai-diagnostic.mjs', import.meta.url));

test('AI diagnostic exposes leaf reason without evidence body or secret-like fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-diagnostic-'));
  try {
    await chmod(root, 0o700);
    const aiRoot = join(root, 'ai-review');
    await mkdir(aiRoot, { mode: 0o700 });
    const latest = {
      schemaVersion: 'research-production-ai-scan-v1',
      status: 'PARTIAL_AI_UNAVAILABLE',
      researchSha: SHA,
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      providerNetworkCalls: 1,
      cacheHits: 0,
      profileCoverage: {
        totalProfiles: 3,
        reviewedProfiles: [],
        missingProfiles: [],
        staleProfiles: ['fast-historical', 'long-history'],
        retryDeferredProfiles: [],
        blockedProfiles: ['forward'],
        allProfilesCurrentAndReviewed: false,
      },
      blockedProfiles: [{
        profile: 'forward',
        evidenceDigest: 'd'.repeat(64),
        reason: 'FREE_AI_RATE_LIMITED',
        retryAfterAt: 123456789,
        apiKey: 'SHOULD_NEVER_APPEAR',
        rawProviderBody: 'SHOULD_NEVER_APPEAR',
      }],
      deferredProfiles: [],
      reviews: [],
      prompt: 'SHOULD_NEVER_APPEAR',
      providerCredential: 'SHOULD_NEVER_APPEAR',
    };
    await writeFile(join(aiRoot, 'latest.json'), JSON.stringify(latest) + '\n', { mode: 0o600 });

    const run = spawnSync(process.execPath, [
      cli, '--state-root', root, '--research-sha', SHA,
    ], { encoding: 'utf8' });

    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.schemaVersion, 'research-production-ai-diagnostic-v1');
    assert.equal(output.status, 'PARTIAL_AI_UNAVAILABLE');
    assert.equal(output.blockedProfiles[0].profile, 'forward');
    assert.equal(output.blockedProfiles[0].reason, 'FREE_AI_RATE_LIMITED');
    assert.equal(output.credentialValuesExposed, false);
    assert.equal(output.executionAuthority, 'NONE');
    assert.doesNotMatch(run.stdout, /SHOULD_NEVER_APPEAR|apiKey|providerCredential|rawProviderBody|prompt|evidenceDigest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AI diagnostic fails closed on release SHA mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-diagnostic-mismatch-'));
  try {
    await chmod(root, 0o700);
    const aiRoot = join(root, 'ai-review');
    await mkdir(aiRoot, { mode: 0o700 });
    await writeFile(join(aiRoot, 'latest.json'), JSON.stringify({
      schemaVersion: 'research-production-ai-scan-v1',
      status: 'COMPLETE',
      researchSha: 'b'.repeat(40),
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      providerNetworkCalls: 1,
      cacheHits: 0,
      blockedProfiles: [],
      deferredProfiles: [],
      reviews: [],
    }) + '\n', { mode: 0o600 });

    const run = spawnSync(process.execPath, [
      cli, '--state-root', root, '--research-sha', SHA,
    ], { encoding: 'utf8' });

    assert.notEqual(run.status, 0);
    const output = JSON.parse(run.stderr);
    assert.equal(output.status, 'FAILED_CLOSED');
    assert.equal(output.reason, 'AI_REVIEW_LATEST_SHA_MISMATCH');
    assert.equal(output.credentialValuesExposed, false);
    assert.equal(output.executionAuthority, 'NONE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
