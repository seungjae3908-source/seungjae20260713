import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import apiRouter from './routes';

declare const __BUILD_COMMIT_SHA__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_MODE__: string;
declare const __BUILD_SOURCE_DIRTY__: boolean;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const buildInfo = {
  commitSha: __BUILD_COMMIT_SHA__,
  buildTime: __BUILD_TIME__,
  service: 'api-server',
  mode: __BUILD_MODE__,
  sourceDirty: __BUILD_SOURCE_DIRTY__,
};

const app = express();

const port = Number(
  process.env.PORT ??
    process.env.API_PORT ??
    8080,
);

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
    ...buildInfo,
    route: '/health',
    time: new Date().toISOString(),
    rssBytes: process.memoryUsage().rss,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ...buildInfo,
    route: '/api/health',
    time: new Date().toISOString(),
    rssBytes: process.memoryUsage().rss,
  });
});

if (buildInfo.mode === 'canary') {
  app.get('/api/canary/slow', async (req, res) => {
    const requested = Number(req.query.ms);
    const delayMs = Number.isFinite(requested)
      ? Math.max(50, Math.min(5_000, Math.trunc(requested)))
      : 500;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.json({ ok: true, delayMs });
  });
}

/*
 * API 라우트는 반드시 프론트 정적 파일보다 먼저 등록합니다.
 */
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

const server = app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `[api-server] listening on 0.0.0.0:${port}`,
    );

    console.log(
      '[api-server] Kiwoom routes enabled at /api/kiwoom',
    );

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

const sockets = new Set<Socket>();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

let shutdownPromise: Promise<void> | null = null;
let shutdownState: 'running' | 'stopping' | 'stopped' = 'running';
let shutdownSignalCount = 0;

function shutdownTimeoutMs(): number {
  const configured = Number(process.env.API_SHUTDOWN_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return 10_000;
  return Math.max(1_000, Math.min(30_000, Math.trunc(configured)));
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

function shutdown(reason: string, requestedExitCode: number): Promise<void> {
  shutdownSignalCount += 1;
  if (shutdownPromise) {
    console.log(
      JSON.stringify({
        event: 'api_shutdown_signal_ignored',
        reason,
        state: shutdownState,
        signalCount: shutdownSignalCount,
      }),
    );
    return shutdownPromise;
  }

  shutdownState = 'stopping';
  shutdownPromise = new Promise<void>((resolve) => {
    let finished = false;
    const finish = (exitCode: number) => {
      if (finished) return;
      finished = true;
      shutdownState = 'stopped';
      process.exitCode = exitCode;
      sockets.clear();
      console.log(
        JSON.stringify({
          event: 'api_stopped',
          reason,
          exitCode,
        }),
      );
      if (buildInfo.mode === 'canary' && process.connected) {
        process.disconnect();
      }
      resolve();
    };

    console.log(
      JSON.stringify({
        event: 'api_stopping',
        reason,
        signalCount: shutdownSignalCount,
        openConnections: sockets.size,
      }),
    );

    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      const forcedExitCode = requestedExitCode === 0 ? 1 : requestedExitCode;
      console.error(
        JSON.stringify({
          event: 'api_shutdown_forced',
          reason,
          openConnections: sockets.size,
          exitCode: forcedExitCode,
        }),
      );
      process.exit(forcedExitCode);
    }, shutdownTimeoutMs());

    server.close((error) => {
      clearTimeout(deadline);
      finish(error ? 1 : requestedExitCode);
    });
    server.closeIdleConnections?.();
  });

  return shutdownPromise;
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM', 0);
});
process.on('SIGINT', () => {
  void shutdown('SIGINT', 0);
});
process.on('unhandledRejection', (error) => {
  console.error(
    JSON.stringify({
      event: 'unhandled_rejection',
      code: safeErrorCode(error),
    }),
  );
});
process.once('uncaughtException', (error) => {
  console.error(
    JSON.stringify({
      event: 'uncaught_exception',
      code: safeErrorCode(error),
    }),
  );
  void shutdown('uncaughtException', 1);
});

if (buildInfo.mode === 'canary') {
  process.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'canary-signal' &&
      'signal' in message &&
      (message.signal === 'SIGTERM' || message.signal === 'SIGINT')
    ) {
      void shutdown(message.signal, 0);
    }
  });
}
