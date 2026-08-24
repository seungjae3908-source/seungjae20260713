export class ProviderHealthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderHealthError";
    this.code = code;
  }
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new ProviderHealthError("INVALID_PROVIDER_HEALTH_POLICY", `${name} must be positive`);
  return number;
}

export class ProviderHealthCircuit {
  #provider;
  #failureThreshold;
  #openMs;
  #maxClockSkewMs;
  #staleAfterMs;
  #minConnectIntervalMs;
  #consecutiveFailures = 0;
  #circuitState = "CLOSED";
  #openUntilMs = 0;
  #connected = false;
  #lastConnectAttemptMs = null;
  #lastConnectedAtMs = null;
  #lastMessageAtMs = null;
  #lastProviderTimestampMs = null;
  #clockSkewMs = null;
  #lastFailureCode = null;
  #resyncRequired = false;

  constructor({ provider, failureThreshold = 3, openMs = 30_000, maxClockSkewMs = 5_000, staleAfterMs = 10_000, minConnectIntervalMs = 1_000 } = {}) {
    if (typeof provider !== "string" || !provider.trim()) throw new ProviderHealthError("PROVIDER_REQUIRED", "provider is required");
    this.#provider = provider.trim().toLowerCase();
    this.#failureThreshold = positive(failureThreshold, "failureThreshold");
    this.#openMs = positive(openMs, "openMs");
    this.#maxClockSkewMs = positive(maxClockSkewMs, "maxClockSkewMs");
    this.#staleAfterMs = positive(staleAfterMs, "staleAfterMs");
    this.#minConnectIntervalMs = positive(minConnectIntervalMs, "minConnectIntervalMs");
  }

  beforeConnect(nowMs = Date.now()) {
    if (this.#circuitState === "OPEN") {
      if (nowMs < this.#openUntilMs) {
        throw new ProviderHealthError("PROVIDER_CIRCUIT_OPEN", `${this.#provider} public market-data circuit is open`);
      }
      this.#circuitState = "HALF_OPEN";
    }
    if (this.#lastConnectAttemptMs !== null && nowMs - this.#lastConnectAttemptMs < this.#minConnectIntervalMs) {
      throw new ProviderHealthError("PROVIDER_CONNECT_RATE_LIMIT", `${this.#provider} reconnect attempt is rate-limited`);
    }
    this.#lastConnectAttemptMs = nowMs;
  }

  recordConnected(nowMs = Date.now()) {
    this.#connected = true;
    this.#lastConnectedAtMs = nowMs;
  }

  recordMessage(providerTimestampMs, nowMs = Date.now()) {
    const providerTs = Number(providerTimestampMs);
    if (!Number.isFinite(providerTs) || providerTs <= 0) {
      throw new ProviderHealthError("INVALID_PROVIDER_TIMESTAMP", "provider timestamp must be positive");
    }
    const skew = nowMs - providerTs;
    if (Math.abs(skew) > this.#maxClockSkewMs) {
      throw new ProviderHealthError("PROVIDER_CLOCK_SKEW_EXCEEDED", `${this.#provider} clock skew exceeds the configured bound`);
    }
    this.#clockSkewMs = skew;
    this.#lastProviderTimestampMs = providerTs;
    this.#lastMessageAtMs = nowMs;
    this.#consecutiveFailures = 0;
    this.#lastFailureCode = null;
    this.#circuitState = "CLOSED";
    this.#openUntilMs = 0;
    this.#connected = true;
  }

  recordFailure(code, nowMs = Date.now()) {
    this.#connected = false;
    this.#consecutiveFailures += 1;
    this.#lastFailureCode = typeof code === "string" && code ? code : "PUBLIC_PROVIDER_FAILURE";
    if (this.#consecutiveFailures >= this.#failureThreshold) {
      this.#circuitState = "OPEN";
      this.#openUntilMs = nowMs + this.#openMs;
    }
  }

  recordDisconnected(code = "PUBLIC_PROVIDER_DISCONNECTED") {
    this.#connected = false;
    this.#lastFailureCode = code;
  }

  requireResync(code = "PUBLIC_BOOK_RESYNC_REQUIRED") {
    this.#resyncRequired = true;
    this.#lastFailureCode = code;
  }

  clearResync() {
    this.#resyncRequired = false;
  }

  nextReconnectDelayMs(nowMs = Date.now()) {
    if (this.#circuitState === "OPEN" && nowMs < this.#openUntilMs) {
      return Math.max(this.#minConnectIntervalMs, this.#openUntilMs - nowMs);
    }
    const power = Math.max(0, Math.min(this.#consecutiveFailures - 1, 6));
    return Math.min(60_000, this.#minConnectIntervalMs * (2 ** power));
  }

  snapshot(nowMs = Date.now()) {
    const stale = this.#lastMessageAtMs === null || nowMs - this.#lastMessageAtMs > this.#staleAfterMs;
    const ready = this.#connected && this.#circuitState === "CLOSED" && !this.#resyncRequired && !stale;
    return Object.freeze({
      provider: this.#provider,
      circuitState: this.#circuitState,
      connected: this.#connected,
      readyForPaperDecisionSupport: ready,
      stale,
      resyncRequired: this.#resyncRequired,
      consecutiveFailures: this.#consecutiveFailures,
      lastFailureCode: this.#lastFailureCode,
      lastConnectAttemptAt: this.#lastConnectAttemptMs === null ? null : new Date(this.#lastConnectAttemptMs).toISOString(),
      lastConnectedAt: this.#lastConnectedAtMs === null ? null : new Date(this.#lastConnectedAtMs).toISOString(),
      lastMessageAt: this.#lastMessageAtMs === null ? null : new Date(this.#lastMessageAtMs).toISOString(),
      lastProviderTimestamp: this.#lastProviderTimestampMs === null ? null : new Date(this.#lastProviderTimestampMs).toISOString(),
      clockSkewMs: this.#clockSkewMs,
      openUntil: this.#openUntilMs > 0 ? new Date(this.#openUntilMs).toISOString() : null,
      liveExecutionEligible: false,
      privateApiUsed: false,
    });
  }
}
