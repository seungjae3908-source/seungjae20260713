import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAiReviewEvidenceValid } from './member-auto-trading-ai-review-evidence.service';
import { STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS } from './evidence-backed-auto-strategy-catalog.service';
import type { MemberAutoTradingPaperHandoffEntry } from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

const now = Date.parse('2026-10-12T04:00:00Z');
const identity = { signalId: 'signal-test', strategyId: 'TREND_PULLBACK_REACCEL_V1',
  market: 'CRYPTO_SPOT', direction: 'BUY', researchCodeSha: 'a'.repeat(40) } as MemberAutoTradingPaperHandoffEntry['identity'];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
// This fake digest is only an integrity fixture, never a provider review,
// Production provenance, readiness or financial-activation certificate.
function fixture(overrides: Record<string, unknown> = {}) {
  const body = { schemaVersion: 'canonical-signal-ai-review-v1', source: 'CANONICAL_SIGNAL_AI_REVIEW',
    ...identity, decision: 'PASS', liveEligibility: 'PASS_ONLY_ELIGIBLE', evidenceDigest: 'b'.repeat(64),
    reviewedAtMs: now, expiresAtMs: now + STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS, ...overrides };
  return { ...body, reviewDigest: createHash('sha256').update(canonical(body)).digest('hex') };
}

test('handoff AI review and rule-pack AI review share the same two-minute maximum TTL', () => {
  assert.equal(STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS, 120_000);
  assert.equal(canonicalAiReviewEvidenceValid(fixture(), identity, now), true);
  assert.equal(canonicalAiReviewEvidenceValid(fixture(), identity, now + 119_999), true);
  for (const ttl of [120_001, 15 * 60_000, 24 * 60 * 60_000]) {
    assert.equal(canonicalAiReviewEvidenceValid(fixture({ expiresAtMs: now + ttl }), identity, now), false);
  }
});

test('expiry cannot be bypassed by a valid unchanged digest or by re-dating the enclosing handoff', () => {
  const review = fixture();
  for (const evaluatedAt of [now + 120_000, now + 120_001, now + 15 * 60_000]) {
    assert.equal(canonicalAiReviewEvidenceValid(review, identity, evaluatedAt), false);
  }
  assert.equal(canonicalAiReviewEvidenceValid(fixture({ reviewedAtMs: now + 1 }), identity, now), false);
});

test('another signal, market, direction, strategy or SHA never inherits a valid review digest', () => {
  for (const change of [{ signalId: 'different' }, { market: 'KR_STOCK' }, { direction: 'SHORT' },
    { strategyId: 'OTHER_STRATEGY' }, { researchCodeSha: 'c'.repeat(40) }]) {
    assert.equal(canonicalAiReviewEvidenceValid(fixture(change), identity, now), false);
  }
  const tampered = { ...fixture(), expiresAtMs: now + 119_999 };
  assert.equal(canonicalAiReviewEvidenceValid(tampered, identity, now), false);
});
