import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const rootDir = process.cwd();
const outDir = path.resolve(rootDir, 'dist');
const sourceExtensions = ['.ts', '.tsx', '.js', '.mjs', '.json'];

function resolveLocalSource(importPath, resolveDir) {
	const candidate = path.resolve(resolveDir, importPath);
	const candidates = [
		candidate,
		...sourceExtensions.map((extension) => `${candidate}${extension}`),
		...sourceExtensions.map((extension) => path.join(candidate, `index${extension}`)),
	];

	return candidates.find((filePath) => {
		try {
			return fs.statSync(filePath).isFile();
		} catch {
			return false;
		}
	});
}

const localSourcePlugin = {
	name: 'local-source',
	setup(buildContext) {
		buildContext.onResolve({ filter: /^\.{1,2}\// }, (args) => {
			const resolved = resolveLocalSource(args.path, args.resolveDir);
			if (!resolved) {
				return { errors: [{ text: `Cannot resolve local source: ${args.path}` }] };
			}
			return { path: resolved, namespace: 'local-source' };
		});

		buildContext.onLoad({ filter: /.*/, namespace: 'local-source' }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8'),
			loader: path.extname(args.path).slice(1),
			resolveDir: path.dirname(args.path),
		}));
	},
};

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
	absWorkingDir: rootDir,
	stdin: {
		contents: fs.readFileSync(path.resolve(rootDir, 'src/index.ts'), 'utf8'),
		resolveDir: path.resolve(rootDir, 'src'),
		sourcefile: 'index.ts',
		loader: 'ts',
	},
	outfile: path.resolve(outDir, 'index.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	minify: false,
	packages: 'external',
	preserveSymlinks: true,
	plugins: [localSourcePlugin],
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
