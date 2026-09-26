export function buildEvidenceBackedFormulaExecutionParametersV1(value: Record<string, unknown>): Record<string, unknown>;
export function createEvidenceBackedFormulaSignalEvaluatorV1(value: Record<string, unknown>): {
  signalEvaluator: (input: Record<string, unknown>) => unknown;
  evaluatorContract: Record<string, unknown>;
};
