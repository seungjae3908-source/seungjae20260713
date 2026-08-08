import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes';
import { rejectPaperJournalQueryIdentity } from './middleware/paper-journal-query-identity';
import { startPriceAlertMonitor } from './services/notification.service';
import { startTradeRecoveryWorker } from './services/trade-recovery-worker.service';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const port = Number(
  process.env.PORT ??
    process.env.API_PORT ??
    8080,
);

const deploySha = /^[0-9a-f]{40}$/.test(String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase())
  ? String(process.env.DEPLOY_SHA).trim().toLowerCase()
  : null;

app.disable('x-powered-by');

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(
  express.json({
    limit: '5mb',
  }),
);

app.use(
  express.urlencoded({
    extended: true,
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'api-server',
    route: '/health',
    deploySha,
    time: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'api-server',
    route: '/api/health',
    deploySha,
    time: new Date().toISOString(),
  });
});

/* API routes remain before frontend static files. Scanner authentication and
 * capability checks are owned by the API router instead of a public bypass. */
app.use('/api/paper-journal', rejectPaperJournalQueryIdentity);
app.use('/api', apiRouter);

const frontendDistCandidates = [
  path.resolve(
    __dirname,
    '../../stock-analyzer/dist/public',
  ),

  path.resolve(
    __dirname,
    '../../stock-analyzer/dist',
  ),

  path.resolve(
    __dirname,
    '../../../stock-analyzer/dist/public',
  ),

  path.resolve(
    __dirname,
    '../../../stock-analyzer/dist',
  ),

  path.resolve(
    process.cwd(),
    '../stock-analyzer/dist/public',
  ),

  path.resolve(
    process.cwd(),
    '../stock-analyzer/dist',
  ),

  path.resolve(
    process.cwd(),
    'artifacts/stock-analyzer/dist/public',
  ),

  path.resolve(
    process.cwd(),
    'artifacts/stock-analyzer/dist',
  ),

  path.resolve(
    process.cwd(),
    'stock-analyzer/dist/public',
  ),

  path.resolve(
    process.cwd(),
    'stock-analyzer/dist',
  ),
];

const frontendDist =
  frontendDistCandidates.find(
    (candidate) =>
      fs.existsSync(
        path.join(
          candidate,
          'index.html',
        ),
      ),
  );

if (frontendDist) {
  app.use(
    express.static(
      frontendDist,
    ),
  );
}

const availableRoutes = [
  '/api',
  '/api/health',
  '/api/config',
  '/api/search?q=삼성전자',
  '/api/quotes?tickers=005930,NVDA,AAPL',
  '/api/market/movers?market=KR',
  '/api/market/movers?market=US',
  '/api/market/scan?market=KR&timeframe=1D',
  '/api/crypto/scan/spot?timeframe=15m',
  '/api/crypto/scan/futures?timeframe=15m',
  '/api/kiwoom/status',
  '/api/kiwoom/token-test',
  '/api/kiwoom/test',
  '/api/kiwoom/rankings?market=KR&type=volume&limit=30',
  '/api/kiwoom/rankings?market=US&type=tradingValue&limit=30',
  '/api/stocks/005930/quote',
  '/api/watchlist',
];

app.use((req, res) => {
  if (
    req.path.startsWith(
      '/api',
    )
  ) {
    res.status(404).json({
      ok: false,
      error: 'API_ROUTE_NOT_FOUND',
      path: req.path,
      available: availableRoutes,
    });

    return;
  }

  if (frontendDist) {
    res.sendFile(
      path.join(
        frontendDist,
        'index.html',
      ),
    );

    return;
  }

  res.status(200).json({
    ok: true,
    service: 'api-server',
    message:
      'API server is running, but frontend dist was not found.',

    available: [
      '/health',
      ...availableRoutes,
    ],
  });
});

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `[api-server] listening on 0.0.0.0:${port}`,
    );

    console.log(
      '[api-server] Kiwoom routes enabled at /api/kiwoom',
    );

    startPriceAlertMonitor();
    startTradeRecoveryWorker();

    if (frontendDist) {
      console.log(
        `[api-server] serving frontend from ${frontendDist}`,
      );
    } else {
      console.log(
        '[api-server] frontend dist not found, api only mode',
      );
    }
  },
);
