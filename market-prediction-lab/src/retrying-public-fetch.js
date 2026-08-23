const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function defaultShouldRetryUrl(url) {
  return String(url).startsWith("https://data.binance.vision/");
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inputUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

export function createRetryingPublicFetch({
  fetchImpl = globalThis.fetch,
  shouldRetryUrl = defaultShouldRetryUrl,
  maxAttempts = 3,
  baseDelayMs = 150,
  sleepImpl = defaultSleep,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof shouldRetryUrl !== "function") throw new TypeError("shouldRetryUrl must be a function");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError("maxAttempts must be an integer between 1 and 5");
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 5_000) throw new TypeError("baseDelayMs must be between 0 and 5000");
  if (typeof sleepImpl !== "function") throw new TypeError("sleepImpl must be a function");

  return async function retryingPublicFetch(input, init) {
    const retryableUrl = shouldRetryUrl(inputUrl(input));
    if (!retryableUrl) return fetchImpl(input, init);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(input, init);
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) return response;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
      }
      await sleepImpl(baseDelayMs * attempt);
    }

    throw new Error("retry loop exhausted");
  };
}
