import type { RequestHandler } from 'express';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
const buckets = new Map<string, { startedAt: number; count: number }>();

export const unifiedSearchRateLimit: RequestHandler = (req, res, next) => {
  const key = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
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
