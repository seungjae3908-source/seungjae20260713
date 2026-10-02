import { join } from 'node:path';

export const PAPER_CANONICAL_VALIDATION_FRESHNESS_POLICY_VERSION =
  'paper-canonical-validation-receipt-freshness-policy-v1' as const;
export const PAPER_CANONICAL_VALIDATION_FRESHNESS_POLICY_RELATIVE_PATH =
  'validation-receipt-policy.json' as const;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type PaperCanonicalValidationFreshnessPolicy = Readonly<{
  schemaVersion: typeof PAPER_CANONICAL_VALIDATION_FRESHNESS_POLICY_VERSION;
  maximumAgeMs: number;
  evidenceSource: 'FORWARD_RECOMMENDATION_OBSERVER';
  immutable: true;
  executionAuthority: 'NONE';
  financialMutationAllowed: false;
  replayBackfillSyntheticManualCredit: 0;
}>;

export type PaperCanonicalValidationFreshnessResolution = Readonly<{
  maximumAgeMs: number;
  source: 'ENV' | 'POLICY_FILE';
  policyPath: string;
}>;

function controlledError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildPaperCanonicalValidationFreshnessPolicy(
  maximumAgeMs: number,
): PaperCanonicalValidationFreshnessPolicy {
  if (!positiveSafeInteger(maximumAgeMs)) {
    throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_INVALID');
  }
  return Object.freeze({
    schemaVersion: PAPER_CANONICAL_VALIDATION_FRESHNESS_POLICY_VERSION,
    maximumAgeMs,
    evidenceSource: 'FORWARD_RECOMMENDATION_OBSERVER',
    immutable: true,
    executionAuthority: 'NONE',
    financialMutationAllowed: false,
    replayBackfillSyntheticManualCredit: 0,
  });
}

export function parsePaperCanonicalValidationFreshnessPolicy(
  raw: unknown,
): PaperCanonicalValidationFreshnessPolicy {
  if (!record(raw)
    || raw.schemaVersion !== PAPER_CANONICAL_VALIDATION_FRESHNESS_POLICY_VERSION
    || !positiveSafeInteger(raw.maximumAgeMs)
    || raw.evidenceSource !== 'FORWARD_RECOMMENDATION_OBSERVER'
    || raw.immutable !== true
    || raw.executionAuthority !== 'NONE'
    || raw.financialMutationAllowed !== false
    || raw.replayBackfillSyntheticManualCredit !== 0) {
    throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_POLICY_INVALID');
  }
  return buildPaperCanonicalValidationFreshnessPolicy(raw.maximumAgeMs);
}

export async function resolvePaperCanonicalValidationReceiptMaximumAgeMs(input: Readonly<{
  env: RuntimeEnvironment;
  stateRoot: string;
  readText(path: string): Promise<string>;
}>): Promise<PaperCanonicalValidationFreshnessResolution> {
  const stateRoot = String(input.stateRoot ?? '').trim();
  if (!stateRoot) throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_POLICY_UNREADABLE');
  const policyPath = join(stateRoot, PAPER_CANONICAL_VALIDATION_FRESHNESS_POLICY_RELATIVE_PATH);
  const explicit = String(input.env.PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS ?? '').trim();
  if (explicit) {
    const maximumAgeMs = Number(explicit);
    if (!positiveSafeInteger(maximumAgeMs)) {
      throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_INVALID');
    }
    return Object.freeze({ maximumAgeMs, source: 'ENV', policyPath });
  }

  let text: string;
  try {
    text = await input.readText(policyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED');
    }
    throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_POLICY_UNREADABLE');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw controlledError('PAPER_CANONICAL_VALIDATION_RECEIPT_POLICY_INVALID_JSON');
  }
  const policy = parsePaperCanonicalValidationFreshnessPolicy(raw);
  return Object.freeze({
    maximumAgeMs: policy.maximumAgeMs,
    source: 'POLICY_FILE',
    policyPath,
  });
}
