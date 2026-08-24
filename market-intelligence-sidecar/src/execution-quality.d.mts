export type ExecutionQualityResult = Readonly<Record<string, unknown>>;

export function walkOrderBook(
  raw?: Readonly<Record<string, unknown>>,
  policyInput?: Readonly<Record<string, unknown>>,
): ExecutionQualityResult;

export function evaluateQueueEvidence(
  raw?: Readonly<Record<string, unknown>>,
): ExecutionQualityResult;

export function evaluateCalibratedFillModel(
  raw?: Readonly<Record<string, unknown>>,
  policyInput?: Readonly<Record<string, unknown>>,
  nowInput?: number,
): ExecutionQualityResult;

export function calculateRealizedTca(
  raw?: Readonly<Record<string, unknown>>,
  policyInput?: Readonly<Record<string, unknown>>,
): ExecutionQualityResult;

export function evaluateExecutionQuality(
  raw?: Readonly<Record<string, unknown>>,
  policyInput?: Readonly<Record<string, unknown>>,
): ExecutionQualityResult;
