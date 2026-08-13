import type { RiskFinalChecker, GeminiValidationEnvelope, EvidenceBundle, NormalizedRiskEvent } from './profit-first-ai-evidence.service';
import type { ProfitFirstSignalSnapshot } from './profit-first-runtime.service';

export interface CanonicalRiskFinalInput {
  snapshot: ProfitFirstSignalSnapshot;
  evidence: EvidenceBundle;
  ai: GeminiValidationEnvelope;
  riskEvents: readonly NormalizedRiskEvent[];
}

export type ExistingRiskEngineEvaluator = (input: CanonicalRiskFinalInput) => Promise<{ pass: boolean; reasons: readonly string[] }>;

/**
 * Adapter boundary for the existing Risk Engine. AI never receives override authority.
 * Normalized evidence is passed to the evaluator; the evaluator's fail result is final.
 */
export class CanonicalRiskFinalGate implements RiskFinalChecker {
  constructor(private readonly evaluateExistingRiskEngine: ExistingRiskEngineEvaluator) {}
  async check(input: CanonicalRiskFinalInput): Promise<{ pass: boolean; reasons: readonly string[] }> {
    const result = await this.evaluateExistingRiskEngine(input);
    return Object.freeze({ pass: result.pass === true, reasons: Object.freeze([...result.reasons]) });
  }
}
