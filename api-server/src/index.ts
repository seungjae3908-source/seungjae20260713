import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import apiRouter from './routes';
import {
  startPriceAlertMonitor,
  startStrongSignalMonitor,
} from './services/notification.service';
// import { attachRealtimeChartServer } from './services/analysis/realtime-chart.service';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8080);

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
    time: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'api-server',
    route: '/api/health',
    time: new Date().toISOString(),
  });
});

app.use('/api', apiRouter);

const repositoryRoot = path.resolve(__dirname, '../..');
const frontendDist = path.join(
  repositoryRoot,
  'stock-analyzer',
  'dist',
  'public',
);
const frontendIndex = path.join(frontendDist, 'index.html');
const hasFrontendBuild = fs.existsSync(frontendIndex);

if (hasFrontendBuild) {
  app.use(
    express.static(frontendDist, {
      index: false,
      setHeaders(res, filePath) {
        if (
          filePath.endsWith('.html') ||
          filePath.endsWith('sw.js')
        ) {
          res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate',
          );
          return;
        }

        if (/\.(?:js|css|woff2|png|svg)$/.test(filePath)) {
          res.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
        }
      },
    }),
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
  '/api/kiwoom/status',
  '/api/kiwoom/token-test',
  '/api/kiwoom/test',
  '/api/kiwoom/rankings?market=KR&type=volume&limit=30',
  '/api/kiwoom/rankings?market=US&type=tradingValue&limit=30',
  '/api/stocks/005930/quote',
  '/api/watchlist',
];

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({
      ok: false,
      error: 'API_ROUTE_NOT_FOUND',
      path: req.path,
      available: availableRoutes,
    });

    return;
  }

  if (hasFrontendBuild) {
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate',
    );
    res.setHeader('X-Frontend-Dist', frontendDist);
    res.sendFile(frontendIndex);
    return;
  }

  res.status(200).json({
    ok: true,
    service: 'api-server',
    message:
      'API server is running, but frontend dist was not found.',
    expectedFrontendDist: frontendDist,
    available: ['/health', ...availableRoutes],
  });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[api-server] listening on 0.0.0.0:${port}`);
  console.log(
    '[api-server] Kiwoom routes enabled at /api/kiwoom',
  );

  startPriceAlertMonitor();
  startStrongSignalMonitor();

  if (hasFrontendBuild) {
    console.log(
      `[api-server] serving frontend from ${frontendDist}`,
    );
  } else {
    console.log(
      `[api-server] frontend dist not found: ${frontendDist}; api only mode`,
    );
  }
});

// attachRealtimeChartServer(server);
void server;