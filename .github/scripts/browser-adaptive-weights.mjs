import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IGNORED_SPECS } from './browser-runtime-shard-plan.mjs';

export const DEFAULT_ALPHA = 0.5;
export const MIN_OBSERVED_RATIO = 0.5;
export const MAX_OBSERVED_RATIO = 2.0;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  const ordered = [...values].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!ordered.length) throw new Error('[NO_POSITIVE_BROWSER_WEIGHTS]');
  return ordered[Math.floor(ordered.length / 2)];
}

export function adaptWeights(base, telemetryDocuments, canonicalSpecs, alpha = DEFAULT_ALPHA) {
  if (!(alpha > 0 && alpha <= 1)) throw new Error('[INVALID_ADAPTIVE_ALPHA]');
  if (!base || !(Number(base.defaultSeconds) > 0)) throw new Error('[INVALID_BASE_WEIGHTS]');

  const lanes = new Map();
  const runIds = new Set();
  const sourceShas = new Set();
  for (const telemetry of telemetryDocuments) {
    if (telemetry?.schemaVersion !== 1) throw new Error('[INVALID_BROWSER_TELEMETRY_SCHEMA]');
    if (!Number.isInteger(telemetry.lane) || telemetry.lane < 1 || telemetry.lane > 4) throw new Error('[INVALID_BROWSER_TELEMETRY_LANE]');
    if (lanes.has(telemetry.lane)) throw new Error('[DUPLICATE_BROWSER_TELEMETRY_LANE]');
    if (telemetry.exitCode !== 0) throw new Error('[FAILED_BROWSER_TELEMETRY_NOT_CREDITABLE]');
    lanes.set(telemetry.lane, telemetry);
    runIds.add(Number(telemetry.runId));
    sourceShas.add(String(telemetry.sourceSha || '').toLowerCase());
  }
  if (lanes.size !== 4) throw new Error(`[INCOMPLETE_BROWSER_TELEMETRY] lanes=${[...lanes.keys()].sort().join(',')}`);
  if (runIds.size !== 1 || sourceShas.size !== 1) throw new Error('[MIXED_BROWSER_TELEMETRY_IDENTITY]');

  const observed = new Map();
  for (const telemetry of lanes.values()) {
    for (const [file, entry] of Object.entries(telemetry.files ?? {})) {
      const seconds = Number(entry?.durationSeconds);
      if (!(seconds > 0)) continue;
      if (!canonicalSpecs.includes(file)) continue;
      if (observed.has(file)) throw new Error(`[DUPLICATE_BROWSER_TELEMETRY_FILE] ${file}`);
      observed.set(file, seconds);
    }
  }

  const weightsSeconds = {};
  let updatedCount = 0;
  let retainedCount = 0;
  for (const file of canonicalSpecs) {
    const previous = Number(base.weightsSeconds?.[file] ?? base.defaultSeconds);
    if (!(previous > 0)) throw new Error(`[INVALID_PREVIOUS_BROWSER_WEIGHT] ${file}`);
    const measured = observed.get(file);
    if (!(measured > 0)) {
      weightsSeconds[file] = Number(previous.toFixed(6));
      retainedCount += 1;
      continue;
    }
    const bounded = clamp(measured, previous * MIN_OBSERVED_RATIO, previous * MAX_OBSERVED_RATIO);
    const next = previous * (1 - alpha) + bounded * alpha;
    weightsSeconds[file] = Number(next.toFixed(6));
    updatedCount += 1;
  }

  const nextDefault = Number(median(Object.values(weightsSeconds)).toFixed(6));
  const runId = [...runIds][0];
  const sourceSha = [...sourceShas][0];

  return {
    schemaVersion: 2,
    strategy: 'EWMA_CLAMPED_V1',
    generatedAt: new Date().toISOString(),
    source: {
      workflowRunId: runId,
      sourceSha,
      laneCount: 4,
      alpha,
      minObservedRatio: MIN_OBSERVED_RATIO,
      maxObservedRatio: MAX_OBSERVED_RATIO,
      updatedSpecCount: updatedCount,
      retainedSpecCount: retainedCount,
      note: 'Adaptive Browser weights are scheduling evidence only and grant no CI or test pass credit.',
    },
    defaultSeconds: nextDefault,
    weightsSeconds,
  };
}

function parseArgs(argv) {
  const options = { base: null, telemetryDir: null, root: 'stock-analyzer/e2e', output: null, alpha: DEFAULT_ALPHA };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') options.base = argv[++i] ?? null;
    else if (arg === '--telemetry-dir') options.telemetryDir = argv[++i] ?? null;
    else if (arg === '--root') options.root = argv[++i] ?? options.root;
    else if (arg === '--output') options.output = argv[++i] ?? null;
    else if (arg === '--alpha') options.alpha = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.base || !options.telemetryDir || !options.output) throw new Error('[MISSING_ADAPTIVE_WEIGHT_ARGUMENT]');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [base, telemetryNames, specEntries] = await Promise.all([
    readFile(options.base, 'utf8').then(JSON.parse),
    readdir(options.telemetryDir),
    readdir(options.root, { withFileTypes: true }),
  ]);
  const telemetryDocuments = [];
  for (const name of telemetryNames.filter((value) => value.endsWith('.json')).sort()) {
    telemetryDocuments.push(JSON.parse(await readFile(path.join(options.telemetryDir, name), 'utf8')));
  }
  const canonicalSpecs = specEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts') && !IGNORED_SPECS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  const adapted = adaptWeights(base, telemetryDocuments, canonicalSpecs, options.alpha);
  await writeFile(options.output, `${JSON.stringify(adapted, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    sourceRunId: adapted.source.workflowRunId,
    sourceSha: adapted.source.sourceSha,
    updatedSpecCount: adapted.source.updatedSpecCount,
    retainedSpecCount: adapted.source.retainedSpecCount,
    defaultSeconds: adapted.defaultSeconds,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[BROWSER_ADAPTIVE_WEIGHTS_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
