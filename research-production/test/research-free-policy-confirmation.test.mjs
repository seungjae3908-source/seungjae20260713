import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmedResearchPolicies, validResearchFreeConfirmation } from '../src/research-free-policy-confirmation.mjs';
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
