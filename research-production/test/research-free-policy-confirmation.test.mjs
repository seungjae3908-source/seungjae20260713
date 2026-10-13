import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { buildConfirmedResearchPolicies, validResearchFreeConfirmation } from '../src/research-free-policy-confirmation.mjs';
import { resolveResearchVideoDiscoveryPolicy } from '../src/research-video-discovery-worker.mjs';
const input = () => ({ aiText: 'RESEARCH_AI_FREE_TIER_CONFIRMED=false\nAI_CHAT_PROVIDER=gemini\nRESEARCH_AI_MAX_CALLS_PER_SCAN=2\n', videoText: 'RESEARCH_VIDEO_DISCOVERY_APPROVED=false\nRESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=["주식 연구"]\nRESEARCH_VIDEO_DISCOVERY_MAX_RESULTS=2\n', targetSha: 'a'.repeat(40), ownerCommentId: '1234', observedAt: Date.now() });
test('explicit owner confirmation preserves bounded settings without granting trading or evidence authority', () => {
  const plan = buildConfirmedResearchPolicies(input());
  assert.match(plan.aiText, /RESEARCH_AI_FREE_TIER_CONFIRMED=true/);
  assert.match(plan.aiText, /AI_CHAT_PROVIDER=gemini/);
  assert.match(plan.aiText, /RESEARCH_AI_MAX_CALLS_PER_SCAN=2/);
  assert.match(plan.videoText, /RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS=2/);
  assert.equal(validResearchFreeConfirmation(plan.confirmation, 'a'.repeat(40)), true);
  for (const key of ['liveTrading', 'privateApi', 'orderAllowed', 'paidFallback']) assert.equal(plan.confirmation[key], false);
});
test('missing owner approval, paid models, excessive budgets, and secrets fail closed', () => {
  for (const change of [{ ownerCommentId: '' }, { targetSha: 'main' }, { aiText: 'AI_CHAT_PROVIDER=openai' }, { aiText: 'GROQ_MODEL=paid-model' }, { aiText: 'RESEARCH_AI_MAX_CALLS_PER_SCAN=4' }, { aiText: 'GROQ_API_KEY=secret' }, { videoText: 'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=[]' }]) assert.throws(() => buildConfirmedResearchPolicies({ ...input(), ...change }));
});
test('consent cannot be replayed on a different release or relabeled with execution authority', () => {
  const value = buildConfirmedResearchPolicies(input()).confirmation;
  assert.equal(validResearchFreeConfirmation(value, 'b'.repeat(40)), false);
  for (const change of [{ paidFallback: true }, { executionAuthority: 'LIVE' }, { freeOnlyConfirmed: false }, { providers: ['groq'] }, { observedAt: Date.now() + 60000 }]) assert.equal(validResearchFreeConfirmation({ ...value, ...change }, 'a'.repeat(40)), false);
});
test('paired consent supports the unchanged app without relabeling the isolated Research release', () => {
  const plan = buildConfirmedResearchPolicies({ ...input(), appSha: 'b'.repeat(40) });
  assert.equal(plan.confirmation.targetSha, 'b'.repeat(40));
  assert.equal(plan.confirmation.appSha, 'b'.repeat(40));
  assert.equal(plan.confirmation.researchSha, 'a'.repeat(40));
  assert.equal(validResearchFreeConfirmation(plan.confirmation, 'b'.repeat(40)), true);
  assert.equal(validResearchFreeConfirmation(plan.confirmation, 'a'.repeat(40)), false);
  assert.equal(validResearchFreeConfirmation(plan.confirmation, 'c'.repeat(40)), false);
  for (const change of [{ appSha: 'main' }, { appSha: '' }]) {
    assert.throws(() => buildConfirmedResearchPolicies({ ...input(), ...change }));
  }
  for (const change of [{ appSha: 'c'.repeat(40) }, { researchSha: 'main' }]) {
    assert.equal(validResearchFreeConfirmation({ ...plan.confirmation, ...change }, 'b'.repeat(40)), false);
  }
});

test('legacy optional video rotation uses exactly the existing worker defaults, never empty-array repair', () => {
  const defaults = resolveResearchVideoDiscoveryPolicy({}).queries;
  const example = parseEnv(readFileSync(new URL('../deploy/research-video.env.example', import.meta.url), 'utf8'));
  assert.equal(defaults.length, 8);
  assert.deepEqual(JSON.parse(example.RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON), defaults);
  for (const videoText of ['RESEARCH_VIDEO_DISCOVERY_APPROVED=true\n',
    'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=\n', 'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=   \n']) {
    const plan = buildConfirmedResearchPolicies({ ...input(), videoText });
    assert.deepEqual(JSON.parse(parseEnv(plan.videoText).RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON), defaults);
    assert.deepEqual(resolveResearchVideoDiscoveryPolicy(parseEnv(plan.videoText)).queries, defaults);
    assert.equal(plan.confirmation.orderAllowed, false);
  }
  for (const value of ['[]', 'null', '{}', 'not-json', '["same","same"]', '["same"," same "]',
    '["Ａ","A"]', '[" "]', '[1]', '["secret=TEST_ONLY_NOT_A_KEY"]',
    JSON.stringify(['bad\u0000query']), JSON.stringify(['x'.repeat(121)]), JSON.stringify(Array(9).fill('query'))]) {
    const videoText = 'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=' + value.replaceAll('#', '\\u0023') + '\n';
    assert.throws(() => buildConfirmedResearchPolicies({ ...input(), videoText }), /VIDEO_QUERIES_INVALID/);
    assert.throws(() => resolveResearchVideoDiscoveryPolicy(parseEnv(videoText)), /QUERIES_INVALID/);
  }
});

test('confirmed query normalization and env roundtrip preserve valid custom topics', () => {
  const queries = ["  momentum #tag  ", "research's strategy", 'ＶＷＡＰ 연구', '"quoted" path\\research $topic `metadata`'];
  const videoText = "RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON='" + JSON.stringify(queries).replaceAll("'", '\\u0027') + "'\n";
  const expected = resolveResearchVideoDiscoveryPolicy(parseEnv(videoText)).queries;
  const plan = buildConfirmedResearchPolicies({ ...input(), videoText });
  assert.deepEqual(resolveResearchVideoDiscoveryPolicy(parseEnv(plan.videoText)).queries, expected);
  // Independent literal-single-quote contract from systemd.exec(5), not a
  // claim that a service or external provider was invoked in this test.
  const line = plan.videoText.split('\n').find(value => value.startsWith('RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON='));
  const assignment = line.slice(line.indexOf('=') + 1);
  assert.equal(assignment[0], "'");
  assert.equal(assignment.at(-1), "'");
  const systemdLiteral = assignment.slice(1, -1);
  assert.equal(systemdLiteral.includes("'"), false);
  assert.equal(parseEnv(plan.videoText).RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON, systemdLiteral);
  assert.deepEqual(JSON.parse(systemdLiteral), expected);
  const repeated = buildConfirmedResearchPolicies({ ...input(), videoText: plan.videoText });
  assert.equal(repeated.videoText, plan.videoText);
});
