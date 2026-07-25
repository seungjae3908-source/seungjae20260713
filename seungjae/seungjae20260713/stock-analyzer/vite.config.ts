import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
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

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        importScripts: ['/push-sw.js'],
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Live market/index/quote/chart data must never be served from an
            // old service-worker cache entry.
            urlPattern: ({ url }) =>
              /\/api\/(market\/(home|summary|movers|alerts|scan|recommendations)|quotes|candles|crypto\/|kiwoom\/(rankings|quote)|stocks\/[^/]+\/(chart|candles|quote))/.test(
                url.pathname,
              ),
            handler: 'NetworkOnly',
          },
          {
            // Cache slower-changing API GETs so the last-seen data is
            // available offline.
            urlPattern: ({ url }) => url.pathname.includes('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
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
