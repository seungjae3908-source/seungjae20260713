import { createHash } from 'node:crypto';
import type { MemberAutoTradingPaperHandoffEntry } from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

export type CanonicalSignalAiReviewProof = Readonly<{
  schemaVersion: 'canonical-signal-ai-review-v1';
  source: 'CANONICAL_SIGNAL_AI_REVIEW';
  signalId: string;
  strategyId: string;
  market: string;
  direction: string;
  researchCodeSha: string;
  decision: 'PASS';
  liveEligibility: 'PASS_ONLY_ELIGIBLE';
  evidenceDigest: string;
  reviewedAtMs: number;
  expiresAtMs: number;
  reviewDigest: string;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Only consume a proof already issued by the canonical upstream producer.
 * This digest binds fields and detects changes; it is not a cryptographic
 * signature or substitute for authentic review provenance. No PASS is invented.
 */
export function canonicalAiReviewEvidenceValid(
  review: unknown,
  identity: MemberAutoTradingPaperHandoffEntry['identity'],
  evaluatedAtMs: number,
): review is CanonicalSignalAiReviewProof {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return false;
  const v = review as Record<string, unknown>;
  const fields = [
    'schemaVersion', 'source', 'signalId', 'strategyId', 'market', 'direction',
    'researchCodeSha', 'decision', 'liveEligibility', 'evidenceDigest',
    'reviewedAtMs', 'expiresAtMs', 'reviewDigest',
  ];
  if (Object.keys(v).sort().join('|') !== fields.sort().join('|')) return false;
  const { reviewDigest, ...body } = v;
  return v.schemaVersion === 'canonical-signal-ai-review-v1'
    && v.source === 'CANONICAL_SIGNAL_AI_REVIEW'
    && v.signalId === identity.signalId
    && v.strategyId === identity.strategyId
    && v.market === identity.market
    && v.direction === identity.direction
    && typeof v.researchCodeSha === 'string'
    && /^[a-f0-9]{40}$/i.test(v.researchCodeSha)
    && v.researchCodeSha.toLowerCase() === identity.researchCodeSha.toLowerCase()
    && v.decision === 'PASS'
    && v.liveEligibility === 'PASS_ONLY_ELIGIBLE'
    && typeof v.evidenceDigest === 'string'
    && /^[a-f0-9]{64}$/.test(v.evidenceDigest)
    && typeof v.reviewedAtMs === 'number'
    && Number.isFinite(v.reviewedAtMs)
    && typeof v.expiresAtMs === 'number'
    && Number.isFinite(v.expiresAtMs)
    && v.reviewedAtMs > 0
    && v.reviewedAtMs <= evaluatedAtMs
    && v.expiresAtMs > v.reviewedAtMs
    && v.expiresAtMs - v.reviewedAtMs <= 24 * 60 * 60_000
    && typeof reviewDigest === 'string'
    && /^[a-f0-9]{64}$/.test(reviewDigest)
    && reviewDigest === createHash('sha256').update(canonical(body)).digest('hex');
}
