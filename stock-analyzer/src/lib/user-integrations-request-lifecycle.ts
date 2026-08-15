import { APP_API_REQUEST_TIMEOUT_MS } from '@/lib/auth-bootstrap';

export type UserIntegrationsTerminal<T> =
  | {
      status: 'success';
      identity: string;
      requestKey: string;
      generation: number;
      value: T;
    }
  | {
      status: 'failure';
      identity: string;
      requestKey: string;
      generation: number;
      error: unknown;
    };

export type UserIntegrationsRequestResult<T> = UserIntegrationsTerminal<T> | {
  status: 'skipped';
  reason: 'logout-in-progress' | 'identity-mismatch';
};

export type UserIntegrationsRequestOptions<T> = {
  identity: string;
  requestKey: string;
  load: (signal: AbortSignal) => Promise<T>;
  force?: boolean;
};

type ActiveFlight<T> = {
  identity: string;
  requestKey: string;
  generation: number;
  promise: Promise<UserIntegrationsTerminal<T>>;
  transport: Promise<UserIntegrationsTerminal<T>>;
  publicPending: boolean;
};

function timeoutError() {
  return new DOMException('User integrations request timed out.', 'TimeoutError');
}

function logoutDrainTimeoutError() {
  return new DOMException('User integrations logout drain timed out.', 'TimeoutError');
}

/**
 * Owns the single user-integrations read for the current authenticated session.
 *
 * The UI deadline and the physical HTTP transport lifetime are deliberately
 * separate. A slow read may become a terminal UI failure without aborting the
 * underlying same-origin request. Logout blocks new reads and waits for the
 * physical transport to reach an HTTP terminal before invalidating auth. If
 * that drain itself exceeds its bounded deadline, logout fails closed and the
 * existing session is restored by AuthProvider; the transport is not aborted.
 */
export class UserIntegrationsRequestLifecycle<T> {
  private identity: string | null = null;
  private requestKey: string | null = null;
  private generation = 0;
  private blocked = false;
  private active: ActiveFlight<T> | null = null;
  private readonly flights = new Set<Promise<UserIntegrationsTerminal<T>>>();
  private terminal: UserIntegrationsTerminal<T> | null = null;
  private lastTerminal: UserIntegrationsTerminal<T> | null = null;

  constructor(
    private readonly timeoutMs = APP_API_REQUEST_TIMEOUT_MS,
    private readonly logoutDrainTimeoutMs = APP_API_REQUEST_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid user integrations request timeout: ${timeoutMs}`);
    }
    if (!Number.isFinite(logoutDrainTimeoutMs) || logoutDrainTimeoutMs <= 0) {
      throw new Error(`invalid user integrations logout drain timeout: ${logoutDrainTimeoutMs}`);
    }
  }

  setIdentity(identity: string | null, requestKey: string | null): void {
    if ((identity === null) !== (requestKey === null)) {
      throw new Error('User integrations identity and request key must transition together.');
    }
    if (this.identity === identity && this.requestKey === requestKey) return;
    this.generation += 1;
    this.identity = identity;
    this.requestKey = requestKey;
    this.active = null;
    this.terminal = null;
  }

  request(options: UserIntegrationsRequestOptions<T>): Promise<UserIntegrationsRequestResult<T>> {
    const { identity, requestKey, load, force = false } = options;
    if (this.blocked) {
      return Promise.resolve({ status: 'skipped', reason: 'logout-in-progress' });
    }
    if (this.identity !== identity || this.requestKey !== requestKey) {
      return Promise.resolve({ status: 'skipped', reason: 'identity-mismatch' });
    }

    const generation = this.generation;
    if (
      this.active
      && this.active.identity === identity
      && this.active.requestKey === requestKey
      && this.active.generation === generation
    ) {
      return this.active.promise;
    }
    if (
      !force
      && this.terminal
      && this.terminal.identity === identity
      && this.terminal.requestKey === requestKey
      && this.terminal.generation === generation
    ) {
      return Promise.resolve(this.terminal);
    }

    // This signal is intentionally not aborted by the logical UI deadline.
    // The owning transport may still reject naturally (HTTP/network terminal),
    // which is safe to drain before auth invalidation.
    const controller = new AbortController();
    const transportOperation = Promise.resolve().then(() => load(controller.signal));
    let transportFlight: Promise<UserIntegrationsTerminal<T>>;
    transportFlight = transportOperation.then(
      (value): UserIntegrationsTerminal<T> => ({ status: 'success', identity, requestKey, generation, value }),
      (error): UserIntegrationsTerminal<T> => ({ status: 'failure', identity, requestKey, generation, error }),
    ).then((result) => {
      this.lastTerminal = result;
      if (
        !this.blocked
        && this.generation === generation
        && this.identity === identity
        && this.requestKey === requestKey
      ) {
        // If the UI deadline fired first, a later physical HTTP terminal becomes
        // the reusable cached truth for a remount/retry without starting a
        // duplicate request.
        this.terminal = result;
      }
      return result;
    }).finally(() => {
      this.flights.delete(transportFlight);
      if (this.active?.transport === transportFlight) this.active = null;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError()), this.timeoutMs);
    });
    const publicOperation: Promise<T> = Promise.race([transportOperation, deadline]);
    let publicFlight: Promise<UserIntegrationsTerminal<T>>;
    publicFlight = publicOperation.then(
      (value): UserIntegrationsTerminal<T> => ({ status: 'success', identity, requestKey, generation, value }),
      (error): UserIntegrationsTerminal<T> => ({ status: 'failure', identity, requestKey, generation, error }),
    ).then((result) => {
      this.lastTerminal = result;
      if (
        !this.blocked
        && this.generation === generation
        && this.identity === identity
        && this.requestKey === requestKey
      ) {
        this.terminal = result;
      }
      return result;
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (this.active?.promise === publicFlight) this.active.publicPending = false;
    });

    this.active = {
      identity,
      requestKey,
      generation,
      promise: publicFlight,
      transport: transportFlight,
      publicPending: true,
    };
    this.flights.add(transportFlight);
    return publicFlight;
  }

  isCurrent(result: UserIntegrationsRequestResult<T>): result is UserIntegrationsTerminal<T> {
    return result.status !== 'skipped'
      && !this.blocked
      && result.generation === this.generation
      && result.identity === this.identity
      && result.requestKey === this.requestKey;
  }

  beginLogout(): Promise<void> {
    if (!this.blocked) {
      this.blocked = true;
      this.generation += 1;
      this.identity = null;
      this.requestKey = null;
      this.active = null;
      this.terminal = null;
    }
    const pending = [...this.flights];
    if (pending.length === 0) return Promise.resolve();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.all(
      pending.map((flight) => flight.then(() => undefined, () => undefined)),
    ).then(() => undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(logoutDrainTimeoutError()), this.logoutDrainTimeoutMs);
    });

    return Promise.race([drained, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  finishLogout(): void {
    this.blocked = false;
    this.setIdentity(null, null);
  }

  restoreAfterFailedLogout(identity: string, requestKey: string): void {
    this.blocked = false;
    this.setIdentity(identity, requestKey);
  }

  invalidate(): void {
    this.terminal = null;
  }

  snapshot() {
    return {
      identity: this.identity,
      requestKey: this.requestKey,
      generation: this.generation,
      blocked: this.blocked,
      activeCount: this.active?.publicPending ? 1 : 0,
      transportCount: this.flights.size,
      terminalStatus: this.terminal?.status ?? null,
      lastTerminalStatus: this.lastTerminal?.status ?? null,
    } as const;
  }
}

export const userIntegrationsRequestLifecycle = new UserIntegrationsRequestLifecycle<unknown>();
