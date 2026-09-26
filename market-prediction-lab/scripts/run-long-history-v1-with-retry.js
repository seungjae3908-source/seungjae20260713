import { createRetryingPublicFetch } from "../src/retrying-public-fetch.js";

const originalFetch = globalThis.fetch;
globalThis.fetch = createRetryingPublicFetch({ fetchImpl: originalFetch });

try {
  await import("./run-long-history-v1.js");
} finally {
  globalThis.fetch = originalFetch;
}
