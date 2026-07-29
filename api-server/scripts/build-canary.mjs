import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');

process.chdir(apiRoot);
process.env.API_BUILD_MODE = 'canary';
process.env.API_BUILD_OUT_DIR = '.canary-dist';
process.env.NODE_ENV = 'test';

await import(`../build.mjs?canary=${Date.now()}`);
