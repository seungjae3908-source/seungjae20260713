import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildResearchAiEvidence,
  resolveResearchFreeAiPolicy,
  runResearchAiReviewScan,
} from '../src/research-ai-review-worker.mjs';

const SHA = 'a'.repeat(40);
const SECRET = 'TEST_ONLY_GROQ_SECRET_VALUE';

function cycle(profile, generatedAt = Date.parse('2026-09-05T07:00:00Z')) {
  return {
    schemaVersion: 'research-production-cycle-v1',
    cycleId: `cycle-${profile}`,
    profile,
    researchSha: SHA,
    generatedAt,
    status: 'complete',
    successCount: 999,
    blockedDataCount: 999,
    failedCount: 0,
    results: [
      { id: `${profile}-alpha`, status: 'success', timedOut: false, stdoutPath: '/secret/path', performance: { profit: 999 } },
      { id: `${profile}-beta`, status: 'blocked_data', timedOut: false, metrics: { winRate: 999 } },
    ],
    secretField: SECRET,
  };
}

const safeAnswer = JSON.stringify({
  summary: 'Runtime evidence is structurally consistent and still requires independent review.',
  findings: ['Observed task states should be checked against preserved provenance.'],
  hypotheses: [{
    hypothesisId: 'RegimeShift',
    thesis: 'A regime sensitive candidate may explain recurring structural failures.',
    requiredEvidence: ['Fresh prospective observations with preserved identity.'],
    falsification: 'Reject the hypothesis when the same failure pattern persists across distinct regimes.',
    intendedRegime: 'Changing market regime.',
    independenceRationale: 'Use observations that do not share source windows.',
  }],
  risks: ['Missing evidence can invalidate the interpretation.'],
  disposition: 'NEEDS_REVIEW',
});

async function writeCycles(root, profiles = ['forward', 'fast-historical', 'long-history']) {
  await mkdir(join(root, 'latest'), { recursive: true });
  for (const profile of profiles) {
    await writeFile(join(root, 'latest', `${profile}.json`), `${JSON.stringify(cycle(profile))}\n`);
  }
}

function fakePreflight(root) {
  return async ({ researchSha }) => ({ stateRoot: resolve(root), researchSha: String(researchSha).toLowerCase() });
}

test('free provider policy fails closed unless an exact approved free route is confirmed', () => {
  assert.equal(resolveResearchFreeAiPolicy({ AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET }).provider, null);
  assert.equal(resolveResearchFreeAiPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'openai-compatible', AI_CHAT_API_KEY: SECRET, AI_CHAT_MODEL: 'gpt-anything' }).provider, null);
  assert.equal(resolveResearchFreeAiPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET, GROQ_MODEL: 'paid-model' }).provider, null);
  const groq = resolveResearchFreeAiPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET });
  assert.equal(groq.provider, 'groq');
  assert.equal(groq.model, 'openai/gpt-oss-20b');
  const gemini = resolveResearchFreeAiPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'gemini', GEMINI_API_KEY: 'TEST_ONLY_GEMINI' });
  assert.equal(gemini.provider, 'gemini');
  assert.equal(gemini.model, 'gemini-3.1-flash-lite');
});

test('cycle projection exposes only structural runtime state and binds it to exact release SHA', () => {
  const projected = buildResearchAiEvidence(cycle('forward'), SHA);
  assert.equal(projected.role, 'CRITIC');
  assert.match(projected.evidenceDigest, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(projected.evidence);
  assert.equal(serialized.includes('profit'), false);
  assert.equal(serialized.includes('winRate'), false);
  assert.equal(serialized.includes('/secret/path'), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.throws(() => buildResearchAiEvidence({ ...cycle('forward'), researchSha: 'b'.repeat(40) }, SHA), /WRONG_RELEASE_SHA/);
});

test('scan reviews each unseen profile once, caches by evidence digest and never grants economic authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-worker-'));
  let calls = 0;
  try {
    await writeCycles(root);
    const env = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET };
    const invoke = async ({ policy }) => {
      calls += 1;
      return { answer: safeAnswer, model: policy.model, provider: policy.provider };
    };
    const input = {
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root), invoke,
      now: () => Date.parse('2026-09-05T07:30:00Z'),
    };
    const first = await runResearchAiReviewScan(input);
    assert.equal(first.status, 'COMPLETE');
    assert.equal(first.providerNetworkCalls, 3);
    assert.equal(first.reviews.length, 3);
    assert.equal(calls, 3);
    assert.equal(first.evidenceCredit, 0);
    assert.equal(first.profitabilityProven, false);
    assert.equal(first.champion, null);
    assert.equal(first.safety.executionAuthority, 'NONE');
    assert.equal(first.safety.orderAllowed, false);

    for (const review of first.reviews) {
      const artifact = JSON.parse(await readFile(join(root, 'ai-review', 'reviews', `${review.evidenceDigest}.json`), 'utf8'));
      assert.equal(artifact.evidenceCredit, 0);
      assert.equal(artifact.profitabilityProven, false);
      assert.equal(artifact.champion, null);
      assert.equal(JSON.stringify(artifact).includes(SECRET), false);
    }

    const second = await runResearchAiReviewScan(input);
    assert.equal(second.status, 'COMPLETE');
    assert.equal(second.providerNetworkCalls, 0);
    assert.equal(second.cacheHits, 3);
    assert.equal(calls, 3);
    assert.equal(JSON.stringify(second).includes(SECRET), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe numeric performance claims are rejected and backed off without affecting canonical research', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-unsafe-'));
  try {
    await writeCycles(root, ['forward']);
    const env = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET };
    const unsafe = JSON.stringify({
      summary: '승률 90%', findings: [], hypotheses: [], risks: [], disposition: 'NEEDS_REVIEW',
    });
    const result = await runResearchAiReviewScan({
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root),
      invoke: async ({ policy }) => ({ answer: unsafe, model: policy.model, provider: policy.provider }),
      now: () => Date.parse('2026-09-05T08:00:00Z'),
    });
    assert.equal(result.status, 'PARTIAL_AI_UNAVAILABLE');
    assert.equal(result.providerNetworkCalls, 1);
    assert.equal(result.reviews.length, 0);
    assert.equal(result.blockedProfiles.length, 1);
    assert.equal(result.blockedProfiles[0].reason, 'FORBIDDEN_AI_AUTHORITY');
    assert.equal(result.evidenceCredit, 0);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
