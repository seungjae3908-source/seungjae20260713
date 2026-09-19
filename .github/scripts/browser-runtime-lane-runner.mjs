import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseDurationSeconds(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error('[INVALID_TEST_DURATION]');
  if (unit === 'ms') return numeric / 1000;
  if (unit === 's') return numeric;
  if (unit === 'm') return numeric * 60;
  throw new Error(`[UNKNOWN_TEST_DURATION_UNIT] ${unit}`);
}

export function collectRuntimeLine(state, line) {
  const running = line.match(/Running\s+(\d+)\s+tests?\s+using/u);
  if (running) state.discoveredTests = Number(running[1]);

  const test = line.match(/[✓✘]\s+\d+\s+e2e\/([^:]+\.spec\.ts):\d+(?::\d+)?\s+.*\(([\d.]+)(ms|s|m)\)\s*$/u);
  if (test) {
    const file = test[1];
    const seconds = parseDurationSeconds(test[2], test[3]);
    const entry = state.files[file] ?? { observedTests: 0, durationSeconds: 0 };
    entry.observedTests += 1;
    entry.durationSeconds = Number((entry.durationSeconds + seconds).toFixed(6));
    state.files[file] = entry;
    state.observedTestLines += 1;
  }

  const passed = line.match(/^\s*(\d+)\s+passed\s+/u);
  if (passed) state.passed = Number(passed[1]);
  const skipped = line.match(/^\s*(\d+)\s+skipped\s*$/u);
  if (skipped) state.skipped = Number(skipped[1]);
}

function parseArgs(argv) {
  const options = { lane: null, specList: null, telemetry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lane') options.lane = Number(argv[++i]);
    else if (arg === '--spec-list') options.specList = argv[++i] ?? null;
    else if (arg === '--telemetry') options.telemetry = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.lane) || options.lane < 1 || options.lane > 4) throw new Error('[INVALID_BROWSER_RUNTIME_LANE]');
  if (!options.specList) throw new Error('[MISSING_SPEC_LIST]');
  if (!options.telemetry) throw new Error('[MISSING_TELEMETRY_PATH]');
  return options;
}

async function runPlaywright(options) {
  const specs = (await readFile(options.specList, 'utf8'))
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (specs.length === 0) throw new Error('[EMPTY_BROWSER_SPEC_LIST]');

  const state = {
    schemaVersion: 1,
    runId: Number(process.env.GITHUB_RUN_ID || 0),
    sourceSha: String(process.env.APPLICATION_STATUS_SHA || process.env.GITHUB_SHA || '').toLowerCase(),
    lane: options.lane,
    selectedSpecCount: specs.length,
    discoveredTests: null,
    observedTestLines: 0,
    passed: null,
    skipped: null,
    files: {},
  };

  const args = [
    '--dir', 'stock-analyzer', 'exec', 'playwright', 'test',
    '-c', 'playwright.config.ts',
    ...specs,
    '--retries=0',
  ];

  const child = spawn('pnpm', args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) collectRuntimeLine(state, line);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (stdoutBuffer) collectRuntimeLine(state, stdoutBuffer);

  state.exitCode = Number(exitCode ?? 1);
  state.completedAt = new Date().toISOString();
  await mkdir(path.dirname(options.telemetry), { recursive: true });
  await writeFile(options.telemetry, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  if (state.exitCode !== 0) process.exitCode = state.exitCode;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runPlaywright(options);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[BROWSER_RUNTIME_LANE_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
