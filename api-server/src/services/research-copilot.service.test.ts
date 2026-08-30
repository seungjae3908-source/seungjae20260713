import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchCopilotService, buildCopilotSnapshot, researchProviderPolicy, validateCopilotDsl } from './research-copilot.service';
import { createDefaultStrategyPromotionService, StrategyPromotionService } from './strategy-promotion.service';
import { runResearchDualFreeAiReview } from './research-dual-free-ai.service';
import { validateChatMessage } from './ai-chat.service';

const NOW = Date.parse('2026-08-30T09:00:00Z');
export function overviewFixture() {
  return {
    schemaVersion: 'research-dashboard-overview-v1', state: { present: true, latestCycleAt: NOW },
    safety: { readOnlyDashboard: true, liveTrading: false, privateApi: false, orderAuthority: false, authorityEvidenceComplete: true, forbiddenAuthorityObserved: false },
    research: { cycles: [{ present: true, generatedAt: NOW, tasks: [{ id: 'oos', status: 'success' }, { id: 'final-holdout', status: 'success' }] }] },
  };
}
const answer = JSON.stringify({
  summary: 'Inspect point-in-time provenance before further research.',
  findings: ['Successful runtime tasks do not prove valid evidence.'], hypotheses: [{
    hypothesisId: 'RESEARCH-A', thesis: 'Test regime alignment using closed candles.',
    requiredEvidence: ['Immutable closed candle history'], falsification: 'Reject if the effect disappears on untouched folds.',
    intendedRegime: 'Directional regimes', independenceRationale: 'Uses structural context.',
  }], risks: ['Holdout reuse can contaminate evaluation.'], disposition: 'RESEARCH_PROPOSAL_ONLY',
});
const promotions = () => createDefaultStrategyPromotionService().list();
function service(options: { now?: () => number; invoke?: (message: string) => Promise<{ answer: string; model: string | null }> } = {}) {
  return new ResearchCopilotService({
    loadOverview: async () => overviewFixture(), promotions, now: options.now ?? (() => NOW),
    policy: () => ({ provider: 'groq', reason: 'TEST_ONLY' }),
    invoke: options.invoke ?? (async message => { validateChatMessage(message); return { answer, model: 'openai/gpt-oss-20b' }; }),
  });
}
test('runtime success never becomes OOS, holdout or health evidence', () => {
  const result = buildCopilotSnapshot(overviewFixture(), NOW, promotions());
  assert.equal(result.stages.find(stage => stage.key === 'oos')?.observedTasks[0].status, 'SUCCESS');
  assert.equal(result.stages.find(stage => stage.key === 'oos')?.status, 'MISSING_EVIDENCE');
  assert.equal(result.stages.find(stage => stage.key === 'holdout')?.status, 'MISSING_EVIDENCE');
  assert.equal(result.authority.finalHoldoutOpened, false);
  assert.equal(result.health.status, 'MISSING_EVIDENCE');
  assert.equal(result.comparisonMode, 'IDENTITY_ONLY_NO_PERFORMANCE_RANKING');
});
test('missing, stale and future timestamps never become current evidence', () => {
  for (const timestamp of [null, NOW - 86_400_001, NOW + 1]) {
    const fixture = { ...overviewFixture(), state: { latestCycleAt: timestamp } };
    const result = buildCopilotSnapshot(fixture, NOW);
    assert.equal(result.status, 'blocked');
    assert.equal(result.timestamp, timestamp);
  }
});
test('forbidden authority and invalid schema fail closed', () => {
  const fixture = overviewFixture();
  fixture.safety.liveTrading = true;
  const result = buildCopilotSnapshot(fixture, NOW);
  assert.equal(result.status, 'blocked');
  assert(result.missing_data.includes('SAFETY_CONTRACT'));
});
test('canonical receipts become readable only with exact identity, provenance and source-time integrity', () => {
  const rows = structuredClone(promotions());
  const item = rows.items[0];
  const stage = item.stages.find(entry => entry.stage === 'OUT_OF_SAMPLE');
  assert(stage);
  item.identity.researchCodeSha = 'b'.repeat(40);
  Object.assign(stage, { status: 'PASS', gateResult: 'PASS', sourceSha: item.identity.researchCodeSha,
    dataQuality: 'VERIFIED', provenance: ['fixture-only canonical owner receipt'], validatedAt: new Date(NOW).toISOString(),
    datasetId: 'fixture-dataset', provider: 'fixture-provider', metrics: { canonicalGatePassed: true }, sampleCount: 50,
    pointInTimeSafe: true, dataRange: { start: new Date(NOW - 3_600_000).toISOString(), end: new Date(NOW - 60_000).toISOString() } });
  const result = buildCopilotSnapshot(overviewFixture(), NOW, rows);
  assert.equal(result.stages.find(entry => entry.key === 'oos')?.verifiedReceiptCount, 1);
  assert.equal(result.stages.find(entry => entry.key === 'oos')?.status, 'READY');
  assert.equal(result.authority.promotionAuthority, false);
  stage.validatedAt = new Date(NOW + 1).toISOString();
  assert.equal(buildCopilotSnapshot(overviewFixture(), NOW + 60_000, rows).stages.find(entry => entry.key === 'oos')?.status, 'MISSING_EVIDENCE');
  stage.validatedAt = new Date(NOW).toISOString();
  stage.sourceSha = 'c'.repeat(40);
  assert.equal(buildCopilotSnapshot(overviewFixture(), NOW, rows).stages.find(entry => entry.key === 'oos')?.status, 'MISSING_EVIDENCE');
});
test('free entitlement, isolated route and allowed model are required without changing environment', () => {
  assert.equal(researchProviderPolicy({ AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: 'fixture' }).provider, null);
  assert.equal(researchProviderPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'openai-compatible', AI_CHAT_API_KEY: 'fixture' }).provider, null);
  assert.equal(researchProviderPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'gemini', GEMINI_API_KEY: 'fixture', GROQ_API_KEY: 'fixture' }).provider, null);
  assert.equal(researchProviderPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: 'fixture', GROQ_MODEL: 'paid-model' }).provider, null);
  assert.equal(researchProviderPolicy({ RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: 'groq', GROQ_API_KEY: 'fixture' }).provider, 'groq');
});
test('receipt corrections invalidate evidence while registry polling timestamps do not', () => {
  let polledAt = NOW;
  const registry = new StrategyPromotionService({ sourceSha: 'b'.repeat(40), now: () => new Date(polledAt) });
  const first = buildCopilotSnapshot(overviewFixture(), NOW, registry.list());
  assert.equal(first.stages.find(stage => stage.key === 'candidate')?.verifiedReceiptCount, 0);
  polledAt += 1_000;
  const rows = structuredClone(registry.list());
  assert.equal(buildCopilotSnapshot(overviewFixture(), polledAt, rows).evidenceDigest, first.evidenceDigest);
  const stage = rows.items[0].stages.find(row => row.stage === 'OUT_OF_SAMPLE');
  assert(stage);
  for (const correction of [{ dataQuality: 'PARTIAL' as const }, { validatedAt: new Date(NOW).toISOString() }, { provenance: ['corrected receipt binding'] }, { metrics: { expectedValue: -1 } }]) {
    const corrected = structuredClone(rows);
    Object.assign(corrected.items[0].stages.find(row => row.stage === stage.stage)!, correction);
    assert.notEqual(buildCopilotSnapshot(overviewFixture(), polledAt, corrected).evidenceDigest, first.evidenceDigest);
  }
});
test('all duplicate waiters reject evidence changes during AI invocation without caching old explanations', async () => {
  let complete: (value: { answer: string; model: string }) => void = () => { throw new Error('invocation not started'); };
  let started: () => void = () => { throw new Error('start gate missing'); };
  const invocationStarted = new Promise<void>(resolve => { started = resolve; });
  const overview = overviewFixture();
  const copilot = new ResearchCopilotService({
    loadOverview: async () => overview, promotions, now: () => NOW,
    policy: () => ({ provider: 'groq', reason: 'TEST_ONLY' }),
    invoke: () => new Promise(resolve => { complete = resolve; started(); }),
  });
  const initial = await copilot.snapshot();
  const outcomes = Promise.allSettled([
    copilot.review('admin', 'propose_candidates', initial.evidenceDigest),
    copilot.review('admin', 'propose_candidates', initial.evidenceDigest),
  ]);
  await invocationStarted;
  overview.safety.liveTrading = true;
  complete({ answer, model: 'openai/gpt-oss-20b' });
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.match(String(outcome.reason), /evidence changed during review/);
  }
  await assert.rejects(copilot.review('admin', 'propose_candidates', initial.evidenceDigest), /refresh evidence/);
  assert.equal((await copilot.snapshot()).ai.calls, 1);
  assert.equal((await copilot.snapshot()).ai.cacheHits, 0);
});
test('deduplicates concurrent and cached requests but isolates users and expires cache', async () => {
  let now = NOW; let calls = 0;
  const copilot = service({ now: () => now, invoke: async message => {
    calls += 1; validateChatMessage(message);
    assert(!message.includes('account')); assert(!message.includes('costPolicyVersion'));
    return { answer, model: 'openai/gpt-oss-20b' };
  } });
  const initial = await copilot.snapshot();
  assert.equal(calls, 0);
  const results = await Promise.all([copilot.review('admin-a', 'propose_candidates', initial.evidenceDigest), copilot.review('admin-a', 'propose_candidates', initial.evidenceDigest)]);
  assert.equal(calls, 1); assert.equal(results[1].cacheHit, true);
  assert.equal(results[0].confidence, null); assert.equal(results[0].risk_reward, null);
  assert.equal(results[0].authority.promotionAuthority, false);
  await copilot.review('admin-b', 'propose_candidates', initial.evidenceDigest);
  assert.equal(calls, 2);
  now += 60_001;
  await copilot.review('admin-a', 'propose_candidates', initial.evidenceDigest);
  assert.equal(calls, 3);
});
test('stale digest, quota failure and paid/model mismatch cannot cause retries or fallback', async () => {
  let calls = 0;
  const copilot = service({ invoke: async () => { calls += 1; throw new Error('fixture quota failure'); } });
  const snapshot = await copilot.snapshot();
  await assert.rejects(copilot.review('admin', 'propose_candidates', 'f'.repeat(64)), /refresh evidence/);
  assert.equal(calls, 0);
  await assert.rejects(copilot.review('admin', 'propose_candidates', snapshot.evidenceDigest), /provider invocation failed/);
  await assert.rejects(copilot.review('admin', 'interpret_evidence', snapshot.evidenceDigest), /budget exhausted/);
  assert.equal(calls, 1);
  const mismatch = service({ invoke: async () => ({ answer, model: 'paid-model' }) });
  await assert.rejects(mismatch.review('admin', 'interpret_evidence', snapshot.evidenceDigest), /provider identity/);
});
test('distinct administrators cannot exceed the process-wide free request cap', async () => {
  const copilot = service();
  const snapshot = await copilot.snapshot();
  for (let index = 0; index < 4; index += 1) await copilot.review(`admin-${index}`, 'propose_candidates', snapshot.evidenceDigest);
  await assert.rejects(copilot.review('admin-over-budget', 'propose_candidates', snapshot.evidenceDigest), /budget exhausted/);
  assert.equal((await copilot.snapshot()).ai.calls, 4);
});
test('blocks numeric claims, Korean authority and oversized private suffixes', async () => {
  const input = { provider: 'groq' as const, role: 'PROPOSER' as const, promptVersion: 'test', evidenceDigest: 'a'.repeat(64), evidenceSummary: 'Public research only' };
  for (const summary of ['수익률이 높고 확률은 확실합니다.', '레버리지 세 배', '챔피언으로 승격', 'Net return 15%', 'ＰＦ 2', 'Profit is ９９', '수\u200b익률 개선', '손실 없음']) {
    await assert.rejects(runResearchDualFreeAiReview(input, async () => ({ answer: JSON.stringify({ ...JSON.parse(answer), summary }), model: 'openai/gpt-oss-20b' })), /forbidden|numeric/i);
  }
  let calls = 0;
  await assert.rejects(runResearchDualFreeAiReview({ ...input, evidenceSummary: 'x'.repeat(800) + 'api_key=secret-fixture' }, async () => { calls += 1; return { answer, model: 'openai/gpt-oss-20b' }; }), /bounds/);
  assert.equal(calls, 0);
});
export function dslFixture() {
  return {
    market: 'US_STOCK', timeframe: '15m', direction: 'LONG', availableDataFields: ['close'],
    entryDsl: { action: 'LONG', rules: [{ kind: 'OPERATOR', operator: 'CROSSOVER', operands: [
      { kind: 'INDICATOR', name: 'EMA', input: 'close', parameters: { period: 'fast' } },
      { kind: 'INDICATOR', name: 'EMA', input: 'close', parameters: { period: 'slow' } },
    ] }] },
    exitDsl: { rules: [{ type: 'TIME_EXIT', barsParameter: 'holding' }] },
    parameterSpace: [
      { name: 'fast', domain: 'PERIOD', valueType: 'INTEGER', min: 5, max: 10, step: 5 },
      { name: 'slow', domain: 'PERIOD', valueType: 'INTEGER', min: 20, max: 30, step: 10 },
      { name: 'holding', domain: 'BAR_COUNT', valueType: 'INTEGER', min: 2, max: 4, step: 2 },
    ],
    limits: { maxAstDepth: 6, maxIndicatorCount: 8, maxRuleCount: 8, maxAstNodes: 64 },
  };
}
test('canonical DSL generates reproducible research identity without execution or metrics', () => {
  const valid = validateCopilotDsl(dslFixture());
  assert.equal(valid.status, 'ready');
  assert.equal(valid.candidateId, validateCopilotDsl(dslFixture()).candidateId);
  assert.equal(valid.evaluationStatus, 'NOT_EVALUATED');
  assert.equal(valid.backtest.submitted, false);
  assert.equal(valid.profitabilityProven, false);
  for (const input of [{ ...dslFixture(), leverage: 50 }, { ...dslFixture(), code: 'process.exit()' }, { ...dslFixture(), direction: 'SHORT' }, { ...dslFixture(), availableDataFields: ['future_close'] }]) {
    assert.equal(validateCopilotDsl(input).status, 'blocked');
  }
});
