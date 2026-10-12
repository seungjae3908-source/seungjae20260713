import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// PORT / BASE_PATH are provided by the workflow in dev. During a production
// build (vite build) they may be unset, so fall back to safe defaults instead
// of throwing — the port only matters for the dev/preview server, and the app
// is served at the site root in production.
const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;

if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

// Phase 9 browser tests intentionally run a frontend-only Vite server. Optional
// Market Intelligence is a backend-owned read-only endpoint, so tests that are
// not specifically about that feature must receive an explicit "not available"
// contract rather than accidentally proxying to a nonexistent localhost:8080.
// Dedicated Market Intelligence E2E tests intercept this URL in Playwright and
// therefore still exercise READY evidence independently of this fallback.
function phase9MarketIntelligenceUnavailableFixture(): Plugin {
  return {
    name: 'phase9-market-intelligence-unavailable-fixture',
    configureServer(server) {
      if (process.env.VITE_PHASE9_E2E !== 'true') return;
      server.middlewares.use('/api/market-intelligence/news-disclosure', (req, res, next) => {
        if (req.method !== 'GET') {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({
          ok: true,
          available: false,
          cache: 'MISS',
          result: null,
          chartPolicy: {
            evidenceOnly: true,
            scoreImpact: 0,
            probabilityImpact: 0,
            sentimentIsPriceDirection: false,
            executionAuthority: 'NONE',
            orderAllowed: false,
            maxAiEvents: 1,
            serverCacheTtlMs: 60_000,
          },
        }));
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  // Both servers optimize the same external libraries. Keep a stable plugin
  // set/hash so a restored-auth server reuses these artifacts rather than
  // rebundling them alongside the fixture server. The legacy directory name
  // is retained; this cache contains dependencies, not auth/data responses.
  cacheDir: path.resolve(
    import.meta.dirname, 'node_modules/.vite/stock-analyzer/phase9-fixtures',
  ),
  // Avoid crawling old production output and every lazy feature before the
  // first source request can finish. These are the app's external runtime
  // dependencies; a regression test checks coverage when imports change.
  // Linked workspace modules remain normal on-demand ESM source transforms.
  optimizeDeps: {
    entries: ['index.html'],
    noDiscovery: true,
    holdUntilCrawlEnd: false,
    include: [
      '@radix-ui/react-toast', '@radix-ui/react-tooltip',
      '@supabase/supabase-js', '@tanstack/react-query',
      'class-variance-authority', 'clsx', 'lightweight-charts', 'lucide-react',
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
      'recharts', 'tailwind-merge', 'wouter',
    ],
  },
  plugins: [
    // The entry only schedules dynamic imports: it has no JSX or component
    // exports. Avoid loading Babel/Fast Refresh before that scheduler can run;
    // every actual React component retains the normal refresh transform.
    react({ exclude: /[\\/]src[\\/]main\.tsx(?:\?.*)?$/ }),
    tailwindcss(),
    // Its configureServer guard keeps the handler absent outside fixture QA;
    // registration alone performs no request, fallback, or environment write.
    phase9MarketIntelligenceUnavailableFixture(),
    runtimeErrorOverlay(),
    VitePWA({
      registerType: 'autoUpdate',
      // The Replit dev preview is proxied under a sub-path with HMR; a service
      // worker there conflicts with tooling, so PWA is production-only.
      disable: process.env.NODE_ENV !== 'production',
      manifest: {
        name: '지식정보',
        short_name: '지식정보',
        description: '주식·코인 정보, 분석, 알림과 승인형 자동매매',
        lang: 'ko-KR',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'portrait',
        id: '/',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        importScripts: ['/push-sw.js'],
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // App APIs can contain live, authenticated, or permission-sensitive
            // data. Never replay an older runtime-cached API response after a
            // deploy or an account/capability change.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ request }) => request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'font-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined &&
    process.env.ENABLE_REPLIT_EDITOR_PLUGINS === 'true'
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    // Prime shared bootstrap, the read-only chart and the login screen module.
    // This does not evaluate client code, fetch APIs, or wait for page-specific
    // data. The first browser request must not pay this compiler waterfall.
    warmup: {
      clientFiles: [
        './src/main.tsx', './src/App.tsx', './src/app-runtime.tsx',
        './src/pages/ai-chart.tsx', './src/components/unified-analysis-chart.tsx',
        './src/pages/account.tsx',
      ],
    },
    proxy: {
      '/api': {
        target: process.env.API_SERVER_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
