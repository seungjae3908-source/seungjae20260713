import type {
  BacktestScenarioEvidence,
  PortfolioScenarioResult,
  ScenarioEvidencePolicy,
} from './types.ts';

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

export function buildPortfolioScenario(
  evidence: BacktestScenarioEvidence,
  policy: ScenarioEvidencePolicy,
): PortfolioScenarioResult {
  const failed: string[] = [];
  if (!Number.isInteger(policy.minSampleSize) || policy.minSampleSize <= 0) failed.push('INVALID_MIN_SAMPLE_SIZE_POLICY');
  if (!finite(evidence.sampleSize) || evidence.sampleSize < policy.minSampleSize) failed.push('SAMPLE_SIZE_INSUFFICIENT');
  if (policy.requireOos && evidence.oosPassed !== true) failed.push('OOS_NOT_PASSED');
  if (policy.requireWalkForward && evidence.walkForwardPassed !== true) failed.push('WALK_FORWARD_NOT_PASSED');
  if (policy.requireCostStress && evidence.costStressPassed !== true) failed.push('COST_STRESS_NOT_PASSED');
  if (!finite(evidence.maxDrawdownPercent)) failed.push('MDD_MISSING');
  if (!finite(evidence.expectancy)) failed.push('EXPECTANCY_MISSING');
  if (!finite(evidence.profitFactor)) failed.push('PROFIT_FACTOR_MISSING');
  if (!finite(evidence.confidence)) failed.push('CONFIDENCE_MISSING');
  if (finite(policy.minProfitFactor) && (!finite(evidence.profitFactor) || evidence.profitFactor < policy.minProfitFactor)) failed.push('PROFIT_FACTOR_BELOW_POLICY');
  if (finite(policy.minConfidence) && (!finite(evidence.confidence) || evidence.confidence < policy.minConfidence)) failed.push('CONFIDENCE_BELOW_POLICY');

  const emptyScenarios = {
    bear: { returnPercent: null, basis: 'No validated return estimate is emitted without sufficient evidence.' },
    base: { returnPercent: null, basis: 'No validated return estimate is emitted without sufficient evidence.' },
    bull: { returnPercent: null, basis: 'No validated return estimate is emitted without sufficient evidence.' },
  };
  if (failed.length) {
    return {
      returnScenarioStatus: 'INSUFFICIENT_EVIDENCE',
      evidence,
      missingOrFailed: failed,
      scenarios: emptyScenarios,
    };
  }

  const supplied = evidence.validatedScenarioReturnsPercent;
  if (!supplied || ![supplied.bear, supplied.base, supplied.bull].every(Number.isFinite)) {
    return {
      returnScenarioStatus: 'EVIDENCE_SUFFICIENT_NO_RETURN_ESTIMATE',
      evidence,
      missingOrFailed: [],
      scenarios: {
        bear: { returnPercent: null, basis: 'Evidence gate passed, but no validated bear return was supplied.' },
        base: { returnPercent: null, basis: 'Evidence gate passed, but no validated base return was supplied.' },
        bull: { returnPercent: null, basis: 'Evidence gate passed, but no validated bull return was supplied.' },
      },
    };
  }

  return {
    returnScenarioStatus: 'VALIDATED_SCENARIOS_AVAILABLE',
    evidence,
    missingOrFailed: [],
    scenarios: {
      bear: { returnPercent: supplied.bear, basis: 'Passed through from validated backtest scenario evidence.' },
      base: { returnPercent: supplied.base, basis: 'Passed through from validated backtest scenario evidence.' },
      bull: { returnPercent: supplied.bull, basis: 'Passed through from validated backtest scenario evidence.' },
    },
  };
}
