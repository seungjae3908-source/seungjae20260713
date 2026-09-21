import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

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
