import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = 'stock-analyzer/e2e';
const DEFAULT_WEIGHTS = '.github/fixtures/browser-runtime-weights-v1.json';
export const IGNORED_SPECS = Object.freeze(new Set(['production-readonly-smoke.spec.ts']));

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, weights: DEFAULT_WEIGHTS, lanes: 4, lane: null, format: 'json', verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i] ?? options.root;
    else if (arg === '--weights') options.weights = argv[++i] ?? options.weights;
    else if (arg === '--lanes') options.lanes = Number(argv[++i] ?? options.lanes);
    else if (arg === '--lane') options.lane = Number(argv[++i]);
    else if (arg === '--format') options.format = argv[++i] ?? options.format;
    else if (arg === '--verify') options.verify = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.lanes) || options.lanes < 2) throw new Error('[INVALID_LANE_COUNT]');
  if (options.lane !== null && (!Number.isInteger(options.lane) || options.lane < 1 || options.lane > options.lanes)) {
    throw new Error('[INVALID_LANE]');
  }
  if (!['json', 'lines'].includes(options.format)) throw new Error('[INVALID_FORMAT]');
  return options;
}

async function listSpecs(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts') && !IGNORED_SPECS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function buildRuntimeWeightedPlan(specs, weightsDocument, laneCount = 4) {
  const defaultSeconds = Number(weightsDocument.defaultSeconds);
  if (!(defaultSeconds > 0)) throw new Error('[INVALID_DEFAULT_WEIGHT]');

  const lanes = Array.from({ length: laneCount }, (_, index) => ({
    lane: index + 1,
    estimatedSeconds: 0,
    files: [],
  }));

  const weighted = [...specs]
    .map((file) => ({
      file,
      seconds: Number(weightsDocument.weightsSeconds?.[file] ?? defaultSeconds),
      observed: Object.prototype.hasOwnProperty.call(weightsDocument.weightsSeconds ?? {}, file),
    }))
    .sort((left, right) => right.seconds - left.seconds || left.file.localeCompare(right.file));

  for (const item of weighted) {
    lanes.sort((left, right) => left.estimatedSeconds - right.estimatedSeconds || left.lane - right.lane);
    const target = lanes[0];
    target.files.push(item.file);
    target.estimatedSeconds += item.seconds;
  }

  lanes.sort((left, right) => left.lane - right.lane);
  return lanes.map((lane) => ({
    lane: lane.lane,
    estimatedSeconds: Number(lane.estimatedSeconds.toFixed(6)),
    files: lane.files,
  }));
}

export function verifyPlan(specs, lanes) {
  const seen = new Map();
  for (const lane of lanes) {
    for (const file of lane.files) seen.set(file, (seen.get(file) ?? 0) + 1);
  }
  const missing = specs.filter((file) => !seen.has(file));
  const duplicated = [...seen.entries()].filter(([, count]) => count !== 1);
  const unexpected = [...seen.keys()].filter((file) => !specs.includes(file));
  if (missing.length || duplicated.length || unexpected.length) {
    throw new Error(`[BROWSER_SHARD_COVERAGE_INVALID] missing=${missing.join(',')} duplicated=${duplicated.map(([f,c]) => `${f}:${c}`).join(',')} unexpected=${unexpected.join(',')}`);
  }

  const loads = lanes.map((lane) => lane.estimatedSeconds);
  const max = Math.max(...loads);
  const min = Math.min(...loads);
  const ratio = min > 0 ? max / min : Number.POSITIVE_INFINITY;
  return {
    specCount: specs.length,
    laneCount: lanes.length,
    minEstimatedSeconds: Number(min.toFixed(6)),
    maxEstimatedSeconds: Number(max.toFixed(6)),
    imbalanceRatio: Number(ratio.toFixed(6)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [specs, weightsDocument] = await Promise.all([
    listSpecs(options.root),
    readFile(options.weights, 'utf8').then(JSON.parse),
  ]);
  const lanes = buildRuntimeWeightedPlan(specs, weightsDocument, options.lanes);
  const verification = verifyPlan(specs, lanes);

  if (options.verify) {
    if (verification.imbalanceRatio > 1.10) {
      throw new Error(`[BROWSER_SHARD_IMBALANCE_TOO_HIGH] ratio=${verification.imbalanceRatio}`);
    }
    process.stdout.write(`${JSON.stringify({ verification, lanes: lanes.map((lane) => ({ ...lane, files: lane.files.length })) }, null, 2)}\n`);
    if (options.lane === null) return;
  }

  if (options.lane === null) {
    process.stdout.write(`${JSON.stringify({ verification, lanes }, null, 2)}\n`);
    return;
  }

  const selected = lanes.find((lane) => lane.lane === options.lane);
  if (!selected) throw new Error('[BROWSER_SHARD_LANE_NOT_FOUND]');
  if (options.format === 'lines') {
    for (const file of selected.files) process.stdout.write(`e2e/${file}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[BROWSER_RUNTIME_SHARD_PLAN_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
