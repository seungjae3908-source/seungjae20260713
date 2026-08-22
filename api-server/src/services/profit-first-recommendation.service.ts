import {
  evaluateNoTradeGate,
  rankProfitCandidates,
  type NoTradeDecision,
  type ProfitEvidence,
  type ProfitRankCandidate,
} from './profit-first-signal.service';
import { SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY } from './signal-performance-learning.service';

export interface ProfitFirstRecommendationCandidate {
  signalId: string;
  evidence: ProfitEvidence;
  evidenceQuality: ProfitRankCandidate['evidenceQuality'];
  dataQualityPass: boolean;
  riskEnginePass: boolean;
}

export interface ProfitFirstRejectedCandidate {
  signalId: string;
  gate: NoTradeDecision;
}

export interface ProfitFirstRecommendationSet {
  outcome: 'RECOMMENDATIONS_AVAILABLE' | 'NO_TRADE';
  recommendations: readonly ProfitFirstRecommendationCandidate[];
  rejected: readonly ProfitFirstRejectedCandidate[];
  executionAuthority: 'NONE';
}

export function evaluateProfitFirstRecommendationSet(input: {
  candidates: readonly ProfitFirstRecommendationCandidate[];
  minimumExpectedNetReturnPercent?: number;
  minimumRiskRewardRatio?: number;
  maximumRecommendations?: number;
}): ProfitFirstRecommendationSet {
  const eligible: ProfitFirstRecommendationCandidate[] = [];
  const rejected: ProfitFirstRejectedCandidate[] = [];

  for (const candidate of input.candidates) {
    const gate = evaluateNoTradeGate({
      evidence: candidate.evidence,
      dataQualityPass: candidate.dataQualityPass,
      riskEnginePass: candidate.riskEnginePass,
      minimumExpectedNetReturnPercent: input.minimumExpectedNetReturnPercent,
      minimumRiskRewardRatio: input.minimumRiskRewardRatio,
    });
    if (gate.eligible) eligible.push(candidate);
    else rejected.push(Object.freeze({ signalId: candidate.signalId, gate }));
  }

  const byId = new Map(eligible.map((candidate) => [candidate.signalId, candidate]));
  const ranked = rankProfitCandidates(eligible.map((candidate) => ({
    signalId: candidate.signalId,
    evidence: candidate.evidence,
    evidenceQuality: candidate.evidenceQuality,
  })));
  const limit = Math.max(0, Math.floor(input.maximumRecommendations ?? ranked.length));
  const recommendations = Object.freeze(ranked
    .slice(0, limit)
    .map((item) => byId.get(item.signalId))
    .filter((item): item is ProfitFirstRecommendationCandidate => item != null));

  return Object.freeze({
    outcome: recommendations.length ? 'RECOMMENDATIONS_AVAILABLE' as const : 'NO_TRADE' as const,
    recommendations,
    rejected: Object.freeze(rejected),
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY,
  });
}
