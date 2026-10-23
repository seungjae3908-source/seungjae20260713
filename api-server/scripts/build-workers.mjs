import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const rootDir = process.cwd();
const outDir = path.resolve(rootDir, 'dist');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Worker entrypoints are built separately from the main API build (build.mjs).
// `packages: 'bundle'` matches the telegram-isolated-worker pattern so workers
// can run without inheriting the live stock-app's node_modules.
const entryPoints = [
  { source: 'src/workers/signal-worker.ts', output: 'signal-worker.mjs' },
  { source: 'src/workers/alert-worker.ts', output: 'alert-worker.mjs' },
];

for (const entry of entryPoints) {
  await build({
    entryPoints: [path.resolve(rootDir, entry.source)],
    outfile: path.resolve(outDir, entry.output),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    minify: true,
    packages: 'bundle',
    external: [
      ...builtinModules,
      ...builtinModules.map((name) => `node:${name}`),
      'web-push',
      'ws',
      '@supabase/supabase-js',
      'pino',
      'pino-http',
      'pino-pretty',
      'thread-stream',
    ],
    banner: {
      js: `
import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __pathDirname } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);
`,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    },
    logLevel: 'info',
  });
  console.log(`[api-server/workers] built dist/${entry.output}`);
}
