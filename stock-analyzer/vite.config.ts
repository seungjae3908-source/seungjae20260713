import path from 'path';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const require = createRequire(import.meta.url);
const lightweightChartsEntry = require.resolve('lightweight-charts');

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

    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined &&
    process.env.ENABLE_REPLIT_EDITOR_PLUGINS === 'true'
      ? [
          await import('@replit/vite-plugin-cartographer').then((module) =>
            module.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),

          await import('@replit/vite-plugin-dev-banner').then((module) =>
            module.devBanner(),
          ),
        ]
      : []),
  ],

  resolve: {
    alias: [
      {
        find: /^lightweight-charts-original$/,
        replacement: lightweightChartsEntry,
      },
      {
        find: /^lightweight-charts$/,
        replacement: path.resolve(
          import.meta.dirname,
          'src/lib/lightweight-charts-relay-patch.ts',
        ),
      },
      {
        find: '@',
        replacement: path.resolve(import.meta.dirname, 'src'),
      },
      {
        find: '@assets',
        replacement: path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
    ],

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
        target:
          process.env.API_SERVER_URL ??
          'http://127.0.0.1:8080',

        changeOrigin: true,
        ws: true,
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
