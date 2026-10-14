import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAutonomousResearchClosedLoopV1 } from '../src/autonomous-research-closed-loop-v1.mjs';
import { runAutonomousResearchCycleV2 } from '../src/autonomous-research-cycle-v2.mjs';
import { runAutonomousResearchDiscoveryV2 } from '../src/autonomous-research-discovery-v2.mjs';

const SHA = 'a'.repeat(40);
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
  const result = await runAutonomousResearchCycleV2({ stateRoot: root, researchCodeSha: SHA, env: {}, now: () => AT,
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
  const result = await runAutonomousResearchCycleV2({
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader,
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
  });
  assert.equal(result.status, 'COMPLETE', JSON.stringify(result));
  assert.equal(result.discoveryStatus, 'DOSSIER_STAGED');
  assert.equal(result.directiveConsumed, true);
  assert.deepEqual(result.actualProviderCalls, { attempted: 2, succeeded: 2, failed: 0 });
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
  assert.match(ai.prompts[1], /BEGIN UNTRUSTED SOURCE/u);
  assert.equal(result.selectedNextStrategy.sourceRevision, SOURCE_SHA);
});

test('successful directive receipt is restart-idempotent and does not call provider or refetch the source twice', async (t) => {
  const root = await fixture(t);
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA, now: () => AT });
  const ai = provider();
  const options = { stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader };
  const first = await runAutonomousResearchDiscoveryV2(options);
  const second = await runAutonomousResearchDiscoveryV2(options);
  assert.equal(first.status, 'DOSSIER_STAGED', JSON.stringify(first));
  assert.equal(second.status, 'ALREADY_DISCOVERED');
  assert.deepEqual(second.actualProviderCalls, { attempted: 0, succeeded: 0, failed: 0 });
  assert.deepEqual(second.actualSourceFetches, { attempted: 0, succeeded: 0, failed: 0 });
  assert.equal(ai.count(), 2);
});

test('a new failure directive cannot spend a second extraction call on the same source revision', async (t) => {
  const root = await fixture(t);
  const ai = provider();
  const options = {
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: ai.invoke, fetchImpl: sourceFetch(), datasetLoader,
    runShockLane: shockLaneStub, runProviderLane: providerLaneStub,
  };
  await runAutonomousResearchCycleV2(options);
  const repeated = await runAutonomousResearchDiscoveryV2(options);
  assert.equal(repeated.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(repeated.reason, 'AI_DISCOVERY_SOURCE_REVISION_ALREADY_ATTEMPTED');
  assert.deepEqual(repeated.actualProviderCalls, { attempted: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(repeated.actualSourceFetches, { attempted: 3, succeeded: 3, failed: 0 });
  assert.equal(repeated.retryAfterAt, Date.parse(AT) + 6 * 60 * 60 * 1_000);
  assert.equal(ai.count(), 3);
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
  const result = await runAutonomousResearchDiscoveryV2({
    stateRoot: root, researchCodeSha: SHA, env: env(), now: () => AT,
    invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: ++calls === 1 ? planAnswer : badExtraction }),
    fetchImpl: sourceFetch(), datasetLoader,
  });
  assert.equal(result.status, 'AI_DISCOVERY_UNAVAILABLE');
  assert.equal(result.reason, 'ENTRY_LOCATOR_NOT_FOUND_IN_SOURCE');
  assert.equal(result.stagedDossierDigest, null);
  assert.deepEqual(result.actualProviderCalls, { attempted: 2, succeeded: 2, failed: 0 });
});
