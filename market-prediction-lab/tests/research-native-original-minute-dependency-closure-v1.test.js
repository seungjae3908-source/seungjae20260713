import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Audits only immutable local source imports. It never reads broker keys,
// opens provider connections or issues orders/Paper mutations.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const seeds = [
  'market-prediction-lab/src/four-market-original-minute-replay-v1.js',
  'market-prediction-lab/src/four-market-original-minute-candidate-review-v1.js',
  'market-prediction-lab/src/four-market-pit-replay-work-queue-v1.js',
  'market-prediction-lab/src/research-original-minute-diagnostic-readonly-v1.js',
  'market-prediction-lab/src/four-market-original-minute-batch-v1.js',
];
const required = [
  'market-prediction-lab/src/original-minute-execution-model-v2.js',
  'market-prediction-lab/src/historical-native-symbol-v1.js',
  'market-prediction-lab/src/historical-pit-venue-universe-gate-v1.js',
  'market-prediction-lab/src/public-native-crypto-roster-v1.js',
  'market-prediction-lab/src/research-minute-archive-v1.js',
  'market-prediction-lab/src/research-minute-archive-window-v1.js',
  'market-prediction-lab/src/research-minute-to-multiframe-v1.js',
  'market-prediction-lab/src/research-selected-window-v1.js',
  'market-prediction-lab/src/timeframes.js',
  'packages/strategy-hypothesis/src/original-minute-backtest.js',
];
function walkSourceImports() {
  const queue = [...seeds], found = new Map();
  while (queue.length) {
    if (found.size > 120) throw Error('NATIVE_REPLAY_DEPENDENCY_UNBOUNDED');
    const absolute = resolve(root, queue.shift());
    const path = relative(root, absolute).replaceAll('\\', '/');
    if (path.startsWith('../') || path === '..' || path.startsWith('/'))
      throw Error('NATIVE_REPLAY_DEPENDENCY_ESCAPES_REPOSITORY');
    if (found.has(path)) continue;
    const state = lstatSync(absolute);
    if (!state.isFile() || state.isSymbolicLink()
      || !realpathSync(absolute).startsWith(root + '/'))
      throw Error('NATIVE_REPLAY_DEPENDENCY_UNSAFE_FILE:' + path);
    const source = readFileSync(absolute, 'utf8');
    if (source.length > 150000) throw Error('NATIVE_REPLAY_DEPENDENCY_TOO_LARGE');
    found.set(path, createHash('sha256').update(source).digest('hex'));
    for (const capture of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g,
    )) {
      const next = capture[1];
      if (!next.startsWith('.')) continue;
      if (!/\.(?:m?js|json)$/u.test(next))
        throw Error('NATIVE_REPLAY_IMPORT_EXTENSION_INVALID:' + path);
      queue.push(relative(root, resolve(dirname(absolute), next)));
    }
  }
  return found;
}
test('historical minute replay has an intact bounded offline local-source closure', () => {
  const files = walkSourceImports();
  for (const path of [...seeds, ...required])
    assert.ok(files.has(path), 'missing local dependency: ' + path);
  assert.ok([...files.keys()].every(p =>
    p.startsWith('market-prediction-lab/src/')
      || p.startsWith('packages/strategy-hypothesis/src/')));
  const timeframeSource = readFileSync(resolve(root,
    'market-prediction-lab/src/timeframes.js'), 'utf8');
  for (const interval of ['1m', '3m', '5m', '15m', '30m', '1h'])
    assert.ok(timeframeSource.includes('"' + interval + '"'));
  const economics = readFileSync(resolve(root,
    'market-prediction-lab/src/original-minute-execution-model-v2.js'), 'utf8');
  for (const token of [
    'GAP_OPEN_STOP_FIRST_CLOSE_MTM_V2',
    'ORIGINAL_MINUTE_LIQUIDATION_INPUT_INVALID',
    'ORIGINAL_MINUTE_EQUITY_STATE_INVALID',
  ]) assert.ok(economics.includes(token));
  console.log(JSON.stringify({
    status: 'OFFLINE_SOURCE_GRAPH_ONLY', files: [...files.keys()].sort(),
    sourceProviderVerified: false, independentOosProven: false,
    profitabilityProven: false, executionAuthority: 'NONE',
  }));
});
test('native replay explicitly forbids nonfutures shorts and unverified PIT', () => {
  const replay = readFileSync(resolve(root,
    'market-prediction-lab/src/four-market-original-minute-replay-v1.js'), 'utf8');
  assert.ok(replay.includes('market!=="CRYPTO_FUTURES"&&direction!=="LONG"'));
  assert.ok(replay.includes('PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED'));
  assert.ok(replay.includes('PRIVATE_REPLAY_COST_RATES_INVALID'));
  assert.ok(replay.includes('originalMinuteLiquidationV2'));
  assert.ok(!replay.includes('LIVE_TRADING=true'));
});
