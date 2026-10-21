import path from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/preview'),
      emptyOutDir: true,
    },
    server: {
      port: Number(process.env.PREVIEW_PORT ?? 5174),
      strictPort: true,
      proxy: {
        '/api': {
          target: process.env.PREVIEW_API_URL ?? 'http://127.0.0.1:8080',
          changeOrigin: true,
          bypass: (req) => {
            if (req.method && req.method !== 'GET') {
              console.warn('[preview] blocked non-GET', req.method, req.url);
              return '/preview-blocked';
            }
          },
        },
      },
    },
  }),
);
