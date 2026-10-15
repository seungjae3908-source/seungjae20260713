import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAutonomousResearchClosedLoopV1 } from '../src/autonomous-research-closed-loop-v1.mjs';
import { runResearchAiIsolatedTransitionV2 } from '../src/research-ai-isolated-transition-v2.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
const AT = '2026-10-14T04:00:00.000Z';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-isolated-transition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'production-state');
  const isolated = join(root, 'isolated-state');
  const repo = join(root, 'repo');
  const envRoot = join(root, 'env');
  await Promise.all([
    mkdir(join(source, 'latest'), { recursive: true, mode: 0o700 }),
    mkdir(repo, { mode: 0o700 }),
    mkdir(envRoot, { mode: 0o700 }),
  ]);
  await runAutonomousResearchClosedLoopV1({ stateRoot: source, researchCodeSha: SOURCE_SHA, now: () => AT });
  await writeFile(join(source, 'latest', 'forward.json'), `${JSON.stringify({
    schemaVersion: 'research-production-cycle-v1', profile: 'forward', researchSha: SOURCE_SHA,
    status: 'blocked_data', results: [],
  })}\n`, { mode: 0o600 });
  // Real fast-historical producer (historical-pipelines.mjs) writes historical-cycle-v2.
  await writeFile(join(source, 'latest', 'fast-historical.json'), `${JSON.stringify({
    schemaVersion: 'research-production-historical-cycle-v2', profile: 'fast-historical', researchSha: SOURCE_SHA,
    status: 'blocked_data', results: [],
  })}\n`, { mode: 0o600 });
  const providerEnvPath = join(envRoot, 'providers.env');
  const aiPolicyEnvPath = join(envRoot, 'ai.env');
  const videoPolicyEnvPath = join(envRoot, 'video.env');
  await Promise.all([
    writeFile(providerEnvPath, 'YOUTUBE_DATA_API_KEY=TEST_ONLY_YOUTUBE\nGEMINI_API_KEY=TEST_ONLY_GEMINI\nGEMINI_MODEL=gemini-3.1-flash-lite\nGROQ_API_KEY=TEST_ONLY_GROQ\nGROQ_MODEL=openai/gpt-oss-20b\n', { mode: 0o600 }),
    writeFile(aiPolicyEnvPath, 'RESEARCH_AI_FREE_TIER_CONFIRMED=true\nAI_CHAT_PROVIDER=gemini\nRESEARCH_AI_MAX_CALLS_PER_SCAN=3\n', { mode: 0o600 }),
    writeFile(videoPolicyEnvPath, 'RESEARCH_VIDEO_DISCOVERY_APPROVED=true\n', { mode: 0o600 }),
  ]);
  return { root, source, isolated, repo, providerEnvPath, aiPolicyEnvPath, videoPolicyEnvPath };
}

function cycle(index) {
  return {
    schemaVersion: 2, contract: 'autonomous-research-cycle/v2', status: 'COMPLETE',
    observedAt: AT, researchCodeSha: TARGET_SHA, directiveConsumed: true, discoveryStatus: 'DOSSIER_STAGED',
    actualProviderCalls: { attempted: 2, succeeded: 2, failed: 0 },
    actualSourceFetches: { attempted: 3, succeeded: 3, failed: 0 },
    selectedNextStrategy: { repository: 'https://github.com/example/public', sourcePath: `strategy-${index}.py`,
      sourceRevision: String(index).repeat(40), family: `FAMILY_${index}`, templateId: 'RVOL_BREAKOUT_V1' },
    stagedDossierDigest: String(index).repeat(64),
    formulaGeneratedCount: index, actualBacktestCount: index, paperRegisteredCount: 0,
    dispositions: { BACKTEST_CANDIDATE: 0, IMPROVE: index, REJECT: 0 },
    safety: { executionAuthority: 'NONE', realOrder: false },
  };
}

test('isolated transition rebinds the existing directive and proves two distinct strategies without production writes', async (t) => {
  const x = await fixture(t);
  let calls = 0;
  const records = [];
  const result = await runResearchAiIsolatedTransitionV2({
    sourceStateRoot: x.source, isolatedStateRoot: x.isolated, repoRoot: x.repo, researchSha: TARGET_SHA,
    providerEnvPath: x.providerEnvPath, aiPolicyEnvPath: x.aiPolicyEnvPath, videoPolicyEnvPath: x.videoPolicyEnvPath,
    maximumCycles: 2, now: () => AT,
    runCycle: async ({ stateRoot }) => {
      const directive = JSON.parse(await readFile(join(stateRoot, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
      assert.equal(directive.researchCodeSha, TARGET_SHA);
      assert.equal(directive.selectionPolicy.sameIdentityRetryAllowed, false);
      const result = cycle(++calls);
      records.push({ dossierDigest: result.stagedDossierDigest, itemDigest: String(calls).repeat(64),
        disposition: 'IMPROVE', metrics: { trades: 4, netReturn: -0.01, winRate: 0.5,
          profitFactor: 0.8, maximumDrawdown: 0.03, expectancy: -0.0025, finalCapital: 990 },
        executionAuthority: 'NONE' });
      const stateRootPath = join(stateRoot, 'autonomous-research', 'releases', TARGET_SHA);
      await mkdir(stateRootPath, { recursive: true, mode: 0o700 });
      await writeFile(join(stateRootPath, 'state.json'), JSON.stringify({
        contract: 'autonomous-research-closed-loop-state/v1', researchCodeSha: TARGET_SHA, records,
      }), { mode: 0o600 });
      return result;
    },
    runReview: async ({ researchSha, verifyGitHead }) => {
      assert.equal(researchSha, SOURCE_SHA);
      assert.equal(verifyGitHead, false);
      return { status: 'PARTIAL_COVERAGE_COMPLETE', provider: 'gemini', model: 'gemini-3.1-flash-lite',
        providerNetworkCalls: 1, cacheHits: 0, reviews: [{}], blockedProfiles: [], safety: { executionAuthority: 'NONE' } };
    },
    runVideo: async ({ verifyGitHead }) => ({ status: verifyGitHead === false ? 'COMPLETE' : 'GIT_HEAD_REVERIFIED', provider: 'YOUTUBE_DATA_API_V3', providerNetworkCalls: 1,
      sourceCount: 0, zeroResultReason: 'ACTIVE_QUERY_AND_FILTERS_RETURNED_NO_PUBLIC_VIDEO', safety: { executionAuthority: 'NONE' } }),
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.productionStateMutated, false);
  assert.equal(result.directiveSeed.state, 'STALE_SHA_DIRECTIVE_REBOUND');
  assert.equal(result.naturalCycleCount, 2);
  assert.equal(result.formulaCandidateCount, 2);
  assert.equal(result.actualBacktestCount, 2);
  assert.equal(new Set(result.strategies.map((row) => `${row.sourceRevision}:${row.sourcePath}`)).size, 2);
  assert.equal(result.youtube.zeroResult, true);
  assert.equal(result.aiReview.evidenceResearchSha, SOURCE_SHA);
  assert.equal(result.aiReview.exactTargetEvidence, false);
  assert.equal(result.paperActivated, false);
  assert.equal(result.executionAuthority, 'NONE');
  const sourceDirective = JSON.parse(await readFile(join(x.source, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
  assert.equal(sourceDirective.researchCodeSha, SOURCE_SHA);
  const proof = JSON.parse(await readFile(join(x.isolated, 'isolated-transition-proof.json'), 'utf8'));
  assert.equal(proof.targetSha, TARGET_SHA);
});

test('isolated transition rejects a state root nested in the production ledger', async (t) => {
  const x = await fixture(t);
  await assert.rejects(runResearchAiIsolatedTransitionV2({
    sourceStateRoot: x.source, isolatedStateRoot: join(x.source, 'transition'), repoRoot: x.repo, researchSha: TARGET_SHA,
    providerEnvPath: x.providerEnvPath, aiPolicyEnvPath: x.aiPolicyEnvPath, videoPolicyEnvPath: x.videoPolicyEnvPath,
    runCycle: async () => cycle(1), runReview: async () => ({}), runVideo: async () => ({}),
  }), /ISOLATED_TRANSITION_STATE_ROOT_OVERLAP/);
});

test('isolated transition retains a bounded provider blocker instead of touching production', async (t) => {
  const x = await fixture(t);
  await assert.rejects(runResearchAiIsolatedTransitionV2({
    sourceStateRoot: x.source, isolatedStateRoot: x.isolated, repoRoot: x.repo, researchSha: TARGET_SHA,
    providerEnvPath: x.providerEnvPath, aiPolicyEnvPath: x.aiPolicyEnvPath, videoPolicyEnvPath: x.videoPolicyEnvPath,
    runCycle: async () => ({ ...cycle(1), status: 'PARTIAL_AI_DISCOVERY_UNAVAILABLE',
      reason: 'FREE_AI_RATE_LIMITED', actualProviderCalls: { attempted: 1, succeeded: 0, failed: 1 } }),
    runReview: async () => ({}), runVideo: async () => ({}),
  }), /ISOLATED_TRANSITION_NATURAL_CYCLE_NOT_PROVEN:FREE_AI_RATE_LIMITED/);
  const sourceDirective = JSON.parse(await readFile(join(x.source, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
  assert.equal(sourceDirective.researchCodeSha, SOURCE_SHA);
});

test('isolated transition still rejects an unknown fast-historical schema', async (t) => {
  const x = await fixture(t);
  await writeFile(join(x.source, 'latest', 'fast-historical.json'), `${JSON.stringify({
    schemaVersion: 'something-else', profile: 'fast-historical', researchSha: SOURCE_SHA, status: 'complete', results: [],
  })}\n`, { mode: 0o600 });
  await assert.rejects(runResearchAiIsolatedTransitionV2({
    sourceStateRoot: x.source, isolatedStateRoot: x.isolated, repoRoot: x.repo, researchSha: TARGET_SHA,
    providerEnvPath: x.providerEnvPath, aiPolicyEnvPath: x.aiPolicyEnvPath, videoPolicyEnvPath: x.videoPolicyEnvPath,
    runCycle: async () => cycle(1), runReview: async () => ({}), runVideo: async () => ({}),
  }), /ISOLATED_TRANSITION_PROFILE_INVALID:fast-historical/);
});

test('forward evidence must keep the cycle-v1 schema', async (t) => {
  const x = await fixture(t);
  await writeFile(join(x.source, 'latest', 'forward.json'), `${JSON.stringify({
    schemaVersion: 'research-production-historical-cycle-v2', profile: 'forward', researchSha: SOURCE_SHA, status: 'complete', results: [],
  })}\n`, { mode: 0o600 });
  await assert.rejects(runResearchAiIsolatedTransitionV2({
    sourceStateRoot: x.source, isolatedStateRoot: x.isolated, repoRoot: x.repo, researchSha: TARGET_SHA,
    providerEnvPath: x.providerEnvPath, aiPolicyEnvPath: x.aiPolicyEnvPath, videoPolicyEnvPath: x.videoPolicyEnvPath,
    runCycle: async () => cycle(1), runReview: async () => ({}), runVideo: async () => ({}),
  }), /ISOLATED_TRANSITION_PROFILE_INVALID:forward/);
});
