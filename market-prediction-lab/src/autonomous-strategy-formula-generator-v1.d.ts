/** Type boundary for the existing deterministic JS validator; no alternate evaluator. */
export interface SafeStrategyDsl {
  readonly market: string;
  readonly direction: string;
  readonly timeframe: string;
  readonly dslHash: string;
  readonly astStats: { readonly nodes: number; readonly indicators: number; readonly rules: number };
}
export function createSafeStrategyDslV1(input: unknown): SafeStrategyDsl;
export function assertFormulaCandidateV1(input: unknown): unknown;
