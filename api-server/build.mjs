import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const outDir = path.resolve(rootDir, 'dist');

if (!fs.existsSync(outDir)) {
	fs.mkdirSync(outDir, { recursive: true });
}

const external = [
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),

	// workspace packages
	'@workspace/api-zod',
	'@workspace/db',
	'@workspace/stock-grade',

	// runtime dependencies
	'@supabase/supabase-js',
	'adm-zip',
	'cookie-parser',
	'cors',
	'drizzle-orm',
	'express',
	'pino',
	'pino-http',
	'web-push',
];

await build({
	entryPoints: [path.resolve(rootDir, 'src/index.ts')],
	outfile: path.resolve(outDir, 'index.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

console.log('[api-server] built dist/index.mjs');

fs.mkdirSync(path.resolve(outDir, 'tools'), { recursive: true });

await build({
	entryPoints: [path.resolve(rootDir, 'scripts/publish-research-canonical-bundle.ts')],
	outfile: path.resolve(outDir, 'tools/publish-research-canonical-bundle.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

console.log('[api-server] built dist/tools/publish-research-canonical-bundle.mjs');

await build({
	entryPoints: [path.resolve(rootDir, 'scripts/assemble-research-canonical-bundle.ts')],
	outfile: path.resolve(outDir, 'tools/assemble-research-canonical-bundle.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

console.log('[api-server] built dist/tools/assemble-research-canonical-bundle.mjs');

await build({
	entryPoints: [path.resolve(rootDir, 'scripts/register-research-canonical-component.ts')],
	outfile: path.resolve(outDir, 'tools/register-research-canonical-component.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

await build({
	entryPoints: [path.resolve(rootDir, 'scripts/check-research-canonical-component-readiness.ts')],
	outfile: path.resolve(outDir, 'tools/check-research-canonical-component-readiness.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

console.log('[api-server] built canonical research component registry tools');

await build({
	entryPoints: [path.resolve(rootDir, 'scripts/check-paper-canonical-runtime-readiness.ts')],
	outfile: path.resolve(outDir, 'tools/check-paper-canonical-runtime-readiness.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

console.log('[api-server] built Paper Canonical runtime readiness tool');

await build({
	entryPoints: [path.resolve(rootDir, 'scripts/check-paper-canonical-runtime-readiness-remote.ts')],
	outfile: path.resolve(outDir, 'tools/check-paper-canonical-runtime-readiness-remote.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	external,
	banner: {
		js: `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`,
	},
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
	},
	logLevel: 'info',
});

console.log('[api-server] built Paper Canonical remote readiness tool');

/* The isolated Telegram entry is built as a dormant artifact.
 * Normal stock-app PM2 never executes it. */
await build({
  entryPoints: [path.resolve(rootDir, 'src/telegram-isolated-worker.ts')],
  outfile: path.resolve(outDir, 'telegram-isolated-worker.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  minify: false,
  // A standalone immutable release has no access to /opt/stock-app/node_modules.
  // Bundle all pinned third-party/workspace packages; only Node builtins remain
  // external. The stock-app web/API build above is deliberately unchanged.
  packages: 'bundle',
  external: [...builtinModules, ...builtinModules.map(name => 'node:' + name)],
  banner: {
    js: "\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);\n",
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
  logLevel: 'info',
});
console.log('[api-server] built dormant isolated Telegram worker bundle');

// This binary is promoted to a separate sealed release without inheriting
// the running stock-app's node_modules. Verify its actual startup in an empty
// directory before expensive CI or an approved Production deploy.
const standaloneCheck = spawnSync(
  process.execPath,
  ['--test', path.resolve(rootDir, '../.github/tests/telegram-isolated-bundle.test.mjs')],
  {
    cwd: path.resolve(rootDir, '..'),
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
    maxBuffer: 65_536,
  },
);
if (standaloneCheck.status !== 0) {
  throw new Error('TELEGRAM_ISOLATED_BUNDLE_DEPENDENCIES_UNRESOLVED');
}
console.log('[api-server] isolated Telegram startup verified without node_modules');

