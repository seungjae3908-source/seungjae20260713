import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Same application entrypoints, React and Tailwind; no Replit plugin or remote server.
// Provider/auth responses are explicitly synthetic in the browser tests.
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    '@': path.resolve(import.meta.dirname, 'src'),
    '@assets': path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
  }, dedupe: ['react','react-dom'] },
  server: { host:'127.0.0.1', port:4173, strictPort:true, fs:{strict:true} },
});
