import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
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

app.use('/api/paper-journal', (req, res, next) => {
  if ('userId' in req.query || 'user_id' in req.query) {
    return res.status(400).json({
      mode: 'journal-sync-only',
      orderSubmitted: false,
      exchangeRequestSent: false,
      ok: false,
      code: 'CLIENT_USER_ID_FORBIDDEN',
      message: '사용자 ID는 로그인 세션에서만 결정됩니다.',
    });
  }
  return next();
});

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
  app.use(express.static(clientDist));

  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(clientIndex);
  });
}

export default app;
