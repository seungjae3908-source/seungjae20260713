import type {
  ScannerAiValidation,
} from './scanner-quant-strategy.service';

export interface ScannerAiValidationInput {
  signalId: string;
  symbol: string;
  market: string;
  strategy: 'scalping' | 'swing';
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  score: number;
  riskScore: number | null;
  dataQualityScore: number;
  evidence: string[];
  warnings: string[];
}

export interface ScannerAiProviderAdapter {
  readonly name: string;
  validate(input: ScannerAiValidationInput, signal: AbortSignal): Promise<ScannerAiValidation>;
}

export type ScannerAiProviderTransport = (
  input: ScannerAiValidationInput,
  signal: AbortSignal,
) => Promise<ScannerAiValidation>;

abstract class TransportBackedAdapter implements ScannerAiProviderAdapter {
  abstract readonly name: string;
  constructor(private readonly transport: ScannerAiProviderTransport) {}
  validate(input: ScannerAiValidationInput, signal: AbortSignal): Promise<ScannerAiValidation> {
    return this.transport(input, signal);
  }
}

export class GeminiAdapter extends TransportBackedAdapter {
  readonly name = 'gemini';
}

export class GroqAdapter extends TransportBackedAdapter {
  readonly name = 'groq';
}

export class FutureProvider extends TransportBackedAdapter {
  readonly name: string;
  constructor(name: string, transport: ScannerAiProviderTransport) {
    super(transport);
    this.name = name.trim() || 'future-provider';
  }
}

export class ScannerAiProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ScannerAiProviderError';
  }
}

interface QueueItem {
  input: ScannerAiValidationInput;
  signal?: AbortSignal;
  resolve(value: ScannerAiValidation): void;
  reject(reason: unknown): void;
}

export interface ScannerAiSchedulerOptions {
  concurrency?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  random?: () => number;
  now?: () => number;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('SCANNER_AI_ABORTED');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ScannerAiProviderScheduler {
  private readonly queue: QueueItem[] = [];
  private active = 0;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | null = null;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitResetMs: number;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly adapter: ScannerAiProviderAdapter,
    options: ScannerAiSchedulerOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
    this.baseBackoffMs = Math.max(10, Math.floor(options.baseBackoffMs ?? 250));
    this.maxBackoffMs = Math.max(this.baseBackoffMs, Math.floor(options.maxBackoffMs ?? 8_000));
    this.circuitFailureThreshold = Math.max(1, Math.floor(options.circuitFailureThreshold ?? 5));
    this.circuitResetMs = Math.max(100, Math.floor(options.circuitResetMs ?? 30_000));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  get providerName(): string {
    return this.adapter.name;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active;
  }

  validate(input: ScannerAiValidationInput, signal?: AbortSignal): Promise<ScannerAiValidation> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolve, reject) => {
      this.queue.push({ input, signal, resolve, reject });
      this.drain();
    });
  }

  private circuitOpen(): boolean {
    if (this.circuitOpenedAt == null) return false;
    if (this.now() - this.circuitOpenedAt >= this.circuitResetMs) {
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.signal?.aborted) {
        item.reject(abortError(item.signal.reason));
        continue;
      }
      if (this.circuitOpen()) {
        item.reject(new ScannerAiProviderError('SCANNER_AI_CIRCUIT_OPEN', true, this.circuitResetMs));
        continue;
      }
      this.active += 1;
      void this.execute(item)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private async execute(item: QueueItem): Promise<ScannerAiValidation> {
    let attempt = 0;
    while (true) {
      if (item.signal?.aborted) throw abortError(item.signal.reason);
      const controller = new AbortController();
      const onAbort = () => controller.abort(item.signal?.reason);
      item.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await this.adapter.validate(item.input, controller.signal);
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = null;
        return result;
      } catch (error) {
        if (item.signal?.aborted || controller.signal.aborted) throw abortError(item.signal?.reason);
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.circuitFailureThreshold) {
          this.circuitOpenedAt = this.now();
        }
        const providerError = error instanceof ScannerAiProviderError
          ? error
          : new ScannerAiProviderError(
            error instanceof Error ? error.message : 'SCANNER_AI_PROVIDER_FAILED',
            false,
          );
        if (!providerError.retryable || attempt >= this.maxRetries || this.circuitOpen()) throw providerError;
        const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
        const jitter = Math.floor(exponential * 0.35 * clampRandom(this.random()));
        const retryAfter = providerError.retryAfterMs ?? 0;
        await delay(Math.max(retryAfter, exponential + jitter), item.signal);
        attempt += 1;
      } finally {
        item.signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
