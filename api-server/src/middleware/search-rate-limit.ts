import type { RequestHandler } from 'express';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
const MAX_BUCKETS = 10_000;
const PRUNE_EVERY_REQUESTS = 100;
const buckets = new Map<string, { startedAt: number; count: number }>();
let handledRequests = 0;

function pruneExpiredBuckets(now: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= WINDOW_MS) buckets.delete(key);
  }
  while (buckets.size > MAX_BUCKETS) {
    const oldestKey = buckets.keys().next().value as string | undefined;
    if (!oldestKey) break;
    buckets.delete(oldestKey);
  }
}

export const unifiedSearchRateLimit: RequestHandler = (req, res, next) => {
  const key = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
  const now = Date.now();
  handledRequests += 1;
  if (handledRequests % PRUNE_EVERY_REQUESTS === 0 || buckets.size > MAX_BUCKETS) {
    pruneExpiredBuckets(now);
  }

  const current = buckets.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    buckets.delete(key);
    buckets.set(key, { startedAt: now, count: 1 });
    next();
    return;
  }

  current.count += 1;
  if (current.count > MAX_REQUESTS) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ ok: false, error: 'SEARCH_RATE_LIMITED', results: [], count: 0 });
    return;
  }
  next();
};

export function resetUnifiedSearchRateLimitForTests() {
  buckets.clear();
  handledRequests = 0;
}
