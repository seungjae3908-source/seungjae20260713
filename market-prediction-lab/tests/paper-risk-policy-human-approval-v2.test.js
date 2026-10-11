import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materializeApprovedPaperRiskPolicyRecord, validateApprovedPaperRiskPolicyDecision } from '../scripts/materialize-paper-risk-policy-record.mjs';

const read = file => JSON.parse(readFileSync(new URL('../config/paper-risk-policy/' + file, import.meta.url)));
const prior = read('natural-paper-btcusdt-v1.json');
const decision = read('natural-paper-btcusdt-v2.json');

test('new 7x decision records actual delegated owner approval without rewriting prior policy', () => {
  assert.equal(prior.requestedLeverage, 2); assert.equal(prior.maximumLeverage, 5);
  assert.equal(decision.policyVersion, 'v2'); assert.notEqual(decision.policyId, prior.policyId);
  assert.equal(decision.supersedesPolicyId, prior.policyId);
  assert.equal(decision.approvalIssue, 1555); assert.equal(decision.approvalCommentId, 6107837053);
  assert.equal(decision.source, 'REPOSITORY_OWNER_DIRECT_CONVERSATION_RECORDED_BY_CODEX');
  assert.equal(decision.approvalStatement, '모의매매는 7배니 새기준으로 인정해서 해');
  assert.equal(decision.requestedLeverage, 7); assert.equal(decision.maximumLeverage, 7);
  assert.equal(decision.riskPercent, 0.5); assert.equal(decision.marginMode, 'isolated');
  assert.deepEqual(validateApprovedPaperRiskPolicyDecision(decision).blockers, []);
});

test('new leverage does not widen market, symbols, strategy scope or evidence authority', () => {
  for (const key of ['marketScopes', 'directionScopes', 'strategyScopes', 'symbolScopes', 'economicEvidencePolicy', 'safety', 'immutable', 'changeRule']) {
    assert.deepEqual(decision[key], prior[key], key);
  }
});

test('existing canonical materializer consumes 7x only for exact research SHA and fresh observation', () => {
  const sha = 'a'.repeat(40), observedAt = Date.parse('2026-10-11T10:02:00Z');
  const result = materializeApprovedPaperRiskPolicyRecord({ decision, researchCodeSha: sha, nowMs: observedAt });
  assert.equal(result.requestedLeverage, 7); assert.equal(result.maximumLeverage, 7);
  assert.equal(result.researchCodeSha, sha); assert.equal(result.observedAtMs, observedAt);
  assert.equal(result.maximumAgeMs, 30_000);
  assert.ok(result.provenance.includes('approvalComment:6107837053'));
  assert.ok(result.provenance.includes('financialValuesFromApprovedDecision:true'));
  assert.throws(() => materializeApprovedPaperRiskPolicyRecord({ decision, researchCodeSha: 'unknown' }));
});

test('protected research activation selects v2; old v1 remains an immutable historical source', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/research-production-activation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /PAPER_FORWARD_RISK_POLICY_DECISION_PATH: [^\r\n]+\/natural-paper-btcusdt-v2\.json/u);
  assert.ok(!/PAPER_FORWARD_RISK_POLICY_DECISION_PATH: [^\r\n]+\/natural-paper-btcusdt-v1\.json/u.test(workflow));
  assert.equal(decision.safety.realOrderEnabled, false); assert.equal(decision.safety.executionAuthority, 'NONE');
});
