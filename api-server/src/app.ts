import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import agentHubControlBridge from './routes/agent-hub-control-bridge';
import deviceTrustRouter from './features/device-trust/device-trust.route';
import { deviceTrustAppGate } from './features/device-trust/device-trust.middleware';
import { logger } from "./lib/logger";
import { requireAuthenticated, type AuthenticatedRequest } from './middleware/auth';
import { rejectPaperJournalQueryIdentity } from './middleware/paper-journal-query-identity';
import { apiRateLimit, securityHeaders } from './middleware/security';

const app: Express = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDist = path.resolve(__dirname, "../../stock-analyzer/dist/public");
const clientIndex = path.join(clientDist, "index.html");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(cors({ origin(origin, callback) {
  if (!origin || process.env.NODE_ENV !== 'production' || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('CORS origin rejected'));
}, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Auto-Trade-Key', 'X-Device-Session'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', apiRateLimit);

app.use('/api/paper-journal', rejectPaperJournalQueryIdentity);

app.get("/api", (_req, res) => {
  res.json({
    status: "ok",
    version: "news-api-test-001",
  });
});

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Device-trust enrollment and proof endpoints must remain reachable when the
// optional global enforcement gate is enabled. The gate itself is default-off
// unless DEVICE_TRUST_ENFORCEMENT is exactly `required`.
app.use('/api/device-trust', deviceTrustRouter);
app.use('/api', deviceTrustAppGate);
// Admin-only Agent Hub bridge stays behind the global device-trust gate and
// performs its own authenticated/admin checks before any GitHub control-plane call.
app.use('/api/admin/agent-hub', agentHubControlBridge);

// Browser auth bootstrap must not depend on a direct cross-origin PostgREST
// profiles read. Reuse the canonical server-side authentication middleware,
// which verifies the bearer token and resolves the exact current database
// profile for that user before this same-origin endpoint can return anything.
app.get('/api/auth/profile', requireAuthenticated, (req: AuthenticatedRequest, res) => {
  const profile = req.member;
  const allowedStatuses = new Set(['pending', 'approved', 'rejected']);
  if (
    !profile
    || typeof profile.id !== 'string'
    || profile.id.length === 0
    || typeof profile.login_name !== 'string'
    || typeof profile.display_name !== 'string'
    || typeof profile.role !== 'string'
    || !allowedStatuses.has(profile.status)
  ) {
    return res.status(403).json({
      code: 'PROFILE_INVALID',
      message: 'Authenticated member profile is missing or invalid.',
      details: null,
      hint: null,
    });
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    id: profile.id,
    login_name: profile.login_name,
    display_name: profile.display_name,
    role: profile.role,
    status: profile.status,
    membership_level: profile.membership_level ?? null,
    is_active: profile.is_active ?? null,
    permissions_updated_at: profile.permissions_updated_at ?? null,
    updated_at: profile.updated_at ?? null,
  });
});

app.use("/api", router);

if (existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    setHeaders(res, filePath) {
      const relative = path.relative(clientDist, filePath).split(path.sep).join('/');
      const mustRevalidate = new Set([
        'index.html',
        'sw.js',
        'registerSW.js',
        'push-sw.js',
        'manifest.webmanifest',
      ]);

      if (mustRevalidate.has(relative)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return;
      }

      if (relative.startsWith('assets/') || /^workbox-[A-Za-z0-9_-]+\.js$/.test(relative)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }

      res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }));

  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(clientIndex);
  });
}

export default app;