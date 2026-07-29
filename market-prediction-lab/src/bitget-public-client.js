const DEFAULT_BASE_URL = "https://api.bitget.com";
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_BITGET_CODES = new Set(["45001", "40725", "40808", "40015"]);

export class BitgetPublicApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BitgetPublicApiError";
    this.details = details;
  }
}

function assertPositiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function buildUrl(baseUrl, path, params) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function parseRetryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export class BitgetPublicClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8_000,
    maxRetries = 4,
    minIntervalMs = 125,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowImpl = () => Date.now(),
    randomImpl = () => Math.random(),
    userAgent = "market-prediction-lab/0.3",
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.baseUrl = new URL(baseUrl).toString();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = assertPositiveInteger(timeoutMs, "timeoutMs", { min: 100, max: 60_000 });
    this.maxRetries = assertPositiveInteger(maxRetries, "maxRetries", { min: 0, max: 8 });
    this.minIntervalMs = assertPositiveInteger(minIntervalMs, "minIntervalMs", { min: 1, max: 10_000 });
    this.sleepImpl = sleepImpl;
    this.nowImpl = nowImpl;
    this.randomImpl = randomImpl;
    this.userAgent = userAgent;
    this.nextRequestAt = 0;
  }

  async #respectRateLimit() {
    const waitMs = this.nextRequestAt - this.nowImpl();
    if (waitMs > 0) await this.sleepImpl(waitMs);
    this.nextRequestAt = this.nowImpl() + this.minIntervalMs;
  }

  #backoffMs(attempt, response) {
    const retryAfter = response ? parseRetryAfterMs(response) : null;
    if (retryAfter !== null) return Math.min(retryAfter, 30_000);
    const exponential = Math.min(250 * (2 ** attempt), 8_000);
    const jitter = Math.floor(this.randomImpl() * 150);
    return exponential + jitter;
  }

  async get(path, params = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.#respectRateLimit();
      const url = buildUrl(this.baseUrl, path, params);
      const { signal, cancel } = createAbortSignal(this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": this.userAgent },
          signal,
        });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new BitgetPublicApiError("Bitget returned non-JSON data", {
            url: url.toString(), status: response.status, bodyPreview: text.slice(0, 200),
          });
        }

        const bitgetCode = String(payload?.code ?? "");
        const retryable = RETRYABLE_HTTP_STATUS.has(response.status) || RETRYABLE_BITGET_CODES.has(bitgetCode);
        if (!response.ok || bitgetCode !== "00000") {
          const error = new BitgetPublicApiError("Bitget public API request failed", {
            url: url.toString(), status: response.status, code: bitgetCode, message: payload?.msg,
            retryable,
          });
          if (retryable && attempt < this.maxRetries) {
            lastError = error;
            await this.sleepImpl(this.#backoffMs(attempt, response));
            continue;
          }
          throw error;
        }
        return payload;
      } catch (error) {
        const isAbort = signal.aborted || error?.name === "AbortError";
        const retryableNetwork = isAbort || error instanceof TypeError;
        if (retryableNetwork && attempt < this.maxRetries) {
          lastError = error;
          await this.sleepImpl(this.#backoffMs(attempt, response));
          continue;
        }
        throw error;
      } finally {
        cancel();
      }
    }
    throw lastError ?? new BitgetPublicApiError("Bitget request failed after retries");
  }
}

export const BITGET_ENDPOINTS = Object.freeze({
  futuresHistoryCandles: "/api/v2/mix/market/history-candles",
  spotHistoryCandles: "/api/v2/spot/market/history-candles",
  openInterest: "/api/v2/mix/market/open-interest",
  fundingHistory: "/api/v2/mix/market/history-fund-rate",
  currentFunding: "/api/v2/mix/market/current-fund-rate",
  symbolPrice: "/api/v2/mix/market/symbol-price",
});
