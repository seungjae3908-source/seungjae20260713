import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
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
}, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Auto-Trade-Key'] }));
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