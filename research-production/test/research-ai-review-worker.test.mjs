import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildResearchAiEvidence,
  invokeResearchFreeAi,
  preflightResearchAiReview,
  RESEARCH_AI_RESPONSE_SCHEMA,
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
  const coexist = resolveResearchFreeAiPolicy({
    RESEARCH_AI_FREE_TIER_CONFIRMED: 'true',
    AI_CHAT_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'TEST_ONLY_GEMINI',
    GROQ_API_KEY: SECRET,
  });
  assert.equal(coexist.provider, 'gemini');
  assert.equal(coexist.model, 'gemini-3.1-flash-lite');
  const conflict = resolveResearchFreeAiPolicy({
    RESEARCH_AI_FREE_TIER_CONFIRMED: 'true',
    AI_CHAT_PROVIDER: 'groq',
    GROQ_API_KEY: 'PROVIDER_KEY_A',
    AI_CHAT_API_KEY: 'PROVIDER_KEY_B',
  });
  assert.equal(conflict.provider, null);
  assert.equal(conflict.reason, 'PROVIDER_CONFIGURATION_CONFLICT');
});

test('provider presence maps a generic AI key only to its explicitly selected provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-presence-'));
  try {
    const common = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_API_KEY: SECRET };
    const groq = await preflightResearchAiReview({
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA,
      env: { ...common, AI_CHAT_PROVIDER: 'groq', AI_CHAT_MODEL: 'openai/gpt-oss-20b' },
      verifyGitHead: false, preflight: fakePreflight(root),
    });
    assert.deepEqual(groq.providerPresence, { groq: true, gemini: false });
    const gemini = await preflightResearchAiReview({
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA,
      env: { ...common, AI_CHAT_PROVIDER: 'gemini', AI_CHAT_MODEL: 'gemini-3.1-flash-lite' },
      verifyGitHead: false, preflight: fakePreflight(root),
    });
    assert.deepEqual(gemini.providerPresence, { groq: false, gemini: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('top-level blocked_data cycle is valid structural evidence rather than a technical failure', () => {
  const input = {
    ...cycle('fast-historical'),
    status: 'blocked_data',
    successCount: 1,
    blockedDataCount: 1,
    failedCount: 0,
  };
  const projected = buildResearchAiEvidence(input, SHA);
  assert.equal(projected.evidence.status, 'blocked_data');
  assert.equal(projected.evidence.profile, 'fast-historical');
  assert.equal(projected.role, 'PROPOSER');
  assert.equal(JSON.stringify(projected.evidence).includes('profit'), false);
  assert.equal(JSON.stringify(projected.evidence).includes(SECRET), false);
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
    assert.equal(first.invocationMode, 'MANUAL');
    assert.equal(first.scheduledInvocationObserved, false);
    assert.equal(first.profileCoverage.allProfilesCurrentAndReviewed, true);
    assert.deepEqual(first.profileCoverage.reviewedProfiles, ['fast-historical','forward','long-history']);

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

test('stale-release profile evidence is deferred instead of blocking fresh exact-release AI review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-stale-release-'));
  let calls = 0;
  try {
    await writeCycles(root);

    for (const profile of ['fast-historical', 'long-history']) {
      await writeFile(
        join(root, 'latest', `${profile}.json`),
        `${JSON.stringify({ ...cycle(profile), researchSha: 'b'.repeat(40) })}\n`,
      );
    }

    const env = {
      RESEARCH_AI_FREE_TIER_CONFIRMED: 'true',
      AI_CHAT_PROVIDER: 'groq',
      GROQ_API_KEY: SECRET,
    };

    const result = await runResearchAiReviewScan({
      repoRoot: '/TEST_ONLY/repo',
      stateRoot: root,
      researchSha: SHA,
      env,
      verifyGitHead: false,
      preflight: fakePreflight(root),
      invoke: async ({ policy }) => {
        calls += 1;
        return { answer: safeAnswer, model: policy.model, provider: policy.provider };
      },
      now: () => Date.parse('2026-09-05T09:00:00Z'),
    });

    assert.equal(result.status, 'PARTIAL_COVERAGE_COMPLETE');
    assert.equal(result.providerNetworkCalls, 1);
    assert.equal(result.reviews.length, 1);
    assert.equal(result.reviews[0].profile, 'forward');
    assert.equal(result.blockedProfiles.length, 0);
    assert.equal(result.deferredProfiles.length, 2);
    assert.deepEqual(
      result.deferredProfiles.map((row) => [row.profile, row.reason]).sort(),
      [
        ['fast-historical', 'STALE_RELEASE_EVIDENCE'],
        ['long-history', 'STALE_RELEASE_EVIDENCE'],
      ],
    );
    assert.equal(calls, 1);
    assert.equal(result.evidenceCredit, 0);
    assert.equal(result.profitabilityProven, false);
    assert.equal(result.safety.executionAuthority, 'NONE');
    assert.equal(result.profileCoverage.allProfilesCurrentAndReviewed, false);
    assert.deepEqual(result.profileCoverage.staleProfiles, ['fast-historical','long-history']);
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


test('structured output schema is sent to both approved providers', async () => {
  const groqCalls = [];
  await invokeResearchFreeAi({
    policy: { provider: 'groq', model: 'openai/gpt-oss-20b', apiKey: 'TEST_ONLY' },
    prompt: 'test',
    fetchImpl: async (_url, options) => {
      groqCalls.push(JSON.parse(options.body));
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: safeAnswer } }] }) };
    },
  });
  assert.equal(groqCalls[0].response_format.type, 'json_schema');
  assert.equal(groqCalls[0].response_format.json_schema.strict, true);
  assert.deepEqual(groqCalls[0].response_format.json_schema.schema, RESEARCH_AI_RESPONSE_SCHEMA);

  const geminiCalls = [];
  await invokeResearchFreeAi({
    policy: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: 'TEST_ONLY' },
    prompt: 'test',
    fetchImpl: async (_url, options) => {
      geminiCalls.push(JSON.parse(options.body));
      return { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: safeAnswer }] } }] }) };
    },
  });
  assert.equal(geminiCalls[0].generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(geminiCalls[0].generationConfig.responseJsonSchema, RESEARCH_AI_RESPONSE_SCHEMA);
});

test('safe structural numbers and cautionary metric language are accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-safe-number-'));
  try {
    await writeCycles(root, ['forward']);
    const env = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET };
    const answer = JSON.stringify({
      summary: 'Compare 3 recent structural cycles before drawing a conclusion.',
      findings: ['Current evidence cannot establish profitability.'],
      hypotheses: [],
      risks: ['Do not infer win rate from incomplete structural evidence.'],
      disposition: 'NEEDS_REVIEW',
    });
    const result = await runResearchAiReviewScan({
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root),
      invoke: async ({ policy }) => ({ answer, model: policy.model, provider: policy.provider }),
      now: () => Date.parse('2026-09-05T08:00:00Z'),
    });
    assert.equal(result.status, 'PARTIAL_COVERAGE_COMPLETE');
    assert.equal(result.blockedProfiles.length, 0);
    assert.equal(result.reviews.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retry backoff preserves the leaf reason instead of degrading to no-new-evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-retry-leaf-'));
  try {
    await writeCycles(root, ['forward']);
    const env = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET };
    const baseInput = {
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root),
      invoke: async () => { throw new Error('FREE_AI_RATE_LIMITED'); },
    };
    const firstAt = Date.parse('2026-09-05T08:00:00Z');
    const first = await runResearchAiReviewScan({ ...baseInput, now: () => firstAt });
    assert.equal(first.status, 'PARTIAL_AI_UNAVAILABLE');
    assert.equal(first.blockedProfiles[0].reason, 'FREE_AI_RATE_LIMITED');
    assert.equal(first.blockedProfiles[0].retryAfterAt, firstAt + 15 * 60 * 1000);

    const second = await runResearchAiReviewScan({ ...baseInput, now: () => firstAt + 60_000 });
    assert.equal(second.status, 'DEFERRED_RETRY');
    assert.equal(second.providerNetworkCalls, 0);
    assert.equal(second.deferredProfiles[0].reason, 'FREE_AI_RATE_LIMITED');
    assert.equal(second.profileCoverage.retryDeferredProfiles[0], 'forward');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test('caution in one clause cannot mask an unsafe performance claim in another clause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-mixed-claim-'));
  try {
    await writeCycles(root, ['forward']);
    const env = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET };
    const answer = JSON.stringify({
      summary: 'Current evidence cannot establish profitability; expected return is strong.',
      findings: [],
      hypotheses: [],
      risks: [],
      disposition: 'NEEDS_REVIEW',
    });
    const result = await runResearchAiReviewScan({
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(root),
      invoke: async ({ policy }) => ({ answer, model: policy.model, provider: policy.provider }),
      now: () => Date.parse('2026-09-05T10:00:00Z'),
    });
    assert.equal(result.status, 'PARTIAL_AI_UNAVAILABLE');
    assert.equal(result.blockedProfiles[0].reason, 'FORBIDDEN_AI_AUTHORITY');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider-facing schema stays within Gemini-supported structured-output subset', () => {
  const forbidden = new Set(['minLength', 'maxLength', 'pattern']);
  const seen = [];
  const walk = (value, path = '$') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) seen.push(path + '.' + key);
      walk(child, path + '.' + key);
    }
  };
  walk(RESEARCH_AI_RESPONSE_SCHEMA);
  assert.deepEqual(seen, []);
  assert.equal(RESEARCH_AI_RESPONSE_SCHEMA.additionalProperties, false);
  assert.equal(RESEARCH_AI_RESPONSE_SCHEMA.properties.hypotheses.items.additionalProperties, false);
});

test('ordinary return wording is allowed while performance-return claims remain blocked', async () => {
  const acceptedRoot = await mkdtemp(join(tmpdir(), 'research-ai-return-language-safe-'));
  const blockedRoot = await mkdtemp(join(tmpdir(), 'research-ai-return-language-blocked-'));
  try {
    const env = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: SECRET };

    await writeCycles(acceptedRoot, ['forward']);
    const ordinary = JSON.stringify({
      summary: 'Return to source provenance before inference.',
      findings: [],
      hypotheses: [],
      risks: [],
      disposition: 'NEEDS_REVIEW',
    });
    const accepted = await runResearchAiReviewScan({
      repoRoot: '/TEST_ONLY/repo', stateRoot: acceptedRoot, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(acceptedRoot),
      invoke: async ({ policy }) => ({ answer: ordinary, model: policy.model, provider: policy.provider }),
      now: () => Date.parse('2026-09-05T08:00:00Z'),
    });
    assert.equal(accepted.status, 'PARTIAL_COVERAGE_COMPLETE');

    await writeCycles(blockedRoot, ['forward']);
    const performanceClaim = JSON.stringify({
      summary: 'Expected return is strong.',
      findings: [],
      hypotheses: [],
      risks: [],
      disposition: 'NEEDS_REVIEW',
    });
    const blocked = await runResearchAiReviewScan({
      repoRoot: '/TEST_ONLY/repo', stateRoot: blockedRoot, researchSha: SHA, env,
      verifyGitHead: false, preflight: fakePreflight(blockedRoot),
      invoke: async ({ policy }) => ({ answer: performanceClaim, model: policy.model, provider: policy.provider }),
      now: () => Date.parse('2026-09-05T09:00:00Z'),
    });
    assert.equal(blocked.status, 'PARTIAL_AI_UNAVAILABLE');
    assert.equal(blocked.blockedProfiles[0].reason, 'FORBIDDEN_AI_AUTHORITY');
  } finally {
    await rm(acceptedRoot, { recursive: true, force: true });
    await rm(blockedRoot, { recursive: true, force: true });
  }
});
