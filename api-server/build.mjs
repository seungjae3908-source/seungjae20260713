import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const rootDir = process.cwd();
const buildMode = String(process.env.API_BUILD_MODE ?? 'production').trim();
const outDir = process.env.API_BUILD_OUT_DIR?.trim()
	? path.resolve(rootDir, process.env.API_BUILD_OUT_DIR)
	: path.resolve(rootDir, 'dist');
const relativeOutDir = path.relative(rootDir, outDir);

if (
	!relativeOutDir ||
	relativeOutDir.startsWith('..') ||
	path.isAbsolute(relativeOutDir)
) {
	throw new Error(`Unsafe API build output directory: ${outDir}`);
}

if (buildMode === 'canary') {
	if (relativeOutDir.split(path.sep)[0] !== '.canary-dist') {
		throw new Error('Canary builds must use api-server/.canary-dist');
	}
	fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

function gitValue(args, fallback) {
	try {
		return execFileSync('git', args, {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return fallback;
	}
}

const commitSha =
	process.env.BUILD_COMMIT_SHA?.trim() ||
	gitValue(['rev-parse', 'HEAD'], 'unknown');
const sourceDirty =
	gitValue(['status', '--porcelain', '--untracked-files=no'], '').length > 0;
const buildTime = new Date().toISOString();

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

const entryPoints = [
	{ source: 'src/index.ts', output: 'index.mjs' },
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
			__BUILD_COMMIT_SHA__: JSON.stringify(commitSha),
			__BUILD_TIME__: JSON.stringify(buildTime),
			__BUILD_MODE__: JSON.stringify(buildMode),
			__BUILD_SOURCE_DIRTY__: JSON.stringify(sourceDirty),
		},
		logLevel: 'info',
	});

	console.log(`[api-server] built ${path.relative(rootDir, path.resolve(outDir, entry.output))}`);
}

const requiredArtifacts = entryPoints.map((entry) =>
	path.resolve(outDir, entry.output),
);
for (const artifact of requiredArtifacts) {
	if (!fs.existsSync(artifact)) {
		throw new Error(`Missing API build artifact: ${artifact}`);
	}
}

const apiBundle = fs.readFileSync(path.resolve(outDir, 'index.mjs'), 'utf8');
for (const forbidden of [
	'startPriceAlertMonitor(',
	'startStrongSignalMonitor(',
	'price alert monitor enabled',
]) {
	if (apiBundle.includes(forbidden)) {
		throw new Error(`API bundle contains forbidden startup monitor: ${forbidden}`);
	}
}

const artifacts = Object.fromEntries(
	requiredArtifacts.map((artifact) => {
		const bytes = fs.readFileSync(artifact);
		return [
			path.basename(artifact),
			{
				bytes: bytes.length,
				sha256: createHash('sha256').update(bytes).digest('hex'),
			},
		];
	}),
);

const metadata = {
	service: 'api-server',
	mode: buildMode,
	commitSha,
	buildTime,
	sourceDirty,
	artifacts,
};
fs.writeFileSync(
	path.resolve(outDir, 'build-meta.json'),
	`${JSON.stringify(metadata, null, 2)}\n`,
	'utf8',
);
console.log(JSON.stringify({ event: 'api_build_complete', ...metadata }));
