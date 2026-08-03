import type { NextFunction, Request, Response } from 'express';
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
  next();
}

export function apiRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now(); const limit = req.path.includes('/ai/chat') ? 20 : req.path.includes('auto-trade') || req.path.includes('/admin') ? 30 : 240;
  const key = `${req.ip}:${req.path.split('/').slice(0, 4).join('/')}`; const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + 60_000 });
  else if (++bucket.count > limit) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ error: 'RATE_LIMITED', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  }
  if (buckets.size > 10_000) for (const [id, value] of buckets) if (value.resetAt <= now) buckets.delete(id);
  return next();
}
