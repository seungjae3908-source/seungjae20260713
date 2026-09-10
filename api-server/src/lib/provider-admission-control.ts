export type ProviderAdmissionCode =
  | 'CAPACITY_EXHAUSTED'
  | 'CIRCUIT_OPEN'
  | 'ABORTED';

export type ProviderCircuitState = 'closed' | 'open' | 'half_open';

export interface ProviderAdmissionIdentity {
  provider: string;
  domain: string;
  operationClass: string;
}

export interface ProviderAdmissionControlOptions {
  globalCapacity: number;
  providerCapacity: number;
  timeoutThreshold?: number;
  cooldownMs: number;
  now?: () => number;
}

export interface ProviderAdmissionOperationSnapshot {
  operationClass: string;
  admittedActive: number;
  physicalOutstanding: number;
  physicalOutstandingHighWater: number;
  timedOutOutstanding: number;
  lateSettledTotal: number;
  rejectedCapacityTotal: number;
  circuitOpenTotal: number;
  oldestOutstandingAgeMs: number;
}

export interface ProviderAdmissionProviderSnapshot {
  provider: string;
  domain: string;
  circuitState: ProviderCircuitState;
  admittedActive: number;
  physicalOutstanding: number;
  physicalOutstandingHighWater: number;
  timedOutOutstanding: number;
  lateSettledTotal: number;
  rejectedCapacityTotal: number;
  circuitOpenTotal: number;
  circuitTripTotal: number;
  oldestOutstandingAgeMs: number;
  consecutiveTimeouts: number;
  operations: ProviderAdmissionOperationSnapshot[];
}

export interface ProviderAdmissionSnapshot {
  configuredGlobalCapacity: number;
  configuredProviderCapacity: number;
  configuredTimeoutThreshold: number;
  configuredCooldownMs: number;
  admittedActive: number;
  physicalOutstanding: number;
  physicalOutstandingHighWater: number;
  timedOutOutstanding: number;
  lateSettledTotal: number;
  rejectedCapacityTotal: number;
  circuitOpenTotal: number;
  circuitTripTotal: number;
  oldestOutstandingAgeMs: number;
  providers: ProviderAdmissionProviderSnapshot[];
}

export interface ProviderAdmissionLease {
  readonly identity: ProviderAdmissionIdentity;
  markCompleted(): void;
  markRejected(): void;
  markTimedOut(): void;
  markAborted(): void;
}

export interface ProviderAdmissionExecution<Result> {
  lease: ProviderAdmissionLease;
  task: Promise<Result>;
}

type LogicalStatus = 'active' | 'completed' | 'rejected' | 'timed_out' | 'aborted';

type OperationState = {
  operationClass: string;
  admittedActive: number;
  physicalOutstanding: number;
  physicalOutstandingHighWater: number;
  timedOutOutstanding: number;
  lateSettledTotal: number;
  rejectedCapacityTotal: number;
  circuitOpenTotal: number;
};

type ProviderState = {
  key: string;
  provider: string;
  domain: string;
  circuitState: ProviderCircuitState;
  openUntil: number;
  halfOpenProbeActive: boolean;
  consecutiveTimeouts: number;
  admittedActive: number;
  physicalOutstanding: number;
  physicalOutstandingHighWater: number;
  timedOutOutstanding: number;
  lateSettledTotal: number;
  rejectedCapacityTotal: number;
  circuitOpenTotal: number;
  circuitTripTotal: number;
  operations: Map<string, OperationState>;
};

export const PROVIDER_ADMISSION_CONFIG_LIMITS = Object.freeze({
  globalCapacity: Object.freeze({ min: 2, max: 64 }),
  providerCapacity: Object.freeze({ min: 1, max: 32 }),
  timeoutThreshold: Object.freeze({ min: 1, max: 32 }),
  cooldownMs: Object.freeze({ min: 10, max: 300_000 }),
});

export const PROVIDER_ADMISSION_TELEMETRY_LIMITS = Object.freeze({
  inactiveProviders: 128,
  inactiveOperationsPerProvider: 32,
});

type OutstandingRecord = {
  id: number;
  admittedAt: number;
  state: ProviderState;
  operation: OperationState;
  identity: ProviderAdmissionIdentity;
  logicalStatus: LogicalStatus;
  physicalSettled: boolean;
  halfOpenProbe: boolean;
};

export class ProviderAdmissionError extends Error {
  readonly statusCode: 503;

  constructor(
    readonly code: ProviderAdmissionCode,
    readonly retryAfterMs: number,
  ) {
    super(code);
    this.name = 'ProviderAdmissionError';
    this.statusCode = 503;
  }
}

function boundedInteger(
  value: number,
  label: string,
  limits: Readonly<{ min: number; max: number }>,
): number {
  if (!Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
    throw new Error(`${label} must be a safe integer between ${limits.min} and ${limits.max}`);
  }
  return value;
}

function normalizedPart(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a stable provider admission identifier`);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 80 || !/^[a-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`${label} must be a stable provider admission identifier`);
  }
  return normalized;
}

function normalizedDomain(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('domain must be a stable provider admission domain');
  }
  const rawParts = value.trim().toLowerCase().split(':');
  if (rawParts.some((part) => !part)) {
    throw new Error('domain must be a stable provider admission domain');
  }
  if (rawParts[0]?.endsWith('.')) rawParts[0] = rawParts[0].slice(0, -1);
  const normalized = rawParts.join(':');
  const hostname = rawParts[0] ?? '';
  const hostnameLabels = hostname.split('.');
  const validHostname = hostname.length > 0
    && hostname.length <= 253
    && hostnameLabels.every((label) => (
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
  const validNamespaces = rawParts.slice(1).every((part) => (
    part.length <= 63 && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(part)
  ));
  if (!validHostname || !validNamespaces || normalized.length > 253) {
    throw new Error('domain must be a stable provider admission domain');
  }
  return normalized;
}

function normalizedIdentity(identity: ProviderAdmissionIdentity): ProviderAdmissionIdentity {
  return {
    provider: normalizedPart(identity.provider, 'provider'),
    domain: normalizedDomain(identity.domain),
    operationClass: normalizedPart(identity.operationClass, 'operationClass'),
  };
}

function configuredInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>,
): number {
  const value = Number(env[name]);
  return Number.isSafeInteger(value) && value >= limits.min && value <= limits.max
    ? value
    : fallback;
}

// Six is the largest current bounded provider pool. Twelve preserves a second
// provider partition even when one partition is physically stuck. The two
// second cooldown matches the existing Scanner concurrency retry contract.
export function resolveProviderAdmissionDefaults(
  env: NodeJS.ProcessEnv = process.env,
): ProviderAdmissionControlOptions {
  const providerCapacity = configuredInteger(
    env,
    'PROVIDER_ADMISSION_PROVIDER_CAPACITY',
    6,
    PROVIDER_ADMISSION_CONFIG_LIMITS.providerCapacity,
  );
  const globalCapacity = Math.max(
    providerCapacity + 1,
    configuredInteger(
      env,
      'PROVIDER_ADMISSION_GLOBAL_CAPACITY',
      12,
      PROVIDER_ADMISSION_CONFIG_LIMITS.globalCapacity,
    ),
  );
  const timeoutThreshold = Math.min(
    providerCapacity,
    configuredInteger(
      env,
      'PROVIDER_ADMISSION_TIMEOUT_THRESHOLD',
      providerCapacity,
      PROVIDER_ADMISSION_CONFIG_LIMITS.timeoutThreshold,
    ),
  );
  return {
    globalCapacity,
    providerCapacity,
    timeoutThreshold,
    cooldownMs: configuredInteger(
      env,
      'PROVIDER_ADMISSION_COOLDOWN_MS',
      2_000,
      PROVIDER_ADMISSION_CONFIG_LIMITS.cooldownMs,
    ),
  };
}

export const PROCESS_WIDE_PROVIDER_ADMISSION_DEFAULTS = Object.freeze(
  resolveProviderAdmissionDefaults(),
);

export class ProviderAdmissionControl {
  private readonly globalCapacity: number;
  private readonly providerCapacity: number;
  private readonly timeoutThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly providers = new Map<string, ProviderState>();
  private readonly outstanding = new Map<number, OutstandingRecord>();
  private nextId = 1;
  private admittedActive = 0;
  private physicalOutstanding = 0;
  private physicalOutstandingHighWater = 0;
  private timedOutOutstanding = 0;
  private lateSettledTotal = 0;
  private rejectedCapacityTotal = 0;
  private circuitOpenTotal = 0;
  private circuitTripTotal = 0;

  constructor(options: ProviderAdmissionControlOptions) {
    this.globalCapacity = boundedInteger(
      options.globalCapacity,
      'globalCapacity',
      PROVIDER_ADMISSION_CONFIG_LIMITS.globalCapacity,
    );
    this.providerCapacity = boundedInteger(
      options.providerCapacity,
      'providerCapacity',
      PROVIDER_ADMISSION_CONFIG_LIMITS.providerCapacity,
    );
    this.timeoutThreshold = boundedInteger(
      options.timeoutThreshold ?? this.providerCapacity,
      'timeoutThreshold',
      PROVIDER_ADMISSION_CONFIG_LIMITS.timeoutThreshold,
    );
    this.cooldownMs = boundedInteger(
      options.cooldownMs,
      'cooldownMs',
      PROVIDER_ADMISSION_CONFIG_LIMITS.cooldownMs,
    );
    this.now = options.now ?? Date.now;
    if (this.providerCapacity >= this.globalCapacity) {
      throw new Error('providerCapacity must be lower than globalCapacity to preserve provider isolation');
    }
    if (this.timeoutThreshold > this.providerCapacity) {
      throw new Error('timeoutThreshold must not exceed providerCapacity');
    }
  }

  start<Result>(
    identityInput: ProviderAdmissionIdentity,
    taskFactory: () => Promise<Result>,
    signal?: AbortSignal,
  ): ProviderAdmissionExecution<Result> {
    if (signal?.aborted) {
      throw new ProviderAdmissionError('ABORTED', 0);
    }

    const identity = normalizedIdentity(identityInput);
    const now = this.now();
    const state = this.providerState(identity);
    const operation = this.operationState(state, identity.operationClass);
    let halfOpenProbe = false;

    if (state.circuitState === 'open') {
      if (now < state.openUntil) {
        const error = this.circuitOpen(state, operation, state.openUntil - now);
        this.cleanupTelemetry(state);
        throw error;
      }
      if (
        state.physicalOutstanding >= this.providerCapacity
        || this.physicalOutstanding >= this.globalCapacity
      ) {
        state.openUntil = now + this.cooldownMs;
        const error = this.circuitOpen(state, operation, this.cooldownMs);
        this.cleanupTelemetry(state);
        throw error;
      }
      state.circuitState = 'half_open';
      state.halfOpenProbeActive = false;
    }

    if (state.circuitState === 'half_open') {
      if (state.halfOpenProbeActive) {
        const error = this.circuitOpen(state, operation, this.cooldownMs);
        this.cleanupTelemetry(state);
        throw error;
      }
      halfOpenProbe = true;
    }

    if (
      this.physicalOutstanding >= this.globalCapacity
      || state.physicalOutstanding >= this.providerCapacity
    ) {
      this.rejectedCapacityTotal += 1;
      state.rejectedCapacityTotal += 1;
      operation.rejectedCapacityTotal += 1;
      const error = new ProviderAdmissionError('CAPACITY_EXHAUSTED', this.cooldownMs);
      this.cleanupTelemetry(state);
      throw error;
    }

    if (halfOpenProbe) state.halfOpenProbeActive = true;
    const record: OutstandingRecord = {
      id: this.nextId,
      admittedAt: now,
      state,
      operation,
      identity,
      logicalStatus: 'active',
      physicalSettled: false,
      halfOpenProbe,
    };
    this.nextId += 1;
    this.outstanding.set(record.id, record);
    this.admittedActive += 1;
    this.physicalOutstanding += 1;
    state.admittedActive += 1;
    state.physicalOutstanding += 1;
    operation.admittedActive += 1;
    operation.physicalOutstanding += 1;
    this.touchProvider(state);
    this.touchOperation(state, operation);
    this.physicalOutstandingHighWater = Math.max(
      this.physicalOutstandingHighWater,
      this.physicalOutstanding,
    );
    state.physicalOutstandingHighWater = Math.max(
      state.physicalOutstandingHighWater,
      state.physicalOutstanding,
    );
    operation.physicalOutstandingHighWater = Math.max(
      operation.physicalOutstandingHighWater,
      operation.physicalOutstanding,
    );

    const task = Promise.resolve()
      .then(taskFactory)
      .then(
        (value) => {
          this.settlePhysical(record);
          return value;
        },
        (reason: unknown) => {
          this.settlePhysical(record);
          throw reason;
        },
      );
    // Logical callers still receive the rejection, while this observer makes a
    // timeout followed by a late provider rejection process-safe.
    void task.catch(() => undefined);

    let logicalSettled = false;
    const settleLogical = (status: Exclude<LogicalStatus, 'active'>) => {
      if (logicalSettled) return;
      logicalSettled = true;
      this.settleLogical(record, status);
    };
    return {
      task,
      lease: {
        identity,
        markCompleted: () => settleLogical('completed'),
        markRejected: () => settleLogical('rejected'),
        markTimedOut: () => settleLogical('timed_out'),
        markAborted: () => settleLogical('aborted'),
      },
    };
  }

  snapshot(): ProviderAdmissionSnapshot {
    const now = this.now();
    const providerRows = [...this.providers.values()]
      .map((state): ProviderAdmissionProviderSnapshot => ({
        provider: state.provider,
        domain: state.domain,
        circuitState: state.circuitState,
        admittedActive: state.admittedActive,
        physicalOutstanding: state.physicalOutstanding,
        physicalOutstandingHighWater: state.physicalOutstandingHighWater,
        timedOutOutstanding: state.timedOutOutstanding,
        lateSettledTotal: state.lateSettledTotal,
        rejectedCapacityTotal: state.rejectedCapacityTotal,
        circuitOpenTotal: state.circuitOpenTotal,
        circuitTripTotal: state.circuitTripTotal,
        oldestOutstandingAgeMs: this.oldestAge(now, (record) => record.state === state),
        consecutiveTimeouts: state.consecutiveTimeouts,
        operations: [...state.operations.values()]
          .map((operation): ProviderAdmissionOperationSnapshot => ({
            operationClass: operation.operationClass,
            admittedActive: operation.admittedActive,
            physicalOutstanding: operation.physicalOutstanding,
            physicalOutstandingHighWater: operation.physicalOutstandingHighWater,
            timedOutOutstanding: operation.timedOutOutstanding,
            lateSettledTotal: operation.lateSettledTotal,
            rejectedCapacityTotal: operation.rejectedCapacityTotal,
            circuitOpenTotal: operation.circuitOpenTotal,
            oldestOutstandingAgeMs: this.oldestAge(
              now,
              (record) => record.state === state && record.operation === operation,
            ),
          }))
          .sort((left, right) => left.operationClass.localeCompare(right.operationClass)),
      }))
      .sort((left, right) => (
        `${left.provider}:${left.domain}`.localeCompare(`${right.provider}:${right.domain}`)
      ));

    return {
      configuredGlobalCapacity: this.globalCapacity,
      configuredProviderCapacity: this.providerCapacity,
      configuredTimeoutThreshold: this.timeoutThreshold,
      configuredCooldownMs: this.cooldownMs,
      admittedActive: this.admittedActive,
      physicalOutstanding: this.physicalOutstanding,
      physicalOutstandingHighWater: this.physicalOutstandingHighWater,
      timedOutOutstanding: this.timedOutOutstanding,
      lateSettledTotal: this.lateSettledTotal,
      rejectedCapacityTotal: this.rejectedCapacityTotal,
      circuitOpenTotal: this.circuitOpenTotal,
      circuitTripTotal: this.circuitTripTotal,
      oldestOutstandingAgeMs: this.oldestAge(now, () => true),
      providers: providerRows,
    };
  }

  private providerState(identity: ProviderAdmissionIdentity): ProviderState {
    const key = JSON.stringify([identity.provider, identity.domain]);
    const existing = this.providers.get(key);
    if (existing) {
      this.touchProvider(existing);
      return existing;
    }
    const state: ProviderState = {
      key,
      provider: identity.provider,
      domain: identity.domain,
      circuitState: 'closed',
      openUntil: 0,
      halfOpenProbeActive: false,
      consecutiveTimeouts: 0,
      admittedActive: 0,
      physicalOutstanding: 0,
      physicalOutstandingHighWater: 0,
      timedOutOutstanding: 0,
      lateSettledTotal: 0,
      rejectedCapacityTotal: 0,
      circuitOpenTotal: 0,
      circuitTripTotal: 0,
      operations: new Map<string, OperationState>(),
    };
    this.providers.set(key, state);
    return state;
  }

  private operationState(state: ProviderState, operationClass: string): OperationState {
    const existing = state.operations.get(operationClass);
    if (existing) {
      this.touchOperation(state, existing);
      return existing;
    }
    const operation: OperationState = {
      operationClass,
      admittedActive: 0,
      physicalOutstanding: 0,
      physicalOutstandingHighWater: 0,
      timedOutOutstanding: 0,
      lateSettledTotal: 0,
      rejectedCapacityTotal: 0,
      circuitOpenTotal: 0,
    };
    state.operations.set(operationClass, operation);
    return operation;
  }

  private circuitOpen(
    state: ProviderState,
    operation: OperationState,
    retryAfterMs: number,
  ): ProviderAdmissionError {
    this.circuitOpenTotal += 1;
    state.circuitOpenTotal += 1;
    operation.circuitOpenTotal += 1;
    return new ProviderAdmissionError('CIRCUIT_OPEN', Math.max(1, retryAfterMs));
  }

  private settleLogical(record: OutstandingRecord, status: Exclude<LogicalStatus, 'active'>): void {
    if (record.logicalStatus !== 'active') return;
    record.logicalStatus = status;
    this.admittedActive = Math.max(0, this.admittedActive - 1);
    record.state.admittedActive = Math.max(0, record.state.admittedActive - 1);
    record.operation.admittedActive = Math.max(0, record.operation.admittedActive - 1);

    if (status === 'timed_out') {
      record.state.consecutiveTimeouts += 1;
      if (!record.physicalSettled) {
        this.timedOutOutstanding += 1;
        record.state.timedOutOutstanding += 1;
        record.operation.timedOutOutstanding += 1;
      }
      if (
        record.halfOpenProbe
        || record.state.consecutiveTimeouts >= this.timeoutThreshold
      ) {
        this.tripCircuit(record.state);
      }
      this.touchProvider(record.state);
      this.touchOperation(record.state, record.operation);
      this.cleanupTelemetry(record.state);
      return;
    }

    if (status === 'completed') {
      record.state.consecutiveTimeouts = 0;
      if (record.halfOpenProbe) this.closeCircuit(record.state);
      this.touchProvider(record.state);
      this.touchOperation(record.state, record.operation);
      this.cleanupTelemetry(record.state);
      return;
    }

    if (status === 'rejected') {
      record.state.consecutiveTimeouts = 0;
      if (record.halfOpenProbe) this.tripCircuit(record.state);
      this.touchProvider(record.state);
      this.touchOperation(record.state, record.operation);
      this.cleanupTelemetry(record.state);
      return;
    }

    if (record.halfOpenProbe) this.tripCircuit(record.state);
    this.touchProvider(record.state);
    this.touchOperation(record.state, record.operation);
    this.cleanupTelemetry(record.state);
  }

  private settlePhysical(record: OutstandingRecord): void {
    if (record.physicalSettled) return;
    record.physicalSettled = true;
    this.outstanding.delete(record.id);
    this.physicalOutstanding = Math.max(0, this.physicalOutstanding - 1);
    record.state.physicalOutstanding = Math.max(0, record.state.physicalOutstanding - 1);
    record.operation.physicalOutstanding = Math.max(0, record.operation.physicalOutstanding - 1);

    if (record.logicalStatus === 'timed_out') {
      this.timedOutOutstanding = Math.max(0, this.timedOutOutstanding - 1);
      record.state.timedOutOutstanding = Math.max(0, record.state.timedOutOutstanding - 1);
      record.operation.timedOutOutstanding = Math.max(0, record.operation.timedOutOutstanding - 1);
    }
    if (record.logicalStatus === 'timed_out' || record.logicalStatus === 'aborted') {
      this.lateSettledTotal += 1;
      record.state.lateSettledTotal += 1;
      record.operation.lateSettledTotal += 1;
    }
    this.touchProvider(record.state);
    this.touchOperation(record.state, record.operation);
    this.cleanupTelemetry(record.state);
  }

  private tripCircuit(state: ProviderState): void {
    if (state.circuitState === 'open') return;
    state.circuitState = 'open';
    state.openUntil = this.now() + this.cooldownMs;
    state.halfOpenProbeActive = false;
    state.circuitTripTotal += 1;
    this.circuitTripTotal += 1;
  }

  private closeCircuit(state: ProviderState): void {
    state.circuitState = 'closed';
    state.openUntil = 0;
    state.halfOpenProbeActive = false;
    state.consecutiveTimeouts = 0;
  }

  private touchProvider(state: ProviderState): void {
    if (!this.providers.delete(state.key)) return;
    this.providers.set(state.key, state);
  }

  private touchOperation(state: ProviderState, operation: OperationState): void {
    if (!state.operations.delete(operation.operationClass)) return;
    state.operations.set(operation.operationClass, operation);
  }

  private providerCanBeEvicted(state: ProviderState): boolean {
    return state.admittedActive === 0
      && state.physicalOutstanding === 0
      && state.timedOutOutstanding === 0
      && state.circuitState === 'closed'
      && !state.halfOpenProbeActive;
  }

  private operationCanBeEvicted(state: ProviderState, operation: OperationState): boolean {
    return state.circuitState === 'closed'
      && !state.halfOpenProbeActive
      && operation.admittedActive === 0
      && operation.physicalOutstanding === 0
      && operation.timedOutOutstanding === 0;
  }

  private cleanupTelemetry(state?: ProviderState): void {
    if (
      state
      && state.operations.size
        > PROVIDER_ADMISSION_TELEMETRY_LIMITS.inactiveOperationsPerProvider
    ) {
      let removableOperations = [...state.operations.values()]
        .filter((operation) => this.operationCanBeEvicted(state, operation)).length
        - PROVIDER_ADMISSION_TELEMETRY_LIMITS.inactiveOperationsPerProvider;
      if (removableOperations > 0) {
        for (const [key, operation] of state.operations) {
          if (removableOperations <= 0) break;
          if (!this.operationCanBeEvicted(state, operation)) continue;
          state.operations.delete(key);
          removableOperations -= 1;
        }
      }
    }

    if (this.providers.size <= PROVIDER_ADMISSION_TELEMETRY_LIMITS.inactiveProviders) return;
    let removableProviders = [...this.providers.values()]
      .filter((state) => this.providerCanBeEvicted(state)).length
      - PROVIDER_ADMISSION_TELEMETRY_LIMITS.inactiveProviders;
    if (removableProviders <= 0) return;
    for (const [key, state] of this.providers) {
      if (removableProviders <= 0) break;
      if (!this.providerCanBeEvicted(state)) continue;
      this.providers.delete(key);
      removableProviders -= 1;
    }
  }

  private oldestAge(now: number, matches: (record: OutstandingRecord) => boolean): number {
    let oldest = 0;
    for (const record of this.outstanding.values()) {
      if (matches(record)) oldest = Math.max(oldest, Math.max(0, now - record.admittedAt));
    }
    return oldest;
  }
}

export const processWideProviderAdmission = new ProviderAdmissionControl(
  PROCESS_WIDE_PROVIDER_ADMISSION_DEFAULTS,
);
