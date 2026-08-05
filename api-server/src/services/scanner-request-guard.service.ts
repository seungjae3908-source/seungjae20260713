export type ScannerGuardErrorCode =
  | 'SCAN_DUPLICATE_REQUEST'
  | 'SCAN_CONCURRENCY_LIMIT'
  | 'SCAN_RATE_LIMITED';

export class ScannerRequestGuardError extends Error {
  constructor(
    readonly code: ScannerGuardErrorCode,
    readonly status: 409 | 429,
    readonly retryAfterSeconds: number,
  ) {
    super(code);
    this.name = 'ScannerRequestGuardError';
  }
}

type MemberState = {
  windowStartedAt: number;
  requestCount: number;
  activeCount: number;
  activeKeys: Set<string>;
  lastSeenAt: number;
};

export type ScannerRequestGuardOptions = {
  windowMs?: number;
  maxRequestsPerWindow?: number;
  maxConcurrentPerMember?: number;
  stateTtlMs?: number;
  now?: () => number;
};

export type ScannerRequestLease = {
  release(): void;
};

export class ScannerRequestGuard {
  private readonly states = new Map<string, MemberState>();
  private readonly windowMs: number;
  private readonly maxRequestsPerWindow: number;
  private readonly maxConcurrentPerMember: number;
  private readonly stateTtlMs: number;
  private readonly now: () => number;

  constructor(options: ScannerRequestGuardOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 12;
    this.maxConcurrentPerMember = options.maxConcurrentPerMember ?? 2;
    this.stateTtlMs = options.stateTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  acquire(memberId: string, requestKey: string): ScannerRequestLease {
    const normalizedMemberId = memberId.trim();
    const normalizedKey = requestKey.trim();
    if (!normalizedMemberId || !normalizedKey) {
      throw new ScannerRequestGuardError('SCAN_RATE_LIMITED', 429, 60);
    }

    const now = this.now();
    this.prune(now);
    let state = this.states.get(normalizedMemberId);
    if (!state) {
      state = {
        windowStartedAt: now,
        requestCount: 0,
        activeCount: 0,
        activeKeys: new Set<string>(),
        lastSeenAt: now,
      };
      this.states.set(normalizedMemberId, state);
    }

    if (now - state.windowStartedAt >= this.windowMs) {
      state.windowStartedAt = now;
      state.requestCount = 0;
    }
    state.lastSeenAt = now;

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((state.windowStartedAt + this.windowMs - now) / 1_000),
    );
    if (state.requestCount >= this.maxRequestsPerWindow) {
      throw new ScannerRequestGuardError(
        'SCAN_RATE_LIMITED',
        429,
        retryAfterSeconds,
      );
    }
    if (state.activeKeys.has(normalizedKey)) {
      throw new ScannerRequestGuardError('SCAN_DUPLICATE_REQUEST', 409, 1);
    }
    if (state.activeCount >= this.maxConcurrentPerMember) {
      throw new ScannerRequestGuardError('SCAN_CONCURRENCY_LIMIT', 429, 2);
    }

    state.requestCount += 1;
    state.activeCount += 1;
    state.activeKeys.add(normalizedKey);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.states.get(normalizedMemberId);
        if (!current) return;
        current.activeKeys.delete(normalizedKey);
        current.activeCount = Math.max(0, current.activeCount - 1);
        current.lastSeenAt = this.now();
      },
    };
  }

  reset(): void {
    this.states.clear();
  }

  private prune(now: number): void {
    for (const [memberId, state] of this.states) {
      if (state.activeCount === 0 && now - state.lastSeenAt > this.stateTtlMs) {
        this.states.delete(memberId);
      }
    }
  }
}

export const scannerRequestGuard = new ScannerRequestGuard();
