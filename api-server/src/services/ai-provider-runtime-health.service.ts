export type AiRuntimeProvider = 'google-gemini' | 'groq' | 'openai-compatible';

export type AiProviderAttemptOutcome =
  | 'SUCCESS'
  | 'RETRYABLE_FAILURE'
  | 'TERMINAL_FAILURE'
  | 'CANCELLED';

export type AiProviderRuntimeState =
  | 'READY'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'NO_EVIDENCE'
  | 'NOT_CONFIGURED';

export interface AiProviderRuntimeConfiguration {
  provider: AiRuntimeProvider;
  role: 'PRIMARY' | 'SECONDARY';
  model: string;
}

type AiProviderSample = {
  provider: AiRuntimeProvider;
  model: string;
  outcome: AiProviderAttemptOutcome;
  errorCode: string | null;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
};

export interface AiProviderRuntimeRow {
  provider: AiRuntimeProvider;
  role: 'PRIMARY' | 'SECONDARY' | 'INACTIVE';
  configured: boolean;
  model: string | null;
  state: AiProviderRuntimeState;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  retryableFailureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface AiProviderRuntimeHealthSnapshot {
  schemaVersion: 'ai-provider-runtime-health-v1';
  overall: AiProviderRuntimeState;
  observedSince: string;
  generatedAt: string;
  processLocalEvidence: true;
  primaryProvider: AiRuntimeProvider | null;
  secondaryProvider: AiRuntimeProvider | null;
  fallbackCount: number;
  lastFallbackAt: string | null;
  providers: AiProviderRuntimeRow[];
  secretsExposed: false;
  readOnly: true;
  executionAuthority: 'NONE';
}

const MAX_SAMPLES_PER_PROVIDER = 50;
const processStartedAt = Date.now();
const samples = new Map<AiRuntimeProvider, AiProviderSample[]>();
let fallbackCount = 0;
let lastFallbackAt: number | null = null;

function boundedErrorCode(value: string | null | undefined): string | null {
  const code = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 80);
  return code || null;
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * 0.95) - 1));
  return Math.round(ordered[index]);
}

function iso(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

export function recordAiProviderAttempt(input: {
  provider: AiRuntimeProvider;
  model: string;
  outcome: AiProviderAttemptOutcome;
  errorCode?: string | null;
  startedAt: number;
  completedAt?: number;
}): void {
  const completedAt = input.completedAt ?? Date.now();
  const row: AiProviderSample = {
    provider: input.provider,
    model: String(input.model ?? '').slice(0, 120),
    outcome: input.outcome,
    errorCode: boundedErrorCode(input.errorCode),
    startedAt: input.startedAt,
    completedAt,
    latencyMs: Math.max(0, completedAt - input.startedAt),
  };
  const previous = samples.get(input.provider) ?? [];
  samples.set(input.provider, [...previous, row].slice(-MAX_SAMPLES_PER_PROVIDER));
}

export function recordAiProviderFallback(): void {
  fallbackCount += 1;
  lastFallbackAt = Date.now();
}

function runtimeRow(
  provider: AiRuntimeProvider,
  configured: AiProviderRuntimeConfiguration | undefined,
): AiProviderRuntimeRow {
  const rows = samples.get(provider) ?? [];
  const successRows = rows.filter((row) => row.outcome === 'SUCCESS');
  const failureRows = rows.filter((row) => row.outcome === 'RETRYABLE_FAILURE' || row.outcome === 'TERMINAL_FAILURE');
  const last = rows.at(-1);
  const lastSuccess = successRows.at(-1);
  const lastFailure = failureRows.at(-1);
  let state: AiProviderRuntimeState;
  if (!configured) state = 'NOT_CONFIGURED';
  else if (!rows.length) state = 'NO_EVIDENCE';
  else if (last?.outcome === 'SUCCESS') state = failureRows.length ? 'DEGRADED' : 'READY';
  else if (successRows.length) state = 'DEGRADED';
  else state = 'UNAVAILABLE';

  return {
    provider,
    role: configured?.role ?? 'INACTIVE',
    configured: Boolean(configured),
    model: configured?.model ?? null,
    state,
    sampleCount: rows.length,
    successCount: successRows.length,
    failureCount: failureRows.length,
    retryableFailureCount: rows.filter((row) => row.outcome === 'RETRYABLE_FAILURE').length,
    lastSuccessAt: iso(lastSuccess?.completedAt ?? null),
    lastFailureAt: iso(lastFailure?.completedAt ?? null),
    lastErrorCode: lastFailure?.errorCode ?? null,
    averageLatencyMs: rows.length
      ? Math.round(rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length)
      : null,
    p95LatencyMs: percentile95(rows.map((row) => row.latencyMs)),
  };
}

export function getAiProviderRuntimeHealth(
  configuration: AiProviderRuntimeConfiguration[],
): AiProviderRuntimeHealthSnapshot {
  const byProvider = new Map(configuration.map((row) => [row.provider, row]));
  const providers: AiRuntimeProvider[] = ['google-gemini', 'groq', 'openai-compatible'];
  const rows = providers.map((provider) => runtimeRow(provider, byProvider.get(provider)));
  const primary = configuration.find((row) => row.role === 'PRIMARY') ?? null;
  const secondary = configuration.find((row) => row.role === 'SECONDARY') ?? null;
  const primaryRow = primary ? rows.find((row) => row.provider === primary.provider) : null;

  let overall: AiProviderRuntimeState;
  if (!primary) overall = 'NOT_CONFIGURED';
  else if (!primaryRow || primaryRow.state === 'NO_EVIDENCE') overall = 'NO_EVIDENCE';
  else if (primaryRow.state === 'READY') overall = fallbackCount > 0 ? 'DEGRADED' : 'READY';
  else if (primaryRow.state === 'DEGRADED') overall = 'DEGRADED';
  else {
    const secondaryRow = secondary ? rows.find((row) => row.provider === secondary.provider) : null;
    overall = secondaryRow && (secondaryRow.state === 'READY' || secondaryRow.state === 'DEGRADED')
      ? 'DEGRADED'
      : 'UNAVAILABLE';
  }

  return {
    schemaVersion: 'ai-provider-runtime-health-v1',
    overall,
    observedSince: new Date(processStartedAt).toISOString(),
    generatedAt: new Date().toISOString(),
    processLocalEvidence: true,
    primaryProvider: primary?.provider ?? null,
    secondaryProvider: secondary?.provider ?? null,
    fallbackCount,
    lastFallbackAt: iso(lastFallbackAt),
    providers: rows,
    secretsExposed: false,
    readOnly: true,
    executionAuthority: 'NONE',
  };
}

export function resetAiProviderRuntimeHealthForTests(): void {
  samples.clear();
  fallbackCount = 0;
  lastFallbackAt = null;
}
