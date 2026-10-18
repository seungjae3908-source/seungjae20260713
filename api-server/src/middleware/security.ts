import type { NextFunction, Request, Response } from 'express';
import type { CorsOptions, CorsOptionsDelegate } from 'cors';
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

const CORS_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Auto-Trade-Key', 'X-Device-Session'];
const LOCAL_DEVELOPMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseCorsAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/u, ''))
    .filter((value) => value.length > 0);
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
}

function originHost(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Decide whether a browser Origin may read credentialed API responses.
 * Requests without an Origin header (server-to-server, curl, same-origin GET)
 * are never blocked here. A browser Origin is accepted only when it is the same
 * host that served the request, an explicitly configured origin, or a local
 * development host outside production. Everything else gets no CORS headers.
 */
export function isCorsOriginAllowed(
  origin: string | undefined,
  requestHosts: readonly string[],
  allowedOrigins: readonly string[],
  nodeEnv: string | undefined,
): boolean {
  if (!origin) return true;
  const normalizedOrigin = origin.trim().replace(/\/+$/u, '').toLowerCase();
  if (normalizedOrigin.length === 0 || normalizedOrigin === 'null') return false;
  if (allowedOrigins.some((value) => value.toLowerCase() === normalizedOrigin)) return true;
  const host = originHost(normalizedOrigin);
  if (!host) return false;
  if (requestHosts.some((value) => value.length > 0 && value === host)) return true;
  if (nodeEnv !== 'production') {
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (LOCAL_DEVELOPMENT_HOSTS.has(hostname)) return true;
  }
  return false;
}

export function createCorsOptionsDelegate(
  env: NodeJS.ProcessEnv = process.env,
): CorsOptionsDelegate<Request> {
  const allowedOrigins = parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  return (req, callback) => {
    const requestHosts = [
      firstHeaderValue(req.headers['x-forwarded-host']),
      firstHeaderValue(req.headers.host),
    ];
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const allowed = isCorsOriginAllowed(origin, requestHosts, allowedOrigins, env.NODE_ENV);
    const options: CorsOptions = {
      origin: allowed,
      credentials: true,
      methods: CORS_ALLOWED_METHODS,
      allowedHeaders: CORS_ALLOWED_HEADERS,
    };
    callback(null, options);
  };
}

/**
 * Headers that are safe for every response of the production entry point.
 * A Content-Security-Policy is intentionally not set here: it needs a
 * report-only rollout against the real page before it can be enforced.
 */
export function productionSecurityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto']);
  if (forwardedProto === 'https' || req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
}
