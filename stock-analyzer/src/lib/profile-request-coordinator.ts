export type ProfileRequestOptions<T> = {
  identity: string;
  requestKey: string;
  load: () => Promise<T>;
  apply: (value: T) => void;
  force?: boolean;
  maxAgeMs?: number;
};

type SharedFlight = Promise<unknown>;

const sharedFlights = new Map<string, SharedFlight>();

function sharedFlight<T>(requestKey: string, load: () => Promise<T>): Promise<T> {
  const existing = sharedFlights.get(requestKey);
  if (existing) return existing as Promise<T>;

  const flight = Promise.resolve().then(load);
  sharedFlights.set(requestKey, flight);
  void flight.then(
    () => {
      if (sharedFlights.get(requestKey) === flight) sharedFlights.delete(requestKey);
    },
    () => {
      if (sharedFlights.get(requestKey) === flight) sharedFlights.delete(requestKey);
    },
  );
  return flight;
}

function waitForSharedFlight(requestKey: string | null): Promise<void> {
  if (!requestKey) return Promise.resolve();
  const flight = sharedFlights.get(requestKey);
  return flight ? flight.then(() => undefined, () => undefined) : Promise.resolve();
}

export class ProfileRequestCoordinator<T> {
  private identity: string | null = null;
  private requestKey: string | null = null;
  private generation = 0;
  private blocked = false;
  private loadedIdentity: string | null = null;
  private loadedAt = 0;
  private active: Promise<void> | null = null;
  private activeGeneration = -1;
  private activeRequestKey: string | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  setIdentity(identity: string | null, requestKey: string | null): void {
    if ((identity === null) !== (requestKey === null)) {
      throw new Error('Profile request identity and request key must transition together.');
    }
    if (this.identity === identity && this.requestKey === requestKey) return;
    this.generation += 1;
    this.identity = identity;
    this.requestKey = requestKey;
    this.loadedIdentity = null;
    this.loadedAt = 0;
  }

  request(options: ProfileRequestOptions<T>): Promise<void> {
    const { identity, requestKey, load, apply, force = false, maxAgeMs } = options;
    if (this.blocked || this.identity !== identity || this.requestKey !== requestKey) {
      return Promise.resolve();
    }

    const generation = this.generation;
    if (
      this.active
      && this.activeGeneration === generation
      && this.activeRequestKey === requestKey
    ) {
      return this.active;
    }

    const isFresh = this.loadedIdentity === identity
      && (maxAgeMs === undefined || this.now() - this.loadedAt < maxAgeMs);
    if (!force && isFresh) return Promise.resolve();

    let work: Promise<void>;
    work = sharedFlight(requestKey, load)
      .then((value) => {
        if (
          this.blocked
          || this.generation !== generation
          || this.identity !== identity
          || this.requestKey !== requestKey
        ) {
          return;
        }
        apply(value);
        this.loadedIdentity = identity;
        this.loadedAt = this.now();
      })
      .finally(() => {
        if (this.active === work) {
          this.active = null;
          this.activeGeneration = -1;
          this.activeRequestKey = null;
        }
      });

    this.active = work;
    this.activeGeneration = generation;
    this.activeRequestKey = requestKey;
    return work;
  }

  beginLogout(): Promise<void> {
    const requestKey = this.requestKey;
    const active = this.active;
    this.blocked = true;
    this.generation += 1;
    this.identity = null;
    this.requestKey = null;
    this.loadedIdentity = null;
    this.loadedAt = 0;
    return Promise.all([
      active?.then(() => undefined, () => undefined) ?? Promise.resolve(),
      waitForSharedFlight(requestKey),
    ]).then(() => undefined);
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
    this.loadedIdentity = null;
    this.loadedAt = 0;
  }
}
