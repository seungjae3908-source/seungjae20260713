import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAutonomousResearchClosedLoopV1 } from '../src/autonomous-research-closed-loop-v1.mjs';
import { runAutonomousResearchCycleV2 } from '../src/autonomous-research-cycle-v2.mjs';
import { DEFAULT_VERIFIED_SOURCE_CATALOG_V2, DISCOVERY_FIXED_TEXT_V2, RESEARCH_LANES_V2, isNonStrategySourcePathV2, isSourceSpecificReasonV2, rotateCatalogWindowV2, runAutonomousResearchDiscoveryV2 } from '../src/autonomous-research-discovery-v2.mjs';
import { readdir as readdirForLanes } from 'node:fs/promises';
import { parseResearchFreeAiReviewForResearchOnlyV1 } from '../src/research-ai-review-worker.mjs';

const SHA = 'a'.repeat(40);
const NEXT_SHA = 'd'.repeat(40);
const AT = '2026-10-14T01:00:00.000Z';
const SOURCE_SHA = 'b'.repeat(40);
const sourceText = `class ParticipationBreakout:
    entry_rule = "rvol above baseline and close above prior highest close"
    exit_rule = "close below trend average"
    stoploss_rule = "fixed protective stop"
`;
const licenseText = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy.
`;

function aiAnswer({ summary, findings, requiredEvidence, thesis = '거래량 참여와 가격 돌파의 결합을 비용 반영 TRAIN에서 반증 가능하게 검증한다.' }) {
  return JSON.stringify({
    summary,
    findings,
    hypotheses: [{
      hypothesisId: 'ParticipationBreakoutPublicSource',
      thesis,
      requiredEvidence,
      falsification: '원문 locator 불일치 또는 비용 반영 성과 부재 시 개선하거나 기각한다.',
      intendedRegime: '거래량 참여가 동반된 추세 확장 구간',
      independenceRationale: '기존 실패 가족과 다른 거래량 참여 및 돌파 결합이다.',
    }],
    risks: ['원문 규칙과 정규화된 변형을 분리해야 한다.'],
    disposition: 'RESEARCH_PROPOSAL_ONLY',
  });
}

const planAnswer = aiAnswer({
  summary: '공개 전략 저장소 후보',
  findings: ['REPOSITORY=https://github.com/example/public-strategies', 'BRANCH=main'],
  requiredEvidence: ['SOURCE_PATH=strategies/ParticipationBreakout.py', 'LICENSE_PATH=LICENSE'],
});

const extractionAnswer = aiAnswer({
  summary: 'Participation Breakout declared variant',
  findings: [],
  requiredEvidence: [
    'MARKET=CRYPTO_SPOT',
    'TIMEFRAME=1h',
    'DIRECTION=LONG',
    'FAMILY=PARTICIPATION_BREAKOUT',
    'TEMPLATE=RVOL_BREAKOUT_V1',
    'ENTRY_LOCATOR=entry_rule = "rvol above baseline and close above prior highest close"',
    'EXIT_LOCATOR=exit_rule = "close below trend average"',
    'RISK_LOCATOR=stoploss_rule = "fixed protective stop"',
  ],
});

function provider() {
  let calls = 0;
  const prompts = [];
  return {
    prompts,
    count: () => calls,
    invoke: async ({ policy, prompt }) => {
      calls += 1;
      prompts.push(prompt);
      return { provider: policy.provider, model: policy.model, answer: calls % 2 === 1 ? planAnswer : extractionAnswer };
    },
  };
}

function sourceFetch() {
  return async (url) => {
    if (String(url).endsWith('/commits/main.atom')) return {
      status: 200,
      text: async () => `<?xml version="1.0"?><feed><updated>2026-10-01T00:00:00Z</updated><entry><id>tag:github.com,2008:Grit::Commit/${SOURCE_SHA}</id><updated>2026-10-01T00:00:00Z</updated><author><name>public-author</name></author></entry></feed>`,
    };
    if (String(url).endsWith('/strategies/ParticipationBreakout.py')) return { status: 200, text: async () => sourceText };
    if (String(url).endsWith('/LICENSE')) return { status: 200, text: async () => licenseText };
    return { status: 404, text: async () => '' };
  };
}

function candles(count = 720) {
  const start = Date.parse('2025-01-01T00:00:00.000Z');
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const burst = index % 30 === 0 ? 0.025 : index % 17 === 0 ? -0.012 : 0.0003;
    const open = close;
    close = open * (1 + burst);
    rows.push(Object.freeze({
      timestamp: start + index * 3_600_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: index % 30 === 0 ? 500 : 100 + (index % 7),
      quoteVolume: null,
    }));
  }
  return rows;
}

function datasetLoader() {
  const rows = candles();
  return Promise.resolve({
    source: 'test-public-candles', exchange: 'UPBIT', providerMarket: 'KRW-BTC', timeframe: '60m',
    candleCount: rows.length, firstTimestamp: rows[0].timestamp, lastTimestamp: rows.at(-1).timestamp,
    candles: rows,
  });
}

function env() {
  return { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: 'synthetic_test_key' };
}

async function shockLaneStub() {
  return { status: 'COMPLETE', actualPublicRequestsThisRun: 0, studyCount: 2, eventCount: 12,
    researchHypothesisCount: 2, formulaCandidateCount: 0, backtestCount: 0,
    nextAction: 'PREDECLARE_FORMULA_AND_RUN_SEPARATE_COST_AWARE_BACKTEST' };
}

async function providerLaneStub() {
  return { status: 'COMPLETE', actualPublicRequestsThisRun: 0, probedProviderCount: 2,
    verifiedProviderCount: 2, categoryCounts: { STRATEGY_RESEARCH: 0, DATA_SOURCE: 2, EXECUTION_REFERENCE: 0 },
    nextAction: 'VERIFY_OFFICIAL_DOCUMENT_TERMS_BEFORE_ANY_DOWNSTREAM_CONNECTION' };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'autonomous-discovery-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('missing free provider persists WAITING_FREE_AI_CONFIGURATION with zero calls while research remains resumable', async (t) => {
  const root = await fixture(t);
  const result = await runAutonomousResearchCycleV2({ verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: {}, now: () => AT,
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub });
  assert.equal(result.status, 'WAITING_FREE_AI_CONFIGURATION');
  assert.equal(result.directiveConsumed, true);
  assert.deepEqual(result.actualProviderCalls, { attempted: 0, succeeded: 0, failed: 0 });
  assert.equal(result.continuousResearch, true);
  assert.equal(result.safety.executionAuthority, 'NONE');
  const persisted = JSON.parse(await readFile(join(root, 'latest', 'autonomous-research-discovery-v2.json'), 'utf8'));
  assert.equal(persisted.status, 'WAITING_FREE_AI_CONFIGURATION');
});

test('directive drives two actual-provider stages, exact public source verification, FormulaCandidate and existing backtest queue', async (t) => {
  const root = await fixture(t);
  const ai = provider();
  const result = await runAutonomousResearchCycleV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader,
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
  });
  assert.equal(result.status, 'COMPLETE', JSON.stringify(result));
  assert.equal(result.discoveryStatus, 'DOSSIER_STAGED');
  assert.equal(result.directiveConsumed, true);
  assert.deepEqual(result.actualProviderCalls, { attempted: 2, succeeded: 2, failed: 0, retried: 0 });
  assert.deepEqual(result.actualSourceFetches, { attempted: 3, succeeded: 3, failed: 0 });
  assert.equal(result.formulaGeneratedCount, 1);
  assert.equal(result.actualBacktestCount, 1, JSON.stringify(result));
  assert.equal(result.paperRegisteredCount, 0);
  assert.equal(result.actualPaperEntryCount, 0);
  assert.equal(result.actualPaperExitCount, 0);
  assert.deepEqual(result.researchLanes, {
    publicStrategyDiscovery: 'DOSSIER_STAGED', marketShockReverseStudy: 'COMPLETE',
    providerTechnicalResearch: 'COMPLETE', parallelExecution: true,
  });
  assert.equal(ai.count(), 2);
  assert.match(ai.prompts[0], /failedFamilies=NONE/u);
  assert.match(ai.prompts[0], /Write each TAG exactly once/u);
  assert.match(ai.prompts[1], /never repeat a TAG in findings/u);
  assert.match(ai.prompts[1], /BEGIN UNTRUSTED SOURCE/u);
  assert.equal(result.selectedNextStrategy.sourceRevision, SOURCE_SHA);
});

test('successful directive receipt is restart-idempotent and does not call provider or refetch the source twice', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  const options = { verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader };
  const first = await runAutonomousResearchDiscoveryV2(options);
  const second = await runAutonomousResearchDiscoveryV2(options);
  assert.equal(first.status, 'DOSSIER_STAGED', JSON.stringify(first));
  assert.equal(second.status, 'ALREADY_DISCOVERED');
  assert.deepEqual(second.actualProviderCalls, { attempted: 0, succeeded: 0, failed: 0 });
  assert.deepEqual(second.actualSourceFetches, { attempted: 0, succeeded: 0, failed: 0 });
  assert.equal(ai.count(), 2);
});

test('cycle consumes a persisted directive before any closed-loop rewrite', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  let loopCalls = 0;
  const result = await runAutonomousResearchCycleV2({ verifiedSourceCatalog: [],
    stateRoot: root,
    researchCodeSha: SHA,
    env: env(),
    now: () => AT,
    runLoop: async () => { loopCalls += 1; throw new Error('PERSISTED_DIRECTIVE_WAS_REWRITTEN'); },
    runDiscovery: async () => ({
      status: 'AI_DISCOVERY_UNAVAILABLE', directiveConsumed: true,
      actualProviderCalls: { attempted: 1, succeeded: 0, failed: 1 },
      actualSourceFetches: { attempted: 0, succeeded: 0, failed: 0 },
      candidate: null, stagedDossierDigest: null, nextAction: 'RETRY_AFTER_BOUNDED_BACKOFF',
      reason: 'FREE_AI_RATE_LIMITED', retryAfterAt: Date.parse(AT) + 60_000,
    }),
    runShockLane: shockLaneStub,
    runProviderLane: providerLaneStub,
  });
  assert.equal(loopCalls, 0);
  assert.equal(result.status, 'PARTIAL_AI_DISCOVERY_UNAVAILABLE');
  assert.equal(result.directiveConsumed, true);
  assert.equal(result.continuousResearch, true);
});

test('cycle rebinds a prior-release directive before discovery and archives both identities', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const prior = JSON.parse(await readFile(join(root, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
  let discoveryCalls = 0;
  const result = await runAutonomousResearchCycleV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: NEXT_SHA, env: env(), now: () => AT,
    runLoop: async () => { throw new Error('REBIND_MUST_PRECEDE_LOOP'); },
    runDiscovery: async ({ stateRoot }) => {
      discoveryCalls += 1;
      const rebound = JSON.parse(await readFile(join(stateRoot, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
      assert.equal(rebound.researchCodeSha, NEXT_SHA);
      assert.equal(rebound.selectionPolicy.sameIdentityRetryAllowed, false);
      return { status: 'AI_DISCOVERY_UNAVAILABLE', directiveConsumed: true,
        actualProviderCalls: { attempted: 1, succeeded: 0, failed: 1 },
        actualSourceFetches: { attempted: 0, succeeded: 0, failed: 0 }, candidate: null,
        stagedDossierDigest: null, nextAction: 'RETRY_AFTER_BOUNDED_BACKOFF', reason: 'FREE_AI_RATE_LIMITED',
        retryAfterAt: Date.parse(AT) + 60_000 };
    },
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
  });
  assert.equal(discoveryCalls, 1);
  assert.equal(result.status, 'PARTIAL_AI_DISCOVERY_UNAVAILABLE');
  assert.equal((await readFile(join(root, 'autonomous-research', 'releases', SHA, 'directives',
    `${prior.directiveDigest}.json`), 'utf8')).length > 0, true);
  const rebound = JSON.parse(await readFile(join(root, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
  assert.equal((await readFile(join(root, 'autonomous-research', 'releases', NEXT_SHA, 'directives',
    `${rebound.directiveDigest}.json`), 'utf8')).length > 0, true);
});

test('a new failure directive cannot spend a second extraction call on the same source revision', async (t) => {
  const root = await fixture(t);
  const ai = provider();
  const options = {
    verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader,
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
  };
  await runAutonomousResearchCycleV2(options);
  const repeated = await runAutonomousResearchDiscoveryV2(options);
  assert.equal(repeated.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(repeated.reason, 'AI_DISCOVERY_SOURCE_REVISION_ALREADY_ATTEMPTED');
  assert.deepEqual(repeated.actualProviderCalls, { attempted: 1, succeeded: 1, failed: 0, retried: 0 });
  assert.deepEqual(repeated.actualSourceFetches, { attempted: 3, succeeded: 3, failed: 0 });
  assert.equal(repeated.retryAfterAt, Date.parse(AT) + 6 * 60 * 60 * 1_000);
  assert.equal(ai.count(), 3);
});

test('a later release preserves prior state and cannot rediscover the same source revision', async (t) => {
  const root = await fixture(t);
  const firstAi = provider();
  await runAutonomousResearchCycleV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: firstAi.invoke, fetchImpl: sourceFetch(), datasetLoader,
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
  });
  const oldStatePath = join(root, 'autonomous-research', 'releases', SHA, 'state.json');
  const oldState = await readFile(oldStatePath, 'utf8');
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: NEXT_SHA, now: () => AT });
  const nextAi = provider();
  const repeated = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: NEXT_SHA, env: env(), now: () => AT,
    invoke: nextAi.invoke, fetchImpl: sourceFetch(), datasetLoader,
  });
  assert.equal(repeated.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(repeated.reason, 'AI_DISCOVERY_SOURCE_REVISION_ALREADY_ATTEMPTED');
  assert.equal(nextAi.count(), 1);
  assert.equal(await readFile(oldStatePath, 'utf8'), oldState);
  const nextState = JSON.parse(await readFile(join(root, 'autonomous-research', 'releases', NEXT_SHA, 'state.json'), 'utf8'));
  assert.equal(nextState.researchCodeSha, NEXT_SHA);
});

test('AI locator that is absent from fetched source fails closed before Formula or backtest', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  const badExtraction = aiAnswer({
    summary: 'Unverified locator', findings: [],
    requiredEvidence: [
      'MARKET=CRYPTO_SPOT', 'TIMEFRAME=1h', 'DIRECTION=LONG', 'FAMILY=PARTICIPATION_BREAKOUT',
      'TEMPLATE=RVOL_BREAKOUT_V1', 'ENTRY_LOCATOR=this text does not occur in the source',
      'EXIT_LOCATOR=exit_rule = "close below trend average"', 'RISK_LOCATOR=NONE',
    ],
  });
  let calls = 0;
  const result = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: ++calls === 1 ? planAnswer : badExtraction }),
    fetchImpl: sourceFetch(), datasetLoader,
  });
  assert.equal(result.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(result.reason, 'ENTRY_LOCATOR_NOT_FOUND_IN_SOURCE');
  assert.equal(result.stagedDossierDigest, null);
  assert.deepEqual(result.actualProviderCalls, { attempted: 2, succeeded: 2, failed: 0, retried: 0 });
});

test('strategy-file guard rejects reports and plumbing by whole words only', () => {
  for (const path of ['qstrader/statistics/tearsheet.py', 'lib/performance_report.py', 'src/plotUtils.ts',
    'tests/test_rsi.py', 'setup.py', 'pkg/__init__.py', 'app/config.py', 'tools/cli.py']) {
    assert.equal(isNonStrategySourcePathV2(path), true, path);
  }
  for (const path of ['strategies/ParticipationBreakout.py', 'strategies/decline_breakout.py',
    'strategies/setup_breakout.py', 'freqtrade/strategies/RsiReversal.py', 'algo/latest_momentum.py']) {
    assert.equal(isNonStrategySourcePathV2(path), false, path);
  }
});

test('a report file chosen by the AI is rejected before any fetch and is not proposed again', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const reportPlan = aiAnswer({
    summary: '공개 저장소 후보',
    findings: ['REPOSITORY=https://github.com/example/public-strategies', 'BRANCH=main'],
    requiredEvidence: ['SOURCE_PATH=qstrader/statistics/tearsheet.py', 'LICENSE_PATH=LICENSE'],
  });
  let fetches = 0;
  const countingFetch = sourceFetch();
  const first = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: reportPlan }),
    fetchImpl: async (url) => { fetches += 1; return countingFetch(url); }, datasetLoader,
  });
  assert.equal(first.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(first.reason, 'AI_DISCOVERY_SOURCE_NOT_STRATEGY');
  assert.deepEqual(first.actualProviderCalls, { attempted: 1, succeeded: 1, failed: 0, retried: 0 });
  assert.equal(fetches, 0);

  // After the semantic back-off, the rejected source is named in the prompt and refused again.
  const later = '2026-10-14T08:00:00.000Z';
  const prompts = [];
  const second = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => later,
    invoke: async ({ policy, prompt }) => { prompts.push(prompt); return { provider: policy.provider, model: policy.model, answer: reportPlan }; },
    fetchImpl: sourceFetch(), datasetLoader,
  });
  assert.match(prompts[0], /rejectedSources=https:\/\/github\.com\/example\/public-strategies:qstrader\/statistics\/tearsheet\.py/u);
  assert.equal(second.reason, 'AI_DISCOVERY_SOURCE_PREVIOUSLY_REJECTED');
});

test('verified locators may quote source words that free text may not use', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const quotedSource = `class LeverageAwareBreakout:
    longEntry = "rvol above baseline then enter long position size small"
    exit_rule = "take profit at prior high or drawdown guard"
`;
  const fetchQuoted = async (url) => {
    if (String(url).endsWith('/strategies/ParticipationBreakout.py')) return { status: 200, text: async () => quotedSource };
    return sourceFetch()(url);
  };
  const extraction = (summary) => aiAnswer({
    summary, findings: [],
    requiredEvidence: [
      'MARKET=CRYPTO_SPOT', 'TIMEFRAME=1h', 'DIRECTION=LONG', 'FAMILY=PARTICIPATION_BREAKOUT', 'TEMPLATE=RVOL_BREAKOUT_V1',
      'ENTRY_LOCATOR=longEntry = "rvol above baseline then enter long position size small"',
      'EXIT_LOCATOR=exit_rule = "take profit at prior high or drawdown guard"', 'RISK_LOCATOR=NONE',
    ],
  });
  let calls = 0;
  const ok = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model,
      answer: ++calls === 1 ? planAnswer : extraction('Participation breakout declared variant') }),
    fetchImpl: fetchQuoted, datasetLoader,
  });
  assert.equal(ok.status, 'DOSSIER_STAGED', JSON.stringify(ok));

  // The same words in AI-written free text are still refused.
  const root2 = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root2, researchCodeSha: SHA, now: () => AT });
  let calls2 = 0;
  const refused = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root2, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model,
      answer: ++calls2 === 1 ? planAnswer : extraction('High profit with low drawdown') }),
    fetchImpl: fetchQuoted, datasetLoader,
  });
  assert.equal(refused.reason, 'FORBIDDEN_AI_AUTHORITY');
});

test('an identical repeated tag is accepted but conflicting repeats still fail closed', async (t) => {
  const repeated = aiAnswer({
    summary: '공개 전략 저장소 후보',
    findings: ['REPOSITORY=https://github.com/example/public-strategies', 'BRANCH=main'],
    requiredEvidence: ['REPOSITORY=https://github.com/example/public-strategies', 'SOURCE_PATH=strategies/ParticipationBreakout.py', 'LICENSE_PATH=LICENSE'],
  });
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  let calls = 0;
  const ok = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: ++calls === 1 ? repeated : extractionAnswer }),
    fetchImpl: sourceFetch(), datasetLoader,
  });
  assert.equal(ok.status, 'DOSSIER_STAGED', JSON.stringify(ok));

  const conflicting = aiAnswer({
    summary: '공개 전략 저장소 후보',
    findings: ['REPOSITORY=https://github.com/example/other-strategies', 'BRANCH=main'],
    requiredEvidence: ['REPOSITORY=https://github.com/example/public-strategies', 'SOURCE_PATH=strategies/ParticipationBreakout.py', 'LICENSE_PATH=LICENSE'],
  });
  const root2 = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root2, researchCodeSha: SHA, now: () => AT });
  const refused = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root2, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: conflicting }),
    fetchImpl: sourceFetch(), datasetLoader,
  });
  assert.equal(refused.reason, 'AI_DISCOVERY_DUPLICATE_TAG:REPOSITORY');
});

test('while verified sources remain, discovery lists them and refuses anything else', async (t) => {
  const catalog = [
    { repository: 'https://github.com/example/public-strategies', branch: 'main', licensePath: 'LICENSE', sourcePath: 'strategies/ParticipationBreakout.py' },
    { repository: 'https://github.com/example/public-strategies', branch: 'main', licensePath: 'LICENSE', sourcePath: 'strategies/Second.py' },
  ];
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  const ok = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: catalog,
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader });
  assert.equal(ok.status, 'DOSSIER_STAGED', JSON.stringify(ok));
  assert.match(ai.prompts[0], /You MUST choose exactly one of these verified sources/u);
  assert.match(ai.prompts[0], /SOURCE_PATH=strategies\/Second\.py/u);

  const invented = aiAnswer({
    summary: '공개 전략 저장소 후보',
    findings: [],
    requiredEvidence: ['REPOSITORY=https://github.com/example/public-strategies', 'BRANCH=main', 'SOURCE_PATH=strategies/Invented.py', 'LICENSE_PATH=LICENSE'],
  });
  const root2 = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root2, researchCodeSha: SHA, now: () => AT });
  let fetches = 0;
  const refused = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: catalog,
    stateRoot: root2, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: invented }),
    fetchImpl: async (url) => { fetches += 1; return sourceFetch()(url); }, datasetLoader });
  assert.equal(refused.reason, 'AI_DISCOVERY_SOURCE_NOT_IN_VERIFIED_CATALOG');
  assert.equal(fetches, 0);
});

test('the default verified catalog holds real strategy files, not reports', () => {
  assert.ok(DEFAULT_VERIFIED_SOURCE_CATALOG_V2.length >= 2);
  for (const entry of DEFAULT_VERIFIED_SOURCE_CATALOG_V2) {
    assert.equal(entry.repository, 'https://github.com/freqtrade/freqtrade-strategies');
    assert.equal(entry.branch, 'main');
    assert.equal(isNonStrategySourcePathV2(entry.sourcePath), false, entry.sourcePath);
  }
  assert.equal(new Set(DEFAULT_VERIFIED_SOURCE_CATALOG_V2.map((entry) => entry.sourcePath)).size, DEFAULT_VERIFIED_SOURCE_CATALOG_V2.length);
});

test('common harmless tag spellings and numbered locators are normalized, then still verified', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const loose = aiAnswer({
    summary: 'Participation Breakout declared variant', findings: [],
    requiredEvidence: [
      'MARKET=crypto spot', 'TIMEFRAME=60m', 'DIRECTION=long', 'FAMILY=participation-breakout', 'TEMPLATE=`RVOL_BREAKOUT_V1`',
      'ENTRY_LOCATOR=0002: entry_rule = "rvol above baseline and close above prior highest close"',
      'EXIT_LOCATOR=`exit_rule = "close below trend average"`', 'RISK_LOCATOR=NONE',
    ],
  });
  let calls = 0;
  const ok = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: ++calls === 1 ? planAnswer : loose }),
    fetchImpl: sourceFetch(), datasetLoader });
  assert.equal(ok.status, 'DOSSIER_STAGED', JSON.stringify(ok));
  assert.equal(ok.candidate.templateId, 'RVOL_BREAKOUT_V1');

  const root2 = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root2, researchCodeSha: SHA, now: () => AT });
  const wrongTimeframe = loose.replace('TIMEFRAME=60m', 'TIMEFRAME=5m');
  let calls2 = 0;
  const refused = await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [],
    stateRoot: root2, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: ++calls2 === 1 ? planAnswer : wrongTimeframe }),
    fetchImpl: sourceFetch(), datasetLoader });
  assert.equal(refused.reason, 'AI_DISCOVERY_CURRENT_DATASET_UNSUPPORTED');
});

test('prompts ask for short answers so the provider output budget is not exceeded', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader });
  for (const prompt of ai.prompts) assert.match(prompt, /Be brief: summary under 12 words/u);
  assert.match(ai.prompts[1], /without the line-number prefix/u);
});

test('the fixed answer wording passes the unchanged shared filter', () => {
  const text = DISCOVERY_FIXED_TEXT_V2;
  for (const summary of [text.planSummary, text.extractionSummary]) {
    const parsed = parseResearchFreeAiReviewForResearchOnlyV1(JSON.stringify({
      summary, findings: [],
      hypotheses: [{ hypothesisId: 'AdxSmasVariant', thesis: text.thesis,
        requiredEvidence: ['MARKET=CRYPTO_SPOT', 'TIMEFRAME=1h', 'DIRECTION=LONG', 'FAMILY=ADX_SMA_TREND', 'TEMPLATE=ADX_ROC_CONTINUATION_V1'],
        falsification: text.falsification, intendedRegime: text.intendedRegime, independenceRationale: text.independenceRationale }],
      risks: [text.risk], disposition: 'RESEARCH_PROPOSAL_ONLY',
    }));
    assert.equal(parsed.summary, summary);
  }
});

test('both prompts carry a fill-in answer template with the fixed wording', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader });
  for (const prompt of ai.prompts) {
    assert.match(prompt, /Return exactly this JSON and nothing else/u);
    assert.ok(prompt.includes(DISCOVERY_FIXED_TEXT_V2.thesis));
  }
  assert.ok(ai.prompts[1].includes('ENTRY_LOCATOR=<exact source line>'));
});

function laneCandles(lane, count = 720) {
  const step = lane.timeframe === '1d' ? 86_400_000 : 3_600_000;
  const start = Date.parse('2024-01-01T00:00:00.000Z');
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const burst = index % 30 === 0 ? (lane.direction === 'SHORT' ? -0.025 : 0.025) : index % 17 === 0 ? 0.012 * (lane.direction === 'SHORT' ? 1 : -1) : 0.0003 * (lane.direction === 'SHORT' ? -1 : 1);
    const open = close;
    close = open * (1 + burst);
    rows.push(Object.freeze({ timestamp: start + index * step, open, high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998, close, volume: index % 30 === 0 ? 500 : 100 + (index % 7) }));
  }
  return rows;
}

async function filesContaining(root, needle) {
  const hits = [];
  async function walk(dir) {
    for (const entry of await readdirForLanes(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.json') && (await readFile(path, 'utf8')).includes(needle)) hits.push(path);
    }
  }
  await walk(root);
  return hits;
}

for (const lane of RESEARCH_LANES_V2) {
  test(`lane ${lane.id} runs discovery, formula and the existing backtest queue end to end`, async (t) => {
    const root = await fixture(t);
    const extraction = aiAnswer({
      summary: 'Participation Breakout declared variant', findings: [],
      requiredEvidence: [
        `MARKET=${lane.market}`, `TIMEFRAME=${lane.timeframe}`, `DIRECTION=${lane.direction}`, 'FAMILY=PARTICIPATION_BREAKOUT',
        'TEMPLATE=RVOL_BREAKOUT_V1',
        'ENTRY_LOCATOR=entry_rule = "rvol above baseline and close above prior highest close"',
        'EXIT_LOCATOR=exit_rule = "close below trend average"', 'RISK_LOCATOR=NONE',
      ],
    });
    let calls = 0;
    const loaderLanes = [];
    const result = await runAutonomousResearchCycleV2({ verifiedSourceCatalog: [], researchLanes: [lane],
      stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
      invoke: async ({ policy, prompt }) => {
        calls += 1;
        if (calls === 2) assert.ok(prompt.includes(`MARKET=${lane.market}`) && prompt.includes(`DIRECTION=${lane.direction}`));
        return { provider: policy.provider, model: policy.model, answer: calls % 2 === 1 ? planAnswer : extraction };
      },
      fetchImpl: sourceFetch(),
      datasetLoader: async ({ lane: requested }) => {
        loaderLanes.push(requested.id);
        const rows = laneCandles(requested);
        return { candles: rows, candleCount: rows.length, firstTimestamp: rows[0].timestamp, lastTimestamp: rows.at(-1).timestamp };
      },
      runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
    });
    assert.equal(result.status, 'COMPLETE', JSON.stringify(result));
    assert.equal(result.discoveryStatus, 'DOSSIER_STAGED');
    assert.equal(result.formulaGeneratedCount, 1);
    assert.equal(result.actualBacktestCount, 1, JSON.stringify(result));
    assert.equal(result.selectedNextStrategy.researchLane, lane.id);
    assert.deepEqual(loaderLanes, [lane.id]);
    const side = lane.direction === 'SHORT' ? 'short' : 'long';
    assert.ok((await filesContaining(root, `"side": "${side}"`)).length > 0, `queued ${side} input`);
    assert.ok((await filesContaining(root, `"market": "${lane.market}"`)).length > 0);
    assert.equal(result.safety.executionAuthority, 'NONE');
  });
}

test('lanes rotate across attempts and an operator filter narrows them', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const seen = [];
  const badPlan = aiAnswer({ summary: 'x', findings: [],
    requiredEvidence: ['REPOSITORY=https://github.com/example/public-strategies', 'BRANCH=main', 'SOURCE_PATH=docs/report.py', 'LICENSE_PATH=LICENSE'] });
  for (let index = 0; index < 3; index += 1) {
    const at = new Date(Date.parse(AT) + index * 7 * 3_600_000).toISOString();
    await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: env(), now: () => at,
      invoke: async ({ policy, prompt }) => { return { provider: policy.provider, model: policy.model, answer: badPlan }; },
      fetchImpl: sourceFetch(), datasetLoader });
    const latest = JSON.parse(await readFile(join(root, 'latest', 'autonomous-research-discovery-v2.json'), 'utf8'));
    seen.push(latest.candidate?.researchLane);
  }
  assert.deepEqual(seen, RESEARCH_LANES_V2.slice(0, 3).map((lane) => lane.id));
  const filtered = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: filtered, researchCodeSha: SHA, now: () => AT });
  await runAutonomousResearchDiscoveryV2({ verifiedSourceCatalog: [], stateRoot: filtered, researchCodeSha: SHA,
    env: { ...env(), RESEARCH_DISCOVERY_LANES: 'US_STOCK_LONG' }, now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: badPlan }), fetchImpl: sourceFetch(), datasetLoader });
  const latest = JSON.parse(await readFile(join(filtered, 'latest', 'autonomous-research-discovery-v2.json'), 'utf8'));
  assert.equal(latest.candidate.researchLane, 'US_STOCK_LONG');
});

test('expanded verified catalog has unique strategy files and no lookahead-bias examples', () => {
  const paths = DEFAULT_VERIFIED_SOURCE_CATALOG_V2.map((row) => row.sourcePath);
  assert.ok(paths.length >= 36);
  assert.equal(paths.includes('user_data/strategies/Diamond.py'), false, 'Diamond.py repeatedly made the free provider fail');
  // No exit rule line to quote: EXIT_LOCATOR extraction always fails closed.
  for (const noExitRule of ['user_data/strategies/Heracles.py', 'user_data/strategies/PatternRecognition.py',
    'user_data/strategies/berlinguyinca/BinHV45.py', 'user_data/strategies/berlinguyinca/Low_BB.py']) {
    assert.equal(paths.includes(noExitRule), false, noExitRule);
  }
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    assert.equal(isNonStrategySourcePathV2(path), false, path);
    assert.doesNotMatch(path, /lookahead_bias|DoesNothing|Sample|backtest_validation/u);
  }
});

test('a missing or filtered source retries soon; same-revision repeats keep the long back-off', () => {
  assert.equal(isSourceSpecificReasonV2('PUBLIC_SOURCE_HTTP_404'), true);
  assert.equal(isSourceSpecificReasonV2('FORBIDDEN_AI_AUTHORITY'), true);
  assert.equal(isSourceSpecificReasonV2('AI_DISCOVERY_SOURCE_REVISION_ALREADY_ATTEMPTED'), false);
  assert.equal(isSourceSpecificReasonV2('FREE_AI_RATE_LIMITED'), false);
});

test('the offered catalog window rotates so a retry starts from a different source', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ sourcePath: `s${i}.py` }));
  const first = rotateCatalogWindowV2(items, 0).map((row) => row.sourcePath);
  const next = rotateCatalogWindowV2(items, 1).map((row) => row.sourcePath);
  assert.equal(first.length, 5);
  assert.notEqual(first[0], next[0]);
  assert.deepEqual(rotateCatalogWindowV2(items.slice(0, 3), 7).map((row) => row.sourcePath), ['s0.py', 's1.py', 's2.py']);
});

test('a provider 503 is retried within the same stage and still counts two logical stages', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  let failedOnce = false;
  const waits = [];
  const result = await runAutonomousResearchDiscoveryV2({
    verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    fetchImpl: sourceFetch(), datasetLoader,
    invoke: async (request) => {
      if (!failedOnce) { failedOnce = true; throw new Error('FREE_AI_PROVIDER_UNAVAILABLE'); }
      return ai.invoke(request);
    },
    providerRetryDelaysMs: [1, 2], sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(result.status, 'DOSSIER_STAGED', JSON.stringify(result));
  assert.deepEqual(result.actualProviderCalls, { attempted: 2, succeeded: 2, failed: 0, retried: 1 });
  assert.deepEqual(waits, [1]);
});

test('a non-transient provider error is not retried', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  let calls = 0;
  const result = await runAutonomousResearchDiscoveryV2({
    verifiedSourceCatalog: [], stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    fetchImpl: sourceFetch(), datasetLoader,
    invoke: async () => { calls += 1; throw new Error('FREE_AI_AUTH_REJECTED'); },
    providerRetryDelaysMs: [1, 2], sleep: async () => {},
  });
  assert.equal(result.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(calls, 1);
  assert.equal(result.actualProviderCalls.retried, 0);
});
