import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  preflightAutonomousResearchAi,
  probeAutonomousResearchAi,
  runAutonomousResearchAiPilot,
} from '../src/autonomous-research-ai-runtime.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHA = 'a'.repeat(40);
const NOW = '2026-08-21T07:30:00.000Z';

function safeEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    LIVE_TRADING: 'false',
    REAL_ORDER_ENABLED: 'false',
    PRIVATE_API_ENABLED: 'false',
    PRIVATE_TRADING_API_ALLOWED: 'false',
    ORDER_AUTHORITY: 'false',
    ...extra,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function reviewPayload(prompt) {
  const adversarial = prompt.includes('Assigned role: ADVERSARIAL_REVIEWER');
  return {
    conclusion: adversarial ? 'REJECT_HYPOTHESIS' : 'PROPOSE_DETERMINISTIC_TEST',
    mechanismOrChallenge: adversarial
      ? 'Reject until leakage, cost realism, and unavailable-feature risks are deterministically tested.'
      : 'Test the bounded published-family hypothesis with canonical point-in-time data.',
    expectedRegime: 'REQUIRES_DETERMINISTIC_TEST',
    findings: [adversarial ? 'ADVERSARIAL_DISAGREEMENT' : 'BOUNDED_RESEARCH_HYPOTHESIS'],
    proposedBoundedVariants: [],
    deterministicResolution: 'RUN_CANONICAL_RESEARCH_QUEUE_WITHOUT_AI_PROMOTION_AUTHORITY',
  };
}

function createMockFetch(calls) {
  return async (url, init = {}) => {
    const parsedBody = JSON.parse(String(init.body ?? '{}'));
    const isGemini = String(url).includes('generativelanguage.googleapis.com');
    const prompt = isGemini
      ? String(parsedBody?.contents?.[0]?.parts?.[0]?.text ?? '')
      : String(parsedBody?.messages?.at?.(-1)?.content ?? parsedBody?.messages?.[parsedBody.messages.length - 1]?.content ?? '');
    calls.push({ url: String(url), method: init.method, prompt });
    const output = prompt.includes('Return JSON only:')
      ? JSON.stringify({ status: 'READY' })
      : JSON.stringify(reviewPayload(prompt));
    return isGemini
      ? jsonResponse({ candidates: [{ content: { parts: [{ text: output }] } }] })
      : jsonResponse({ choices: [{ message: { content: output } }] });
  };
}

async function withStateRoot(run) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'research-ai-runtime-'));
  try {
    return await run(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

test('preflight is network-free and fails closed when FREE providers are not configured', async () => {
  await withStateRoot(async (stateRoot) => {
    let networkCalls = 0;
    const preflight = await preflightAutonomousResearchAi({
      repoRoot: REPO_ROOT,
      stateRoot,
      researchSha: SHA,
      env: safeEnv(),
      verifyGitHead: false,
      fetchImpl: async () => { networkCalls += 1; throw new Error('unexpected network call'); },
      now: () => NOW,
    });
    assert.equal(preflight.result.status, 'WAITING_FOR_AI');
    assert.equal(preflight.result.providerPresence.geminiConfigured, false);
    assert.equal(preflight.result.providerPresence.groqConfigured, false);
    assert.equal(preflight.result.providerNetworkCalls, 0);
    assert.equal(networkCalls, 0);
    assert.equal(preflight.result.PAID_FALLBACK, false);
    assert.equal(preflight.result.safety.LIVE_TRADING, false);
  });
});

test('provider probe uses exactly Gemini and Groq and never serializes credential values', async () => {
  await withStateRoot(async (stateRoot) => {
    const calls = [];
    const env = safeEnv({
      GEMINI_API_KEY: 'gemini-secret-value-for-test',
      GROQ_API_KEY: 'groq-secret-value-for-test',
    });
    const probed = await probeAutonomousResearchAi({
      repoRoot: REPO_ROOT,
      stateRoot,
      researchSha: SHA,
      env,
      verifyGitHead: false,
      fetchImpl: createMockFetch(calls),
      now: () => NOW,
    });
    assert.equal(probed.result.status, 'READY');
    assert.equal(probed.result.providerReadiness.AI_PROVIDER_A_READY, 'READY');
    assert.equal(probed.result.providerReadiness.AI_PROVIDER_B_READY, 'READY');
    assert.equal(probed.result.providerReadiness.AI_DUAL_REVIEW_READY, 'READY');
    assert.equal(probed.result.providerNetworkCalls, 2);
    assert.equal(calls.length, 2);
    const serialized = JSON.stringify(probed.result);
    assert.equal(serialized.includes(env.GEMINI_API_KEY), false);
    assert.equal(serialized.includes(env.GROQ_API_KEY), false);
  });
});

test('provider probe counts only configured provider calls', async () => {
  await withStateRoot(async (stateRoot) => {
    const calls = [];
    const env = safeEnv({ GEMINI_API_KEY: 'gemini-only-secret-for-test' });
    const probed = await probeAutonomousResearchAi({
      repoRoot: REPO_ROOT,
      stateRoot,
      researchSha: SHA,
      env,
      verifyGitHead: false,
      fetchImpl: createMockFetch(calls),
      now: () => NOW,
    });
    assert.equal(probed.result.status, 'AI_RESEARCH_UNAVAILABLE');
    assert.equal(probed.result.providerReadiness.AI_PROVIDER_A_READY, 'READY');
    assert.equal(probed.result.providerReadiness.AI_PROVIDER_B_READY, 'UNAVAILABLE');
    assert.equal(probed.result.providerNetworkCalls, 1);
    assert.equal(calls.length, 1);
  });
});

test('real-AI pilot contract performs probe plus four role-reversal reviews and persists only sanitized evidence', async () => {
  await withStateRoot(async (stateRoot) => {
    const calls = [];
    const env = safeEnv({
      GEMINI_API_KEY: 'gemini-secret-value-for-pilot',
      GROQ_API_KEY: 'groq-secret-value-for-pilot',
    });
    const result = await runAutonomousResearchAiPilot({
      repoRoot: REPO_ROOT,
      stateRoot,
      researchSha: SHA,
      env,
      verifyGitHead: false,
      fetchImpl: createMockFetch(calls),
      now: () => NOW,
    });
    assert.equal(result.status, 'AI_REVIEW_CONFLICT');
    assert.equal(result.reviewCalls, 4);
    assert.equal(result.reviews, 4);
    assert.equal(calls.length, 6);
    assert.equal(result.queueJobsCreated, 0);
    assert.equal(result.backtestsExecuted, 0);
    assert.equal(result.profitabilityClaimed, false);
    assert.equal(result.championCreated, false);
    assert.equal(result.safety.REAL_ORDER_ENABLED, false);
    assert.match(result.artifactDigest, /^[0-9a-f]{64}$/);
    const persisted = await readFile(join(stateRoot, 'autonomous-ai', 'latest-ai-pilot.json'), 'utf8');
    assert.equal(persisted.includes(env.GEMINI_API_KEY), false);
    assert.equal(persisted.includes(env.GROQ_API_KEY), false);
    assert.match(persisted, /AI_REVIEW_CONFLICT/);
  });
});

test('pilot with missing provider credentials records unavailable state without provider calls', async () => {
  await withStateRoot(async (stateRoot) => {
    let networkCalls = 0;
    const result = await runAutonomousResearchAiPilot({
      repoRoot: REPO_ROOT,
      stateRoot,
      researchSha: SHA,
      env: safeEnv(),
      verifyGitHead: false,
      fetchImpl: async () => { networkCalls += 1; throw new Error('unexpected network call'); },
      now: () => NOW,
    });
    assert.equal(result.status, 'AI_RESEARCH_UNAVAILABLE');
    assert.equal(result.reviewCalls, 0);
    assert.equal(result.reviews, 0);
    assert.equal(networkCalls, 0);
    assert.equal(result.profitabilityClaimed, false);
  });
});

test('isolated autonomous AI systemd unit has no install or recurring activation authority', async () => {
  const unit = await readFile(join(REPO_ROOT, 'research-production/deploy/research-autonomous-ai@.service'), 'utf8');
  assert.match(unit, /EnvironmentFile=-\/etc\/investment-research\/research-ai\.env/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(unit, /autonomous-research-ai\.mjs %i/);
  assert.doesNotMatch(unit, /^\[Install\]$/m);
  assert.doesNotMatch(unit, /^WantedBy=/m);
});

test('Research Production safety gate still rejects any live-trading activation flag', async () => {
  await withStateRoot(async (stateRoot) => {
    await assert.rejects(
      preflightAutonomousResearchAi({
        repoRoot: REPO_ROOT,
        stateRoot,
        researchSha: SHA,
        env: safeEnv({ LIVE_TRADING: 'true' }),
        verifyGitHead: false,
        now: () => NOW,
      }),
      /refuses live\/private activation/,
    );
  });
});
