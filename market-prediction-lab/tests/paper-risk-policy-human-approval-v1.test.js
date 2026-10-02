import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PAPER_RISK_POLICY_RUNTIME_RECORD_MAXIMUM_AGE_MS,
  materializeApprovedPaperRiskPolicyRecord,
  validateApprovedPaperRiskPolicyDecision,
} from '../scripts/materialize-paper-risk-policy-record.mjs';

const decision = JSON.parse(await readFile(
  new URL('../config/paper-risk-policy/natural-paper-btcusdt-v1.json', import.meta.url),
  'utf8',
));

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-09-21T10:30:00.000Z');

test('approved v1 decision exactly locks the owner-selected BTCUSDT futures risk values', () => {
  assert.equal(decision.schemaVersion, 'paper-risk-policy-human-approval-v1');
  assert.equal(decision.policyId, 'NATURAL_PAPER_BTCUSDT_CRYPTO_FUTURES_V1');
  assert.equal(decision.policyVersion, 'v1');
  assert.equal(decision.approvalIssue, 23);
  assert.equal(decision.approvalCommentId, 5759144475);
  assert.equal(decision.approvedBy, 'seungjae3908-source');
  assert.equal(decision.riskPercent, 0.5);
  assert.equal(decision.requestedLeverage, 2);
  assert.equal(decision.maximumLeverage, 5);
  assert.equal(decision.marginMode, 'isolated');
  assert.deepEqual(decision.marketScopes, ['CRYPTO_FUTURES']);
  assert.deepEqual(decision.directionScopes, ['LONG', 'SHORT']);
  assert.deepEqual(decision.symbolScopes, ['BTCUSDT']);
  assert.deepEqual(decision.strategyScopes, [
    'CRYPTO_FUTURES_SCALP_V1_LONG',
    'CRYPTO_FUTURES_SCALP_V1_SHORT',
    'CRYPTO_FUTURES_SWING_V1_LONG',
    'CRYPTO_FUTURES_SWING_V1_SHORT',
    'CRYPTO_FUTURES_POSITION_V1_LONG',
    'CRYPTO_FUTURES_POSITION_V1_SHORT',
  ]);
  assert.equal(decision.immutable, true);
  assert.equal(decision.changeRule, 'NEW_POLICY_VERSION_ONLY_NO_RETROSPECTIVE_MUTATION');
  assert.deepEqual(decision.economicEvidencePolicy, {
    futureNaturalPaperOnly: true,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    fixtureCredit: 0,
  });
  assert.deepEqual(decision.safety, {
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
    productionDeployAuthority: false,
    stagingDeployAuthority: false,
  });
});

test('materializer changes only runtime SHA/freshness fields and preserves approved financial values', () => {
  const result = materializeApprovedPaperRiskPolicyRecord({
    decision,
    researchCodeSha: SHA,
    nowMs: NOW,
  });
  assert.equal(result.schemaVersion, 'authoritative-paper-generic-risk-policy-record-v1');
  assert.equal(result.researchCodeSha, SHA);
  assert.equal(result.observedAtMs, NOW);
  assert.equal(result.maximumAgeMs, PAPER_RISK_POLICY_RUNTIME_RECORD_MAXIMUM_AGE_MS);
  assert.equal(result.riskPercent, 0.5);
  assert.equal(result.requestedLeverage, 2);
  assert.equal(result.maximumLeverage, 5);
  assert.equal(result.marginMode, 'isolated');
  assert.deepEqual(result.marketScopes, decision.marketScopes);
  assert.deepEqual(result.strategyScopes, decision.strategyScopes);
  assert.deepEqual(result.symbolScopes, decision.symbolScopes);
  assert.ok(result.provenance.includes('approvalComment:5759144475'));
  assert.ok(result.provenance.some((item) => item.startsWith('decisionDigest:')));
  assert.ok(result.provenance.includes('financialValuesFromApprovedDecision:true'));
});

test('decision validator fails closed rather than inventing or widening policy', () => {
  for (const patch of [
    { riskPercent: 0 },
    { requestedLeverage: 6, maximumLeverage: 5 },
    { maximumLeverage: 0 },
    { marginMode: 'portfolio' },
    { symbolScopes: ['*'] },
    { marketScopes: ['CRYPTO_FUTURES', 'CRYPTO_SPOT'] },
    { immutable: false },
    { economicEvidencePolicy: { ...decision.economicEvidencePolicy, syntheticCredit: 1 } },
    { safety: { ...decision.safety, liveTrading: true } },
  ]) {
    const candidate = structuredClone(decision);
    Object.assign(candidate, patch);
    const checked = validateApprovedPaperRiskPolicyDecision(candidate);
    assert.equal(checked.decision, null, JSON.stringify(patch));
    assert.ok(checked.blockers.length > 0, JSON.stringify(patch));
  }
});

test('invalid research SHA cannot be materialized', () => {
  assert.throws(
    () => materializeApprovedPaperRiskPolicyRecord({
      decision,
      researchCodeSha: 'not-a-sha',
      nowMs: NOW,
    }),
    /PAPER_RISK_POLICY_EXACT_RESEARCH_SHA_REQUIRED/u,
  );
});
